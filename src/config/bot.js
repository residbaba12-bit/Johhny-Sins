import fs from 'fs';
import path from 'path';
import {
  Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, GatewayIntentBits,
} from 'discord.js';

// !!! Adjust these two import paths to where your files really live !!!
import { logger } from '../utils/logger.js';
import {
  botConfig, getColor, isFeatureEnabled, isBotOwner, isMaintenanceMode, getBotMessage,
} from '../config/bot.js';

// ===================================================================
//  TEAM BOT PLUGIN  (sign / unsign / cd / ?ranked + moderation + roles)
//  Usage: registerTeamBot(client)  -> call once, right after the client is created.
//  It never calls client.login(), uses its own prefix ("?" by default, so it does
//  not clash with Titan's "!") and its own button ids ("tb_").
//  All settings come from botConfig.teamBot (see the snippet for config.js).
// ===================================================================

const tb = botConfig.teamBot ?? {};
const tbRanked = tb.ranked ?? {};

const DATA_DIR = path.join(process.cwd(), 'data', 'teambot');
fs.mkdirSync(DATA_DIR, { recursive: true });

const PREFIX = tb.prefix || process.env.TEAMBOT_PREFIX || '?';
const COOLDOWN_MS = (tb.transferCooldownHours ?? 24) * 60 * 60 * 1000;
const TEAM_REGEX = new RegExp(tb.teamRoleRegex ?? '\\| TEAM$');
const ALLOWED_ROLE_NAMES = (tb.captainRoles ?? ['captain', 'vice captain']).map((n) => n.toLowerCase());
const CAPTAIN_CMDS = ['sign', 'unsign', 'cd', 'ranked'];
const RANKED_CHANNEL_NAME = (tbRanked.channelName ?? 'ranked-scrims').toLowerCase();
const RANKED_CHANNEL_ID = tbRanked.channelId ?? null;
const RANKED_COOLDOWN_MS = (tbRanked.cooldownMinutes ?? 30) * 60 * 1000;
const RANKED_LIMIT = tbRanked.dailyLimit ?? 4;
const RESET_UTC_OFFSET_HOURS = tbRanked.resetUtcOffsetHours ?? 4;
const LOG_CHANNEL_ID = tb.logChannelId || process.env.LOG_CHANNEL_ID || null;

const DB_FILE = path.join(DATA_DIR, 'cooldowns.json');
const WARN_FILE = path.join(DATA_DIR, 'warns.json');
const RANKED_FILE = path.join(DATA_DIR, 'ranked.json');
const CASE_FILE = path.join(DATA_DIR, 'cases.json');
const TIMER_FILE = path.join(DATA_DIR, 'timers.json');

// ---------- colors (taken from botConfig.embeds.colors) ----------
const COLORS = {
  gold: getColor('economy'),
  green: getColor('success'),
  red: getColor('error'),
  blue: getColor('blurple'),
  orange: getColor('#E67E22'),
};

// ---------- storage ----------
const load = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

let db = load(DB_FILE, {});
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const getCd = (id) => {
  const t = db[id];
  if (!t) return null;
  if (t <= Date.now()) { delete db[id]; save(); return null; }
  return t;
};
const setCd = (id) => { db[id] = Date.now() + COOLDOWN_MS; save(); return db[id]; };
const delCd = (id) => { const had = !!db[id]; delete db[id]; save(); return had; };

let warns = load(WARN_FILE, {});
const saveWarns = () => fs.writeFileSync(WARN_FILE, JSON.stringify(warns, null, 2));

let ranked = load(RANKED_FILE, {});
const saveRanked = () => fs.writeFileSync(RANKED_FILE, JSON.stringify(ranked, null, 2));

let cases = load(CASE_FILE, {});
const saveCases = () => fs.writeFileSync(CASE_FILE, JSON.stringify(cases, null, 2));
const addCase = (guildId, userId, type, modId, reason) => {
  cases[guildId] ??= {};
  cases[guildId][userId] ??= [];
  cases[guildId][userId].push({ type, mod: modId, reason, time: Date.now() });
  saveCases();
};

let timers = load(TIMER_FILE, []);
const saveTimers = () => fs.writeFileSync(TIMER_FILE, JSON.stringify(timers, null, 2));

// day key + next reset (00:00 in the configured UTC offset)
const dayKey = () => new Date(Date.now() + RESET_UTC_OFFSET_HOURS * 36e5).toISOString().slice(0, 10);
const nextReset = () => {
  const [y, m, d] = dayKey().split('-').map(Number);
  return Date.UTC(y, m - 1, d + 1) - RESET_UTC_OFFSET_HOURS * 36e5;
};

const ts = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;

