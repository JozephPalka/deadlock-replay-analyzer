/*
 * main.js — wiring: pick a replay, parse it, analyse it, render it.
 */

import { parseReplay } from './parse.js';
import { analyze, deriveTeams, formatClock } from './analyze.js';
import { analyzeBuild } from './build.js';
import { NameResolver } from './names.js';
import { renderAll, renderFailure } from './ui.js';

const el = (selector) => document.querySelector(selector);

const state = {
  raw: null,
  analysis: null,
  resolver: null,
  directoryHandle: null,
  files: [],
  focusCtrl: null,
  teams: null,
  statsRequested: false
};

/* ------------------------------------------------------------------ */
/* tiny IndexedDB store, just to remember the replays folder           */
/* ------------------------------------------------------------------ */

const DB_NAME = 'deadlock-analyzer';
const STORE = 'handles';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveHandle(handle) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, 'replays');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) {
    /* not fatal */
  }
}

async function loadHandle() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get('replays');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* replay folder                                                       */
/* ------------------------------------------------------------------ */

const supportsDirectoryPicker = typeof window.showDirectoryPicker === 'function';

async function listReplays(handle) {
  const files = [];
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind !== 'file') continue;
    if (!name.toLowerCase().endsWith('.dem')) continue;
    let size = null;
    let modified = null;
    try {
      const file = await entry.getFile();
      size = file.size;
      modified = file.lastModified;
    } catch (_) {
      /* keep going */
    }
    files.push({ name, entry, size, modified });
  }
  files.sort((a, b) => (b.modified || 0) - (a.modified || 0));
  return files;
}

function renderFileList() {
  const list = el('#file-list');
  if (!state.files.length) {
    list.innerHTML = '<p class="muted">No .dem files in that folder.</p>';
    return;
  }
  list.innerHTML = `
    <table class="table table--compact file-table">
      <thead><tr><th>Replay</th><th class="right">Size</th><th class="right">Saved</th><th></th></tr></thead>
      <tbody>
        ${state.files
          .map(
            (f, i) => `<tr>
              <td class="mono">${f.name}</td>
              <td class="right">${f.size ? `${(f.size / 1048576).toFixed(0)} MB` : '—'}</td>
              <td class="right muted">${f.modified ? new Date(f.modified).toLocaleString() : '—'}</td>
              <td class="right"><button class="btn btn--small" data-file="${i}">Analyze</button></td>
            </tr>`
          )
          .join('')}
      </tbody>
    </table>`;

  list.querySelectorAll('[data-file]').forEach((button) => {
    button.addEventListener('click', async () => {
      const entry = state.files[Number(button.dataset.file)].entry;
      const file = await entry.getFile();
      run(file);
    });
  });
}

async function chooseFolder() {
  try {
    const handle = await window.showDirectoryPicker({ id: 'deadlock-replays', mode: 'read' });
    state.directoryHandle = handle;
    await saveHandle(handle);
    state.files = await listReplays(handle);
    el('#folder-name').textContent = handle.name;
    renderFileList();
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    setStatus(`Could not open that folder: ${err.message}`, 'error');
  }
}

async function restoreFolder() {
  if (!supportsDirectoryPicker) return;
  const handle = await loadHandle();
  if (!handle) return;
  try {
    const permission = await handle.queryPermission({ mode: 'read' });
    if (permission !== 'granted') {
      el('#folder-name').textContent = `${handle.name} (click to reconnect)`;
      el('#reconnect').hidden = false;
      state.directoryHandle = handle;
      return;
    }
    state.directoryHandle = handle;
    state.files = await listReplays(handle);
    el('#folder-name').textContent = handle.name;
    renderFileList();
  } catch (_) {
    /* handle went stale */
  }
}

async function reconnectFolder() {
  if (!state.directoryHandle) return;
  const permission = await state.directoryHandle.requestPermission({ mode: 'read' });
  if (permission !== 'granted') {
    setStatus('Permission denied for that folder.', 'error');
    return;
  }
  el('#reconnect').hidden = true;
  state.files = await listReplays(state.directoryHandle);
  el('#folder-name').textContent = state.directoryHandle.name;
  renderFileList();
}

/* ------------------------------------------------------------------ */
/* status + progress                                                   */
/* ------------------------------------------------------------------ */

function setStatus(message, kind = 'info') {
  const status = el('#status');
  status.textContent = message;
  status.className = `status status--${kind}`;
  status.hidden = !message;
}

function setProgress(fraction, label) {
  const wrap = el('#progress');
  wrap.hidden = false;
  el('#progress-bar').style.width = `${Math.round(fraction * 100)}%`;
  el('#progress-label').textContent = `${label} — ${Math.round(fraction * 100)}%`;
}

