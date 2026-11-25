/**
 * my-jizhang 家庭记账本服务端（安全增强版）
 * 零依赖：仅使用 Node 内置模块。
 *
 * 新增能力：
 *   - 数据静态加密（AES-256-GCM，密钥存放在单独的 master.key 文件）
 *   - 旧明文 ledger.json 自动迁移为加密格式
 *   - 登录认证（scrypt 密码哈希 + 会话 Cookie），首次启动生成初始密码
 *   - 修改密码（需旧密码），改密后其它设备会话失效
 *   - 自动备份（定时 + 手动 + 保留轮数），备份文件同样加密，路径收口防穿越
 *   - 审计日志（登录/登出/改密/文档增删改/导入导出/备份）JSONL + 按大小轮转
 *   - CSRF 防护（SameSite=Strict Cookie + Origin 校验）
 *
 * 适用：ARM64 路由器 / NAS 等小内存设备，容器内 8080 端口。
 */
import { createServer } from 'node:http';
import {
  readFile, writeFile, rename, mkdir, readdir, stat, unlink, chmod, appendFile, access,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  randomBytes, randomUUID, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual,
} from 'node:crypto';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'ledger.json');
const KEY_FILE = path.resolve(process.env.KEY_FILE || path.join(DATA_DIR, 'master.key'));
const AUTH_FILE = path.resolve(process.env.AUTH_FILE || path.join(DATA_DIR, 'auth.json'));
const AUDIT_FILE = path.resolve(process.env.AUDIT_FILE || path.join(DATA_DIR, 'audit.log'));
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups'));
const PORT = Number(process.env.PORT || 8080);

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const SESSION_TTL = Number(process.env.SESSION_TTL_MS || 7 * 24 * 3600 * 1000);
const BACKUP_INTERVAL = Number(process.env.BACKUP_INTERVAL_MS || 24 * 3600 * 1000);
const BACKUP_KEEP = Math.max(1, Number(process.env.BACKUP_KEEP || 30));
const AUDIT_MAX_BYTES = 5 * 1024 * 1024;
const LOGIN_MAX_FAIL = Math.max(1, Number(process.env.LOGIN_MAX_FAIL || 8));
const LOGIN_LOCK_MS = Math.max(1, Number(process.env.LOGIN_LOCK_MS || 5 * 60 * 1000));
const BODY_LIMIT = 25 * 1024 * 1024;

let db = { docs: [] };
let persistChain = Promise.resolve();
let masterKey = null; // 32 bytes
const sessions = new Map(); // token -> { expires }
const loginFails = new Map(); // ip -> { count, until }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const SAMPLE_NOVEMBER = [
  '<p class="day-label">11月</p>',
  '<p>本月收支记录，直接改表格或点底部「＋收入 / －支出」加一行。</p>',
  '<div class="ledger" contenteditable="false">',
  '<table class="ledger-table">',
  '<thead><tr><th class="c-date">日期</th><th class="c-type">类型</th><th class="c-desc">内容</th><th class="c-amount">金额</th><th class="c-op"></th></tr></thead>',
  '<tbody>',
  '<tr class="ledger-row" data-type="income"><td class="c-date"><input type="date" class="lg-date" value="2026-11-01"></td>',
  '<td class="c-type"><select class="lg-type"><option value="income" selected>收入</option><option value="expense">支出</option></select></td>',
  '<td class="c-desc"><input class="lg-desc" value="工资" placeholder="如：买菜"></td>',
  '<td class="c-amount num"><input class="lg-amount" type="number" step="0.01" min="0" value="3900" placeholder="0.00"></td>',
  '<td class="c-op"><button class="lg-del" type="button" title="删除该行">✕</button></td></tr>',
  '<tr class="ledger-row" data-type="expense"><td class="c-date"><input type="date" class="lg-date" value="2026-11-02"></td>',
  '<td class="c-type"><select class="lg-type"><option value="income">收入</option><option value="expense" selected>支出</option></select></td>',
  '<td class="c-desc"><input class="lg-desc" value="就餐食品费" placeholder="如：买菜"></td>',
  '<td class="c-amount num"><input class="lg-amount" type="number" step="0.01" min="0" value="300" placeholder="0.00"></td>',
  '<td class="c-op"><button class="lg-del" type="button" title="删除该行">✕</button></td></tr>',
  '</tbody>',
  '<tfoot><tr class="ledger-foot"><td colspan="3" class="lg-label">合计</td>',
  '<td colspan="2" class="lg-sum"><span class="lg-income">收入 ¥0.00</span>',
  '<span class="lg-expense">支出 ¥0.00</span><span class="lg-balance">结余 ¥0.00</span></td></tr></tfoot>',
  '</table>',
  '<div class="ledger-bar"><button class="lg-add" data-type="income" type="button">＋ 收入</button>',
  '<button class="lg-add" data-type="expense" type="button">－ 支出</button></div>',
  '</div>',
  '<p></p>',
].join('');

