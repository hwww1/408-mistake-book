import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(APP_ROOT, 'public');
const USER_PROFILE = process.env.USERPROFILE || 'C:\\Users\\Administrator';
const ONEDRIVE_ROOT = process.env.OneDrive || path.join(USER_PROFILE, 'OneDrive');
const DATA_ROOT = process.env.CS408_ASSISTANT_DATA || path.join(ONEDRIVE_ROOT, '408AI错题助手数据');
const LIBRARY_ROOT = process.env.CS408_ASSISTANT_LIBRARY || 'D:\\408\\按章节整理';
const PORT = Number(process.env.CS408_ASSISTANT_PORT || 4184);
const HOST = '127.0.0.1';
const SNAPSHOT_PATH = path.join(DATA_ROOT, 'mistakes.snapshot.json');
const PREVIOUS_SNAPSHOT_PATH = path.join(DATA_ROOT, 'mistakes.snapshot.previous.json');
const MAX_BODY = 160 * 1024 * 1024;

for (const directory of [DATA_ROOT]) fs.mkdirSync(directory, { recursive: true });

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.ico': 'image/x-icon',
};

function corsHeaders(req) {
  const origin = req.headers.origin || '';
  const allowed = origin === 'https://hwww1.github.io' || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  return allowed ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Vary': 'Origin',
  } : {};
}

function sendJson(req, res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...corsHeaders(req),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendFile(req, res, filePath, cache = 'no-cache') {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return sendJson(req, res, 404, { error: '文件不存在' });
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    ...corsHeaders(req),
    'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cache,
  });
  fs.createReadStream(filePath).pipe(res);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('同步内容超过 160MB，请减少单次图片数量'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('请求数据格式无效')); }
    });
    req.on('error', reject);
  });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, filePath);
}

function readSnapshot() {
  try {
    const value = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    if (value?.format === '408-mistake-book-sync') return value;
  } catch {}
  return { format: '408-mistake-book-sync', updatedAt: new Date(0).toISOString(), mistakes: [], deletedIds: {} };
}

function recordTime(record) {
  return String(record?.updatedAt || record?.createdAt || '');
}

function mergeSnapshots(first, second) {
  const records = new Map();
  const deletedIds = { ...(first.deletedIds || {}), ...(second.deletedIds || {}) };
  for (const record of [...(first.mistakes || []), ...(second.mistakes || [])]) {
    if (!record?.id || !record?.imageDataUrl) continue;
    const existing = records.get(record.id);
    if (!existing || recordTime(record) >= recordTime(existing)) records.set(record.id, record);
  }
  for (const [id, deletedAt] of Object.entries(deletedIds)) {
    const record = records.get(id);
    if (record && String(deletedAt) >= recordTime(record)) records.delete(id);
  }
  return {
    format: '408-mistake-book-sync',
    updatedAt: new Date().toISOString(),
    mistakes: [...records.values()].sort((a, b) => recordTime(b).localeCompare(recordTime(a))),
    deletedIds,
  };
}

function saveSnapshot(snapshot) {
  if (fs.existsSync(SNAPSHOT_PATH)) fs.copyFileSync(SNAPSHOT_PATH, PREVIOUS_SNAPSHOT_PATH);
  writeJson(SNAPSHOT_PATH, snapshot);
}

function walkPdfs() {
  if (!fs.existsSync(LIBRARY_ROOT)) return [];
  const files = [];
  const stack = [LIBRARY_ROOT];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.toLowerCase().endsWith('.pdf')) {
        files.push({ name: entry.name, path: path.relative(LIBRARY_ROOT, full).split(path.sep).join('/'), size: fs.statSync(full).size });
      }
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
}

function resolveLibraryFile(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  const candidate = path.resolve(LIBRARY_ROOT, normalized);
  const root = path.resolve(LIBRARY_ROOT);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error('PDF 路径无效');
  if (path.extname(candidate).toLowerCase() !== '.pdf') throw new Error('只允许读取 PDF');
  return candidate;
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }
  if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(req, res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/api/status') {
    const items = walkPdfs();
    return sendJson(req, res, 200, {
      ok: true,
      connected: true,
      auth: { connected: true, label: '普通 ChatGPT 模式，不调用 Codex' },
      dataRoot: DATA_ROOT,
      libraryRoot: LIBRARY_ROOT,
      libraryCount: items.length,
      oneDrive: path.resolve(DATA_ROOT).toLowerCase().startsWith(path.resolve(ONEDRIVE_ROOT).toLowerCase()),
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/library') return sendJson(req, res, 200, { items: walkPdfs(), libraryRoot: LIBRARY_ROOT });
  if (req.method === 'GET' && url.pathname === '/api/pdf') {
    try { return sendFile(req, res, resolveLibraryFile(url.searchParams.get('path')), 'private, max-age=3600'); }
    catch (error) { return sendJson(req, res, 400, { error: error.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/sync') {
    const incoming = await readJson(req);
    if (incoming?.format !== '408-mistake-book-sync') return sendJson(req, res, 400, { error: '同步数据格式无效' });
    const merged = mergeSnapshots(readSnapshot(), incoming);
    saveSnapshot(merged);
    return sendJson(req, res, 200, merged);
  }
  return sendJson(req, res, 404, { error: '接口不存在' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    const publicPath = url.pathname.startsWith('/408-mistake-book/')
      ? url.pathname.slice('/408-mistake-book/'.length)
      : url.pathname.slice(1);
    const requested = url.pathname === '/' || !publicPath ? 'index.html' : decodeURIComponent(publicPath);
    let filePath = path.resolve(PUBLIC_ROOT, requested);
    const publicRoot = path.resolve(PUBLIC_ROOT);
    if (!filePath.startsWith(`${publicRoot}${path.sep}`) && filePath !== path.join(publicRoot, 'index.html')) return sendJson(req, res, 403, { error: '路径无效' });
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(publicRoot, 'index.html');
    return sendFile(req, res, filePath);
  } catch (error) {
    return sendJson(req, res, 500, { error: error.message || '本地助手发生错误' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`408 AI 错题助手已启动：http://${HOST}:${PORT}`);
  console.log(`OneDrive 同步目录：${DATA_ROOT}`);
  console.log(`本机练习册：${LIBRARY_ROOT}`);
});
