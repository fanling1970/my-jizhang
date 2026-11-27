/**
 * my-jizhang 家庭记账本服务端（密码自加密版）
 * 零依赖：仅使用 Node 内置模块。
 *
 * 加密模型：
 *   - 不再使用独立的 master.key 文件。
 *   - 加密密钥 = scrypt(登录密码, salt)，AES-256-GCM。
 *   - 每个加密包（数据文件 / 备份 / 导出 / 登录校验哨兵）都内嵌自身的 salt 与参数，
 *     解密时用「当前登录密码 + 包内 salt」重新派生密钥。
 *     因此同密码即可解密（换机器、跨实例也行），换密码则旧包全部失效。
 *   - 登录校验：auth.json 是一个用密钥加密的固定哨兵字符串；派生密钥能解开哨兵即密码正确。
 *     登录与数据解密共用同一把密钥，天然绑定。
 *   - 旧 master.key 数据在首次登录成功后自动迁移为密码加密，成功后删除 master.key。
 *
 * 其它：
 *   - 会话 Cookie / CSRF / 限速 / 审计 / 自动备份（路径收口防穿越）。
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
// 仅用于迁移旧数据，迁移成功后删除；不再作为运行时依赖。
const KEY_FILE = path.resolve(process.env.KEY_FILE || path.join(DATA_DIR, 'master.key'));
const AUTH_FILE = path.resolve(process.env.AUTH_FILE || path.join(DATA_DIR, 'auth.json'));
const AUDIT_FILE = path.resolve(process.env.AUDIT_FILE || path.join(DATA_DIR, 'audit.log'));
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups'));
const ASSETS_DIR = path.resolve(process.env.ASSETS_DIR || path.join(DATA_DIR, 'assets'));
const PORT = Number(process.env.PORT || 8080);

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const BLOB_VERSION = 2;
const KDF = 'scrypt';
const SENTINEL = 'mj-verifier-v2';
const SESSION_TTL = Number(process.env.SESSION_TTL_MS || 7 * 24 * 3600 * 1000);
const BACKUP_INTERVAL = Number(process.env.BACKUP_INTERVAL_MS || 24 * 3600 * 1000);
const BACKUP_KEEP = Math.max(1, Number(process.env.BACKUP_KEEP || 30));
const AUDIT_MAX_BYTES = 5 * 1024 * 1024;
const LOGIN_MAX_FAIL = Math.max(1, Number(process.env.LOGIN_MAX_FAIL || 8));
const LOGIN_LOCK_MS = Math.max(1, Number(process.env.LOGIN_LOCK_MS || 5 * 60 * 1000));
/* 请求体大小上限（MB）：0 或未设置 = 不限制。可用环境变量 BODY_LIMIT_MB 按需收紧。 */
const BODY_LIMIT_MB = Number(process.env.BODY_LIMIT_MB || 0);
const BODY_LIMIT = Number.isFinite(BODY_LIMIT_MB) && BODY_LIMIT_MB > 0 ? BODY_LIMIT_MB * 1024 * 1024 : 0;
/* 单张图片资产上限（MB）：默认 20MB，防止异常大图把磁盘/内存撑爆。 */
const ASSET_LIMIT_MB = Number(process.env.ASSET_LIMIT_MB || 20);
const ASSET_LIMIT = Number.isFinite(ASSET_LIMIT_MB) && ASSET_LIMIT_MB > 0 ? ASSET_LIMIT_MB * 1024 * 1024 : 20 * 1024 * 1024;
const ASSET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ASSET_MAGIC = Buffer.from('MJA1');

let db = { docs: [] };
let persistChain = Promise.resolve();
// 登录成功后缓存：当前密码派生的密钥、对应 salt、以及明文密码（用于导入/恢复时按包内 salt 重派生）
let currentKey = null;
let currentSalt = null;
let currentPassword = null;
let storeLoaded = false;
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

function deriveKey(password, salt, params) {
  const p = params || SCRYPT;
  return scryptSync(String(password), salt, p.keylen, { N: p.N, r: p.r, p: p.p });
}

/** 用指定 key 加密 obj，salt 写入包内（自描述）。返回 JSON 字符串。 */
function encryptBlob(obj, key, salt) {
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: BLOB_VERSION,
    kdf: KDF,
    params: SCRYPT,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: enc.toString('hex'),
  });
}

