const http = require('http');
const crypto = require('crypto');
const { log } = require('./util');

function sendJson(res, code, obj) {
  if (res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** Читает тело запроса целиком (с лимитом) и вызывает cb(buffer). */
function readBody(req, res, limit, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { sendJson(res, 413, { ok: false, error: 'too large' }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => { if (!res.writableEnded) cb(Buffer.concat(chunks)); });
  req.on('error', () => {});
}

/** Один HTTP-сервер для всего: приём статистики, ретранслятор вебхуков и т.д. */
function startHttpServer(cfg, handlers) {
  const hc = cfg.http || {};
  const port = Number(process.env.PORT) || hc.port || cfg.playtime?.httpPort || 8080;
  const host = hc.host || cfg.playtime?.httpHost || '0.0.0.0';
  const list = handlers.filter(Boolean);

  const server = http.createServer((req, res) => {
    let path = (req.url || '').split('?')[0];
    try { path = decodeURIComponent(path); } catch { /* оставляем как есть */ }
    if (req.method === 'GET' && (path === '/' || path === '/api/health')) return sendJson(res, 200, { ok: true });
    try {
      for (const h of list) if (h(req, res, path)) return;
    } catch (e) {
      log('[http] ошибка обработчика:', e);
      return sendJson(res, 500, { ok: false, error: 'internal' });
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
  });
  server.requestTimeout = 60_000;
  server.on('error', (e) => log('[http] сервер:', e.message));
  server.listen(port, host, () => log(`[http] слушаю http://${host}:${port}`));
  return server;
}

/** Проверка заголовка Authorization: Bearer <secret> (или X-Secret). */
function makeAuth(secret) {
  const want = Buffer.from(String(secret || ''));
  return (req) => {
    if (!want.length) return false;
    const h = String(req.headers.authorization || '');
    const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : String(req.headers['x-secret'] || ''));
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  };
}

module.exports = { startHttpServer, sendJson, readBody, makeAuth };
