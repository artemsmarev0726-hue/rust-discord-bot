const { log, JsonStore } = require('./util');
const { sendJson, readBody, makeAuth } = require('./http');

const apiSecretOk = (cfg) => cfg.api?.secret && !String(cfg.api.secret).startsWith('ПРИДУМАЙ');

const MAX_BODY = 1024 * 1024;
const KEEP_BATCH_IDS = 1000;

/** Статистика с момента последнего сброса: наигранное время игроков + время стримов. */
class PlaytimeStats {
  constructor() {
    this.store = new JsonStore('stats.json', () => ({
      since: new Date().toISOString(),
      players: {},  // steamId -> { name, seconds, lastSeen }
      streams: {},  // twitchLogin -> { name, seconds, count }
      batches: [],  // id последних принятых пачек (защита от повторной доставки)
    }));
    this.store.save();
  }

  get data() { return this.store.data; }

  applyBatch(batchId, players) {
    const d = this.data;
    if (batchId && d.batches.includes(batchId)) return { duplicate: true, applied: 0 };
    let applied = 0;
    const now = new Date().toISOString();
    for (const p of players) {
      const steamId = String(p.steamId || '');
      const seconds = Math.floor(Number(p.seconds));
      if (!/^\d{17}$/.test(steamId) || !Number.isFinite(seconds) || seconds <= 0 || seconds > 7 * 86400) continue;
      const e = d.players[steamId] || (d.players[steamId] = { name: '', seconds: 0, lastSeen: null });
      e.seconds += seconds;
      if (p.name) e.name = String(p.name).slice(0, 64);
      e.lastSeen = now;
      applied++;
    }
    if (batchId) {
      d.batches.push(batchId);
      if (d.batches.length > KEEP_BATCH_IDS) d.batches.splice(0, d.batches.length - KEEP_BATCH_IDS);
    }
    this.store.save();
    return { duplicate: false, applied };
  }

  addStream(login, name, seconds) {
    const e = this.data.streams[login] || (this.data.streams[login] = { name, seconds: 0, count: 0 });
    e.name = name || e.name;
    e.seconds += seconds;
    e.count += 1;
    this.store.save();
  }

  /** Сохраняет копию в data/backups и обнуляет. Возвращает путь к копии. */
  reset() {
    const file = this.store.backup('stats');
    const batches = this.data.batches; // id пачек сохраняем, чтобы повтор старой пачки не «воскресил» часы
    this.store.data = { since: new Date().toISOString(), players: {}, streams: {}, batches };
    this.store.save();
    return file;
  }
}

/**
 * HTTP-приёмник для Rust-плагина.
 * POST /api/playtime   Authorization: Bearer <secret>
 * { "batchId": "...", "server": "...", "players": [ { "steamId": "7656...", "name": "Ник", "seconds": 60 } ] }
 * Возвращает обработчик (req, res, path) => true, если запрос его.
 */
function createPlaytimeHandler(cfg, stats) {
  const pc = cfg.playtime;
  if (!pc || pc.enabled === false) return null;
  if (!apiSecretOk(cfg)) {
    log('[playtime] ВНИМАНИЕ: не задан api.secret — приём данных от плагина выключен');
    return null;
  }
  const checkAuth = makeAuth(cfg.api.secret);

  return (req, res, path) => {
    if (path !== '/api/playtime') return false;
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method' }), true;
    if (!checkAuth(req)) return sendJson(res, 401, { ok: false, error: 'bad secret' }), true;

    readBody(req, res, MAX_BODY, (buf) => {
      let body;
      try { body = JSON.parse(buf.toString('utf8')); }
      catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
      if (!Array.isArray(body.players)) return sendJson(res, 400, { ok: false, error: 'players[] required' });
      try {
        const r = stats.applyBatch(body.batchId ? String(body.batchId).slice(0, 64) : null, body.players);
        if (!r.duplicate && r.applied) log(`[playtime] принято: ${r.applied} игрок(ов)`);
        sendJson(res, 200, { ok: true, ...r });
      } catch (e) {
        log('[playtime] ошибка сохранения:', e.message);
        sendJson(res, 500, { ok: false, error: 'save failed' });
      }
    });
    return true;
  };
}

module.exports = { PlaytimeStats, createPlaytimeHandler, apiSecretOk };
