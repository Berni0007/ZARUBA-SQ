import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const MAX_PLAYERS = 100;
const BM_TOKEN = process.env.BM_TOKEN || process.env.BATTLEMETRICS_TOKEN || '';

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.min(Math.max(x, min), max);
}

async function readBMIds() {
  const file = path.join(ROOT, 'bm-servers.txt');
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    console.error('[BM-CRON] Не удалось прочитать bm-servers.txt:', e.message);
    return ['', '', '', '', ''];
  }
  const rawLines = text.split(/\r?\n/).map(s => (s || '').trim());
  let lines = rawLines.filter(s => !s.startsWith('#'));
  while (lines.length && lines[0] === '') lines.shift();
  const sliced = lines.slice(0, 5);
  while (sliced.length < 5) sliced.push('');
  console.log('[BM-CRON] Parsed BM IDs:', sliced);
  return sliced;
}

async function fetchData(id) {
  if (!id) return null;
  const url = 'https://api.battlemetrics.com/servers/' + encodeURIComponent(id);
  const headers = { 'Accept': 'application/json' };
  if (BM_TOKEN) headers['Authorization'] = 'Bearer ' + BM_TOKEN;
  console.log('[BM-CRON] Fetching', url);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const attrs = json?.data?.attributes || {};
  const details = attrs?.details || {};
  const players = clamp(attrs?.players, 0, MAX_PLAYERS);
  const queue = clamp(details?.squad_publicQueue, 0, MAX_PLAYERS);
  const map = typeof details?.map === 'string' && details.map.trim() ? details.map.trim() : null;
  const playTimeSec = Number.isFinite(Number(details?.squad_playTime)) ? Number(details.squad_playTime) : null;
  return { players, queue, map, playTimeSec };
}

async function main() {
  const ids = await readBMIds();
  const results = [];
  for (let idx = 0; idx < ids.length; idx++) {
    const id = ids[idx];
    try {
      const data = await fetchData(id);
      const value = data ? data.players : null; // backward compat for older UI
      console.log('[BM-CRON] Result for', id || '(empty)', '=>', data);
      results.push({ idx, value, ...data });
    } catch (e) {
      console.warn('[BM-CRON] Ошибка для', id, e.message);
      results.push({ idx, value: null, players: null, queue: null, map: null, playTimeSec: null });
    }
  }
  const payload = { updatedAt: new Date().toISOString(), results };
  const outPath = path.join(ROOT, 'players.json');
  try {
    await writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
    console.log('[BM-CRON] Записан файл', outPath);
  } catch (e) {
    console.error('[BM-CRON] Не удалось записать players.json:', e.message);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[BM-CRON] Критическая ошибка:', err);
  process.exit(1);
});