function parseBlob(raw) {
  if (typeof raw !== 'string') return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || parsed.v !== BLOB_VERSION || !parsed.salt || !parsed.iv || !parsed.tag || !parsed.data) return null;
  return parsed;
}

/** 用已知 key 解密（包内 salt 仅用于校验，key 必须与加密时一致）。
 *  返回：obj 成功；null=不是 v2 加密包；{__decryptError:true}=解密失败（密钥不对/损坏）。 */
function decryptBlobWith(raw, key) {
  const parsed = parseBlob(raw);
  if (!parsed) return null;
  try {
    const iv = Buffer.from(parsed.iv, 'hex');
    const tag = Buffer.from(parsed.tag, 'hex');
    const enc = Buffer.from(parsed.data, 'hex');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    return { __decryptError: true };
  }
}

/** 用密码解密任意 v2 包：先从包内取 salt/params 派生 key，再解密。
 *  同密码即可解开任何同密码生成的包（跨 salt、跨实例）。 */
function decryptBlob(raw, password) {
  const parsed = parseBlob(raw);
  if (!parsed) return null;
  let key;
  try { key = deriveKey(password, Buffer.from(parsed.salt, 'hex'), parsed.params); } catch { return { __decryptError: true }; }
  return decryptBlobWith(raw, key);
}

/** 旧版（v:1，master.key）数据解密，仅用于迁移。 */
async function decryptLegacyMaster(raw) {
  let key;
  try { key = await readFile(KEY_FILE); } catch { return null; }
  if (key.length !== 32) return null;
  try {
    const p = JSON.parse(raw);
    if (!p || !p.iv || !p.tag || !p.data) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(p.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(p.tag, 'hex'));
    const plain = Buffer.concat([decipher.update(Buffer.from(p.data, 'hex')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch { return null; }
}

/* ---------------- 图片资产（独立文件，按登录密钥加密） ---------------- */
/*
 * 文档正文只保留 /api/assets/<id> 引用，图片字节单独落盘，避免 base64 内嵌导致
 * 文档体积与浏览器解码内存双双爆炸（手机渲染进程 OOM 的根因）。
 * 文件格式：MJA1 | iv(12) | tag(16) | 密文，密文明文 = 头部长度(4,BE) + JSON 头 + 图片字节。
 * 头部 JSON 目前只含 { mime }，因此文件自描述、导出/备份无需额外索引。
 */

function assetPath(id) {
  if (typeof id !== 'string' || !ASSET_ID_RE.test(id)) return null;
  const full = path.resolve(ASSETS_DIR, id);
  if (full !== path.join(ASSETS_DIR, id)) return null; // 防路径穿越
  return full;
}

function encryptAsset(bytes, mime, key) {
  const head = Buffer.from(JSON.stringify({ mime: mime || 'application/octet-stream' }), 'utf8');
  const headLen = Buffer.alloc(4);
  headLen.writeUInt32BE(head.length, 0);
  const plain = Buffer.concat([headLen, head, bytes]);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([ASSET_MAGIC, iv, cipher.getAuthTag(), enc]);
}

/** 解密资产文件，返回 { mime, bytes }；格式不符/密钥不对返回 null。 */
function decryptAsset(buf, key) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 + 12 + 16 + 4) return null;
  if (!buf.subarray(0, 4).equals(ASSET_MAGIC)) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(4, 16));
    decipher.setAuthTag(buf.subarray(16, 32));
    const plain = Buffer.concat([decipher.update(buf.subarray(32)), decipher.final()]);
    const headLen = plain.readUInt32BE(0);
    if (headLen > plain.length - 4) return null;
    const head = JSON.parse(plain.subarray(4, 4 + headLen).toString('utf8'));
    return { mime: head.mime || 'application/octet-stream', bytes: plain.subarray(4 + headLen) };
  } catch {
    return null;
  }
}

async function writeAsset(id, bytes, mime, key) {
  const full = assetPath(id);
  if (!full) throw new Error('非法的图片 id');
  await ensureDir(ASSETS_DIR);
  const tmp = `${full}.tmp`;
  await writeFile(tmp, encryptAsset(bytes, mime, key));
  await rename(tmp, full);
}

