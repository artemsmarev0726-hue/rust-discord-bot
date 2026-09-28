const { ActivityType } = require('discord.js');
const { log } = require('./util');

const TYPES = {
  custom: ActivityType.Custom,
  watching: ActivityType.Watching,
  playing: ActivityType.Playing,
  listening: ActivityType.Listening,
  competing: ActivityType.Competing,
};

/**
 * Статус бота: количество участников и сколько из них онлайн.
 * Плейсхолдеры: {members} {online} — Discord; {server_online} {server_max} {server_queue} {server_joining} — Rust-сервер (присылает плагин).
 * Берём approximate_member_count / approximate_presence_count из API —
 * для этого НЕ нужны привилегированные интенты (Server Members / Presence).
 */
function startPresence(client, cfg, getGuildId, game) {
  const pc = cfg.presence;
  if (!pc || pc.enabled === false) return;
  const type = TYPES[String(pc.type || 'custom').toLowerCase()] ?? ActivityType.Custom;
  let lastText = null;

  async function update() {
    try {
      const guildId = getGuildId();
      if (!guildId) return;
      const guild = await client.guilds.fetch({ guild: guildId, withCounts: true, force: true });
      const members = guild.approximateMemberCount ?? guild.memberCount ?? 0;
      const online = guild.approximatePresenceCount ?? 0;
      const st = game?.getStatus();
      const off = pc.serverOfflineText ?? 'офлайн';
      const text = String(pc.text || '👥 {members} | 🟢 {online}')
        .replace(/\{members\}/g, members)
        .replace(/\{online\}/g, online)
        .replace(/\{server_online\}/g, st ? st.online : off)
        .replace(/\{server_max\}/g, st ? st.max : '—')
        .replace(/\{server_queue\}/g, st ? st.queue : 0)
        .replace(/\{server_joining\}/g, st ? st.joining : 0)
        .slice(0, 128);
      if (text === lastText) return;
      const activity = type === ActivityType.Custom
        ? { name: 'Custom Status', state: text, type }
        : { name: text, type };
      client.user.setPresence({ activities: [activity], status: 'online' });
      lastText = text;
    } catch (e) {
      log('[presence] ошибка обновления:', e.message);
    }
  }

  update();
  setInterval(update, Math.max(30, pc.updateIntervalSec || 60) * 1000);
  log('[presence] запущено');
}

module.exports = { startPresence };