export function registerTeamBot(client) {
  if (!isFeatureEnabled('teamBot')) {
    logger.info('Team bot plugin is disabled (features.teamBot = false).');
    return;
  }

  const teamRolesOf = (member) => member.roles.cache.filter((r) => TEAM_REGEX.test(r.name));
  const isCaptain = (member) =>
    isBotOwner(member.id)
    || member.roles.cache.some((r) => ALLOWED_ROLE_NAMES.includes(r.name.trim().toLowerCase()));

  const countWith = (role, memberId) => new Set([...role.members.keys(), memberId]).size;
  const countWithout = (role, memberId) => [...role.members.keys()].filter((id) => id !== memberId).length;

  // ---------- moderation helpers ----------
  const parseDuration = (s) => {
    const m = /^(\d+)\s*(s|m|h|d|w)$/i.exec(s || '');
    if (!m) return null;
    const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2].toLowerCase()];
    return Number(m[1]) * mult;
  };
  const fmtDuration = (ms) => {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60), sec = s % 60;
    return [d && `${d}d`, h && `${h}h`, m && `${m}m`, sec && !d && !h && `${sec}s`].filter(Boolean).join(' ') || '0s';
  };

  const resolveMember = async (msg, arg) => {
    const m = msg.mentions.members.first();
    if (m) return m;
    if (arg && /^\d{17,20}$/.test(arg)) return msg.guild.members.fetch(arg).catch(() => null);
    return null;
  };

  const resolveRole = (msg, text) => {
    const m = msg.mentions.roles.first();
    if (m) return m;
    const q = (text || '').trim().toLowerCase();
    if (!q) return null;
    return msg.guild.roles.cache.get(q)
      || msg.guild.roles.cache.find((r) => r.name.toLowerCase() === q)
      || msg.guild.roles.cache.find((r) => r.name.toLowerCase().includes(q))
      || null;
  };

  const hierarchyError = (msg, target) => {
    if (target.id === msg.author.id) return "You can't do that to yourself!";
    if (target.id === msg.guild.ownerId) return "You can't do that to the server owner!";
    if (target.id === client.user.id) return 'Nice try. 😄';
    if (msg.author.id !== msg.guild.ownerId && target.roles.highest.position >= msg.member.roles.highest.position) {
      return 'That user has the same or a higher role than you.';
    }
    return null;
  };

  const roleError = (msg, role, member) => {
    const isOwner = msg.author.id === msg.guild.ownerId;
    // you can't give/take roles of someone equal or above you (except yourself)
    if (member && member.id !== msg.author.id) {
      const he = hierarchyError(msg, member);
      if (he) return he;
    }
    if (role.managed || role.id === msg.guild.id) return "I can't manage that role.";
    if (!isOwner && role.position >= msg.member.roles.highest.position) {
      return 'That role is higher than or equal to your highest role.';
    }
    // you can't hand out a role containing permissions you don't have (e.g. Administrator)
    if (!isOwner) {
      const missing = msg.member.permissions.missing(role.permissions);
      if (missing.length) return `That role has permissions you don't have (${missing.slice(0, 3).join(', ')}).`;
    }
    if (!role.editable) return "I can't manage that role (it's above my role).";
    return null;
  };

  // bot owners (OWNER_IDS) always pass permission checks
  const hasPerm = (msg, flag, name) => {
    if (isBotOwner(msg.author.id) || msg.member.permissions.has(flag)) return true;
    msg.reply(`❌ ${getBotMessage('noPermission')} (needs **${name}**)`);
    return false;
  };

  const modEmbed = (title, color, user, mod, reason, extra = []) =>
    new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setThumbnail(user.displayAvatarURL())
      .addFields(
        { name: '👤 User', value: `${user} (${user.username})`, inline: true },
        { name: '🛡️ Moderator', value: `${mod}`, inline: true },
        ...extra,
        { name: '📄 Reason', value: reason },
      )
      .setFooter({ text: `ID: ${user.id}` })
      .setTimestamp();

  const dmAction = (user, guild, title, color, reason, extra = []) =>
    user.send({
      embeds: [new EmbedBuilder()
        .setColor(color).setTitle(title)
        .setDescription(`Server: **${guild.name}**`)
        .addFields(...extra, { name: '📄 Reason', value: reason })
        .setTimestamp()],
    }).catch(() => {});

  const modLog = async (guild, embed) => {
    if (!LOG_CHANNEL_ID) return;
    const ch = guild.channels.cache.get(LOG_CHANNEL_ID) || (await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null));
    ch?.send({ embeds: [embed] }).catch(() => {});
  };

  // send embed to channel + mod log + save case
  const done = async (msg, embed, type, user, reason) => {
    addCase(msg.guild.id, user.id, type, msg.author.id, reason);
    await msg.channel.send({ embeds: [embed] });
    return modLog(msg.guild, embed);
  };

  // Discord button customId max length is 100 chars -> pack IDs in base36
  const enc = (id) => BigInt(id).toString(36);
  const dec = (str) => [...str].reduce((a, c) => a * 36n + BigInt(parseInt(c, 36)), 0n).toString();
  const pack = (...ids) => ids.map(enc).join('|');

  // DM first; if DMs are closed, post the offer in the channel (only the target can answer)
  const sendOffer = async (msg, target, embed, row) => {
    try {
      await target.send({ embeds: [embed], components: [row] });
      return msg.react('✅').catch(() => {});
    } catch (e) {
      logger.warn(`Team bot: DM failed (${e.code}): ${e.message}`);
    }
    try {
      await msg.channel.send({
        content: `${target}, I couldn't DM you, so your offer is posted here. Only you can answer it.`,
        embeds: [embed],
        components: [row],
        allowedMentions: { users: [target.id] },
      });
      return msg.react('✅').catch(() => {});
    } catch (e) {
      logger.error(`Team bot: channel send failed (${e.code}): ${e.message}`);
      return msg.reply(`❌ I couldn't send the offer to **${target.user.username}**. Check that I can send messages and embeds in this channel.`).catch(() => {});
    }
  };

  // ---------- timers (tempban / temprole) ----------
  const runTimers = async () => {
    const now = Date.now();
    const due = timers.filter((t) => t.at <= now);
    if (!due.length) return;
    timers = timers.filter((t) => t.at > now);
    saveTimers();
    for (const t of due) {
      const guild = client.guilds.cache.get(t.guild);
      if (!guild) continue;
      if (t.type === 'unban') {
        await guild.members.unban(t.user, 'Tempban expired').catch(() => {});
      } else if (t.type === 'role') {
        const m = await guild.members.fetch(t.user).catch(() => null);
        if (m) await m.roles.remove(t.role, 'Temprole expired').catch(() => {});
      }
    }
  };

  let started = false;
  const start = async () => {
    if (started) return;
    started = true;
    logger.info(`✅ Team bot plugin active as ${client.user.tag} (prefix "${PREFIX}")`);
    const need = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent];
    const missing = need.filter((f) => !client.options.intents.has(f));
    if (missing.length) logger.warn(`Team bot: client is missing intents: ${missing.join(', ')}`);
    for (const g of client.guilds.cache.values()) {
      await g.members.fetch().catch(() => {});
    }
    setInterval(() => runTimers().catch(() => {}), 30 * 1000);
    runTimers().catch(() => {});
  };
  if (client.isReady()) start(); else client.once(Events.ClientReady, start);

  // ---------- prefix commands ----------
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot || !msg.guild || !msg.content.startsWith(PREFIX)) return;
    const args = msg.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = (args.shift() || '').toLowerCase();
    if (!cmd) return;

    // maintenance mode: only bot owners
    if (isMaintenanceMode() && !isBotOwner(msg.author.id)) {
      return msg.reply(`🛠️ ${getBotMessage('maintenanceMode')}`).catch(() => {});
    }

    const usage = (text) => msg.reply(`❌ **Usage:** \`${text}\``);

    // captain-only commands
    if (CAPTAIN_CMDS.includes(cmd) && !isCaptain(msg.member)) {
      return msg.reply('❌ Only **CAPTAIN** or **VICE CAPTAIN** can use this command.');
    }

    try {
      switch (cmd) {
        // =====================================================
        //  TEAM COMMANDS
        // =====================================================
        case 'sign': {
          const target = msg.mentions.members.first();
          if (!target) return usage(`${PREFIX}sign @user`);
          if (target.id === msg.author.id) return msg.reply("❌ You can't sign yourself!");
          if (target.user.bot) return msg.reply("❌ Bots can't join teams!");

          const cd = getCd(target.id);
          if (cd) return msg.reply(`⏳ **${target.user.username}** is locked by the transfer cooldown. Available again ${ts(cd)}.`);

          const teamRole = teamRolesOf(msg.member).first();
          if (!teamRole) return msg.reply('❌ You need a role ending with `| TEAM` to sign players!');
          if (target.roles.cache.has(teamRole.id)) return msg.reply(`❌ **${target.user.username}** is already on your team!`);

          const embed = new EmbedBuilder()
            .setColor(COLORS.gold)
            .setAuthor({ name: `${msg.author.username} sent you an offer`, iconURL: msg.author.displayAvatarURL() })
            .setTitle('📜  TRANSFER OFFER')
            .setDescription(`> **Do you want to join ${teamRole.name}?**\n> *A new chapter is waiting for you.*`)
            .addFields(
              { name: '🏆 Team', value: teamRole.name, inline: true },
              { name: '🧑‍💼 Offered by', value: `${msg.author}`, inline: true },
              { name: '👥 Members', value: `${teamRole.members.size}`, inline: true },
              { name: '🔒 Lock', value: `${tb.transferCooldownHours ?? 24} hours after signing`, inline: true },
            )
            .setThumbnail(msg.guild.iconURL())
            .setFooter({ text: msg.guild.name })
            .setTimestamp();

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`tb_accept|${pack(msg.guild.id, msg.channel.id, msg.author.id, teamRole.id, target.id)}`)
              .setLabel("Yes, I'm in!").setEmoji('✍️').setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`tb_decline|${pack(msg.guild.id, msg.channel.id, msg.author.id, teamRole.id, target.id)}`)
              .setLabel('No, thanks').setEmoji('🚫').setStyle(ButtonStyle.Danger),
          );

          return sendOffer(msg, target, embed, row);
        }

        case 'unsign': {
          const target = msg.mentions.members.first();
          if (!target) return usage(`${PREFIX}unsign @user`);
          if (target.id === msg.author.id) return msg.reply("❌ You can't unsign yourself!");
          if (target.user.bot) return msg.reply("❌ Bots aren't on teams!");

          const cd = getCd(target.id);
          if (cd) return msg.reply(`⏳ **${target.user.username}** is locked by the transfer cooldown. Available again ${ts(cd)}.`);

          const myTeams = teamRolesOf(msg.member);
          if (!myTeams.size) return msg.reply('❌ You need a role ending with `| TEAM` to use this command!');

          const shared = myTeams.find((r) => target.roles.cache.has(r.id));
          if (!shared) return msg.reply(`❌ **${target.user.username}** is not on your team!`);

          const embed = new EmbedBuilder()
            .setColor(COLORS.red)
            .setAuthor({ name: `${msg.author.username} is asking you something`, iconURL: msg.author.displayAvatarURL() })
            .setTitle('🚪  LEAVE THE TEAM?')
            .setDescription(`> **Do you want to leave ${shared.name}?**\n> This action can't be undone.`)
            .addFields(
              { name: '🏆 Team', value: shared.name, inline: true },
              { name: '🧑‍💼 Requested by', value: `${msg.author}`, inline: true },
              { name: '👥 Members', value: `${shared.members.size}`, inline: true },
            )
            .setThumbnail(msg.guild.iconURL())
            .setFooter({ text: msg.guild.name })
            .setTimestamp();

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`tb_leave_yes|${pack(msg.guild.id, msg.channel.id, msg.author.id, shared.id, target.id)}`)
              .setLabel("Yes, I'm leaving").setEmoji('🚪').setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId(`tb_leave_no|${pack(msg.guild.id, msg.channel.id, msg.author.id, shared.id, target.id)}`)
              .setLabel("No, I'll stay").setEmoji('🛡️').setStyle(ButtonStyle.Success),
          );

          return sendOffer(msg, target, embed, row);
        }

        case 'cd': {
          const target = msg.mentions.members.first();
          if (!target) return usage(`${PREFIX}cd @user`);
          if (!delCd(target.id)) return msg.reply(`ℹ️ **${target.user.username}** has no active cooldown.`);
          const embed = new EmbedBuilder()
            .setColor(COLORS.green)
            .setTitle('🔓  COOLDOWN REMOVED')
            .setDescription(`${target} can transfer again.\n\n**Removed by:** ${msg.author}`)
            .setTimestamp();
          return msg.channel.send({ embeds: [embed] });
        }

        // =====================================================
        //  RANKED (CAPTAIN / VICE CAPTAIN only)
        // =====================================================
        case 'ranked': {
          const teamRole = teamRolesOf(msg.member).first();
          if (!teamRole) return msg.reply('❌ You need a role ending with `| TEAM` to use this command!');

          // limit is shared by the whole team role and resets every day at 00:00
          const day = dayKey();
          let rec = ranked[teamRole.id];
          const last = rec && !Array.isArray(rec) ? rec.last || 0 : 0; // cooldown survives the daily reset
          if (!rec || Array.isArray(rec) || rec.day !== day) rec = { day, count: 0, last };
          if (rec.count >= RANKED_LIMIT) {
            return msg.reply(`⏳ **${teamRole.name}** already used \`${PREFIX}ranked\` **${RANKED_LIMIT} times** today. Resets ${ts(nextReset())}.`);
          }
          if (Date.now() - rec.last < RANKED_COOLDOWN_MS) {
            return msg.reply(`⏳ **${teamRole.name}** is on cooldown. You can use \`${PREFIX}ranked\` again ${ts(rec.last + RANKED_COOLDOWN_MS)}.`);
          }

          const allChannels = await msg.guild.channels.fetch().catch(() => msg.guild.channels.cache);
          const ch = allChannels.find((c) => c && c.isTextBased() && !c.isThread()
              && c.name.toLowerCase().includes(RANKED_CHANNEL_NAME))
            || (RANKED_CHANNEL_ID ? allChannels.get(RANKED_CHANNEL_ID) : null);
          if (!ch) return msg.reply(`❌ I can't find a channel with "${RANKED_CHANNEL_NAME}" in its name.`);

          const findRole = (name) => msg.guild.roles.cache.find((r) => r.name.trim().toLowerCase() === name);
          const pings = ALLOWED_ROLE_NAMES.map(findRole).filter(Boolean);

          const text = `${teamRole} is lf ranked dm ${msg.author}`
            + (pings.length ? `\n${pings.join(' ')}` : '');
          try {
            await ch.send({
              content: text,
              allowedMentions: { roles: [teamRole.id, ...pings.map((r) => r.id)], users: [msg.author.id] },
            });
          } catch (e) {
            logger.error(`Team bot: ranked send failed (${e.code}): ${e.message}`);
            return msg.reply(`❌ I couldn't post in ${ch}: ${e.message}`);
          }

          rec.count += 1;
          rec.last = Date.now();
          ranked[teamRole.id] = rec;
          saveRanked();
          const left = RANKED_LIMIT - rec.count;
          return msg.reply(`✅ Posted in ${ch}. **${teamRole.name}** has **${left}** use${left === 1 ? '' : 's'} left today.`);
        }

        // =====================================================
        //  ROLE COMMANDS
        // =====================================================
        case 'role': {
          if (!hasPerm(msg, PermissionFlagsBits.ManageRoles, 'Manage Roles')) return;
          const first = (args[0] || '').toLowerCase();
          const mode = ['add', 'remove'].includes(first) ? first : 'toggle';
          const rest = mode === 'toggle' ? args : args.slice(1);

          const member = await resolveMember(msg, rest[0]);
          if (!member) return usage(`${PREFIX}role [add|remove] @user <role>`);
          const role = resolveRole(msg, rest.slice(1).join(' '));
          if (!role) return msg.reply(`❌ Role not found. Usage: \`${PREFIX}role [add|remove] @user <role>\``);
          const err = roleError(msg, role, member);
          if (err) return msg.reply(`❌ ${err}`);

          const has = member.roles.cache.has(role.id);
          const action = mode === 'toggle' ? (has ? 'remove' : 'add') : mode;
          const quiet = { allowedMentions: { parse: [] } };

          if (action === 'add') {
            if (has) return msg.reply({ content: `ℹ️ **${member.user.username}** already has **${role.name}**.`, ...quiet });
            await member.roles.add(role, `${msg.author.username} used ${PREFIX}role`);
            return msg.reply({ content: `✅ Added **${role.name}** to **${member.user.username}**.`, ...quiet });
          }
          if (!has) return msg.reply({ content: `ℹ️ **${member.user.username}** doesn't have **${role.name}**.`, ...quiet });
          await member.roles.remove(role, `${msg.author.username} used ${PREFIX}role`);
          return msg.reply({ content: `✅ Removed **${role.name}** from **${member.user.username}**.`, ...quiet });
        }

        case 'addrole':
        case 'delrole': {
          if (!hasPerm(msg, PermissionFlagsBits.ManageRoles, 'Manage Roles')) return;
          const member = await resolveMember(msg, args[0]);
          if (!member) return usage(`${PREFIX}${cmd} @user <role>`);
          const role = resolveRole(msg, args.slice(1).join(' '));
          if (!role) return msg.reply('❌ Role not found.');
          const err = roleError(msg, role, member);
          if (err) return msg.reply(`❌ ${err}`);
          const quiet = { allowedMentions: { parse: [] } };
          if (cmd === 'addrole') {
            if (member.roles.cache.has(role.id)) return msg.reply({ content: `ℹ️ **${member.user.username}** already has **${role.name}**.`, ...quiet });
            await member.roles.add(role, `${msg.author.username} used ${PREFIX}addrole`);
            return msg.reply({ content: `✅ Added **${role.name}** to **${member.user.username}**.`, ...quiet });
          }
          if (!member.roles.cache.has(role.id)) return msg.reply({ content: `ℹ️ **${member.user.username}** doesn't have **${role.name}**.`, ...quiet });
          await member.roles.remove(role, `${msg.author.username} used ${PREFIX}delrole`);
          return msg.reply({ content: `✅ Removed **${role.name}** from **${member.user.username}**.`, ...quiet });
        }

        case 'temprole': {
          if (!hasPerm(msg, PermissionFlagsBits.ManageRoles, 'Manage Roles')) return;
          const member = await resolveMember(msg, args[0]);
          const duration = parseDuration(args[1]);
          if (!member || !duration) return usage(`${PREFIX}temprole @user <1h|2d|1w> <role>`);
          const role = resolveRole(msg, args.slice(2).join(' '));
          if (!role) return msg.reply('❌ Role not found.');
          const err = roleError(msg, role, member);
          if (err) return msg.reply(`❌ ${err}`);
          await member.roles.add(role, `${msg.author.username} used ${PREFIX}temprole`);
          timers.push({ type: 'role', guild: msg.guild.id, user: member.id, role: role.id, at: Date.now() + duration });
          saveTimers();
          return msg.reply({ content: `✅ **${role.name}** given to **${member.user.username}** for **${fmtDuration(duration)}**.`, allowedMentions: { parse: [] } });
        }

        case 'roles': {
          const list = msg.guild.roles.cache.filter((r) => r.id !== msg.guild.id)
            .sort((a, b) => b.position - a.position).map((r) => r.name);
          const e = new EmbedBuilder().setColor(COLORS.blue)
            .setTitle(`🎭 Roles (${list.length})`)
            .setDescription(list.join(', ').slice(0, 4000) || 'None');
          return msg.channel.send({ embeds: [e] });
        }

        case 'roleinfo': {
          const role = resolveRole(msg, args.join(' '));
          if (!role) return usage(`${PREFIX}roleinfo <role>`);
          const e = new EmbedBuilder().setColor(role.color || COLORS.blue).setTitle(role.name)
            .addFields(
              { name: '🆔 ID', value: role.id, inline: true },
              { name: '🎨 Color', value: role.hexColor, inline: true },
              { name: '👥 Members', value: `${role.members.size}`, inline: true },
              { name: '📌 Position', value: `${role.position}`, inline: true },
              { name: '📣 Mentionable', value: role.mentionable ? 'Yes' : 'No', inline: true },
              { name: '📅 Created', value: ts(role.createdTimestamp), inline: true },
            );
          return msg.channel.send({ embeds: [e] });
        }

        // =====================================================
        //  MODERATION
        // =====================================================
        case 'ban': {
          if (!hasPerm(msg, PermissionFlagsBits.BanMembers, 'Ban Members')) return;
          const id = msg.mentions.users.first()?.id || (/^\d{17,20}$/.test(args[0] || '') ? args[0] : null);
          if (!id) return usage(`${PREFIX}ban @user [reason]`);
          const reason = args.slice(1).join(' ') || 'No reason provided';

          const member = await msg.guild.members.fetch(id).catch(() => null);
          if (member) {
            const err = hierarchyError(msg, member);
            if (err) return msg.reply(`❌ ${err}`);
            if (!member.bannable) return msg.reply("❌ I can't ban that user (their role is above mine).");
            await dmAction(member.user, msg.guild, '🔨 You were banned', COLORS.red, reason);
          }
          const user = member?.user || (await client.users.fetch(id).catch(() => null));
          if (!user) return msg.reply('❌ User not found.');

          await msg.guild.members.ban(id, { reason: `${msg.author.username}: ${reason}` });
          return done(msg, modEmbed('🔨  USER BANNED', COLORS.red, user, msg.author, reason), 'BAN', user, reason);
        }

        case 'tempban': {
          if (!hasPerm(msg, PermissionFlagsBits.BanMembers, 'Ban Members')) return;
          const member = await resolveMember(msg, args[0]);
          const duration = parseDuration(args[1]);
          if (!member || !duration) return usage(`${PREFIX}tempban @user <1h|2d|1w> [reason]`);
          const reason = args.slice(2).join(' ') || 'No reason provided';
          const err = hierarchyError(msg, member);
          if (err) return msg.reply(`❌ ${err}`);
          if (!member.bannable) return msg.reply("❌ I can't ban that user (their role is above mine).");

          await dmAction(member.user, msg.guild, '⏳ You were temporarily banned', COLORS.red, reason,
            [{ name: '⏱️ Duration', value: fmtDuration(duration), inline: true }]);
          await msg.guild.members.ban(member.id, { reason: `Tempban by ${msg.author.username}: ${reason}` });
          timers.push({ type: 'unban', guild: msg.guild.id, user: member.id, at: Date.now() + duration });
          saveTimers();
          return done(msg, modEmbed('⏳  USER TEMPBANNED', COLORS.red, member.user, msg.author, reason,
            [{ name: '⏱️ Duration', value: `${fmtDuration(duration)} (ends ${ts(Date.now() + duration)})`, inline: true }]),
          'TEMPBAN', member.user, reason);
        }

        case 'softban': {
          if (!hasPerm(msg, PermissionFlagsBits.BanMembers, 'Ban Members')) return;
          const member = await resolveMember(msg, args[0]);
          if (!member) return usage(`${PREFIX}softban @user [reason]`);
          const reason = args.slice(1).join(' ') || 'No reason provided';
          const err = hierarchyError(msg, member);
          if (err) return msg.reply(`❌ ${err}`);
          if (!member.bannable) return msg.reply("❌ I can't ban that user (their role is above mine).");

          await dmAction(member.user, msg.guild, '🧹 You were softbanned', COLORS.orange, reason);
          await msg.guild.members.ban(member.id, { reason: `Softban by ${msg.author.username}: ${reason}`, deleteMessageSeconds: 7 * 24 * 3600 });
          await msg.guild.members.unban(member.id, 'Softban').catch(() => {});
          return done(msg, modEmbed('🧹  USER SOFTBANNED', COLORS.orange, member.user, msg.author, reason,
            [{ name: 'ℹ️ Info', value: 'Messages from the last 7 days deleted', inline: true }]),
          'SOFTBAN', member.user, reason);
        }

        case 'unban': {
          if (!hasPerm(msg, PermissionFlagsBits.BanMembers, 'Ban Members')) return;
          if (!/^\d{17,20}$/.test(args[0] || '')) return usage(`${PREFIX}unban <userID> [reason]`);
          const reason = args.slice(1).join(' ') || 'No reason provided';
          const user = await msg.guild.members.unban(args[0], `${msg.author.username}: ${reason}`).catch(() => null);
          if (!user) return msg.reply('❌ That user is not banned (or the ID is wrong).');
          timers = timers.filter((t) => !(t.type === 'unban' && t.user === user.id && t.guild === msg.guild.id));
          saveTimers();
          return done(msg, modEmbed('✅  USER UNBANNED', COLORS.green, user, msg.author, reason), 'UNBAN', user, reason);
        }

        case 'kick': {
          if (!hasPerm(msg, PermissionFlagsBits.KickMembers, 'Kick Members')) return;
          const member = await resolveMember(msg, args[0]);
          if (!member) return usage(`${PREFIX}kick @user [reason]`);
          const reason = args.slice(1).join(' ') || 'No reason provided';
          const err = hierarchyError(msg, member);
          if (err) return msg.reply(`❌ ${err}`);
          if (!member.kickable) return msg.reply("❌ I can't kick that user (their role is above mine).");

          await dmAction(member.user, msg.guild, '👢 You were kicked', COLORS.orange, reason);
          await member.kick(`${msg.author.username}: ${reason}`);
          return done(msg, modEmbed('👢  USER KICKED', COLORS.orange, member.user, msg.author, reason), 'KICK', member.user, reason);
        }

        case 'mute':
        case 'timeout': {
          if (!hasPerm(msg, PermissionFlagsBits.ModerateMembers, 'Timeout Members')) return;
          const member = await resolveMember(msg, args[0]);
          if (!member) return usage(`${PREFIX}mute @user [10m|2h|1d] [reason]`);
          const rest = args.slice(1);
          let duration = parseDuration(rest[0]);
          const reason = (duration ? rest.slice(1) : rest).join(' ') || 'No reason provided';
          if (!duration) duration = 10 * 60 * 1000; // default 10 minutes
          if (duration > 28 * 864e5) return msg.reply('❌ Maximum mute duration is **28 days**.');
          const err = hierarchyError(msg, member);
          if (err) return msg.reply(`❌ ${err}`);
          if (!member.moderatable) return msg.reply("❌ I can't mute that user (their role is above mine).");

          await member.timeout(duration, `${msg.author.username}: ${reason}`);
          await dmAction(member.user, msg.guild, '🔇 You were muted', COLORS.orange, reason,
            [{ name: '⏱️ Duration', value: fmtDuration(duration), inline: true }]);
          return done(msg, modEmbed('🔇  USER MUTED', COLORS.orange, member.user, msg.author, reason,
            [{ name: '⏱️ Duration', value: `${fmtDuration(duration)} (ends ${ts(Date.now() + duration)})`, inline: true }]),
          'MUTE', member.user, reason);
        }

        case 'unmute':
        case 'untimeout': {
          if (!hasPerm(msg, PermissionFlagsBits.ModerateMembers, 'Timeout Members')) return;
          const member = await resolveMember(msg, args[0]);
          if (!member) return usage(`${PREFIX}unmute @user [reason]`);
          const reason = args.slice(1).join(' ') || 'No reason provided';
          const uerr = hierarchyError(msg, member);
          if (uerr) return msg.reply(`❌ ${uerr}`);
          if (!member.isCommunicationDisabled()) return msg.reply('ℹ️ That user is not muted.');
          if (!member.moderatable) return msg.reply("❌ I can't unmute that user.");
          await member.timeout(null, `${msg.author.username}: ${reason}`);
          return done(msg, modEmbed('🔊  USER UNMUTED', COLORS.green, member.user, msg.author, reason), 'UNMUTE', member.user, reason);
        }

        case 'warn': {
          if (!hasPerm(msg, PermissionFlagsBits.ModerateMembers, 'Timeout Members')) return;
          const member = await resolveMember(msg, args[0]);
          if (!member) return usage(`${PREFIX}warn @user <reason>`);
          const reason = args.slice(1).join(' ');
          if (!reason) return usage(`${PREFIX}warn @user <reason>`);
          const err = hierarchyError(msg, member);
          if (err) return msg.reply(`❌ ${err}`);

          warns[msg.guild.id] ??= {};
          warns[msg.guild.id][member.id] ??= [];
          warns[msg.guild.id][member.id].push({ mod: msg.author.id, reason, time: Date.now() });
          saveWarns();
          const total = warns[msg.guild.id][member.id].length;

          await dmAction(member.user, msg.guild, '⚠️ You were warned', COLORS.gold, reason,
            [{ name: '📊 Total warnings', value: `${total}`, inline: true }]);
          return done(msg, modEmbed('⚠️  USER WARNED', COLORS.gold, member.user, msg.author, reason,
            [{ name: '📊 Total warnings', value: `${total}`, inline: true }]),
          'WARN', member.user, reason);
        }

        case 'warnings':
        case 'warns': {
          if (!hasPerm(msg, PermissionFlagsBits.ModerateMembers, 'Timeout Members')) return;
          const member = await resolveMember(msg, args[0]);
          if (!member) return usage(`${PREFIX}warnings @user`);
          const list = warns[msg.guild.id]?.[member.id] || [];
          if (!list.length) return msg.reply(`✅ **${member.user.username}** has no warnings.`);
          const lines = list.slice(-10).map((w, i) =>
            `**${list.length - Math.min(10, list.length) + i + 1}.** ${w.reason}\n> by <@${w.mod}> ${ts(w.time)}`);
          const e = new EmbedBuilder()
            .setColor(COLORS.gold)
            .setTitle(`⚠️  Warnings for ${member.user.username}`)
            .setThumbnail(member.user.displayAvatarURL())
            .setDescription(lines.join('\n\n'))
            .setFooter({ text: `Total: ${list.length}` });
          return msg.channel.send({ embeds: [e] });
        }

        case 'delwarn': {
          if (!hasPerm(msg, PermissionFlagsBits.ModerateMembers, 'Timeout Members')) return;
          const member = await resolveMember(msg, args[0]);
          const n = parseInt(args[1], 10);
          if (!member || !n) return usage(`${PREFIX}delwarn @user <warning number>`);
          const derr = hierarchyError(msg, member);
          if (derr) return msg.reply(`❌ ${derr}`);
          const list = warns[msg.guild.id]?.[member.id] || [];
          if (n < 1 || n > list.length) return msg.reply('❌ Invalid warning number.');
          list.splice(n - 1, 1);
          saveWarns();
          return msg.reply(`✅ Removed warning **#${n}** from **${member.user.username}**.`);
        }

        case 'clearwarns': {
          if (!hasPerm(msg, PermissionFlagsBits.ModerateMembers, 'Timeout Members')) return;
          const member = await resolveMember(msg, args[0]);
          if (!member) return usage(`${PREFIX}clearwarns @user`);
          const cerr = hierarchyError(msg, member);
          if (cerr) return msg.reply(`❌ ${cerr}`);
          if (warns[msg.guild.id]?.[member.id]) { delete warns[msg.guild.id][member.id]; saveWarns(); }
          return msg.reply(`✅ Cleared all warnings of **${member.user.username}**.`);
        }

        case 'note': {
          if (!hasPerm(msg, PermissionFlagsBits.ModerateMembers, 'Timeout Members')) return;
          const member = await resolveMember(msg, args[0]);
          const text = args.slice(1).join(' ');
          if (!member || !text) return usage(`${PREFIX}note @user <text>`);
          addCase(msg.guild.id, member.id, 'NOTE', msg.author.id, text);
          return msg.reply(`📝 Note added to **${member.user.username}**.`);
        }

        case 'modlogs':
        case 'notes': {
          if (!hasPerm(msg, PermissionFlagsBits.ModerateMembers, 'Timeout Members')) return;
          const member = await resolveMember(msg, args[0]);
          if (!member) return usage(`${PREFIX}${cmd} @user`);
          let list = cases[msg.guild.id]?.[member.id] || [];
          if (cmd === 'notes') list = list.filter((c) => c.type === 'NOTE');
          if (!list.length) return msg.reply(`✅ **${member.user.username}** has no ${cmd === 'notes' ? 'notes' : 'mod logs'}.`);
          const lines = list.slice(-10).map((c) => `**${c.type}** — ${c.reason}\n> by <@${c.mod}> ${ts(c.time)}`);
          const e = new EmbedBuilder()
            .setColor(COLORS.blue)
            .setTitle(`📋  ${cmd === 'notes' ? 'Notes' : 'Mod logs'} for ${member.user.username}`)
            .setThumbnail(member.user.displayAvatarURL())
            .setDescription(lines.join('\n\n').slice(0, 4000))
            .setFooter({ text: `Total: ${list.length}` });
          return msg.channel.send({ embeds: [e] });
        }

        case 'purge':
        case 'clean':
        case 'clear': {
          if (!hasPerm(msg, PermissionFlagsBits.ManageMessages, 'Manage Messages')) return;
          const n = parseInt(args[0], 10);
          if (!n || n < 1 || n > 1000) return usage(`${PREFIX}purge <1-1000> [@user | bots]`);
          const only = msg.mentions.users.first();
          const botsOnly = (args[1] || '').toLowerCase() === 'bots';
          await msg.delete().catch(() => {});

          let deleted = 0;
          if (only || botsOnly) {
            const fetched = await msg.channel.messages.fetch({ limit: 100 });
            const list = [...fetched.filter((m) => (only ? m.author.id === only.id : m.author.bot)).values()].slice(0, n);
            if (list.length) deleted = (await msg.channel.bulkDelete(list, true)).size;
          } else {
            let remaining = n;
            while (remaining > 0) {
              const batch = Math.min(remaining, 100);
              const d = await msg.channel.bulkDelete(batch, true);
              deleted += d.size;
              if (d.size < batch) break; // older than 14 days or nothing left
              remaining -= batch;
            }
          }
          const note = await msg.channel.send(`🧹 Deleted **${deleted}** messages.`);
          setTimeout(() => note.delete().catch(() => {}), 4000);
          return modLog(msg.guild, new EmbedBuilder()
            .setColor(COLORS.blue).setTitle('🧹  MESSAGES PURGED')
            .addFields(
              { name: '🛡️ Moderator', value: `${msg.author}`, inline: true },
              { name: '📍 Channel', value: `${msg.channel}`, inline: true },
              { name: '🗑️ Deleted', value: `${deleted}`, inline: true },
            ).setTimestamp());
        }

        case 'slowmode': {
          if (!hasPerm(msg, PermissionFlagsBits.ManageChannels, 'Manage Channels')) return;
          const sec = parseInt(args[0], 10);
          if (isNaN(sec) || sec < 0 || sec > 21600) return usage(`${PREFIX}slowmode <0-21600 seconds>`);
          await msg.channel.setRateLimitPerUser(sec);
          return msg.reply(sec === 0 ? '✅ Slowmode **disabled**.' : `✅ Slowmode set to **${sec}s**.`);
        }

        case 'lock': {
          if (!hasPerm(msg, PermissionFlagsBits.ManageChannels, 'Manage Channels')) return;
          await msg.channel.permissionOverwrites.edit(msg.guild.roles.everyone, { SendMessages: false });
          return msg.channel.send(`🔒 **Channel locked.** Use \`${PREFIX}unlock\` to open it again.`);
        }

        case 'unlock': {
          if (!hasPerm(msg, PermissionFlagsBits.ManageChannels, 'Manage Channels')) return;
          await msg.channel.permissionOverwrites.edit(msg.guild.roles.everyone, { SendMessages: null });
          return msg.channel.send('🔓 **Channel unlocked.**');
        }

        case 'nick': {
          if (!hasPerm(msg, PermissionFlagsBits.ManageNicknames, 'Manage Nicknames')) return;
          const member = await resolveMember(msg, args[0]);
          if (!member) return usage(`${PREFIX}nick @user [new nickname]`);
          const err = hierarchyError(msg, member);
          if (err && member.id !== msg.author.id) return msg.reply(`❌ ${err}`);
          if (!member.manageable) return msg.reply("❌ I can't change that user's nickname.");
          const nick = args.slice(1).join(' ').slice(0, 32) || null;
          await member.setNickname(nick);
          return msg.reply(nick ? `✅ Nickname changed to **${nick}**.` : '✅ Nickname reset.');
        }

        case 'say': {
          if (!hasPerm(msg, PermissionFlagsBits.ManageMessages, 'Manage Messages')) return;
          const text = args.join(' ');
          if (!text) return usage(`${PREFIX}say <message>`);
          await msg.delete().catch(() => {});
          return msg.channel.send({ content: text, allowedMentions: { parse: [] } });
        }

        case 'announce': {
          if (!hasPerm(msg, PermissionFlagsBits.ManageMessages, 'Manage Messages')) return;
          const ch = msg.mentions.channels.first();
          const text = args.slice(1).join(' ');
          if (!ch || !text) return usage(`${PREFIX}announce #channel <message>`);
          const e = new EmbedBuilder().setColor(COLORS.blue).setTitle('📢  Announcement')
            .setDescription(text).setFooter({ text: msg.guild.name }).setTimestamp();
          await ch.send({ embeds: [e] });
          return msg.react('✅').catch(() => {});
        }

        // =====================================================
        //  INFO
        // =====================================================
        case 'ping':
          return msg.reply(`🏓 Pong! **${client.ws.ping}ms**`);

        case 'avatar': {
          const user = msg.mentions.users.first() || msg.author;
          const e = new EmbedBuilder()
            .setColor(COLORS.blue)
            .setTitle(`${user.username}'s avatar`)
            .setImage(user.displayAvatarURL({ size: 1024 }));
          return msg.channel.send({ embeds: [e] });
        }

        case 'membercount':
          return msg.reply(`👥 **${msg.guild.memberCount}** members`);

        case 'userinfo': {
          const member = (await resolveMember(msg, args[0])) || msg.member;
          const roles = member.roles.cache.filter((r) => r.id !== msg.guild.id)
            .sort((a, b) => b.position - a.position).map((r) => `${r}`);
          const e = new EmbedBuilder()
            .setColor(member.displayColor || COLORS.blue)
            .setTitle(member.user.username)
            .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
            .addFields(
              { name: '🆔 ID', value: member.id, inline: true },
              { name: '📅 Created', value: ts(member.user.createdTimestamp), inline: true },
              { name: '📥 Joined', value: ts(member.joinedTimestamp), inline: true },
              { name: `🎭 Roles (${roles.length})`, value: roles.slice(0, 15).join(' ') || 'None' },
            );
          return msg.channel.send({ embeds: [e] });
        }

        case 'serverinfo': {
          const g = msg.guild;
          const owner = await g.fetchOwner().catch(() => null);
          const e = new EmbedBuilder()
            .setColor(COLORS.blue)
            .setTitle(g.name)
            .setThumbnail(g.iconURL())
            .addFields(
              { name: '👑 Owner', value: owner ? `${owner}` : 'Unknown', inline: true },
              { name: '👥 Members', value: `${g.memberCount}`, inline: true },
              { name: '💬 Channels', value: `${g.channels.cache.size}`, inline: true },
              { name: '🎭 Roles', value: `${g.roles.cache.size}`, inline: true },
              { name: '🚀 Boosts', value: `${g.premiumSubscriptionCount || 0}`, inline: true },
              { name: '📅 Created', value: ts(g.createdTimestamp), inline: true },
            )
            .setFooter({ text: `ID: ${g.id}` });
          return msg.channel.send({ embeds: [e] });
        }

        case 'help': {
          const p = PREFIX;
          const e = new EmbedBuilder()
            .setColor(COLORS.blue)
            .setTitle('📖  Commands')
            .setDescription(`Prefix: \`${p}\``)
            .addFields(
              { name: '🏆 Team (CAPTAIN / VICE CAPTAIN)',
                value: `\`${p}sign @user\` \`${p}unsign @user\` \`${p}cd @user\`` },
              { name: '🎮 Ranked (CAPTAIN / VICE CAPTAIN)',
                value: `\`${p}ranked\` (${RANKED_LIMIT} per team per day, ${Math.round(RANKED_COOLDOWN_MS / 60000)} min cooldown)` },
              { name: '🎭 Roles',
                value: `\`${p}role @user <role>\` (toggle) \`${p}role add|remove @user <role>\`\n`
                     + `\`${p}addrole\` \`${p}delrole\` \`${p}temprole @user <1h|2d> <role>\` \`${p}roles\` \`${p}roleinfo <role>\`` },
              { name: '🔨 Moderation',
                value: `\`${p}ban\` \`${p}tempban @user <1d>\` \`${p}softban\` \`${p}unban <id>\` \`${p}kick\`\n`
                     + `\`${p}mute @user [10m|2h|1d] [reason]\` \`${p}unmute\`\n`
                     + `\`${p}warn\` \`${p}warnings\` \`${p}delwarn @user <#>\` \`${p}clearwarns\`\n`
                     + `\`${p}note @user <text>\` \`${p}notes\` \`${p}modlogs\`` },
              { name: '🧹 Management',
                value: `\`${p}purge <1-1000> [@user|bots]\` \`${p}slowmode <sec>\` \`${p}lock\` \`${p}unlock\`\n`
                     + `\`${p}nick @user [name]\` \`${p}say <text>\` \`${p}announce #channel <text>\`` },
              { name: 'ℹ️ Info',
                value: `\`${p}userinfo [@user]\` \`${p}serverinfo\` \`${p}avatar [@user]\` \`${p}membercount\` \`${p}ping\`` },
            )
            .setFooter({ text: botConfig.embeds?.footer?.text || 'Team Bot' });
          return msg.channel.send({ embeds: [e] });
        }

        default:
          return;
      }
    } catch (err) {
      logger.error(`Team bot: error in ${PREFIX}${cmd}:`, err);
    }
  });

  // ---------- buttons (work inside DMs) ----------
  client.on('interactionCreate', async (i) => {
    if (!i.isButton()) return;
    const [rawAction, ...packed] = i.customId.split('|');
    if (!rawAction.startsWith('tb_')) return; // not ours -> leave it to the rest of the bot
    const action = rawAction.slice(3);
    if (!['accept', 'decline', 'leave_yes', 'leave_no'].includes(action)) return;
    if (packed.length !== 5 || packed.some((x) => !/^[0-9a-z]+$/.test(x))) {
      return i.reply({ content: '❌ This offer is outdated. Ask for a new one.', ephemeral: true });
    }
    const [guildId, channelId, otherId, roleId, targetId] = packed.map(dec);
    if (targetId && i.user.id !== targetId) return i.reply({ content: "❌ This offer isn't for you.", ephemeral: true });

    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return i.reply({ content: '❌ Server not found.', ephemeral: true });
    const member = await guild.members.fetch(i.user.id).catch(() => null);
    if (!member) return i.reply({ content: '❌ You are not in that server anymore.', ephemeral: true });
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    const role = guild.roles.cache.get(roleId);
    const roleName = role ? role.name : 'the team';

    const finish = (embed) => i.update({ embeds: [embed], components: [] });
    const announce = (embed) => channel?.send({ embeds: [embed] }).catch(() => {});

    // ----- accept (cooldown starts here) -----
    if (action === 'accept') {
      const cd = getCd(i.user.id);
      if (cd) return i.reply({ content: `⏳ You are on cooldown! Available again ${ts(cd)}.`, ephemeral: true });
      if (!role) return i.reply({ content: '❌ That team role no longer exists.', ephemeral: true });

      try {
        const old = teamRolesOf(member);
        if (old.size) await member.roles.remove(old);
        await member.roles.add(role);
      } catch {
        return i.reply({ content: `❌ ${getBotMessage('missingPermissions')} (Bot role must be above team roles with Manage Roles.)`, ephemeral: true });
      }
      const until = setCd(i.user.id);
      const count = countWith(role, member.id);

      await finish(new EmbedBuilder()
        .setColor(COLORS.green).setTitle('🎉  WELCOME TO THE TEAM')
        .setDescription(`You are now part of **${roleName}**.\n\n🔒 Transfer lock ends ${ts(until)}.`)
        .addFields({ name: '👥 Members', value: `${count}`, inline: true })
        .setFooter({ text: guild.name }).setTimestamp());

      return announce(new EmbedBuilder()
        .setColor(COLORS.green).setTitle('✅  TRANSFER COMPLETE')
        .setDescription(`🔥 ${i.user} has signed with **${roleName}**!\n\n> *Welcome to the family.*`)
        .addFields(
          { name: '🏆 Team', value: roleName, inline: true },
          { name: '🧑‍💼 Signed by', value: `<@${otherId}>`, inline: true },
          { name: '👥 Members', value: `${count}`, inline: true },
          { name: '🔒 Lock ends', value: ts(until), inline: true },
        )
        .setThumbnail(i.user.displayAvatarURL()).setFooter({ text: guild.name }).setTimestamp());
    }

    // ----- decline (NO cooldown) -----
    if (action === 'decline') {
      await finish(new EmbedBuilder()
        .setColor(COLORS.red).setTitle('🚫  OFFER DECLINED')
        .setDescription('You turned the offer down.').setFooter({ text: guild.name }).setTimestamp());
      return announce(new EmbedBuilder()
        .setColor(COLORS.red).setTitle('🚫  OFFER DECLINED')
        .setDescription(`${i.user} turned down the offer from <@${otherId}>.\n\n> *Not every road leads to the same place.*`)
        .setThumbnail(i.user.displayAvatarURL()).setFooter({ text: guild.name }).setTimestamp());
    }

    // ----- leave yes (NO cooldown) -----
    if (action === 'leave_yes') {
      try {
        const old = teamRolesOf(member); // removes EVERY role ending with | TEAM
        if (old.size) await member.roles.remove(old);
      } catch {
        return i.reply({ content: `❌ ${getBotMessage('missingPermissions')} (Bot role must be above team roles with Manage Roles.)`, ephemeral: true });
      }
      const count = role ? countWithout(role, member.id) : 0;

      await finish(new EmbedBuilder()
        .setColor(COLORS.red).setTitle('👋  YOU LEFT THE TEAM')
        .setDescription(`You are no longer part of **${roleName}**.`)
        .setFooter({ text: guild.name }).setTimestamp());

      return announce(new EmbedBuilder()
        .setColor(COLORS.red).setTitle('🚪  PLAYER LEFT')
        .setDescription(`${i.user} has left **${roleName}**.\n\n> *Every ending is a new beginning.*`)
        .addFields(
          { name: '🏆 Former team', value: roleName, inline: true },
          { name: '🧑‍💼 Requested by', value: `<@${otherId}>`, inline: true },
          { name: '👥 Members left', value: `${count}`, inline: true },
        )
        .setThumbnail(i.user.displayAvatarURL()).setFooter({ text: guild.name }).setTimestamp());
    }

    // ----- leave no (NO cooldown) -----
    if (action === 'leave_no') {
      await finish(new EmbedBuilder()
        .setColor(COLORS.green).setTitle('🛡️  STAYING PUT')
        .setDescription('Good choice. Loyalty wins. 💪').setFooter({ text: guild.name }).setTimestamp());
      return announce(new EmbedBuilder()
        .setColor(COLORS.green).setTitle('🛡️  STAYING PUT')
        .setDescription(`${i.user} decided to stay with **${roleName}**.\n\n> *Loyalty wins.* 💪`)
        .setThumbnail(i.user.displayAvatarURL()).setFooter({ text: guild.name }).setTimestamp());
    }
  });
}