/* ---------------- 加密 ---------------- */

async function ensureDir(dir) { await mkdir(dir, { recursive: true }); }

async function loadKey() {
  await ensureDir(path.dirname(KEY_FILE));
  try {
    const buf = await readFile(KEY_FILE);
    if (buf.length === 32) { masterKey = buf; return; }
  } catch { /* 不存在则创建 */ }
  masterKey = randomBytes(32);
  await writeFile(KEY_FILE, masterKey);
  try { await chmod(KEY_FILE, 0o600); } catch { /* Windows 忽略 */ }
  console.log('[my-jizhang] 已生成新的主密钥文件：' + KEY_FILE + '（请妥善备份，丢失则无法解密数据）');
}

function encryptJson(obj) {
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ v: 1, iv: iv.toString('hex'), tag: tag.toString('hex'), data: enc.toString('hex') });
}

function decryptJson(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || !parsed.iv || !parsed.tag || !parsed.data) {
    return null; // 不是加密格式
  }
  try {
    const iv = Buffer.from(parsed.iv, 'hex');
    const tag = Buffer.from(parsed.tag, 'hex');
    const enc = Buffer.from(parsed.data, 'hex');
    const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    return { __decryptError: true };
  }
}

/* ---------------- 密码 / 会话 ---------------- */

function hashPw(password, salt) {
  return scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
}

async function loadAuth() {
  await ensureDir(path.dirname(AUTH_FILE));
  try {
    const raw = await readFile(AUTH_FILE, 'utf8');
    const a = JSON.parse(raw);
    if (a && a.hash && a.salt) return a;
  } catch { /* 首次运行 */ }
  return null;
}

async function writeAuth(password) {
  const salt = randomBytes(16);
  const hash = hashPw(password, salt);
  await writeFile(AUTH_FILE, JSON.stringify({
    hash: hash.toString('hex'),
    salt: salt.toString('hex'),
    params: SCRYPT,
  }));
  try { await chmod(AUTH_FILE, 0o600); } catch { /* ignore */ }
}

function verifyPassword(password, auth) {
  if (!auth || !auth.hash || !auth.salt) return false;
  const salt = Buffer.from(auth.salt, 'hex');
  const expected = Buffer.from(auth.hash, 'hex');
  let actual;
  try { actual = hashPw(password, salt); } catch { return false; }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function randomPassword(len = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += chars[bytes[i] % chars.length];
  return out;
}

function createSession() {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { expires: Date.now() + SESSION_TTL });
  return token;
}

function getSession(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  if (!m) return null;
  const token = m[1];
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  return token;
}

function clearSession(req) {
  const token = getSession(req);
  if (token) sessions.delete(token);
}

function invalidateOtherSessions(keepToken) {
  for (const [t] of sessions) if (t !== keepToken) sessions.delete(t);
}

/* ---------------- 审计日志 ---------------- */

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

