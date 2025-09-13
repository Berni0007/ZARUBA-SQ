import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';
import dns from 'node:dns';
import { setGlobalDispatcher, ProxyAgent, request } from 'undici';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });
// Prefer IPv4 to reduce connection delays on some networks (configurable)
let IPV4_FIRST_ENABLED = false;
try {
  const ipv4FirstEnv = (process.env.DNS_IPV4FIRST ?? 'true').toLowerCase();
  if (ipv4FirstEnv === '1' || ipv4FirstEnv === 'true' || ipv4FirstEnv === 'yes') {
    dns.setDefaultResultOrder('ipv4first');
    IPV4_FIRST_ENABLED = true;
  }
} catch (_) {}

// Optional proxy support (allows routing via custom host:port, not forcing 443 directly)
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
try {
  if (PROXY_URL) {
    setGlobalDispatcher(new ProxyAgent(PROXY_URL));
    console.log('[BOT] Proxy enabled via', PROXY_URL);
  }
} catch (e) {
  console.warn('[BOT] Failed to set proxy agent:', e?.message || e);
}

// Filter specific noisy warnings while keeping other warnings visible
process.on('warning', (w) => {
  const msg = String(w?.message || '');
  if (w?.name === 'ExperimentalWarning' && msg.includes('buffer.File')) return;
  if (w?.name === 'DeprecationWarning' && msg.includes('ready event has been renamed to clientReady')) return;
  // Let other warnings pass through visibly
  console.warn(w);
});

const MAX_PLAYERS = 100;

// Display names for servers (5th is RUBAS Vanilla+)
const SERVER_NAMES = ['ZARUBA 1','ZARUBA 2','ZARUBA 3','ZARUBA 4','RUBAS Vanilla+'];

// Optional REST customization to avoid hard dependency on default https:443
const DISCORD_API_BASE = process.env.DISCORD_API_BASE || 'https://discord.com/api';
const DISCORD_API_VERSION = process.env.DISCORD_API_VERSION || '10';

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

// Startup diagnostics
try {
  console.log('[BOT] Using script:', __filename);
  console.log('[BOT] Node:', process.version);
  console.log('[BOT] DNS ipv4first:', IPV4_FIRST_ENABLED);
  console.log('[BOT] Proxy:', PROXY_URL ? 'enabled' : 'disabled');
  console.log('[BOT] REST:', DISCORD_API_BASE, 'v' + DISCORD_API_VERSION);
} catch (_) {}

// --- Reliability helpers ---
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isTransientError(err) {
  const msg = String(err?.message || err || '');
  return (
    msg.includes('Timeout') ||
    msg.includes('UND_ERR_CONNECT_TIMEOUT') ||
    msg.includes('UND_ERR_HEADERS_TIMEOUT') ||
    msg.includes('UND_ERR_SOCKET') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ENETUNREACH') ||
    msg.includes('EAI_AGAIN') ||
    msg.includes('FetchError') ||
    msg.includes('connect ECONNREFUSED')
  );
}

async function withRetry(fn, { attempts = 3, baseDelay = 500, onRetry } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isTransientError(e) || i === attempts - 1) throw e;
      try { if (typeof onRetry === 'function') onRetry(i + 1, e); } catch (_) {}
      await sleep(baseDelay * Math.pow(2, i));
    }
  }
  throw lastErr;
}

async function fetchChannelWithRetry(client, id) {
  return withRetry(() => client.channels.fetch(id), { attempts: 5, baseDelay: 1000 });
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
    // Normalize to 5 items by idx
    const out = [];
    for (let i = 0; i < 5; i++) {
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
    return new Array(5).fill(0).map((_, i) => ({ idx: i, players: null, queue: null, map: null, playTimeSec: null }));
  }
}

async function readLinks() {
  const file = path.join(ROOT, 'links.txt');
  try {
    const text = await readFile(file, 'utf8');
    const lines = text.split(/\r?\n/).map(s => (s || '').trim());
    const arr = [];
    for (let i = 0; i < 5; i++) {
      const link = (lines[i] || '').trim();
      const ok = typeof link === 'string' && link.startsWith('steam://joinlobby/');
      arr.push({ ok, steam: ok ? link : '' });
    }
    return arr;
  } catch (e) {
    console.warn('[BOT] Failed to read links.txt:', e.message);
    return new Array(5).fill(0).map(() => ({ ok: false, steam: '' }));
  }
}

