import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const APP_ID = '393380'; // Squad
const BM_TOKEN = process.env.BM_TOKEN || process.env.BATTLEMETRICS_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbiI6ImM0Y2VhNDQ2MTMxMDIyMzAiLCJpYXQiOjE3NTU3MzU2NTAsIm5iZiI6MTc1NTczNTY1MCwiaXNzIjoiaHR0cHM6Ly93d3cuYmF0dGxlbWV0cmljcy5jb20iLCJzdWIiOiJ1cm46dXNlcjoxMDU0OTAxIn0.xQKibQ5UmFRKEJ5Y9wX31D48Sa47k70w_NeTfcVimWs';
const STEAM_API_KEY = process.env.STEAM_API_KEY || process.env.STEAM_KEY || '7B1DCE29B0B4A39D3A5817F8204EB89B';
const _ENV_SAMPLE = Number(process.env.LOBBY_SAMPLE_SIZE || process.env.LINKS_SAMPLE_SIZE);
const LOBBY_SAMPLE_SIZE = Number.isFinite(_ENV_SAMPLE) ? Math.max(1, Math.min(100, _ENV_SAMPLE)) : 20;
console.log('[LINKS-CRON] LOBBY_SAMPLE_SIZE =', LOBBY_SAMPLE_SIZE);

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function readBMIds() {
  const file = path.join(ROOT, 'bm-servers.txt');
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    console.error('[LINKS-CRON] Не удалось прочитать bm-servers.txt:', e.message);
    return ['', '', '', ''];
  }
  const rawLines = text.split(/\r?\n/).map(s => (s || '').trim());
  // Drop comments
  let lines = rawLines.filter(s => !s.startsWith('#'));
  // Remove leading blanks
  while (lines.length && lines[0] === '') lines.shift();
  const sliced = lines.slice(0, 4);
  while (sliced.length < 4) sliced.push('');
  console.log('[LINKS-CRON] Parsed BM IDs:', sliced);
  return sliced;
}

function extractSteamIdsFromBM(json) {
  try {
    const included = Array.isArray(json?.included) ? json.included : [];
    const players = included.filter(x => x?.type === 'player');
    const playerIds = players.map(p => p.id);
    const identifiers = included.filter(x => x?.type === 'identifier');

    const result = [];
    const seen = new Set();

    for (const pid of playerIds) {
      const idents = identifiers.filter(i => i?.relationships?.player?.data?.id === pid);
      for (const ident of idents) {
        const t = String(ident?.attributes?.type || '').toLowerCase();
        const v = String(ident?.attributes?.identifier || '');
        let steam64 = null;
        if (/^\d{17,}$/.test(v)) {
          steam64 = v;
        } else if (t.includes('steam') && /\d{17,}/.test(v)) {
          const m = v.match(/(\d{17,})/);
          if (m) steam64 = m[1];
        }
        if (steam64 && !seen.has(steam64)) {
          result.push(steam64);
          seen.add(steam64);
          break; // take the first matching identifier for this player
        }
      }
    }
    return result;
  } catch (e) {
    console.warn('[LINKS-CRON] Ошибка парсинга BattleMetrics included:', e.message);
    return [];
  }
}

async function fetchBMPlayersSteamIds(serverId) {
  if (!serverId) return [];
  const url = 'https://api.battlemetrics.com/servers/' + encodeURIComponent(serverId) + '?include=player,identifier';
  const headers = { 'Accept': 'application/json' };
  if (BM_TOKEN) headers['Authorization'] = 'Bearer ' + BM_TOKEN;
  console.log('[LINKS-CRON] Fetching BM:', url);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error('BattleMetrics HTTP ' + res.status);
  const json = await res.json();
  return extractSteamIdsFromBM(json);
}