async function audit(event, detail, req) {
  const entry = {
    ts: new Date().toISOString(),
    ip: clientIp(req),
    event,
  };
  if (detail && typeof detail === 'object') Object.assign(entry, detail);
  else if (detail !== undefined) entry.detail = detail;
  try {
    let rotate = false;
    try {
      const st = await stat(AUDIT_FILE);
      if (st.size > AUDIT_MAX_BYTES) rotate = true;
    } catch { /* 文件不存在，无需轮转 */ }
    if (rotate) {
      try { await rename(AUDIT_FILE, AUDIT_FILE + '.1'); } catch { /* ignore */ }
    }
    await appendFile(AUDIT_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    console.error('[my-jizhang] 写审计日志失败：', e.message);
  }
}

/* ---------------- 备份 ---------------- */

async function listBackups() {
  await ensureDir(BACKUP_DIR);
  const names = (await readdir(BACKUP_DIR)).filter((n) => /^ledger-\d{8}-\d{6}\.enc$/.test(n));
  const out = [];
  for (const n of names) {
    try {
      const st = await stat(path.join(BACKUP_DIR, n));
      out.push({ name: n, size: st.size, mtime: st.mtime.toISOString() });
    } catch { /* ignore */ }
  }
  out.sort((a, b) => (a.name < b.name ? 1 : -1));
  return out;
}

function safeBackupPath(name) {
  if (typeof name !== 'string' || !/^ledger-\d{8}-\d{6}\.enc$/.test(name)) return null;
  const full = path.resolve(BACKUP_DIR, name);
  // 防止路径穿越：规范化后必须仍在备份目录内
  if (full !== path.join(BACKUP_DIR, name)) return null;
  return full;
}

async function createBackup() {
  await ensureDir(BACKUP_DIR);
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const name = `ledger-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.enc`;
  // 始终用内存中的数据重新加密后写备份，保证备份文件一定是加密的
  const dest = path.join(BACKUP_DIR, name);
  await writeFile(dest, encryptJson(db), 'utf8');
  // 轮转：只保留最近 BACKUP_KEEP 个
  const list = await listBackups();
  for (const old of list.slice(BACKUP_KEEP)) {
    try { await unlink(path.join(BACKUP_DIR, old.name)); } catch { /* ignore */ }
  }
  return name;
}

async function restoreBackup(name) {
  const full = safeBackupPath(name);
  if (!full) throw new Error('非法的备份文件名');
  const raw = await readFile(full, 'utf8');
  const decrypted = decryptJson(raw);
  if (!decrypted || decrypted.__decryptError || !Array.isArray(decrypted.docs)) {
    throw new Error('备份文件无法解密或格式不正确');
  }
  db = decrypted;
  await persist();
}

/* ---------------- 数据存取 ---------------- */

function seed() {
  const now = new Date().toISOString();
  const make = (parent, name, kind, content, sort) => ({
    id: randomUUID(), parent_id: parent, name, kind, content, sort,
    created_at: now, updated_at: now,
  });
  const rootId = randomUUID();
  db.docs.push({ id: rootId, parent_id: null, name: '我的笔记本', kind: 'folder', content: '', sort: 0, created_at: now, updated_at: now });
  db.docs.push(make(rootId, 'daily note', 'doc', '<p>随手记点什么。</p>', 1));
  const yearId = randomUUID();
  db.docs.push({ id: yearId, parent_id: rootId, name: '2026年', kind: 'folder', content: '', sort: 2, created_at: now, updated_at: now });
  for (let month = 1; month <= 12; month += 1) {
    db.docs.push(make(yearId, `2026年${month}月`, 'doc', month === 11 ? SAMPLE_NOVEMBER : '', month));
  }
}

async function initStore() {
  await ensureDir(DATA_DIR);
  let loaded = false;
  try {
    const raw = await readFile(DATA_FILE, 'utf8');
    const decrypted = decryptJson(raw);
    if (decrypted && !decrypted.__decryptError && Array.isArray(decrypted.docs)) {
      db = decrypted; loaded = true;
    } else if (decrypted && decrypted.__decryptError) {
      // 加密了但密钥不对 → 无法加载
      console.error('[my-jizhang] 数据解密失败：主密钥不匹配。请确认 master.key 与创建数据时一致。');
      db = { docs: [] }; loaded = true;
    } else {
      // 旧明文格式 → 直接用，下次持久化时会加密（兼容可能的 BOM）
      try {
        const legacy = JSON.parse(raw.replace(/^\uFEFF/, ''));
        if (legacy && Array.isArray(legacy.docs)) { db = legacy; loaded = true; }
      } catch { /* 损坏 */ }
    }
  } catch { /* 文件不存在 */ }

  if (db.docs.length === 0 && !loaded) {
    seed();
    await persist();
  }
}

function persist() {
  const snapshot = encryptJson(db);
  persistChain = persistChain
    .then(async () => {
      const tmp = `${DATA_FILE}.tmp`;
      await writeFile(tmp, snapshot, 'utf8');
      await rename(tmp, DATA_FILE);
    })
    .catch((err) => console.error('[my-jizhang] 保存数据失败：', err));
  return persistChain;
}

function meta(doc) {
  return {
    id: doc.id, parent_id: doc.parent_id, name: doc.name, kind: doc.kind,
    sort: doc.sort, updated_at: doc.updated_at,
  };
}

function collectIds(rootId) {
  const ids = [rootId];
  for (let i = 0; i < ids.length; i += 1) {
    const parent = ids[i];
    for (const doc of db.docs) {
      if (doc.parent_id === parent && !ids.includes(doc.id)) ids.push(doc.id);
    }
  }
  return ids;
}

/* ---------------- HTTP 工具 ---------------- */

function sendJson(res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }, extraHeaders || {}));
  res.end(body);
}

function sendRedirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

async function readBody(req, limit = BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { return false; }
    return host === req.headers.host;
  }
  const referer = req.headers.referer;
  if (referer) {
    let host;
    try { host = new URL(referer).host; } catch { return false; }
    return host === req.headers.host;
  }
  return true; // 既无 Origin 也无 Referer，放行（SameSite Cookie 已防跨站）
}

function isWrite(method) { return method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH'; }

function cookieHeader(token, maxAge) {
  const parts = [`sid=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  return parts.join('; ');
}

/* ---------------- 启动前初始化 ---------------- */

async function boot() {
  await ensureDir(DATA_DIR);
  await loadKey();
  await initStore();

  // 认证：首次运行设初始密码
  let auth = await loadAuth();
  const initPw = process.env.INIT_PASSWORD;
  if (!auth) {
    const pw = initPw && initPw.trim() ? initPw.trim() : randomPassword();
    await writeAuth(pw);
    if (!initPw) {
      console.log('======================================================');
      console.log('[my-jizhang] 首次启动，已生成初始登录密码：' + pw);
      console.log('[my-jizhang] 请登录后在「设置」中立即修改密码。');
      console.log('[my-jizhang] 可用环境变量 INIT_PASSWORD 指定初始密码。');
      console.log('======================================================');
    } else {
      console.log('[my-jizhang] 已使用 INIT_PASSWORD 设置登录密码。');
    }
  } else if (initPw && initPw.trim()) {
    // 显式指定则覆盖（便于忘记密码时重置）
    await writeAuth(initPw.trim());
    console.log('[my-jizhang] 已用 INIT_PASSWORD 重置登录密码。');
  }

  // 立即做一次备份并启动定时备份
  try {
    const n = await createBackup();
    console.log('[my-jizhang] 启动备份已创建：' + n);
  } catch (e) { console.error('[my-jizhang] 启动备份失败：', e.message); }
  setInterval(() => {
    createBackup().then((n) => audit('backup.auto', { name: n })).catch((e) => console.error('[my-jizhang] 自动备份失败：', e.message));
  }, BACKUP_INTERVAL);
}

/* ---------------- 请求处理 ---------------- */

async function handleAuth(req, res, pathname) {
  if (pathname === '/api/health') {
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/auth/status') {
    const auth = await loadAuth();
    return sendJson(res, 200, { ok: true, authenticated: !!getSession(req), needsSetup: !auth });
  }
  if (pathname === '/api/login' && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: '非法来源' });
    const ip = clientIp(req);
    const fail = loginFails.get(ip);
    if (fail && fail.until > Date.now()) {
      await audit('login.fail', { reason: 'locked', ip }, req);
      return sendJson(res, 429, { error: '尝试过于频繁，请稍后再试' });
    }
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: '请求无效' }); }
    const auth = await loadAuth();
    const ok = !!auth && verifyPassword(body.password, auth);
    if (ok) {
      loginFails.delete(ip);
      const token = createSession();
      res.setHeader('set-cookie', cookieHeader(token, SESSION_TTL));
      await audit('login.success', null, req);
      return sendJson(res, 200, { ok: true });
    }
    const next = (fail?.count || 0) + 1;
    loginFails.set(ip, { count: next, until: next >= LOGIN_MAX_FAIL ? Date.now() + LOGIN_LOCK_MS : 0 });
    await audit('login.fail', { reason: 'bad_password', attempts: next }, req);
    return sendJson(res, 401, { error: '密码错误' });
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: '非法来源' });
    await audit('logout', null, req);
    clearSession(req);
    res.setHeader('set-cookie', cookieHeader('', 0));
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/change-password' && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: '非法来源' });
    if (!getSession(req)) return sendJson(res, 401, { error: '未登录' });
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: '请求无效' }); }
    const auth = await loadAuth();
    if (!auth || !verifyPassword(body.old, auth)) {
      await audit('password.change', { ok: false, reason: 'old_mismatch' }, req);
      return sendJson(res, 400, { error: '旧密码不正确' });
    }
    const np = String(body.new || '');
    if (np.length < 6) {
      return sendJson(res, 400, { error: '新密码至少 6 位' });
    }
    await writeAuth(np);
    const token = getSession(req);
    invalidateOtherSessions(token); // 其它设备重新登录
    await audit('password.change', { ok: true }, req);
    return sendJson(res, 200, { ok: true });
  }
  return null;
}

async function handleDocs(req, res, pathname) {
  if (pathname === '/api/docs') {
    if (req.method === 'GET') {
      await audit('doc.list', { count: db.docs.length }, req);
      return sendJson(res, 200, db.docs.map(meta));
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const kind = body.kind === 'folder' ? 'folder' : 'doc';
      const parent = body.parent_id ? String(body.parent_id) : null;
      if (!name) return sendJson(res, 400, { error: '名称不能为空' });
      if (parent && !db.docs.some((doc) => doc.id === parent)) {
        return sendJson(res, 400, { error: '父节点不存在' });
      }
      const siblings = db.docs.filter((doc) => doc.parent_id === parent);
      const sort = siblings.length ? Math.max(...siblings.map((doc) => doc.sort || 0)) + 1 : 1;
      const now = new Date().toISOString();
      const doc = {
        id: randomUUID(), parent_id: parent, name, kind,
        content: typeof body.content === 'string' ? body.content : '',
        sort, created_at: now, updated_at: now,
      };
      db.docs.push(doc);
      await persist();
      await audit('doc.create', { id: doc.id, name, kind, parent }, req);
      return sendJson(res, 201, meta(doc));
    }
    return sendJson(res, 405, { error: '不支持的请求方法' });
  }

  const matched = pathname.match(/^\/api\/docs\/([^/]+)$/);
  if (matched) {
    const id = decodeURIComponent(matched[1]);
    const doc = db.docs.find((item) => item.id === id);
    if (!doc) return sendJson(res, 404, { error: '文档不存在' });

    if (req.method === 'GET') {
      await audit('doc.read', { id, name: doc.name }, req);
      return sendJson(res, 200, doc);
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readBody(req);
      let changed = false;
      if (typeof body.name === 'string' && body.name.trim()) { doc.name = body.name.trim(); changed = true; await audit('doc.rename', { id, name: doc.name }, req); }
      if (typeof body.content === 'string') { doc.content = body.content; changed = true; }
      if (body.parent_id !== undefined) {
        const nextParent = body.parent_id || null;
        if (nextParent && !db.docs.some((item) => item.id === nextParent)) {
          return sendJson(res, 400, { error: '父节点不存在' });
        }
        if (doc.parent_id !== nextParent) {
          const old = doc.parent_id;
          doc.parent_id = nextParent; changed = true;
          await audit('doc.move', { id, from: old, to: nextParent }, req);
        }
      }
      if (changed) { doc.updated_at = new Date().toISOString(); await persist(); }
      return sendJson(res, 200, meta(doc));
    }
    if (req.method === 'DELETE') {
      if (doc.kind === 'folder' && !doc.parent_id && db.docs.filter((item) => item.kind === 'folder' && !item.parent_id).length <= 1) {
        return sendJson(res, 400, { error: '不能删除唯一的顶级目录' });
      }
      const doomed = collectIds(id);
      db.docs = db.docs.filter((item) => !doomed.includes(item.id));
      await persist();
      await audit('doc.delete', { id, name: doc.name, count: doomed.length }, req);
      return sendJson(res, 200, { deleted: doomed });
    }
    return sendJson(res, 405, { error: '不支持的请求方法' });
  }
  return null;
}

async function handleExtra(req, res, pathname) {
  // 导出：?id=xxx 导出该节点子树；不带 id 导出全部
  if (pathname === '/api/export' && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const rootId = url.searchParams.get('id');
    let ids = null;
    if (rootId) {
      if (!db.docs.some((d) => d.id === rootId)) return sendJson(res, 404, { error: '节点不存在' });
      ids = collectIds(rootId);
    }
    const docs = ids ? db.docs.filter((d) => ids.includes(d.id)) : db.docs;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="my-jizhang-export-${stamp}.json"`,
    });
    // 流式写出，避免大图把整个 JSON 一次性读进内存
    res.write('{"app":"my-jizhang","version":1,"exported_at":"' + new Date().toISOString() + '","docs":[');
    for (let i = 0; i < docs.length; i += 1) {
      if (i) res.write(',');
      res.write(JSON.stringify(docs[i]));
    }
    res.write(']}');
    res.end();
    await audit('export', { id: rootId || null, count: docs.length }, req);
    return true;
  }

  if (pathname === '/api/backup' && req.method === 'POST') {
    const name = await createBackup();
    await audit('backup.manual', { name }, req);
    return sendJson(res, 200, { ok: true, name });
  }
  if (pathname === '/api/backups' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, items: await listBackups() });
  }
  const rb = pathname.match(/^\/api\/backups\/([^/]+)\/restore$/);
  if (rb && req.method === 'POST') {
    const name = decodeURIComponent(rb[1]);
    try {
      await restoreBackup(name);
      await audit('backup.restore', { name }, req);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      await audit('backup.restore', { name, ok: false, error: e.message }, req);
      return sendJson(res, 400, { error: e.message });
    }
  }
  const db2 = pathname.match(/^\/api\/backups\/([^/]+)$/);
  if (db2 && req.method === 'DELETE') {
    const name = decodeURIComponent(db2[1]);
    const full = safeBackupPath(name);
    if (!full) return sendJson(res, 400, { error: '非法文件名' });
    try { await unlink(full); } catch { return sendJson(res, 404, { error: '备份不存在' }); }
    await audit('backup.delete', { name }, req);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/audit' && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit') || 500)));
    let raw = '';
    try { raw = await readFile(AUDIT_FILE, 'utf8'); } catch { return sendJson(res, 200, { ok: true, items: [] }); }
    const lines = raw.split('\n').filter(Boolean);
    const items = [];
    for (let i = lines.length - 1; i >= 0 && items.length < limit; i -= 1) {
      try { items.push(JSON.parse(lines[i])); } catch { /* skip malformed */ }
    }
    return sendJson(res, 200, { ok: true, items });
  }
  return null;
}

