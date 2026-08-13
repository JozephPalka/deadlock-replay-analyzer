/*
 * preview.mjs — renders the UI against the synthetic fixture and writes a
 * standalone preview.html. Useful for eyeballing layout changes without
 * needing a real replay.
 *
 *   node tools/preview.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { analyze } from '../js/analyze.js';
import { renderAll } from '../js/ui.js';
import { analyzeBuild } from '../js/build.js';
import { raw, FOCUS, itemsById, itemStats } from './fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

class StubElement {
  constructor() {
    this._html = '';
  }
  set innerHTML(value) {
    this._html = value;
  }
  get innerHTML() {
    return this._html;
  }
  querySelectorAll() {
    return [];
  }
  querySelector() {
    return null;
  }
}

const analysis = analyze(raw, {
  focusCtrl: FOCUS.ctrl,
  heroName: (id) => ['Abrams', 'Bebop', 'Dynamo', 'Grey Talon', 'Haze', 'Infernus', 'Ivy', 'Kelvin', 'Lady Geist', 'Lash', 'McGinnis', 'Mo & Krill'][id % 12],
  itemName: (id) => itemsById.get(id) || null
});

analysis.build = analyzeBuild(analysis, raw, { itemsById, itemStats });

const mount = new StubElement();
renderAll(analysis, mount, {
  raw,
  nameStatus: { items: 'loaded (912)', heroes: 'loaded (28)' }
});

// Tabs need JavaScript to switch; for a static preview just show every panel.
const body = mount.innerHTML
  .replace(/class="panel"/g, 'class="panel panel--active"')
  .replace(/<nav class="tabs"[\s\S]*?<\/nav>/, '');

const css = readFileSync(join(root, 'assets', 'styles.css'), 'utf8');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Preview — Deadlock Replay Analyzer</title>
<style>${css}
.panel { border-top: 1px solid var(--line); margin-top: 32px; padding-top: 8px; }
</style></head>
<body><main>
<header class="topbar"><div><h1>Deadlock Replay Analyzer</h1>
<p class="subtitle">Static preview rendered from synthetic match data — every tab stacked.</p></div></header>
${body}
</main></body></html>`;

const out = join(root, 'preview.html');
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
