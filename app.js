'use strict';

// Helpful warning when opened directly from disk
if (location && location.protocol === 'file:') {
  console.warn('[BM-DEBUG] Внимание: страница открыта по file://. Запросы fetch к links.txt и bm-servers.txt не будут работать. Откройте сайт через локальный сервер (http://).');
}

document.addEventListener('DOMContentLoaded', function () {
  const buttons = [
    document.getElementById('join-btn-1'),
    document.getElementById('join-btn-2'),
    document.getElementById('join-btn-3'),
    document.getElementById('join-btn-4')
  ];

  const counters = [
    document.getElementById('pc-1'),
    document.getElementById('pc-2'),
    document.getElementById('pc-3'),
    document.getElementById('pc-4')
  ];

  const defaultText = 'Присоединиться';
  const MAX_PLAYERS = 100;
  const BM_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbiI6ImM0Y2VhNDQ2MTMxMDIyMzAiLCJpYXQiOjE3NTU3MzU2NTAsIm5iZiI6MTc1NTczNTY1MCwiaXNzIjoiaHR0cHM6Ly93d3cuYmF0dGxlbWV0cmljcy5jb20iLCJzdWIiOiJ1cm46dXNlcjoxMDU0OTAxIn0.xQKibQ5UmFRKEJ5Y9wX31D48Sa47k70w_NeTfcVimWs';
  const clamp = (n, min, max) => Math.min(Math.max(Number(n) || 0, min), max);

  function setDisabled(btn, disabled) {
    if (!btn) return;
    if (disabled) {
      btn.classList.add('opacity-50', 'pointer-events-none');
      btn.textContent = 'Недоступно';
    } else {
      btn.classList.remove('opacity-50', 'pointer-events-none');
      btn.textContent = defaultText;
    }
  }

  function applyLinks(links) {
    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      const link = (links[i] || '').trim();
      if (typeof link === 'string' && link.startsWith('steam://joinlobby/')) {
        btn.setAttribute('href', link);
        setDisabled(btn, false);
      } else {
        setDisabled(btn, true);
      }
    }
  }

  async function fetchLinks() {
    try {
      const url = 'links.txt?ts=' + Date.now(); // cache-busting
      console.log('[BM-DEBUG] Requesting links:', url);
      const res = await fetch(url, { cache: 'no-store' });
      console.log('[BM-DEBUG] links.txt status:', res.status);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      console.log('[BM-DEBUG] links.txt content:', text);
      const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      console.log('[BM-DEBUG] parsed links:', lines);
      applyLinks(lines);
    } catch (e) {
      console.error('Не удалось загрузить links.txt:', e);
      // При ошибке оставляем текущие ссылки без изменений
    }
  }

  function setCounter(index, value) {
    const el = counters[index];
    if (!el) return;
    if (Number.isFinite(value)) {
      el.textContent = `${value}/${MAX_PLAYERS}`;
    } else {
      el.textContent = `—/${MAX_PLAYERS}`;
    }
  }

  function parseBMCount(json) {
    try {
      const data = json && json.data ? json.data : null;
      if (!data) return null;
      const attrs = data.attributes || null;
      const val = (attrs && attrs.players != null) ? attrs.players : data.players;
      return Number.isFinite(Number(val)) ? Number(val) : null;
    } catch (_) {
      return null;
    }
  }

  async function loadBMIds() {
    try {
      const url = 'bm-servers.txt?ts=' + Date.now();
      console.log('[BM-DEBUG] Requesting bm-servers:', url);
      const res = await fetch(url, { cache: 'no-store' });
      console.log('[BM-DEBUG] bm-servers.txt status:', res.status);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      console.log('[BM-DEBUG] bm-servers.txt content:', text);
      const rawLines = text.split(/\r?\n/).map(s => (s || '').trim());
      // Remove comment lines entirely
      let lines = rawLines.filter(s => !s.startsWith('#'));
      // Drop leading blank lines (header spacing after comments)
      while (lines.length && lines[0] === '') lines.shift();
      // Take first N entries; keep internal blanks to allow hiding specific slots
      const sliced = lines.slice(0, counters.length);
      // Pad to required length
      while (sliced.length < counters.length) sliced.push('');
      console.log('[BM-DEBUG] parsed BM IDs:', sliced);
      return sliced;
    } catch (e) {
      console.error('Не удалось загрузить bm-servers.txt:', e);
      return new Array(counters.length).fill('');
    }
  }

  async function fetchPlayerCounts() {
    try {
      const url = 'players.json?ts=' + Date.now();
      console.log('[BM-DEBUG] Requesting cached players:', url);
      const res = await fetch(url, { cache: 'no-store' });
      console.log('[BM-DEBUG] players.json status:', res.status);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      console.log('[BM-DEBUG] players.json JSON:', json);
      const results = Array.isArray(json?.results) ? json.results : [];
      for (let i = 0; i < counters.length; i++) {
        const entry = results.find(r => Number(r?.idx) === i);
        const value = entry && Number.isFinite(Number(entry.value)) ? Number(entry.value) : null;
        console.log('[BM-DEBUG] Applying counter', i + 1, 'value:', (Number.isFinite(value) ? value : '—') + '/' + MAX_PLAYERS);
        setCounter(i, value);
      }
    } catch (e) {
      console.error('Не удалось загрузить players.json:', e);
      // При ошибке оставляем текущие значения
    }
  }

  // Initial load
  fetchLinks();
  fetchPlayerCounts();

  // Periodic refresh every 30s
  setInterval(() => {
    fetchLinks();
    fetchPlayerCounts();
  }, 30000);
});