async function readAsset(id, key) {
  const full = assetPath(id);
  if (!full) return null;
  let buf;
  try { buf = await readFile(full); } catch { return null; }
  return decryptAsset(buf, key);
}

/** 收集文档里引用的资产 id（去重）。 */
function collectAssetIds(docs) {
  const ids = new Set();
  const re = /\/api\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
  for (const doc of docs || []) {
    if (!doc || typeof doc.content !== 'string') continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(doc.content))) ids.add(m[1]);
  }
  return ids;
}

/** 改密时用新密钥重加密全部资产。先写临时文件再改名，避免半截文件。 */
async function reEncryptAssets(oldKey, newKey) {
  await ensureDir(ASSETS_DIR);
  const names = await readdir(ASSETS_DIR);
  for (const name of names) {
    if (!ASSET_ID_RE.test(name)) continue;
    const full = path.join(ASSETS_DIR, name);
    let buf;
    try { buf = await readFile(full); } catch { continue; }
    const dec = decryptAsset(buf, oldKey);
    if (!dec) continue;
    const tmp = `${full}.tmp`;
    await writeFile(tmp, encryptAsset(dec.bytes, dec.mime, newKey));
    await rename(tmp, full);
  }
}

/* ---------------- 密码 / 会话 ---------------- */

/** 返回 {format:'new', blob} | {format:'old', auth} | null */
async function loadAuth() {
  await ensureDir(path.dirname(AUTH_FILE));
  let raw;
  try { raw = await readFile(AUTH_FILE, 'utf8'); } catch { return null; }
  const blob = parseBlob(raw);
  if (blob) return { format: 'new', blob };
  try {
    const a = JSON.parse(raw);
    if (a && a.hash && a.salt) return { format: 'old', auth: a };
  } catch { /* ignore */ }
  return null;
}

async function writeAuthVerifier(key, salt) {
  await ensureDir(path.dirname(AUTH_FILE));
  await writeFile(AUTH_FILE, encryptBlob(SENTINEL, key, salt), 'utf8');
  try { await chmod(AUTH_FILE, 0o600); } catch { /* Windows 忽略 */ }
}

function hashPw(password, salt) {
  return scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
}

/** 校验登录密码。成功返回派生 key（新版）或 'legacy'（旧版哈希，需迁移）；失败返回 null。 */
function verifyAuth(password, loaded) {
  if (!loaded) return null;
  if (loaded.format === 'new') {
    let key;
    try { key = deriveKey(password, Buffer.from(loaded.blob.salt, 'hex'), loaded.blob.params); } catch { return null; }
    const dec = decryptBlobWith(JSON.stringify(loaded.blob), key);
    if (dec === SENTINEL) return key;
    return null;
  }
  // 旧版哈希校验
  const a = loaded.auth;
  const salt = Buffer.from(a.salt, 'hex');
  const expected = Buffer.from(a.hash, 'hex');
  let actual;
  try { actual = hashPw(password, salt); } catch { return null; }
  if (actual.length !== expected.length) return null;
  try { if (timingSafeEqual(actual, expected)) return 'legacy'; } catch { return null; }
  return null;
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
  if (!currentKey) return null; // 尚未登录加载数据，跳过
  await ensureDir(BACKUP_DIR);
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const name = `ledger-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.enc`;
  const dest = path.join(BACKUP_DIR, name);
  /* 备份必须连图片资产一起打包，否则恢复后正文引用的图片会丢失。 */
  const assets = [];
  for (const id of collectAssetIds(db.docs)) {
    const a = await readAsset(id, currentKey);
    if (a) assets.push({ id, mime: a.mime, data: a.bytes.toString('base64') });
  }
  const payload = { docs: db.docs, assets };
  await writeFile(dest, encryptBlob(payload, currentKey, currentSalt), 'utf8');
  const list = await listBackups();
  for (const old of list.slice(BACKUP_KEEP)) {
    try { await unlink(path.join(BACKUP_DIR, old.name)); } catch { /* ignore */ }
  }
  return name;
}