function hideProgress() {
  el('#progress').hidden = true;
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

async function run(file) {
  if (!file) return;
  el('#results').innerHTML = '';
  el('#who').hidden = true;
  setStatus('');
  setProgress(0, 'Starting');

  const started = performance.now();

  try {
    if (!state.resolver) {
      state.resolver = new NameResolver();
      await state.resolver.load();
    }

    const sampleIntervalSec = Number(el('#sample-rate').value) || 1;

    const raw = await parseReplay(file, {
      sampleIntervalSec,
      onProgress: (fraction, label) => setProgress(fraction, label)
    });

    state.raw = raw;

    if (raw.players.length === 0) {
      hideProgress();
      setStatus(
        'The file parsed but no players were found. This usually means the replay is from a newer game build than the parser supports — check the Diagnostics tab.',
        'error'
      );
      renderResults();
      return;
    }

    // Only ever default to someone on a playing team — a replay's controller
    // list can also hold spectators and casters.
    const teams = deriveTeams(raw);
    state.teams = teams;
    const roster = raw.players.filter((p) => teams.includes(p.team));
    const candidates = roster.length > 0 ? roster : raw.players;

    const remembered = window.localStorage.getItem('deadlock-analyzer-me');
    const match = candidates.find((p) => p.name === remembered);
    state.focusCtrl = match ? match.ctrl : candidates[0].ctrl;

    renderWhoPicker(candidates, teams);
    renderResults();

    hideProgress();
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    setStatus(
      `Parsed ${file.name} in ${seconds}s — ${formatClock(raw.duration)} of match, ${raw.kills.length} kills, ${raw.samples.length} state samples.`,
      'ok'
    );
  } catch (err) {
    hideProgress();
    console.error(err);
    setStatus(`Parsing failed: ${err.message}`, 'error');
  }
}

function renderWhoPicker(candidates, teams) {
  const who = el('#who');
  who.hidden = false;
  who.innerHTML = `
    <label for="who-select">Which player are you?</label>
    <select id="who-select">
      ${candidates
        .slice()
        .sort((a, b) => (a.team - b.team) || String(a.name).localeCompare(String(b.name)))
        .map(
          (p) =>
            `<option value="${p.ctrl}" ${p.ctrl === state.focusCtrl ? 'selected' : ''}>${p.name} — ${teams.label(p.team)}</option>`
        )
        .join('')}
    </select>`;

  who.querySelector('#who-select').addEventListener('change', (event) => {
    state.focusCtrl = Number(event.target.value);
    const player = candidates.find((p) => p.ctrl === state.focusCtrl);
    if (player) {
      try {
        window.localStorage.setItem('deadlock-analyzer-me', player.name);
      } catch (_) { /* ignore */ }
    }
    renderResults();
  });
}

function renderResults() {
  const context = { raw: state.raw, nameStatus: state.resolver?.status || {} };

  // If analysis or rendering falls over, still show Diagnostics — that tab is
  // exactly what is needed to work out why.
  try {
    const analysis = analyze(state.raw, {
      focusCtrl: state.focusCtrl,
      heroName: (id) => state.resolver?.heroName(id) ?? null,
      itemName: (id) => state.resolver?.itemName(id) ?? null
    });

    const heroId = analysis.focus?.heroId ?? null;
    const stats = state.resolver?.cachedItemStats(heroId) ?? null;

    analysis.build = analyzeBuild(analysis, state.raw, {
      itemsById: state.resolver?.items ?? new Map(),
      itemStats: stats
    });

    state.analysis = analysis;
    context.nameStatus = state.resolver?.status || {};
    renderAll(analysis, el('#results'), context);

    // Win-rate benchmarking is a separate network call and only matters once we
    // know which hero to ask about. Fetch it in the background and redraw once.
    if (!stats && state.resolver && !state.statsRequested) {
      state.statsRequested = true;
      state.resolver
        .loadItemStats(heroId)
        .then((loaded) => {
          state.statsRequested = false;
          if (loaded) renderResults();
        })
        .catch(() => {
          state.statsRequested = false;
        });
    }
  } catch (err) {
    console.error(err);
    setStatus(`Could not build the report: ${err.message}`, 'error');
    renderFailure(err, el('#results'), context);
  }
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

function boot() {
  if (!window.deadem) {
    setStatus(
      'The parser library could not be loaded from the CDN. Check your internet connection and reload the page.',
      'error'
    );
  }

  if (!supportsDirectoryPicker) {
    el('#folder-picker').hidden = true;
    el('#no-picker-note').hidden = false;
  } else {
    el('#choose-folder').addEventListener('click', chooseFolder);
    el('#reconnect').addEventListener('click', reconnectFolder);
    restoreFolder();
  }

  el('#file-input').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (file) run(file);
  });

  const drop = el('#drop');
  ['dragenter', 'dragover'].forEach((type) =>
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add('drop--active');
    })
  );
  ['dragleave', 'drop'].forEach((type) =>
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.remove('drop--active');
    })
  );
  drop.addEventListener('drop', (event) => {
    const file = event.dataTransfer.files[0];
    if (file) run(file);
  });
}

document.addEventListener('DOMContentLoaded', boot);
