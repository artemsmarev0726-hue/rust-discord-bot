const crypto = require('crypto');
const { log, JsonStore } = require('./util');
const { sendJson, readBody } = require('./http');

/**
 * Ретранслятор вебхуков Discord.
 *
 * Rust-сервер в РФ шлёт вебхук не на discord.com, а боту (хостинг вне РФ):
 *   было:  https://discord.com/api/webhooks/ID/TOKEN
 *   стало: http://IP_БОТА:8080/<relay.secret>/api/webhooks/ID/TOKEN
 *
 * Бот сразу отвечает 204, кладёт сообщение в очередь на диске (data/relay-queue.json)
 * и сам доставляет его в Discord: с соблюдением rate-limit, повторами и сохранением порядка
 * (отдельно для каждого вебхука). Плагины менять не нужно — только адрес вебхука в конфиге.
 *
 * GET-запросы и запросы с ?wait=true проксируются сразу (плагину нужен ответ Discord).
 */

const DISCORD = process.env.RELAY_TARGET || 'https://discord.com'; // RELAY_TARGET — только для тестов
const MAX_BODY = 25 * 1024 * 1024; // вложения тоже пролезут
const PATH_RE = /^\/([^/]+)\/api(?:\/v\d+)?\/webhooks\/(\d{5,25})\/([A-Za-z0-9_-]{10,200})(\/[^?]*)?$/;
const DROP_CODES = new Set([400, 401, 403, 404, 405, 413]);

class WebhookRelay {
  constructor(cfg) {
    const rc = cfg.relay || {};
    this.rc = rc;
    this.secret = String(rc.secret || '');
    this.allowedIps = new Set((rc.allowedIps || []).map(String));
    this.trustProxy = cfg.http?.trustProxy !== false;
    this.allowedIds = new Set((rc.allowedWebhookIds || []).map(String));
    this.maxQueue = rc.maxQueue ?? 5000;
    this.maxAgeMs = (rc.maxAgeHours ?? 48) * 3600_000;
    this.concurrency = 4;
    this.store = new JsonStore('relay-queue.json', () => ({ items: [] }));
    this.hooks = new Map(); // wid -> { next, backoff, busy }
    this.active = 0;
    this.saveTimer = null;
    this.stats = { received: 0, delivered: 0, dropped: 0, lastError: null, lastErrorAt: null };
    this.lastLog = new Map();
  }

  get enabled() {
    return this.rc.enabled !== false && this.secret && !this.secret.startsWith('ПРИДУМАЙ');
  }

  start() {
    if (!this.enabled) {
      log('[relay] выключен (нет relay.secret)');
      return;
    }
    const n = this.store.data.items.length;
    log(`[relay] включён${n ? `, в очереди с прошлого запуска: ${n}` : ''}`);
    setInterval(() => this.pump(), 250);
  }

  hook(wid) {
    let h = this.hooks.get(wid);
    if (!h) this.hooks.set(wid, (h = { next: 0, backoff: 0, busy: false }));
    return h;
  }