async function restoreBackup(name) {
  const full = safeBackupPath(name);
  if (!full) throw new Error('非法的备份文件名');
  if (!currentPassword) throw new Error('尚未登录，无法解密备份');
  const raw = await readFile(full, 'utf8');
  const decrypted = decryptBlob(raw, currentPassword);
  if (!decrypted || decrypted.__decryptError || !Array.isArray(decrypted.docs)) {
    throw new Error('备份文件无法解密（可能是更换密码前的旧备份，已失效）');
  }
  /* 先恢复图片资产，再切换文档数据，避免正文引用到不存在的图片。 */
  if (Array.isArray(decrypted.assets) && currentKey) {
    for (const a of decrypted.assets) {
      if (!a || !assetPath(a.id)) continue;
      if (await readAsset(a.id, currentKey)) continue; // 已存在则跳过
      const bytes = Buffer.from(String(a.data || ''), 'base64');
      if (bytes.length) await writeAsset(a.id, bytes, a.mime, currentKey);
    }
  }
  db = { docs: decrypted.docs };
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
  db.docs.push({ id: yearId, parent_id: rootId, name: '2026年', kind: 'doc', content: '', sort: 2, created_at: now, updated_at: now });
  for (let month = 1; month <= 12; month += 1) {
    db.docs.push(make(yearId, `2026年${month}月`, 'doc', month === 11 ? SAMPLE_NOVEMBER : '', month));
  }
}

async function readLedgerRaw() {
  try { return await readFile(DATA_FILE, 'utf8'); } catch { return null; }
}

/**
 * 目录结构整理：只保留顶级笔记本为目录（folder），其余目录一律转为页面（doc）。
 * 页面仍可拥有子页面，因此「2026年」这类中间层会变成可打开的页面。
 * 返回是否发生改动。
 */
function normalizeLayout() {
  let changed = 0;
  for (const doc of db.docs) {
    if (doc.kind === 'folder' && doc.parent_id) { doc.kind = 'doc'; changed += 1; }
  }
  if (changed) console.log(`[my-jizhang] 已将 ${changed} 个多级目录转为页面（仅保留顶级笔记本为目录）。`);
  return changed > 0;
}

