const {
  EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, MessageFlags,
} = require('discord.js');
const { log, formatDuration, escapeMd } = require('./util');

const MAX_IN_EMBED = 40;      // сколько игроков выводить в сообщении (остальные — в файле)
const EMBED_LIMIT = 3900;     // запас от лимита 4096 символов описания

function commandDefs(cfg) {
  const pc = cfg.playtime;
  return [
    {
      name: pc.commandStats || 'статистика',
      description: 'Сколько отыграли игроки на Rust-сервере (и сколько стримили стримеры)',
    },
    {
      name: pc.commandReset || 'статистика-сброс',
      description: 'Обнулить статистику (итоги сохранятся файлом)',
      default_member_permissions: String(PermissionFlagsBits.Administrator),
    },
    ...(cfg.console?.enabled === false ? [] : [{
      name: cfg.console?.command || 'консоль',
      description: 'Выполнить консольную команду на Rust-сервере',
      default_member_permissions: String(PermissionFlagsBits.Administrator),
      options: [{ type: 3, name: 'команда', description: 'Например: say Привет / kick ник / status', required: true, max_length: 500 }],
    }]),
  ];
}

async function registerCommands(client, cfg, guildIds) {
  const defs = commandDefs(cfg);
  for (const id of guildIds) {
    try {
      const guild = await client.guilds.fetch(id);
      await guild.commands.set(defs);
      log(`[commands] зарегистрированы на сервере ${guild.name}`);
    } catch (e) {
      log(`[commands] не удалось зарегистрировать на ${id}:`, e.message);
    }
  }
}

/** Собирает строки отчёта: игроки + привязка к твичу. */
function buildRows(cfg, stats, twitch) {
  const links = twitch.steamLinks();
  const players = stats.data.players;
  const rows = [];
  const seen = new Set();
  for (const [steamId, p] of Object.entries(players)) {
    const link = links.get(steamId);
    if (cfg.playtime.showOnlyStreamers && !link) continue;
    rows.push({ steamId, name: p.name || '—', seconds: p.seconds, twitch: link?.url || '' });
    seen.add(steamId);
  }
  // Стримеры с указанным steamId, которые ещё не заходили, — тоже в списке (с нулём)
  for (const [steamId, s] of links) {
    if (!seen.has(steamId)) rows.push({ steamId, name: s.login, seconds: 0, twitch: s.url });
  }
  rows.sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name));
  return rows;
}

function buildCsv(rows, stats, twitch) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['SteamID;Ник;Секунд;Часов;Время;Twitch'];
  for (const r of rows) {
    lines.push([r.steamId, esc(r.name), r.seconds, (r.seconds / 3600).toFixed(2), esc(formatDuration(r.seconds)), r.twitch].join(';'));
  }
  lines.push('', 'Twitch;Стримов;Секунд;Время');
  for (const s of twitch.streamers) {
    const t = stats.data.streams[s.login] || { seconds: 0, count: 0 };
    lines.push([s.url, t.count, t.seconds, esc(formatDuration(t.seconds))].join(';'));
  }
  // BOM, чтобы Excel правильно открыл кириллицу
  return Buffer.from('﻿' + lines.join('\r\n'), 'utf8');
}

function buildEmbeds(rows, stats, twitch) {
  const since = Math.floor(Date.parse(stats.data.since) / 1000);
  const total = rows.reduce((a, r) => a + r.seconds, 0);

  const lines = rows.slice(0, MAX_IN_EMBED).map((r, i) => {
    const steam = `[${r.steamId}](https://steamcommunity.com/profiles/${r.steamId})`;
    const tw = r.twitch ? ` · [Twitch](${r.twitch})` : '';
    return `**${i + 1}.** ${escapeMd(r.name)} — **${formatDuration(r.seconds)}**\n ${steam}${tw}`;
  });

  const embeds = [];
  let chunk = '';
  for (const line of lines) {
    if (chunk.length + line.length + 1 > EMBED_LIMIT) { embeds.push(chunk); chunk = ''; }
    chunk += (chunk ? '\n' : '') + line;
  }
  if (chunk) embeds.push(chunk);
  if (!embeds.length) embeds.push('Пока нет данных от сервера.');

  const rest = rows.length - Math.min(rows.length, MAX_IN_EMBED);
  const result = embeds.map((desc, i) => {
    const e = new EmbedBuilder().setColor(0xce422b).setDescription(desc);
    if (i === 0) {
      e.setTitle('📊 Наигранное время на сервере')
        .addFields(
          { name: 'Считается с', value: `<t:${since}:f>`, inline: true },
          { name: 'Игроков', value: String(rows.length), inline: true },
          { name: 'Всего', value: formatDuration(total), inline: true },
        );
    }
    return e;
  });
  if (rest > 0) result[result.length - 1].setFooter({ text: `…и ещё ${rest} игрок(ов) — полный список в файле` });

  // Стримы
  if (twitch.streamers.length) {
    const streamLines = twitch.streamers
      .map((s) => ({ s, t: stats.data.streams[s.login] || { seconds: 0, count: 0, name: s.login } }))
      .sort((a, b) => b.t.seconds - a.t.seconds)
      .map(({ s, t }) => {
        const st = twitch.state.data.streams[s.login];
        const liveMark = st?.live ? ' 🔴 в эфире' : '';
        return `[${escapeMd(t.name || s.login)}](${s.url}) — **${formatDuration(t.seconds)}** (стримов: ${t.count})${liveMark}`;
      });
    let desc = streamLines.join('\n');
    if (desc.length > EMBED_LIMIT) desc = desc.slice(0, EMBED_LIMIT) + '\n…';
    result.push(new EmbedBuilder().setColor(0x9146ff).setTitle('🎥 Время стримов').setDescription(desc));
  }
  return result;
}

