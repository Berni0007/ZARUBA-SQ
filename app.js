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
    document.getElementById('join-btn-4'),
    document.getElementById('join-btn-5')
  ];

  const counters = [
    document.getElementById('pc-1'),
    document.getElementById('pc-2'),
    document.getElementById('pc-3'),
    document.getElementById('pc-4'),
    document.getElementById('pc-5')
  ];

  // Display names for servers (used in charts and info). Fifth is renamed.
  const SERVER_NAMES = [
    'ZARUBA 1',
    'ZARUBA 2',
    'ZARUBA 3',
    'ZARUBA 4',
    'RUBAS Vanilla+'
  ];

  // Tracks whether each server currently has a valid join link (from links.txt)
  let linkAvailable = new Array(buttons.length).fill(false);

  const defaultText = 'Присоединиться';
  const MAX_PLAYERS = 100;
  const clamp = (n, min, max) => Math.min(Math.max(Number(n) || 0, min), max);

  function setDisabled(btn, disabled) {
    if (!btn) return;
    if (disabled) {
      btn.classList.add('opacity-50', 'pointer-events-none');
      btn.setAttribute('aria-disabled', 'true');
      btn.removeAttribute('href');
      btn.textContent = 'Недоступно';
    } else {
      btn.classList.remove('opacity-50', 'pointer-events-none');
      btn.removeAttribute('aria-disabled');
      btn.textContent = defaultText;
    }
  }

  function applyLinks(links) {
    const BASE = 'http://212.22.93.230:8080';
    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      const link = (links[i] || '').trim();
      const ok = typeof link === 'string' && link.startsWith('steam://joinlobby/');
      linkAvailable[i] = !!ok;
      if (ok) {
        btn.setAttribute('href', `${BASE}/s${i + 1}c/`);
        setDisabled(btn, false);
      } else {
        setDisabled(btn, true);
      }
    }
    // Immediately refresh chart colors if we already have player data
    if (lastResults) {
      updateServerCards(lastResults);
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
      const lines = text.split(/\r?\n/).map(s => s.trim());
      console.log('[BM-DEBUG] parsed links (with blanks kept):', lines);
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

  // ===== NEW: Chart + Info rendering =====
  let playersChart = null;
  let serverCharts = new Array(counters.length).fill(null);
  let lastResults = null;

  function formatPlayTime(sec) {
    const s = Number(sec);
    if (!Number.isFinite(s) || s < 0) return '—:—';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const mm = String(m).padStart(2, '0');
    return h + ':' + mm;
  }

  function updateChartWith(results) {
    try {
      if (!(window && window.Chart)) {
        console.warn('[BM-DEBUG] Chart.js не загружен');
        return;
      }
      const labels = Array.from({ length: counters.length }, (_, i) => SERVER_NAMES[i] || `ZARUBA ${i + 1}`);
      const players = [];
      const queue = [];
      for (let i = 0; i < counters.length; i++) {
        const entry = results.find(r => Number(r?.idx) === i) || {};
        const p = Number(entry?.players ?? entry?.value);
        const q = Number(entry?.queue);
        players.push(Number.isFinite(p) ? p : 0);
        queue.push(Number.isFinite(q) ? q : 0);
      }
      const ctx = document.getElementById('playersChart');
      if (!ctx) return;
      const data = {
        labels,
        datasets: [
          {
            label: 'Игроки',
            data: players,
            backgroundColor: 'rgba(255, 215, 0, 0.6)',
            borderColor: 'rgba(255, 215, 0, 1)',
            borderWidth: 1,
          },
          {
            label: 'Очередь',
            data: queue,
            backgroundColor: 'rgba(91, 108, 95, 0.6)',
            borderColor: 'rgba(91, 108, 95, 1)',
            borderWidth: 1,
          }
        ]
      };
      const options = {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
            suggestedMax: MAX_PLAYERS,
            grid: { color: 'rgba(255,255,255,0.1)' },
            ticks: { color: '#e5e5e5' }
          },
          x: {
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: '#e5e5e5' }
          }
        },
        plugins: {
          legend: { labels: { color: '#e5e5e5' } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.raw}` } }
        }
      };
      if (playersChart) {
        playersChart.data = data;
        playersChart.options = options;
        playersChart.update();
      } else {
        playersChart = new Chart(ctx, { type: 'bar', data, options });
      }
    } catch (e) {
      console.warn('[BM-DEBUG] Не удалось обновить диаграмму:', e);
    }
  }

  function updateServerInfo(results) {
    const box = document.getElementById('serverInfo');
    if (!box) return;
    const items = [];
    for (let i = 0; i < counters.length; i++) {
      const r = results.find(x => Number(x?.idx) === i) || {};
      const map = (r && typeof r.map === 'string' && r.map.trim()) ? r.map.trim() : '—';
      const time = formatPlayTime(r?.playTimeSec);
      const players = Number.isFinite(Number(r?.players ?? r?.value)) ? Number(r?.players ?? r?.value) : null;
      const queue = Number.isFinite(Number(r?.queue)) ? Number(r?.queue) : null;
      const line1 = SERVER_NAMES[i] || `ZARUBA ${i + 1}`;
      const line2 = `Карта: ${map}`;
      const line3 = `Время: ${time}`;
      const line4 = `Онлайн: ${players != null ? players : '—'}/${MAX_PLAYERS} · Очередь: ${queue != null ? queue : '—'}`;
      items.push(
        `<div class=\"rounded-lg border border-gold/40 bg-military-dark/50 p-4\">
          <div class=\"text-lg font-semibold text-gold mb-1\">${line1}</div>
          <div class=\"text-neutral-200\">${line2}</div>
          <div class=\"text-neutral-200\">${line3}</div>
          <div class=\"text-neutral-300 text-sm mt-1\">${line4}</div>
        </div>`
      );
    }
    box.innerHTML = items.join('');
  }

  // New: Render per-card doughnut charts and info
  function updateServerCards(results) {
    try {
      if (!(window && window.Chart)) {
        console.warn('[BM-DEBUG] Chart.js не загружен');
        return;
      }
      for (let i = 0; i < counters.length; i++) {
        const r = results.find(x => Number(x?.idx) === i) || {};
        const p = Number(r?.players ?? r?.value);
        const q = Number(r?.queue);
        const players = Number.isFinite(p) ? clamp(p, 0, MAX_PLAYERS) : 0;
        const queue = Number.isFinite(q) ? clamp(q, 0, MAX_PLAYERS) : 0;
        const free = Math.max(0, MAX_PLAYERS - players);

        const canvas = document.getElementById('chart-' + (i + 1));
        if (canvas) {
          const data = {
            labels: ['Игроки', 'Очередь', 'Свободно'],
            datasets: [{
              data: [players, queue, free],
              backgroundColor: [
                'rgba(255, 215, 0, 0.85)', // gold for players
                'rgba(239, 68, 68, 0.85)', // red for queue
                (linkAvailable[i] ? 'rgba(16, 185, 129, 0.9)' : 'rgba(239, 68, 68, 0.85)') // green if can join, red if no link
              ],
              borderWidth: 0,
            }]
          };
          const options = {
            responsive: true,
            maintainAspectRatio: true,
            cutout: '70%',
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: (ctx) => `${ctx.label}: ${ctx.raw}`
                }
              }
            }
          };
          if (serverCharts[i]) {
            serverCharts[i].data = data;
            serverCharts[i].options = options;
            serverCharts[i].update();
          } else {
            serverCharts[i] = new Chart(canvas, { type: 'doughnut', data, options });
          }
        }

        const info = document.getElementById('info-' + (i + 1));
        if (info) {
          const map = (r && typeof r.map === 'string' && r.map.trim()) ? r.map.trim() : '—';
          const time = formatPlayTime(r?.playTimeSec);
          const onlineText = (Number.isFinite(p) ? players : '—') + '/' + MAX_PLAYERS;
          const queueText = Number.isFinite(q) ? queue : '—';
          info.innerHTML = `
            <div class="mb-1"><span class="text-gold">Карта:</span> ${map}</div>
            <div class="mb-1"><span class="text-gold">Время:</span> ${time}</div>
            <div class="text-neutral-300 text-sm">Онлайн: ${onlineText} · Очередь: ${queueText}</div>
          `;
        }
      }
    } catch (e) {
      console.warn('[BM-DEBUG] Не удалось обновить карточки серверов:', e);
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
      lastResults = results;
      // Обновляем бейджи
      for (let i = 0; i < counters.length; i++) {
        const entry = results.find(r => Number(r?.idx) === i) || null;
        const value = entry && Number.isFinite(Number(entry.value)) ? Number(entry.value) : null;
        console.log('[BM-DEBUG] Applying counter', i + 1, 'value:', (Number.isFinite(value) ? value : '—') + '/' + MAX_PLAYERS);
        setCounter(i, value);
      }
      // Обновляем круговые диаграммы и инфо в карточках
      updateServerCards(results);
      return results;
    } catch (e) {
      console.error('Не удалось загрузить players.json:', e);
      // При ошибке оставляем текущие значения
      return [];
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