async function serveStatic(res, pathname, authed) {
  // 未登录只允许访问登录页
  if (!authed && pathname !== '/login.html') {
    return sendRedirect(res, '/login.html');
  }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const full = path.resolve(PUBLIC_DIR, relative);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: '禁止访问' });
  }
  try {
    const buf = await readFile(full);
    res.writeHead(200, {
      'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'cache-control': pathname === '/' || pathname === '/index.html' || pathname === '/login.html' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // 公开接口（不需登录）
    const handled = await handleAuth(req, res, pathname);
    if (handled !== null) return;

    const authed = !!getSession(req);

    if (pathname.startsWith('/api/')) {
      if (!authed) return sendJson(res, 401, { error: '未登录' });
      if (isWrite(req.method) && !sameOrigin(req)) return sendJson(res, 403, { error: '非法来源' });
      const r1 = await handleDocs(req, res, pathname);
      if (r1 !== null) return;
      const r2 = await handleExtra(req, res, pathname);
      if (r2 !== null && r2 !== true) return; // r2===true 表示已自行结束响应
      if (r2 === true) return;
      return sendJson(res, 404, { error: '接口不存在' });
    }

    await serveStatic(res, pathname, authed);
  } catch (err) {
    console.error('[my-jizhang] 请求处理失败：', err);
    if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
    else res.end();
  }
});

await boot();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[my-jizhang] 已启动：http://0.0.0.0:${PORT}  数据目录：${DATA_DIR}`);
});
