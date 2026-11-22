/**
 * my-jizhang 家庭记账本服务端
 * 零依赖：仅使用 Node 内置模块，数据以 JSON 文件保存在挂载卷中。
 * 适用于 ARM64 路由器 / NAS 等小内存设备。
 */
import { createServer } from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT_DIR, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'ledger.json');
const PORT = Number(process.env.PORT || 8080);

let db = { docs: [] };
let persistChain = Promise.resolve();

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
  '<p class="day-label">11月1日</p>',
  '<p>工资卡取款，存入 3900 元。</p>',
  '<div class="money-block income" data-type="income" contenteditable="false">',
  '<span class="money-badge">收入</span>',
  '<label class="money-field">内容<input class="money-desc" value="工资卡取款" placeholder="如：工资"></label>',
  '<label class="money-field">金额<input class="money-amount" type="number" step="0.01" min="0" value="3900" placeholder="0.00"></label>',
  '<span class="money-unit">元</span>',
  '<button class="money-del" type="button" title="删除">×</button>',
  '</div>',
  '<p class="day-label">11月2日</p>',
  '<p>就餐食品费。</p>',
  '<div class="money-block expense" data-type="expense" contenteditable="false">',
  '<span class="money-badge">支出</span>',
  '<label class="money-field">内容<input class="money-desc" value="就餐食品费" placeholder="如：买菜"></label>',
  '<label class="money-field">金额<input class="money-amount" type="number" step="0.01" min="0" value="300" placeholder="0.00"></label>',
  '<span class="money-unit">元</span>',
  '<button class="money-del" type="button" title="删除">×</button>',
  '</div>',
  '<div class="total-block" contenteditable="false">',
  '<span class="total-title">本月合计</span>',
  '<span class="total-item">收入 <b class="total-income">¥0.00</b></span>',
  '<span class="total-item">支出 <b class="total-expense">¥0.00</b></span>',
  '<span class="total-item">结余 <b class="total-balance">¥0.00</b></span>',
  '</div>',
  '<p></p>',
].join('');

function seed() {
  const now = new Date().toISOString();
  const make = (parent, name, kind, content, sort) => ({
    id: randomUUID(),
    parent_id: parent,
    name,
    kind,
    content,
    sort,
    created_at: now,
    updated_at: now,
  });

  const rootId = randomUUID();
  db.docs.push({
    id: rootId,
    parent_id: null,
    name: '我的笔记本',
    kind: 'folder',
    content: '',
    sort: 0,
    created_at: now,
    updated_at: now,
  });
  db.docs.push(make(rootId, 'daily note', 'doc', '<p>随手记点什么。</p>', 1));

  const yearId = randomUUID();
  db.docs.push({
    id: yearId,
    parent_id: rootId,
    name: '2026年',
    kind: 'folder',
    content: '',
    sort: 2,
    created_at: now,
    updated_at: now,
  });
  for (let month = 1; month <= 12; month += 1) {
    const name = `2026年${month}月`;
    db.docs.push(make(yearId, name, 'doc', month === 11 ? SAMPLE_NOVEMBER : '', month));
  }
}

async function initStore() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.docs)) db = parsed;
  } catch {
    db = { docs: [] };
  }
  if (db.docs.length === 0) {
    seed();
    await persist();
  }
}

function persist() {
  const snapshot = JSON.stringify(db, null, 2);
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
    id: doc.id,
    parent_id: doc.parent_id,
    name: doc.name,
    kind: doc.kind,
    sort: doc.sort,
    updated_at: doc.updated_at,
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

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limit = 25 * 1024 * 1024) {
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

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health') return sendJson(res, 200, { ok: true });

  if (pathname === '/api/docs') {
    if (req.method === 'GET') return sendJson(res, 200, db.docs.map(meta));

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
      const sort = siblings.length
        ? Math.max(...siblings.map((doc) => doc.sort || 0)) + 1
        : 1;
      const now = new Date().toISOString();
      const doc = {
        id: randomUUID(),
        parent_id: parent,
        name,
        kind,
        content: typeof body.content === 'string' ? body.content : '',
        sort,
        created_at: now,
        updated_at: now,
      };
      db.docs.push(doc);
      await persist();
      return sendJson(res, 201, meta(doc));
    }
    return sendJson(res, 405, { error: '不支持的请求方法' });
  }

  const matched = pathname.match(/^\/api\/docs\/([^/]+)$/);
  if (matched) {
    const id = decodeURIComponent(matched[1]);
    const doc = db.docs.find((item) => item.id === id);
    if (!doc) return sendJson(res, 404, { error: '文档不存在' });

    if (req.method === 'GET') return sendJson(res, 200, doc);

    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (typeof body.name === 'string' && body.name.trim()) doc.name = body.name.trim();
      if (typeof body.content === 'string') doc.content = body.content;
      if (body.parent_id !== undefined) {
        const nextParent = body.parent_id || null;
        if (nextParent && !db.docs.some((item) => item.id === nextParent)) {
          return sendJson(res, 400, { error: '父节点不存在' });
        }
        doc.parent_id = nextParent;
      }
      doc.updated_at = new Date().toISOString();
      await persist();
      return sendJson(res, 200, meta(doc));
    }

    if (req.method === 'DELETE') {
      if (doc.kind === 'folder' && !doc.parent_id && db.docs.filter((item) => item.kind === 'folder' && !item.parent_id).length <= 1) {
        return sendJson(res, 400, { error: '不能删除唯一的顶级目录' });
      }
      const doomed = collectIds(id);
      db.docs = db.docs.filter((item) => !doomed.includes(item.id));
      await persist();
      return sendJson(res, 200, { deleted: doomed });
    }
    return sendJson(res, 405, { error: '不支持的请求方法' });
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const full = path.resolve(PUBLIC_DIR, relative);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: '禁止访问' });
  }
  try {
    const buf = await readFile(full);
    res.writeHead(200, {
      'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'cache-control': pathname === '/' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

await initStore();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url.pathname);
    } else {
      await serveStatic(res, url.pathname);
    }
  } catch (err) {
    console.error('[my-jizhang] 请求处理失败：', err);
    if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
    else res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[my-jizhang] 已启动：http://0.0.0.0:${PORT}  数据目录：${DATA_DIR}`);
});
