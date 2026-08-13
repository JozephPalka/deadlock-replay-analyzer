/*
 * charts.js — hand-rolled SVG charts.
 *
 * No chart library: one less CDN dependency to break, and the charts here are
 * simple enough that a library would cost more than it saves. Everything
 * returns an SVG string.
 *
 * Design rules kept consistent across every chart:
 *   - one hue per team, one bright accent for the focused player
 *   - axis labels sit outside the plot, gridlines stay faint
 *   - every mark carries a <title> so hovering explains it
 */

export const COLORS = {
  amber: '#f0a63c',
  sapphire: '#58a6ff',
  focus: '#7ee787',
  bad: '#f85149',
  good: '#3fb950',
  grid: '#262b33',
  axis: '#484f58',
  text: '#8b949e',
  strong: '#e6edf3'
};

export const PLAYER_COLORS = [
  '#f0a63c', '#ffcc66', '#e8845c', '#d98cb3', '#c9a227', '#b7793f',
  '#58a6ff', '#79c0ff', '#56d4dd', '#8b95f6', '#4dc9a4', '#7aa2f7'
];

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const span = max - min;
  const step = Math.pow(10, Math.floor(Math.log10(span / count)));
  const candidates = [step, step * 2, step * 5, step * 10];
  const chosen = candidates.find((c) => span / c <= count) || step * 10;
  const ticks = [];
  for (let v = Math.ceil(min / chosen) * chosen; v <= max + 1e-9; v += chosen) ticks.push(v);
  return ticks;
}

function shortNumber(value) {
  const abs = Math.abs(value);
  if (abs >= 1000) return `${(value / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

/* ------------------------------------------------------------------ */
/* line chart                                                          */
/* ------------------------------------------------------------------ */

/**
 * @param {Object} config
 * @param {Array}  config.series  [{label, color, points:[{t,v}], emphasis:bool}]
 */
export function lineChart(config) {
  const {
    series = [],
    width = 860,
    height = 320,
    yFormat = shortNumber,
    title = ''
  } = config;

  const pad = { top: 16, right: 16, bottom: 30, left: 56 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const all = series.flatMap((s) => s.points);
  if (all.length === 0) return emptyChart(width, height, 'No data captured for this chart');

  const tMin = 0;
  const tMax = Math.max(...all.map((p) => p.t), 1);
  const vMin = Math.min(0, ...all.map((p) => p.v));
  // Scale to the data, not to an arbitrary floor — otherwise fractional series
  // (like team spread) get squashed against the bottom of a 0-to-1 axis.
  const observedMax = Math.max(...all.map((p) => p.v));
  const vMax = observedMax > vMin ? observedMax : vMin + 1;

  const x = (t) => pad.left + ((t - tMin) / (tMax - tMin)) * plotW;
  const y = (v) => pad.top + plotH - ((v - vMin) / (vMax - vMin || 1)) * plotH;

  const yTicks = niceTicks(vMin, vMax, 5);
  const xStep = tMax > 1800 ? 300 : tMax > 600 ? 180 : 60;

  let svg = `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img" aria-label="${esc(title)}">`;

  for (const tick of yTicks) {
    const yy = y(tick);
    svg += `<line x1="${pad.left}" y1="${yy}" x2="${width - pad.right}" y2="${yy}" stroke="${COLORS.grid}" stroke-width="1"/>`;
    svg += `<text x="${pad.left - 8}" y="${yy + 4}" text-anchor="end" fill="${COLORS.text}" font-size="11">${esc(yFormat(tick))}</text>`;
  }

  for (let t = 0; t <= tMax; t += xStep) {
    const xx = x(t);
    svg += `<text x="${xx}" y="${height - 10}" text-anchor="middle" fill="${COLORS.text}" font-size="11">${clock(t)}</text>`;
  }

  for (const s of series) {
    if (s.points.length === 0) continue;
    const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    const strokeWidth = s.emphasis ? 2.6 : 1.4;
    const opacity = s.emphasis ? 1 : 0.75;
    svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${strokeWidth}" opacity="${opacity}" stroke-linejoin="round"><title>${esc(s.label)}</title></path>`;
  }

  svg += `<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="${COLORS.axis}"/>`;
  svg += `<line x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}" stroke="${COLORS.axis}"/>`;
  svg += '</svg>';

  const legend = series
    .map(
      (s) =>
        `<span class="legend-item${s.emphasis ? ' legend-item--emphasis' : ''}"><i style="background:${s.color}"></i>${esc(s.label)}</span>`
    )
    .join('');

  return `${svg}<div class="legend">${legend}</div>`;
}

/* ------------------------------------------------------------------ */
/* soul lead (diverging area)                                          */
/* ------------------------------------------------------------------ */

