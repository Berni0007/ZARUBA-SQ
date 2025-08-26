import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const MAX_PLAYERS = 100;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';
// Optional: Base URL to your site to link s1c/s2c pages like http://host/s1c/
const JOIN_BASE = (process.env.DISCORD_JOIN_BASE || 'http://212.22.93.230:8080').replace(/\/$/, '');
// Logo attachment to beautify embeds
const LOGO_FILE = 'logo.png';
const LOGO_PATH = path.join(ROOT, LOGO_FILE);

if (!DISCORD_TOKEN || !CHANNEL_ID) {
  console.error('[BOT] Missing env vars. Required: DISCORD_TOKEN, DISCORD_CHANNEL_ID');
  console.error('[BOT] Optional: DISCORD_JOIN_BASE (e.g., http://localhost:8080)');
  process.exit(1);
}

function formatPlayTime(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s < 0) return '—:—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h + ':' + String(m).padStart(2, '0');
}

async function readPlayers() {
  const file = path.join(ROOT, 'players.json');
  try {
    const text = await readFile(file, 'utf8');
    const json = JSON.parse(text);
    const arr = Array.isArray(json?.results) ? json.results : [];
    // Normalize to 4 items by idx
    const out = [];
    for (let i = 0; i < 4; i++) {
      const r = arr.find(x => Number(x?.idx) === i) || {};
      out.push({
        idx: i,
        players: Number.isFinite(Number(r?.players ?? r?.value)) ? Number(r?.players ?? r?.value) : null,
        queue: Number.isFinite(Number(r?.queue)) ? Number(r?.queue) : null,
        map: typeof r?.map === 'string' && r.map.trim() ? r.map.trim() : null,
        playTimeSec: Number.isFinite(Number(r?.playTimeSec)) ? Number(r?.playTimeSec) : null,
      });
    }
    return out;
  } catch (e) {
    console.warn('[BOT] Failed to read players.json:', e.message);
    return new Array(4).fill(0).map((_, i) => ({ idx: i, players: null, queue: null, map: null, playTimeSec: null }));
  }
}

async function readLinks() {
  const file = path.join(ROOT, 'links.txt');
  try {
    const text = await readFile(file, 'utf8');
    const lines = text.split(/\r?\n/).map(s => (s || '').trim());
    const arr = [];
    for (let i = 0; i < 4; i++) {
      const link = (lines[i] || '').trim();
      const ok = typeof link === 'string' && link.startsWith('steam://joinlobby/');
      arr.push({ ok, steam: ok ? link : '' });
    }
    return arr;
  } catch (e) {
    console.warn('[BOT] Failed to read links.txt:', e.message);
    return new Array(4).fill(0).map(() => ({ ok: false, steam: '' }));
  }
}

function buildEmbeds(playersArr, linksArr) {
  const embeds = [];
  const logoRef = `attachment://${LOGO_FILE}`;
  for (let i = 0; i < 4; i++) {
    const p = playersArr[i] || {};
    const l = linksArr[i] || { ok: false, steam: '' };

    const onlineText = (p.players != null ? p.players : '—') + '/' + MAX_PLAYERS;
    const queueText = (p.queue != null ? p.queue : '—').toString();
    const mapText = p.map || '—';
    const timeText = formatPlayTime(p.playTimeSec);

    // Use site redirect pages s1c/s2c/... only when a valid link exists; no steam:// fallback
    let joinUrl = '';
    if (l.ok) {
      joinUrl = `${JOIN_BASE}/s${i + 1}c/`;
    }
    const joinDisplay = joinUrl ? `[Подключиться](${joinUrl})` : '`Подключиться`';

    const color = (l && l.ok) ? 0x10B981 : 0xEF4444; // green if can join, red if no link

    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: 'ZARUBA', iconURL: logoRef })
      .setTitle(`Сервер ZARUBA ${i + 1}`)
      .setDescription(joinDisplay)
      .setThumbnail(logoRef)
      .addFields(
        { name: '👥 Онлайн', value: `**${onlineText}**`, inline: true },
        { name: '⏳ Очередь', value: `**${queueText}**`, inline: true },
        { name: '🗺️ Карта', value: mapText, inline: false },
        { name: '⏱️ Время', value: timeText, inline: true },
      )
      .setFooter({ text: 'Обновляется каждую минуту', iconURL: logoRef })
      .setTimestamp(new Date());

    if (joinUrl) {
      try { embed.setURL(joinUrl); } catch (_) { /* ignore invalid URL */ }
    }

    embeds.push(embed);
  }
  return embeds;
}

async function cleanupPreviousEmbeds(channel) {
  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    const myId = client.user?.id;
    if (!myId) return;
    const toDelete = messages.filter(m => m?.author?.id === myId && Array.isArray(m?.embeds) && m.embeds.length > 0);
    for (const [, msg] of toDelete) {
      try {
        if (msg.deletable) await msg.delete();
      } catch (_) { /* ignore */ }
    }
  } catch (e) {
    console.warn('[BOT] Cleanup failed:', e.message);
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
let postedMessageIds = [];
let isRunning = false;

async function cycle(channel) {
  if (isRunning) {
    console.warn('[BOT] Skip cycle: previous run still in progress');
    return;
  }
  isRunning = true;
  try {
    // Delete previous messages (best-effort)
    for (const id of postedMessageIds) {
      try {
        const msg = await channel.messages.fetch(id);
        if (msg && msg.deletable) await msg.delete();
      } catch (_) { /* ignore */ }
    }
    postedMessageIds = [];

    // Additional cleanup across restarts: remove previous embeds by this bot from recent history
    await cleanupPreviousEmbeds(channel);

    const players = await readPlayers();
    const links = await readLinks();
    const embeds = buildEmbeds(players, links);

    for (const embed of embeds) {
      try {
        const sent = await channel.send({ embeds: [embed], files: [LOGO_PATH] });
        postedMessageIds.push(sent.id);
      } catch (e) {
        console.error('[BOT] Failed to send embed:', e.message);
      }
    }
  } catch (e) {
    console.error('[BOT] Cycle error:', e);
  } finally {
    isRunning = false;
  }
}

client.once('ready', async () => {
  console.log(`[BOT] Logged in as ${client.user?.tag}`);
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel || !('send' in channel)) {
      console.error('[BOT] Channel not found or cannot send messages');
      process.exit(1);
    }
    await cycle(channel);
    setInterval(() => cycle(channel), 60_000);
  } catch (e) {
    console.error('[BOT] Startup error:', e);
    process.exit(1);
  }
});

client.login(DISCORD_TOKEN).catch(err => {
  console.error('[BOT] Login failed:', err);
  process.exit(1);
});