async function getPlayerSummaries(steamIds) {
  if (!STEAM_API_KEY) throw new Error('STEAM_API_KEY не задан');
  const chunks = [];
  for (let i = 0; i < steamIds.length; i += 100) chunks.push(steamIds.slice(i, i + 100));

  const players = [];
  for (const chunk of chunks) {
    const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/');
    url.searchParams.set('key', STEAM_API_KEY);
    url.searchParams.set('steamids', chunk.join(','));
    console.log('[LINKS-CRON] Fetching Steam summaries:', url.toString());
    const res = await fetch(url.toString(), { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('Steam HTTP ' + res.status);
    const json = await res.json();
    const arr = Array.isArray(json?.response?.players) ? json.response.players : [];
    players.push(...arr);
    // Be polite to API
    await sleep(200);
  }
  return players;
}

function chooseBestLobbyLink(orderedSteamIds, players, maxProfiles = LOBBY_SAMPLE_SIZE) {
  const byId = new Map(players.map(p => [String(p.steamid), p]));
  const candidates = [];
  for (const id of orderedSteamIds) {
    const p = byId.get(String(id));
    if (!p) continue;
    if (Number(p.communityvisibilitystate) === 3 && p.lobbysteamid) {
      const steamid = String(p.steamid);
      const lobby = String(p.lobbysteamid);
      const link = `steam://joinlobby/${APP_ID}/${lobby}/${steamid}`;
      candidates.push({ steamid, lobby, link });
      if (candidates.length >= maxProfiles) break;
    }
  }
  if (!candidates.length) return null;
  // Count frequency of lobbies among candidates
  const freq = new Map();
  for (const c of candidates) {
    freq.set(c.lobby, (freq.get(c.lobby) || 0) + 1);
  }
  let best = candidates[0];
  let bestCount = freq.get(best.lobby) || 1;
  for (const c of candidates) {
    const cnt = freq.get(c.lobby) || 1;
    if (cnt > bestCount) {
      best = c;
      bestCount = cnt;
    }
  }
  return best; // { steamid, lobby, link }
}

async function buildLinkForServer(serverId) {
  try {
    const steamIds = await fetchBMPlayersSteamIds(serverId);
    if (!steamIds.length) return '';
    const players = await getPlayerSummaries(steamIds);
    const best = chooseBestLobbyLink(steamIds, players, LOBBY_SAMPLE_SIZE);
    if (best && best.lobby && best.steamid) {
      const link = best.link;
      console.log('[LINKS-CRON] Link for', serverId, '=>', link, `(matches for lobby ${best.lobby})`);
      return link;
    }
    console.log('[LINKS-CRON] Не найден публичный профиль с lobbysteamid для сервера', serverId);
    return '';
  } catch (e) {
    console.warn('[LINKS-CRON] Ошибка при обработке сервера', serverId, e.message);
    return '';
  }
}

async function writeLinksFile(links) {
  const outPath = path.join(ROOT, 'links.txt');
  const content = links.map(s => (s || '').trim()).join('\n') + '\n';
  try {
    await writeFile(outPath, content, 'utf8');
    console.log('[LINKS-CRON] Записан файл', outPath);
  } catch (e) {
    console.error('[LINKS-CRON] Не удалось записать links.txt:', e.message);
    throw e;
  }
}

async function runOnce() {
  const ids = await readBMIds();
  const links = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!id) {
      links.push('');
      continue;
    }
    const link = await buildLinkForServer(id);
    links.push(link);
  }
  await writeLinksFile(links);
}

async function main() {
  const watch = process.argv.includes('--watch') || process.env.WATCH === '1';
  if (!STEAM_API_KEY) {
    console.warn('[LINKS-CRON] Внимание: переменная окружения STEAM_API_KEY не установлена. Скрипт не сможет получить сводки игроков.');
  }
  if (watch) {
    console.log('[LINKS-CRON] Режим наблюдения: обновление links.txt каждые 60 секунд');
    // Run immediately, then every minute
    while (true) {
      try {
        await runOnce();
      } catch (e) {
        console.error('[LINKS-CRON] Ошибка в runOnce:', e);
      }
      await sleep(60_000);
    }
  } else {
    await runOnce();
  }
}

main().catch(err => {
  console.error('[LINKS-CRON] Критическая ошибка:', err);
  process.exit(1);
});