/** Discord: не больше 6000 символов эмбедов на сообщение — раскладываем по сообщениям. */
function packMessages(embeds) {
  const msgs = [];
  let cur = [];
  let size = 0;
  for (const e of embeds) {
    const len = JSON.stringify(e.toJSON()).length;
    if (cur.length && (size + len > 5500 || cur.length >= 10)) { msgs.push(cur); cur = []; size = 0; }
    cur.push(e);
    size += len;
  }
  if (cur.length) msgs.push(cur);
  return msgs;
}

function isAdmin(interaction, cfg) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  const roles = cfg.adminRoleIds || [];
  const memberRoles = interaction.member?.roles?.cache ?? interaction.member?.roles;
  if (!memberRoles) return false;
  return roles.some((id) => (memberRoles.has ? memberRoles.has(id) : memberRoles.includes?.(id)));
}

async function handleStats(interaction, cfg, stats, twitch) {
  const rows = buildRows(cfg, stats, twitch);
  const embeds = buildEmbeds(rows, stats, twitch);
  const file = new AttachmentBuilder(buildCsv(rows, stats, twitch), { name: 'statistics.csv' });
  const msgs = packMessages(embeds);
  await interaction.reply({ embeds: msgs[0], files: msgs.length === 1 ? [file] : [] });
  for (let i = 1; i < msgs.length; i++) {
    await interaction.followUp({ embeds: msgs[i], files: i === msgs.length - 1 ? [file] : [] });
  }
}

async function handleReset(interaction, cfg, stats, twitch) {
  if (!isAdmin(interaction, cfg)) {
    return interaction.reply({ content: '⛔ Нет прав на сброс статистики.', flags: MessageFlags.Ephemeral });
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('reset_yes').setLabel('Да, обнулить').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('reset_no').setLabel('Отмена').setStyle(ButtonStyle.Secondary),
  );
  await interaction.reply({
    content: '⚠️ Обнулить статистику наигранного времени и стримов? Итоги до сброса будут приложены файлом.',
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
  const msg = await interaction.fetchReply();
  let click;
  try {
    click = await msg.awaitMessageComponent({ filter: (i) => i.user.id === interaction.user.id, time: 30_000 });
  } catch {
    return interaction.editReply({ content: 'Время вышло — сброс отменён.', components: [] });
  }
  if (click.customId !== 'reset_yes') {
    return click.update({ content: 'Сброс отменён.', components: [] });
  }

  const rows = buildRows(cfg, stats, twitch);
  const csv = buildCsv(rows, stats, twitch);
  const since = Math.floor(Date.parse(stats.data.since) / 1000);
  const backup = stats.reset();
  log(`[stats] сброс от ${interaction.user.tag}, копия: ${backup}`);

  await click.update({ content: '✅ Готово.', components: [] });
  const stamp = new Date().toISOString().slice(0, 10);
  await interaction.followUp({
    content: `🧹 Статистика обнулена (${interaction.user}). Итоги за период с <t:${since}:f> — в файле.`,
    files: [new AttachmentBuilder(csv, { name: `statistics-${stamp}.csv` })],
    allowedMentions: { parse: [] },
  });
}

/** Консольная команда на сервер: бот кладёт в очередь, плагин забирает, выполняет и присылает вывод. */
async function handleConsole(interaction, cfg, game) {
  if (!isAdmin(interaction, cfg)) {
    return interaction.reply({ content: '⛔ Нет прав.', flags: MessageFlags.Ephemeral });
  }
  const command = interaction.options.getString('команда', true).trim().replace(/[\r\n]+/g, ' ');
  const allowed = (cfg.console?.allowedCommands || []).map((c) => c.toLowerCase());
  const first = command.split(/\s+/)[0].toLowerCase();
  if (allowed.length && (!allowed.includes(first) || command.includes(';'))) {
    return interaction.reply({ content: `⛔ Команда \`${first}\` не разрешена. Разрешены: ${allowed.map((c) => `\`${c}\``).join(', ')}`, flags: MessageFlags.Ephemeral });
  }
  const ephemeral = cfg.console?.ephemeral !== false;
  await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
  log(`[console] ${interaction.user.tag}: ${command}`);
  const r = await game.runCommand(command);
  let out = r.output.trim() || '(пустой вывод)';
  if (out.length > 1800) out = out.slice(0, 1800) + '\n…';
  await interaction.editReply({
    content: `${r.ok ? '✅' : '⚠️'} \`${command.slice(0, 200).replace(/`/g, "'")}\`\n\`\`\`\n${out.replace(/```/g, "'''")}\n\`\`\``,
  });
}

function setupCommands(client, cfg, stats, twitch, game) {
  const statsName = cfg.playtime.commandStats || 'статистика';
  const resetName = cfg.playtime.commandReset || 'статистика-сброс';
  const consoleName = cfg.console?.command || 'консоль';
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      if (interaction.commandName === statsName) await handleStats(interaction, cfg, stats, twitch);
      else if (interaction.commandName === resetName) await handleReset(interaction, cfg, stats, twitch);
      else if (interaction.commandName === consoleName && game) await handleConsole(interaction, cfg, game);
    } catch (e) {
      log('[commands] ошибка:', e);
      const payload = { content: '❌ Ошибка при выполнении команды.', flags: MessageFlags.Ephemeral };
      try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
        else await interaction.reply(payload);
      } catch { /* ignore */ }
    }
  });
}

module.exports = { registerCommands, setupCommands, buildRows, buildEmbeds, buildCsv, packMessages };
