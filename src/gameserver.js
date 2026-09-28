const crypto = require('crypto');
const { log } = require('./util');
const { sendJson, readBody, makeAuth } = require('./http');

const STATUS_STALE_MS = 3 * 60_000;   // нет статуса 3 мин — сервер считается офлайн
const PICKUP_TIMEOUT_MS = 30_000;     // команду не забрали за 30 с — отменяем (чтобы не выполнилась «вдруг» потом)
const RESULT_TIMEOUT_MS = 60_000;

/**
 * Связь бот <-> игровой сервер в обе стороны без прямого доступа сервера к Discord.
 *
 * Сервер -> бот:
 *   POST /api/status           { online, max, queue, joining, hostname }  — для статуса бота
 * Бот -> сервер (сервер сам опрашивает бота, входящие порты на игровом сервере не нужны):
 *   GET  /api/commands         -> { commands: [ { id, command } ] }
 *   POST /api/commands/result  { id, ok, output }
 * Все запросы с заголовком Authorization: Bearer <api.secret>.
 */
class GameServerLink {
  constructor(cfg) {
    this.cfg = cfg;
    this.status = null;
    this.statusAt = 0;
    this.lastPollAt = 0;
    this.queue = [];               // ждут, пока сервер заберёт
    this.pending = new Map();      // id -> { resolve, timer } — забраны, ждём результат
  }

  getStatus() {
    if (!this.status || Date.now() - this.statusAt > STATUS_STALE_MS) return null;
    return this.status;
  }

  isServerPolling() {
    return Date.now() - this.lastPollAt < 30_000;
  }

  handler() {
    const secret = this.cfg.api?.secret;
    if (!secret || String(secret).startsWith('ПРИДУМАЙ')) return null;
    const auth = makeAuth(secret);

    return (req, res, path) => {
      if (!['/api/status', '/api/commands', '/api/commands/result'].includes(path)) return false;
      if (!auth(req)) { sendJson(res, 401, { ok: false, error: 'bad secret' }); return true; }

      if (path === '/api/commands' && req.method === 'GET') {
        this.lastPollAt = Date.now();
        const now = Date.now();
        const out = [];
        while (this.queue.length) {
          const c = this.queue.shift();
          if (now - c.createdAt > PICKUP_TIMEOUT_MS) continue; // просрочена — уже ответили «сервер не ответил»
          clearTimeout(c.pickupTimer);
          c.resultTimer = setTimeout(() => this.finish(c.id, { ok: false, output: 'Сервер забрал команду, но не прислал результат за 60 с.' }), RESULT_TIMEOUT_MS);
          this.pending.set(c.id, c);
          out.push({ id: c.id, command: c.command });
        }
        sendJson(res, 200, { ok: true, commands: out });
        return true;
      }

      if (req.method !== 'POST') { sendJson(res, 405, { ok: false }); return true; }

      readBody(req, res, 256 * 1024, (buf) => {
        let body;
        try { body = JSON.parse(buf.toString('utf8')); } catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }

        if (path === '/api/status') {
          this.status = {
            online: Number(body.online) || 0,
            max: Number(body.max) || 0,
            queue: Number(body.queue) || 0,
            joining: Number(body.joining) || 0,
            hostname: String(body.hostname || '').slice(0, 100),
          };
          this.statusAt = Date.now();
          return sendJson(res, 200, { ok: true });
        }

        // /api/commands/result
        this.finish(String(body.id || ''), { ok: body.ok !== false, output: String(body.output ?? '') });
        sendJson(res, 200, { ok: true });
      });
      return true;
    };
  }

  finish(id, result) {
    const c = this.pending.get(id);
    if (!c) return;
    this.pending.delete(id);
    clearTimeout(c.resultTimer);
    c.resolve(result);
  }

  /** Поставить консольную команду в очередь; промис вернёт вывод сервера. */
  runCommand(command) {
    return new Promise((resolve) => {
      const c = { id: crypto.randomUUID(), command, createdAt: Date.now(), resolve };
      c.pickupTimer = setTimeout(() => {
        const i = this.queue.indexOf(c);
        if (i >= 0) this.queue.splice(i, 1);
        resolve({ ok: false, output: 'Сервер не забрал команду за 30 с (выключен или нет связи с ботом).' });
      }, PICKUP_TIMEOUT_MS);
      this.queue.push(c);
      log(`[console] в очереди: ${command}`);
    });
  }
}

module.exports = { GameServerLink };
