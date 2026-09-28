const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// DATA_DIR — если у хостинга есть постоянный диск (volume), укажи путь к нему, чтобы статистика не пропадала при деплое
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

function log(...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}]`, ...args);
}

function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Переменные окружения имеют приоритет (удобно на хостинге)
  if (process.env.DISCORD_TOKEN) cfg.token = process.env.DISCORD_TOKEN;
  if (process.env.GUILD_ID) cfg.guildId = process.env.GUILD_ID;
  if (process.env.TWITCH_CLIENT_ID) cfg.twitch.clientId = process.env.TWITCH_CLIENT_ID;
  if (process.env.TWITCH_CLIENT_SECRET) cfg.twitch.clientSecret = process.env.TWITCH_CLIENT_SECRET;
  cfg.api = cfg.api || {};
  cfg.relay = cfg.relay || {};
  cfg.playtime = cfg.playtime || {};
  // совместимость с конфигом 1.0.0
  if (!cfg.api.secret && cfg.playtime.secret) cfg.api.secret = cfg.playtime.secret;
  if (!cfg.adminRoleIds && cfg.playtime.adminRoleIds) cfg.adminRoleIds = cfg.playtime.adminRoleIds;
  if (process.env.API_SECRET) cfg.api.secret = process.env.API_SECRET;
  if (process.env.RELAY_SECRET) cfg.relay.secret = process.env.RELAY_SECRET;
  // PORT (многие хостинги выдают порт сами) читается в http.js
  return cfg;
}

/** JSON-хранилище с атомарной записью (сначала во временный файл, потом rename). */
class JsonStore {
  constructor(name, defaults) {
    this.file = path.join(DATA_DIR, name);
    this.defaults = defaults;
    this.data = defaults();
    this.dirty = false;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        this.data = Object.assign(defaults(), JSON.parse(fs.readFileSync(this.file, 'utf8')));
      } catch (e) {
        const broken = this.file + '.broken-' + Date.now();
        fs.copyFileSync(this.file, broken);
        log(`[store] ${name} повреждён, копия: ${broken}. Начинаю с пустого.`);
      }
    }
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }
  backup(prefix) {
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(dir, `${prefix}-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(this.data, null, 2));
    return file;
  }
}

/** 45296 -> "12 ч 34 мин" */
function formatDuration(seconds) {
  seconds = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0 && m === 0) return seconds > 0 ? '< 1 мин' : '0 мин';
  if (h === 0) return `${m} мин`;
  return `${h} ч ${String(m).padStart(2, '0')} мин`;
}

/** "https://www.twitch.tv/Name/" -> "name" */
function twitchLogin(url) {
  const s = String(url || '').trim();
  const m = s.match(/twitch\.tv\/([A-Za-z0-9_]{2,25})/i);
  if (m) return m[1].toLowerCase();
  if (/^[A-Za-z0-9_]{2,25}$/.test(s)) return s.toLowerCase();
  return null;
}

function escapeMd(text) {
  return String(text ?? '').replace(/([\\*_`~|>\[\]()])/g, '\\$1');
}

module.exports = { log, loadConfig, JsonStore, formatDuration, twitchLogin, escapeMd, DATA_DIR };