function buildEmbeds(playersArr, linksArr) {
  const embeds = [];
  const logoRef = `attachment://${LOGO_FILE}`;
  for (let i = 0; i < 5; i++) {
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

    const displayName = SERVER_NAMES[i] || `ZARUBA ${i + 1}`;
    const title = (displayName === 'RUBAS Vanilla+') ? 'RUBAS Vanilla+' : `Сервер ${displayName}`;
    const embed = new EmbedBuilder()
      .setColor(color)
      .setAuthor({ name: 'ZARUBA', iconURL: logoRef })
      .setTitle(title)
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
    const messages = await withRetry(() => channel.messages.fetch({ limit: 50 }), { attempts: 3, baseDelay: 700 });
    const myId = client.user?.id;
    if (!myId) return;
    const toDelete = messages.filter(m => m?.author?.id === myId && Array.isArray(m?.embeds) && m.embeds.length > 0);
    for (const [, msg] of toDelete) {
      try {
        if (msg.deletable) {
          await withRetry(() => msg.delete(), { attempts: 3, baseDelay: 500 });
          await sleep(250);
        }
      } catch (_) { /* ignore */ }
    }
  } catch (e) {
    console.warn('[BOT] Cleanup failed:', e.message);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  rest: {
    timeout: 30_000,
    retries: 3,
    api: DISCORD_API_BASE,
    version: DISCORD_API_VERSION,
  },
});
let postedMessageIds = [];
let isRunning = false;
let lastDeepCleanupAt = 0;

// Gateway/WebSocket resilience and logging
client.on('shardError', (error, shardId) => {
  const msg = error?.message || error?.code || String(error);
  console.warn('[BOT] shardError', shardId, '-', msg);
});
client.on('shardDisconnect', (event, shardId) => {
  console.warn('[BOT] shardDisconnect', shardId, '-', event?.code, event?.reason || '');
});
client.on('shardReconnecting', (shardId) => {
  console.log('[BOT] shardReconnecting', shardId);
});
client.on('shardReady', (shardId) => {
  console.log('[BOT] shardReady', shardId);
});
client.on('error', (err) => {
  console.warn('[BOT] Client error:', err?.message || err);
});

process.on('unhandledRejection', (reason) => {
  if (isTransientError(reason)) {
    console.warn('[BOT] Suppressed transient unhandledRejection:', String(reason?.message || reason));
  } else {
    console.error('[BOT] Unhandled rejection:', reason);
  }
});
process.on('uncaughtException', (err) => {
  if (isTransientError(err)) {
    console.warn('[BOT] Suppressed transient uncaughtException:', err?.message || err);
  } else {
    console.error('[BOT] Uncaught exception:', err);
  }
});

async function maybeDeepCleanup(channel) {
  const now = Date.now();
  if (now - lastDeepCleanupAt < 10 * 60_000) return;
  lastDeepCleanupAt = now;
  await cleanupPreviousEmbeds(channel);
}

async function cycle(channel) {
  if (isRunning) {
    console.warn('[BOT] Skip cycle: previous run still in progress');
    return;
  }
  isRunning = true;
  try {
    // Delete previous messages (best-effort, with retry and pacing)
    for (const id of postedMessageIds) {
      try {
        const msg = await withRetry(() => channel.messages.fetch(id), { attempts: 3, baseDelay: 500 });
        if (msg && msg.deletable) {
          await withRetry(() => msg.delete(), { attempts: 3, baseDelay: 500 });
          await sleep(250);
        }
      } catch (_) { /* ignore */ }
    }
    postedMessageIds = [];

    // Additional cleanup across restarts: remove previous embeds by this bot from recent history (not more often than every 10 minutes)
    await maybeDeepCleanup(channel);

    const players = await readPlayers();
    const links = await readLinks();
    const embeds = buildEmbeds(players, links);

    for (const embed of embeds) {
      try {
        const sent = await withRetry(() => channel.send({ embeds: [embed], files: [LOGO_PATH] }), { attempts: 3, baseDelay: 700 });
        postedMessageIds.push(sent.id);
        await sleep(200);
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

// --- Preflight and resilient login ---
async function preflightDiscord() {
  try {
    const url = `${DISCORD_API_BASE.replace(/\/$/, '')}/v${DISCORD_API_VERSION}/gateway`;
    const res = await request(url, {
      headersTimeout: 15_000,
      bodyTimeout: 15_000,
      maxRedirections: 0,
    });
    return res.statusCode >= 200 && res.statusCode < 500;
  } catch (_) {
    return false;
  }
}

async function loginWithRetry(token) {
  return withRetry(() => client.login(token), { attempts: 5, baseDelay: 2000 });
}

client.once('clientReady', async () => {
  console.log(`[BOT] Logged in as ${client.user?.tag}`);
  try {
    const channel = await fetchChannelWithRetry(client, CHANNEL_ID);
    if (!channel || !('send' in channel)) {
      console.error('[BOT] Channel not found or cannot send messages');
      setTimeout(() => process.exit(1), 5_000);
      return;
    }
    await cycle(channel);
    setInterval(() => cycle(channel), 60_000);
  } catch (e) {
    console.error('[BOT] Startup error:', e);
    setTimeout(() => process.exit(1), 5_000);
  }
});

(async () => {
  const ok = await preflightDiscord();
  if (!ok) {
    console.warn('[BOT] Preflight to Discord API failed; proceeding with login retries');
  }
  try {
    await loginWithRetry(DISCORD_TOKEN);
  } catch (err) {
    console.error('[BOT] Login failed after retries:', err);
    setTimeout(() => process.exit(1), 5_000);
  }
})();