  markDirty() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try { this.store.save(); } catch (e) { log('[relay] не удалось сохранить очередь:', e.message); }
    }, 1000);
  }

  logThrottled(key, ...args) {
    const now = Date.now();
    if (now - (this.lastLog.get(key) || 0) < 60_000) return;
    this.lastLog.set(key, now);
    log(...args);
  }

  clientIp(req) {
    // За прокси хостинга (Traefik/nginx) реальный IP приходит в X-Forwarded-For / X-Real-IP
    if (this.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      const real = String(req.headers['x-real-ip'] || '').trim();
      if (xff || real) return (xff || real).replace(/^::ffff:/, '');
    }
    return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  }

  /** HTTP-обработчик: (req, res, path) => true, если запрос наш. */
  handler() {
    if (!this.enabled) return null;
    const secretBuf = Buffer.from(this.secret);
    const secretOk = (s) => {
      const b = Buffer.from(String(s));
      return b.length === secretBuf.length && crypto.timingSafeEqual(b, secretBuf);
    };

    return (req, res, path) => {
      if (path === `/${this.secret}/relay-status` && secretOk(this.secret)) {
        sendJson(res, 200, this.status());
        return true;
      }
      const m = path.match(PATH_RE);
      if (!m) return false;
      const [, secret, wid, token, sub = ''] = m;
      if (!secretOk(secret)) { sendJson(res, 404, { ok: false }); return true; }

      const ip = this.clientIp(req);
      if (this.allowedIps.size && !this.allowedIps.has(ip)) {
        this.logThrottled('ip' + ip, `[relay] отклонён запрос с IP ${ip} (нет в allowedIps)`);
        sendJson(res, 403, { ok: false, error: 'ip not allowed' });
        return true;
      }
      if (this.allowedIds.size && !this.allowedIds.has(wid)) {
        sendJson(res, 403, { ok: false, error: 'webhook not allowed' });
        return true;
      }

      const query = new URLSearchParams((req.url.split('?')[1]) || '');
      const wait = query.get('wait') === 'true';
      const method = req.method.toUpperCase();

      readBody(req, res, MAX_BODY, (body) => {
        const item = {
          id: crypto.randomUUID(),
          wid, token, sub, method,
          query: query.toString(),
          ct: String(req.headers['content-type'] || 'application/json'),
          body: body.length ? body.toString('base64') : '',
          at: Date.now(),
          tries: 0,
        };
        this.stats.received++;
        if (method === 'GET' || wait) return this.proxyNow(item, res);
        this.enqueue(item);
        res.writeHead(204);
        res.end();
      });
      return true;
    };
  }

  enqueue(item) {
    item.query = new URLSearchParams(item.query);
    item.query.delete('wait');
    item.query = item.query.toString();
    const items = this.store.data.items;
    items.push(item);
    if (this.maxQueue > 0 && items.length > this.maxQueue) {
      const cut = items.length - this.maxQueue;
      items.splice(0, cut);
      this.stats.dropped += cut;
      this.logThrottled('overflow', `[relay] очередь переполнена, выброшено старых: ${cut}`);
    }
    this.markDirty();
  }

  async request(item) {
    const url = `${DISCORD}/api/webhooks/${item.wid}/${item.token}${item.sub}${item.query ? '?' + item.query : ''}`;
    const init = {
      method: item.method,
      headers: { 'User-Agent': 'RustDiscordBot-Relay (https://discord.com, 1.0)' },
      signal: AbortSignal.timeout(20_000),
    };
    if (item.body && item.method !== 'GET') {
      init.body = Buffer.from(item.body, 'base64');
      init.headers['Content-Type'] = item.ct;
    }
    const res = await fetch(url, init);
    const text = await res.text();
    return { res, text };
  }

  /** Прямое проксирование (GET или ?wait=true): отдаём ответ Discord как есть. */
  async proxyNow(item, clientRes) {
    try {
      const { res, text } = await this.request(item);
      clientRes.writeHead(res.status, { 'Content-Type': res.headers.get('content-type') || 'application/json' });
      clientRes.end(text);
      if (res.ok) this.stats.delivered++;
    } catch (e) {
      this.noteError(`прямой запрос: ${e.message}`);
      sendJson(clientRes, 502, { ok: false, error: 'discord unreachable' });
    }
  }

  noteError(msg) {
    this.stats.lastError = msg;
    this.stats.lastErrorAt = new Date().toISOString();
  }

  pump() {
    const items = this.store.data.items;
    if (!items.length) return;
    const now = Date.now();

    // Старьё выбрасываем
    if (this.maxAgeMs > 0 && now - items[0].at > this.maxAgeMs) {
      const before = items.length;
      this.store.data.items = items.filter((i) => now - i.at <= this.maxAgeMs);
      this.stats.dropped += before - this.store.data.items.length;
      this.markDirty();
      return;
    }

    // Для каждого вебхука берём самое старое сообщение (порядок внутри вебхука сохраняется)
    const seen = new Set();
    for (const item of items) {
      if (this.active >= this.concurrency) break;
      if (seen.has(item.wid)) continue;
      seen.add(item.wid);
      const h = this.hook(item.wid);
      if (h.busy || now < h.next) continue;
      this.deliver(item, h);
    }
  }

  remove(item) {
    const items = this.store.data.items;
    const idx = items.indexOf(item);
    if (idx >= 0) items.splice(idx, 1);
    this.markDirty();
  }

  async deliver(item, h) {
    h.busy = true;
    this.active++;
    item.tries++;
    try {
      const { res, text } = await this.request(item);
      const now = Date.now();
      const isJson = (res.headers.get('content-type') || '').includes('json');

      if (res.ok) {
        this.remove(item);
        this.stats.delivered++;
        h.backoff = 0;
        if (res.headers.get('x-ratelimit-remaining') === '0') {
          h.next = now + Number(res.headers.get('x-ratelimit-reset-after') || 1) * 1000 + 50;
        }
        return;
      }

      if (res.status === 429) {
        let after = Number(res.headers.get('retry-after') || 1);
        try { after = JSON.parse(text).retry_after ?? after; } catch { /* ignore */ }
        h.next = now + Math.max(0.5, after) * 1000 + 100;
        return;
      }

      if (DROP_CODES.has(res.status) && isJson) {
        // Настоящий отказ Discord (битое сообщение, удалённый вебхук) — повтор бесполезен
        this.remove(item);
        this.stats.dropped++;
        const msg = `вебхук ${item.wid}: Discord ответил ${res.status} ${text.slice(0, 200)} — сообщение отброшено`;
        this.noteError(msg);
        this.logThrottled('drop' + item.wid + res.status, '[relay]', msg);
        return;
      }

      this.retryLater(h, `вебхук ${item.wid}: HTTP ${res.status}`);
    } catch (e) {
      this.retryLater(h, `вебхук ${item.wid}: ${e.message}`);
    } finally {
      h.busy = false;
      this.active--;
      this.markDirty();
    }
  }

  retryLater(h, msg) {
    h.backoff = Math.min(Math.max(2000, h.backoff * 2), 300_000);
    h.next = Date.now() + h.backoff;
    this.noteError(msg);
    this.logThrottled('retry' + msg.split(':')[0], `[relay] ${msg}, повтор через ${Math.round(h.backoff / 1000)} с`);
  }

  status() {
    const per = {};
    for (const i of this.store.data.items) per[i.wid] = (per[i.wid] || 0) + 1;
    return { ok: true, queued: this.store.data.items.length, perWebhook: per, ...this.stats };
  }

  flushSync() {
    try { this.store.save(); } catch { /* ignore */ }
  }
}

module.exports = { WebhookRelay };