export function leadChart(config) {
  const {
    points = [],
    width = 860,
    height = 220,
    positiveLabel = 'Amber ahead',
    negativeLabel = 'Sapphire ahead',
    markers = []
  } = config;

  if (points.length === 0) return emptyChart(width, height, 'No net worth samples captured');

  const pad = { top: 16, right: 16, bottom: 30, left: 56 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const tMax = Math.max(...points.map((p) => p.t), 1);
  const magnitude = Math.max(...points.map((p) => Math.abs(p.v)), 1000);

  const x = (t) => pad.left + (t / tMax) * plotW;
  const y = (v) => pad.top + plotH / 2 - (v / magnitude) * (plotH / 2);

  const zero = y(0);

  let svg = `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img" aria-label="Soul lead over time">`;

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const closed = `${path} L${x(tMax).toFixed(1)},${zero} L${x(0).toFixed(1)},${zero} Z`;

  svg += `<defs>
    <linearGradient id="leadFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${COLORS.amber}" stop-opacity="0.45"/>
      <stop offset="50%" stop-color="${COLORS.amber}" stop-opacity="0.05"/>
      <stop offset="50%" stop-color="${COLORS.sapphire}" stop-opacity="0.05"/>
      <stop offset="100%" stop-color="${COLORS.sapphire}" stop-opacity="0.45"/>
    </linearGradient>
  </defs>`;

  svg += `<path d="${closed}" fill="url(#leadFill)" stroke="none"/>`;
  svg += `<path d="${path}" fill="none" stroke="${COLORS.strong}" stroke-width="1.8"/>`;
  svg += `<line x1="${pad.left}" y1="${zero}" x2="${width - pad.right}" y2="${zero}" stroke="${COLORS.axis}" stroke-dasharray="3 3"/>`;

  svg += `<text x="${pad.left - 8}" y="${pad.top + 12}" text-anchor="end" fill="${COLORS.amber}" font-size="11">${esc(shortNumber(magnitude))}</text>`;
  svg += `<text x="${pad.left - 8}" y="${pad.top + plotH}" text-anchor="end" fill="${COLORS.sapphire}" font-size="11">${esc(shortNumber(magnitude))}</text>`;

  for (const marker of markers) {
    const xx = x(marker.t);
    svg += `<line x1="${xx}" y1="${pad.top}" x2="${xx}" y2="${pad.top + plotH}" stroke="${marker.color || COLORS.text}" stroke-width="1" opacity="0.5"/>`;
    svg += `<circle cx="${xx}" cy="${pad.top + 4}" r="3" fill="${marker.color || COLORS.text}"><title>${esc(marker.label)}</title></circle>`;
  }

  const xStep = tMax > 1800 ? 300 : 180;
  for (let t = 0; t <= tMax; t += xStep) {
    svg += `<text x="${x(t)}" y="${height - 10}" text-anchor="middle" fill="${COLORS.text}" font-size="11">${clock(t)}</text>`;
  }

  svg += '</svg>';

  return `${svg}<div class="legend"><span class="legend-item"><i style="background:${COLORS.amber}"></i>${esc(positiveLabel)}</span><span class="legend-item"><i style="background:${COLORS.sapphire}"></i>${esc(negativeLabel)}</span></div>`;
}

/* ------------------------------------------------------------------ */
/* map plot                                                            */
/* ------------------------------------------------------------------ */

export function mapPlot(config) {
  const { points = [], bases = {}, baseIds = null, width = 420, height = 420, caption = '' } = config;
  // Team ids are derived per replay, so the caller passes them in rather than
  // this assuming Source's usual 2 and 3.
  const ids = baseIds && baseIds.length === 2 ? baseIds : Object.keys(bases).map(Number).sort((a, b) => a - b);

  const coords = points.filter((p) => p.x !== null && p.x !== undefined);
  const baseList = Object.values(bases).filter((b) => b && Number.isFinite(b.x));
  if (coords.length === 0 && baseList.length === 0) {
    return emptyChart(width, height, 'No positional data captured');
  }

  const xs = [...coords.map((p) => p.x), ...baseList.map((b) => b.x)];
  const ys = [...coords.map((p) => p.y), ...baseList.map((b) => b.y)];

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const span = Math.max(spanX, spanY) * 1.12;

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const pad = 24;
  const size = Math.min(width, height) - pad * 2;

  const px = (x) => pad + ((x - (cx - span / 2)) / span) * size;
  // Flip Y so the plot reads like the in-game minimap rather than screen space.
  const py = (y) => pad + size - ((y - (cy - span / 2)) / span) * size;

  let svg = `<svg viewBox="0 0 ${width} ${height}" class="chart chart--map" role="img" aria-label="${esc(caption || 'Map positions')}">`;
  svg += `<rect x="${pad}" y="${pad}" width="${size}" height="${size}" fill="#0d1117" stroke="${COLORS.grid}"/>`;

  const firstBase = ids.length === 2 ? bases[ids[0]] : null;
  const secondBase = ids.length === 2 ? bases[ids[1]] : null;
  if (firstBase && secondBase) {
    svg += `<line x1="${px(firstBase.x)}" y1="${py(firstBase.y)}" x2="${px(secondBase.x)}" y2="${py(secondBase.y)}" stroke="${COLORS.grid}" stroke-width="1" stroke-dasharray="4 4"/>`;
    svg += `<circle cx="${px(firstBase.x)}" cy="${py(firstBase.y)}" r="7" fill="none" stroke="${COLORS.amber}" stroke-width="1.5"><title>Amber base</title></circle>`;
    svg += `<circle cx="${px(secondBase.x)}" cy="${py(secondBase.y)}" r="7" fill="none" stroke="${COLORS.sapphire}" stroke-width="1.5"><title>Sapphire base</title></circle>`;
  }

  for (const p of coords) {
    const r = p.emphasis ? 5.5 : 4;
    svg += `<circle cx="${px(p.x).toFixed(1)}" cy="${py(p.y).toFixed(1)}" r="${r}" fill="${p.color || COLORS.bad}" fill-opacity="${p.emphasis ? 0.95 : 0.55}" stroke="${p.emphasis ? COLORS.strong : 'none'}" stroke-width="${p.emphasis ? 1.2 : 0}"><title>${esc(p.label || '')}</title></circle>`;
  }

  svg += '</svg>';
  return caption ? `${svg}<p class="chart-caption">${esc(caption)}</p>` : svg;
}

/* ------------------------------------------------------------------ */
/* horizontal bars                                                     */
/* ------------------------------------------------------------------ */

export function barRows(config) {
  const { rows = [], width = 420, valueFormat = (v) => v.toLocaleString() } = config;
  if (rows.length === 0) return '<p class="muted">No data.</p>';

  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);

  return `<div class="bars" style="--bar-width:${width}px">${rows
    .map((r) => {
      const pct = (Math.abs(r.value) / max) * 100;
      return `<div class="bar-row${r.emphasis ? ' bar-row--emphasis' : ''}">
        <span class="bar-label">${esc(r.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct.toFixed(1)}%;background:${r.color || COLORS.amber}"></span></span>
        <span class="bar-value">${esc(valueFormat(r.value))}</span>
      </div>`;
    })
    .join('')}</div>`;
}

/* ------------------------------------------------------------------ */
/* timeline                                                            */
/* ------------------------------------------------------------------ */

export function timeline(config) {
  const { lanes = [], duration = 1, width = 860, laneHeight = 30 } = config;
  if (lanes.length === 0) return '<p class="muted">No events.</p>';

  const pad = { left: 130, right: 16, top: 10, bottom: 26 };
  const plotW = width - pad.left - pad.right;
  const height = pad.top + lanes.length * laneHeight + pad.bottom;
  const x = (t) => pad.left + (t / duration) * plotW;

  let svg = `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img" aria-label="Event timeline">`;

  lanes.forEach((lane, i) => {
    const y = pad.top + i * laneHeight + laneHeight / 2;
    svg += `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="${COLORS.grid}"/>`;
    svg += `<text x="${pad.left - 10}" y="${y + 4}" text-anchor="end" fill="${lane.color || COLORS.text}" font-size="11">${esc(lane.label)}</text>`;

    for (const event of lane.events) {
      const xx = x(event.t);
      if (event.shape === 'diamond') {
        svg += `<path d="M${xx},${y - 5} L${xx + 5},${y} L${xx},${y + 5} L${xx - 5},${y} Z" fill="${event.color || lane.color || COLORS.text}"><title>${esc(event.label)}</title></path>`;
      } else {
        svg += `<circle cx="${xx}" cy="${y}" r="4" fill="${event.color || lane.color || COLORS.text}" fill-opacity="0.9"><title>${esc(event.label)}</title></circle>`;
      }
    }
  });

  const step = duration > 1800 ? 300 : 180;
  for (let t = 0; t <= duration; t += step) {
    svg += `<text x="${x(t)}" y="${height - 8}" text-anchor="middle" fill="${COLORS.text}" font-size="11">${clock(t)}</text>`;
  }

  svg += '</svg>';
  return svg;
}

function emptyChart(width, height, message) {
  return `<svg viewBox="0 0 ${width} ${height}" class="chart chart--empty" role="img" aria-label="${esc(message)}">
    <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"/>
    <text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="${COLORS.text}" font-size="13">${esc(message)}</text>
  </svg>`;
}

export { esc, clock, shortNumber };
