const { Client, GatewayIntentBits, Events } = require('discord.js');
const { log, loadConfig } = require('./util');
const { startHttpServer } = require('./http');
const { startPresence } = require('./presence');
const { TwitchWatcher } = require('./twitch');
const { PlaytimeStats, createPlaytimeHandler } = require('./playtime');
const { WebhookRelay } = require('./relay');
const { GameServerLink } = require('./gameserver');
const { registerCommands, setupCommands } = require('./commands');

const cfg = loadConfig();
if (!cfg.token || cfg.token.startsWith('ВСТАВЬ')) {
  console.error('Укажи token в config.json (или переменную окружения DISCORD_TOKEN).');
  process.exit(1);
}

// Только Guilds — привилегированные интенты не нужны
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const stats = new PlaytimeStats();
const twitch = new TwitchWatcher(client, cfg, stats);
const relay = new WebhookRelay(cfg);
const game = new GameServerLink(cfg);

// HTTP стартует сразу, не дожидаясь Discord: плагины и ретранслятор работают даже при проблемах с логином
startHttpServer(cfg, [
  relay.handler(),
  game.handler(),
  createPlaytimeHandler(cfg, stats),
]);
relay.start();

const getGuildId = () => {
  if (cfg.guildId && !cfg.guildId.startsWith('ID_')) return cfg.guildId;
  return client.guilds.cache.first()?.id; // если не указан — первый сервер, где есть бот
};

client.once(Events.ClientReady, async () => {
  log(`Бот запущен как ${client.user.tag}. Серверов: ${client.guilds.cache.size}`);
  const gid = getGuildId();
  if (!gid) log('ВНИМАНИЕ: бот не добавлен ни на один сервер');
  await registerCommands(client, cfg, gid ? [gid] : []);
  setupCommands(client, cfg, stats, twitch, game);
  startPresence(client, cfg, getGuildId, game);
  twitch.start();
});

client.on(Events.GuildCreate, (g) => { if (!cfg.guildId || cfg.guildId.startsWith('ID_')) registerCommands(client, cfg, [g.id]); });
client.on('error', (e) => log('[discord] ошибка:', e.message));
process.on('unhandledRejection', (e) => log('[unhandledRejection]', e));

const shutdown = () => {
  log('Остановка…');
  try { stats.store.save(); twitch.state.save(); relay.flushSync(); } catch { /* ignore */ }
  client.destroy().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(cfg.token);