function ledgerFormat(raw) {
  if (!raw) return 'empty';
  if (parseBlob(raw)) return 'new';
  let parsed;
  try { parsed = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { return 'unknown'; }
  if (parsed && parsed.iv && parsed.tag && parsed.data && parsed.v !== BLOB_VERSION) return 'old-master';
  if (parsed && Array.isArray(parsed.docs)) return 'plaintext';
  return 'unknown';
}

/** 登录成功后调用：用密码把数据加载进内存。新格式直接解密；旧格式/空库则迁移或 seed。 */
async function ensureStoreLoaded(password) {
  if (storeLoaded) return;
  await ensureDir(DATA_DIR);
  const raw = await readLedgerRaw();
  const fmt = ledgerFormat(raw);

  if (fmt === 'new') {
    const blob = parseBlob(raw);
    let key;
    try { key = deriveKey(password, Buffer.from(blob.salt, 'hex'), blob.params); } catch { throw new Error('密钥派生失败'); }
    const dec = decryptBlobWith(raw, key);
    if (!dec || dec.__decryptError) throw new Error('数据解密失败：密码不匹配');
    if (!Array.isArray(dec.docs)) throw new Error('数据文件格式损坏');
    db = dec;
    currentKey = key;
    currentSalt = Buffer.from(blob.salt, 'hex');
    currentPassword = password;
    storeLoaded = true;
    /* 旧数据里的多级目录统一转为页面，只保留顶级笔记本 */
    if (normalizeLayout()) await persist();
    // 若 auth 仍是旧哈希格式，顺手迁到哨兵格式（与 ledger 同 salt/key）
    const loadedAuth = await loadAuth();
    if (loadedAuth && loadedAuth.format !== 'new') {
      await writeAuthVerifier(currentKey, currentSalt);
    }
    return;
  }

  // 迁移 / 首次 seed
  let migrated = false;
  if (fmt === 'old-master') {
    const dec = await decryptLegacyMaster(raw);
    if (dec && Array.isArray(dec.docs)) { db = dec; migrated = true; }
    else throw new Error('旧数据无法用 master.key 解密（master.key 可能丢失或不匹配）');
  } else if (fmt === 'plaintext') {
    db = JSON.parse(raw.replace(/^\uFEFF/, ''));
    migrated = true;
  } else {
    db = { docs: [] };
    seed();
    migrated = true;
  }

  const newSalt = randomBytes(16);
  const newKey = deriveKey(password, newSalt);
  currentKey = newKey;
  currentSalt = newSalt;
  currentPassword = password;
  storeLoaded = true;
  normalizeLayout();
  await persist(); // 用新密钥重新加密落盘
  await writeAuthVerifier(newKey, newSalt);
  // 迁移成功后删除 master.key，数据自此仅与登录密码绑定
  try { await unlink(KEY_FILE); } catch { /* 不存在则忽略 */ }
  if (migrated && fmt !== 'empty') {
    try { await audit('migrate', { from: fmt }, null); } catch { /* ignore */ }
    console.log('[my-jizhang] 数据已迁移到「密码自加密」模式，master.key 已删除。请牢记登录密码——它是唯一解密凭证。');
  } else if (fmt === 'empty') {
    console.log('[my-jizhang] 首次使用已初始化示例数据。请牢记登录密码——它是唯一解密凭证。');
  }
  // 加载/迁移完成后做一次启动备份
  try { await createBackup(); } catch (e) { console.error('[my-jizhang] 启动备份失败：', e.message); }
}

function persist() {
  if (!currentKey) return persistChain; // 数据未加载（未登录），忽略写入
  const snapshot = encryptBlob(db, currentKey, currentSalt);
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
  return JSON.parse(await readBodyText(req, limit));
}

async function readBodyText(req, limit = BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (limit > 0 && size > limit) {
      const err = new Error(`请求内容过大：${(size / 1024 / 1024).toFixed(1)}MB > 限制 ${(limit / 1024 / 1024).toFixed(0)}MB`);
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return '';
  return Buffer.concat(chunks).toString('utf8');
}

/** 读取原始二进制请求体（图片上传用）。 */
async function readBodyBuffer(req, limit = BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (limit > 0 && size > limit) {
      const err = new Error(`图片内容过大：${(size / 1024 / 1024).toFixed(1)}MB > 限制 ${(limit / 1024 / 1024).toFixed(0)}MB`);
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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

/** 导入文件中的顶层节点：父节点不在这批导入数据里。 */
function importRootsOf(valid) {
  const ids = new Set(valid.map((d) => d.id));
  return valid.filter((d) => !d.parent_id || !ids.has(d.parent_id));
}

/** 预检：导入到 parentId 时，顶层节点与现有子页面重名的列表。 */
function importConflicts(docs, parentId) {
  const valid = (docs || []).filter((d) => d && d.id && d.name);
  const names = new Set(importRootsOf(valid).map((d) => String(d.name).trim()).filter(Boolean));
  if (!names.size) return [];
  return db.docs
    .filter((d) => (d.parent_id || null) === (parentId || null) && names.has(d.name))
    .map((d) => d.name);
}

/**
 * 在服务端构建导入树，落到指定父节点下。
 * opts.parentId：目标目录/页面 id（null 表示顶级）。
 * opts.overwrite：同名顶层页面是否覆盖（删除原页面子树后重新导入）。
 * 返回 { count, names }。
 */
function importDocsIntoDb(docs, opts) {
  const o = opts || {};
  const parentId = o.parentId || null;
  const overwrite = !!o.overwrite;
  const valid = (docs || []).filter((d) => d && d.id && d.name);
  if (!valid.length) throw new Error('文件中没有可导入的文档');
  if (parentId && !db.docs.some((d) => d.id === parentId)) throw new Error('导入位置不存在');

  const roots = importRootsOf(valid);
  const names = roots.map((d) => String(d.name).trim()).filter(Boolean);
  const conflicts = names.length
    ? db.docs.filter((d) => (d.parent_id || null) === parentId && names.includes(d.name))
    : [];
  if (conflicts.length && !overwrite) {
    const err = new Error('同名页面已存在');
    err.code = 'IMPORT_CONFLICT';
    err.conflicts = conflicts.map((d) => d.name);
    throw err;
  }
  if (conflicts.length) {
    const doomed = new Set();
    for (const doc of conflicts) for (const id of collectIds(doc.id)) doomed.add(id);
    db.docs = db.docs.filter((d) => !doomed.has(d.id));
  }

  const iso = new Date().toISOString();
  const importedIds = new Set(valid.map((d) => d.id));
  const depthOf = (id) => {
    let depth = 0;
    let cur = id;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const doc = valid.find((x) => x.id === cur);
      if (!doc) break;
      cur = doc.parent_id;
      depth += 1;
    }
    return depth;
  };
  valid.sort((a, b) => depthOf(a.id) - depthOf(b.id));

  const siblings = db.docs.filter((d) => (d.parent_id || null) === parentId);
  let sort = siblings.length ? Math.max(...siblings.map((d) => d.sort || 0)) + 1 : 1;
  const idMap = {};
  for (const d of valid) {
    const newId = randomUUID();
    idMap[d.id] = newId;
    const isRoot = !d.parent_id || !importedIds.has(d.parent_id);
    const parent = isRoot ? parentId : (idMap[d.parent_id] || parentId);
    /* 导入到某个节点下时全部作为页面；只有顶级且原为目录时才保留目录 */
    const kind = (isRoot && !parentId && d.kind === 'folder') ? 'folder' : 'doc';
    db.docs.push({
      id: newId, parent_id: parent, name: String(d.name),
      kind,
      content: typeof d.content === 'string' ? d.content : '',
      sort: isRoot ? sort++ : (typeof d.sort === 'number' ? d.sort : 0),
      created_at: d.created_at || iso, updated_at: d.updated_at || iso,
    });
  }
  return { count: valid.length, names };
}

/* ---------------- 启动前初始化 ---------------- */

async function boot() {
  await ensureDir(DATA_DIR);

  // 若指定了 INIT_PASSWORD 且尚未设置密码，预写 auth（数据仍惰性加载，首次登录时 seed）
  const auth = await loadAuth();
  const initPw = process.env.INIT_PASSWORD;
  if (!auth && initPw && initPw.trim()) {
    const pw = initPw.trim();
    const salt = randomBytes(16);
    await writeAuthVerifier(deriveKey(pw, salt), salt);
    console.log('[my-jizhang] 已使用 INIT_PASSWORD 设置登录密码（首次登录时初始化数据）。');
  } else if (!auth) {
    console.log('[my-jizhang] 尚未设置登录密码，请打开登录页设置初始密码（或用环境变量 INIT_PASSWORD 指定）。');
  }

  setInterval(() => {
    if (!currentKey) return;
    createBackup().then((n) => n && audit('backup.auto', { name: n })).catch((e) => console.error('[my-jizhang] 自动备份失败：', e.message));
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
  if (pathname === '/api/setup' && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: '非法来源' });
    if (await loadAuth()) return sendJson(res, 400, { error: '已设置过密码，请直接登录' });
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: '请求无效' }); }
    const pw = String(body.password || '');
    if (pw.length < 6) return sendJson(res, 400, { error: '密码至少 6 位' });
    const salt = randomBytes(16);
    const key = deriveKey(pw, salt);
    await writeAuthVerifier(key, salt);
    currentKey = null; currentSalt = null; currentPassword = null; storeLoaded = false;
    try {
      await ensureStoreLoaded(pw); // 首次 seed + 加密落盘
    } catch (e) {
      return sendJson(res, 500, { error: '初始化数据失败：' + e.message });
    }
    const token = createSession();
    res.setHeader('set-cookie', cookieHeader(token, SESSION_TTL));
    await audit('setup', null, req);
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/login' && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: '非法来源' });
    const ip = clientIp(req);
    const fail = loginFails.get(ip);
    if (fail && fail.until > Date.now()) {
      await audit('login.fail', { reason: 'locked' }, req);
      return sendJson(res, 429, { error: '尝试过于频繁，请稍后再试' });
    }
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: '请求无效' }); }
    const loaded = await loadAuth();
    const ok = !!loaded && verifyAuth(body.password, loaded);
    if (ok) {
      try {
        await ensureStoreLoaded(body.password);
      } catch (e) {
        await audit('login.fail', { reason: 'load_error', error: e.message }, req);
        return sendJson(res, 400, { error: e.message || '数据加载失败' });
      }
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
    const loaded = await loadAuth();
    if (!loaded || !verifyAuth(body.old, loaded)) {
      await audit('password.change', { ok: false, reason: 'old_mismatch' }, req);
      return sendJson(res, 400, { error: '旧密码不正确' });
    }
    const np = String(body.new || '');
    if (np.length < 6) return sendJson(res, 400, { error: '新密码至少 6 位' });
    if (np === String(body.old || '')) return sendJson(res, 400, { error: '新密码不能与旧密码相同' });
    // 用新密码重新派生密钥，重新加密数据文件 + 重写 auth 哨兵
    const newSalt = randomBytes(16);
    const newKey = deriveKey(np, newSalt);
    /* 图片资产也用同一把密钥加密，换密码必须先重加密，否则旧资产无法解密。 */
    if (currentKey) {
      try {
        await reEncryptAssets(currentKey, newKey);
      } catch (e) {
        await audit('password.change', { ok: false, reason: 'asset_reencrypt', error: e.message }, req);
        return sendJson(res, 500, { error: '图片资产重新加密失败：' + e.message });
      }
    }
    currentKey = newKey;
    currentSalt = newSalt;
    currentPassword = np;
    await persist(); // 用新密钥重写 ledger.json
    await writeAuthVerifier(newKey, newSalt);
    const token = getSession(req);
    invalidateOtherSessions(token); // 其它设备需用新密码重新登录
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

async function handleAssets(req, res, pathname) {
  // 上传：请求体就是图片原始字节，Content-Type 声明图片类型
  if (pathname === '/api/assets' && req.method === 'POST') {
    if (!currentKey) return sendJson(res, 503, { error: '数据尚未加载' });
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!/^image\//.test(mime)) return sendJson(res, 400, { error: '仅支持图片文件' });
    let bytes;
    try {
      bytes = await readBodyBuffer(req, ASSET_LIMIT);
    } catch (e) {
      if (e.code === 'PAYLOAD_TOO_LARGE') {
        return sendJson(res, 413, { error: `图片过大，单张上限 ${Math.round(ASSET_LIMIT / 1024 / 1024)}MB` });
      }
      throw e;
    }
    if (!bytes || !bytes.length) return sendJson(res, 400, { error: '图片内容为空' });
    const id = randomUUID();
    await writeAsset(id, bytes, mime, currentKey);
    await audit('asset.create', { id, bytes: bytes.length, mime }, req);
    return sendJson(res, 201, { ok: true, id, url: `/api/assets/${id}` });
  }

  // 读取：浏览器 <img src> 直接请求，走同源 Cookie 鉴权
  const matched = pathname.match(/^\/api\/assets\/([0-9a-f-]{36})$/);
  if (matched && req.method === 'GET') {
    if (!currentKey) return sendJson(res, 503, { error: '数据尚未加载' });
    const asset = await readAsset(matched[1], currentKey);
    if (!asset) return sendJson(res, 404, { error: '图片不存在' });
    res.writeHead(200, {
      'content-type': asset.mime,
      'content-length': asset.bytes.length,
      /* id 内容不可变，可长期缓存，减少手机端重复解码与流量 */
      'cache-control': 'private, max-age=31536000, immutable',
    });
    res.end(asset.bytes);
    return true;
  }
  return null;
}

async function handleExtra(req, res, pathname) {
  // 导出：?id=xxx 导出该节点子树；不带 id 导出全部。输出加密包。
  if (pathname === '/api/export' && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const rootId = url.searchParams.get('id');
    let ids = null;
    if (rootId) {
      if (!db.docs.some((d) => d.id === rootId)) return sendJson(res, 404, { error: '节点不存在' });
      ids = collectIds(rootId);
    }
    const docs = ids ? db.docs.filter((d) => ids.includes(d.id)) : db.docs;
    /* 导出必须带上正文引用的图片资产，否则换机器导入后图片全是坏链。 */
    const assets = [];
    if (currentKey) {
      for (const id of collectAssetIds(docs)) {
        const a = await readAsset(id, currentKey);
        if (a) assets.push({ id, mime: a.mime, data: a.bytes.toString('base64') });
      }
    }
    const payload = {
      app: 'my-jizhang',
      version: BLOB_VERSION,
      exported_at: new Date().toISOString(),
      docs,
      assets,
    };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const blob = encryptBlob(payload, currentKey, currentSalt);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="my-jizhang-export-${stamp}.json"`,
    });
    res.end(blob);
    await audit('export', { id: rootId || null, count: docs.length }, req);
    return true;
  }

  // 导入：上传加密导出文件，服务端用当前登录密码解密后建目录树
  // ?parent_id=xxx 指定落点（目录或页面），?mode=overwrite 表示同名覆盖
  if (pathname === '/api/import' && req.method === 'POST') {
    const iu = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const parentId = iu.searchParams.get('parent_id') || null;
    const overwrite = iu.searchParams.get('mode') === 'overwrite';
    let text;
    try { text = await readBodyText(req); } catch { return sendJson(res, 400, { error: '读取文件失败' }); }
    if (!currentPassword) return sendJson(res, 401, { error: '未登录' });
    let parsed = null;
    const dec = decryptBlob(text, currentPassword);
    if (dec && !dec.__decryptError) {
      parsed = dec;
    } else {
      // 兼容旧版明文导出（{docs:[...]}），无加密
      try {
        const obj = JSON.parse(text);
        if (obj && Array.isArray(obj.docs)) parsed = obj;
      } catch { /* ignore */ }
    }
    if (!parsed || !Array.isArray(parsed.docs)) {
      return sendJson(res, 400, { error: '无法解密：该文件可能由不同密码加密，或文件已损坏' });
    }
    /* 先预检同名冲突，避免用户取消覆盖时白写图片资产 */
    const conflicts = importConflicts(parsed.docs, parentId);
    if (conflicts.length && !overwrite) {
      return sendJson(res, 409, { error: '同名页面已存在', conflicts });
    }
    /* 先落盘导入文件里的图片资产（同 id 已存在时跳过），再建文档树。 */
    if (Array.isArray(parsed.assets) && currentKey) {
      for (const a of parsed.assets) {
        if (!a || !assetPath(a.id)) continue;
        if (await readAsset(a.id, currentKey)) continue;
        const bytes = Buffer.from(String(a.data || ''), 'base64');
        if (bytes.length) await writeAsset(a.id, bytes, a.mime, currentKey);
      }
    }
    let result;
    try {
      result = importDocsIntoDb(parsed.docs, { parentId, overwrite });
    } catch (e) {
      if (e.code === 'IMPORT_CONFLICT') return sendJson(res, 409, { error: e.message, conflicts: e.conflicts });
      return sendJson(res, 400, { error: e.message });
    }
    await persist();
    await audit('import', { count: result.count, parent: parentId, overwrite }, req);
    return sendJson(res, 200, { ok: true, count: result.count, names: result.names });
  }

  if (pathname === '/api/backup' && req.method === 'POST') {
    const name = await createBackup();
    if (!name) return sendJson(res, 503, { error: '数据尚未加载' });
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
      const ra = await handleAssets(req, res, pathname);
      if (ra !== null) return;
      const r2 = await handleExtra(req, res, pathname);
      if (r2 !== null && r2 !== true) return; // r2===true 表示已自行结束响应
      if (r2 === true) return;
      return sendJson(res, 404, { error: '接口不存在' });
    }

    await serveStatic(res, pathname, authed);
  } catch (err) {
    if (err && err.code === 'PAYLOAD_TOO_LARGE') {
      console.warn('[my-jizhang]', err.message, '|', req.method, req.url);
      if (!res.headersSent) return sendJson(res, 413, { error: '文档过大（图片过多或过大），请删除或压缩部分图片后再保存' });
      return res.end();
    }
    console.error('[my-jizhang] 请求处理失败：', err);
    if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
    else res.end();
  }
});

await boot();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[my-jizhang] 已启动：http://0.0.0.0:${PORT}  数据目录：${DATA_DIR}`);
  console.log(`[my-jizhang] 请求体上限：${BODY_LIMIT > 0 ? BODY_LIMIT_MB + 'MB（可用环境变量 BODY_LIMIT_MB 调整）' : '不限制（设 BODY_LIMIT_MB 可按需收紧）'}`);
  console.log('[my-jizhang] 加密模式：密码自加密（无 master.key）。登录密码是唯一解密凭证，请妥善保管。');
});
