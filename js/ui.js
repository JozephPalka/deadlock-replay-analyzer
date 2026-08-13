/*
 * ui.js — renders the analysis into the page.
 *
 * Team ids come from the analysis (they are derived per replay, not constants),
 * so everything here goes through analysis.teams for labels and colours.
 */

import { formatClock } from './analyze.js';
import { lineChart, leadChart, mapPlot, barRows, timeline, COLORS, PLAYER_COLORS, esc } from './charts.js';
import { buildMarkdownBrief, buildJsonBrief } from './export.js';

function num(value, fallback = '—') {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  return Math.round(value).toLocaleString();
}

function severityClass(severity) {
  return severity === 'high' ? 'finding--high' : severity === 'medium' ? 'finding--medium' : 'finding--good';
}

/**
 * Everything below needs the same three things over and over: the two team ids,
 * a colour per team and a name per team. Bundle them once per render.
 */
function makeContext(analysis) {
  const teams = analysis.teams;
  const [first, second] = teams.ids;

  const colors = new Map();
  const firstRoster = analysis.players.filter((p) => p.team === first);
  const secondRoster = analysis.players.filter((p) => p.team === second);
  firstRoster.forEach((p, i) => colors.set(p.ctrl, PLAYER_COLORS[i % 6]));
  secondRoster.forEach((p, i) => colors.set(p.ctrl, PLAYER_COLORS[6 + (i % 6)]));

  return {
    teams,
    first,
    second,
    ids: teams.ids,
    roster: analysis.teamRoster,
    colors,
    teamColor: (team) => (team === first ? COLORS.amber : team === second ? COLORS.sapphire : COLORS.text),
    teamName: (team) => teams.label(team),
    playerColor: (ctrl) => colors.get(ctrl) || COLORS.text
  };
}

/* ------------------------------------------------------------------ */

export function renderAll(analysis, mount, context = {}) {
  const ctx = makeContext(analysis);

  const tabs = [
    ['Overview', () => renderOverview(analysis, ctx)],
    ['Deaths', () => renderDeaths(analysis, ctx)],
    ['Build', () => renderBuild(analysis, ctx)],
    ['Farm & items', () => renderFarm(analysis, ctx)],
    ['Teamfights', () => renderFights(analysis, ctx)],
    ['Macro', () => renderMacro(analysis, ctx)],
    ['Ask Claude', () => renderExport(analysis)],
    ['Diagnostics', () => renderDiagnostics(analysis, context)]
  ];

  mount.innerHTML = `
    <nav class="tabs" role="tablist">
      ${tabs
        .map(
          ([label], i) =>
            `<button class="tab${i === 0 ? ' tab--active' : ''}" role="tab" data-tab="${i}">${esc(label)}</button>`
        )
        .join('')}
    </nav>
    <div class="panels">
      ${tabs
        .map(
          ([, render], i) =>
            `<section class="panel${i === 0 ? ' panel--active' : ''}" data-panel="${i}">${render()}</section>`
        )
        .join('')}
    </div>
  `;

  mount.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      mount.querySelectorAll('.tab').forEach((t) => t.classList.remove('tab--active'));
      mount.querySelectorAll('.panel').forEach((p) => p.classList.remove('panel--active'));
      tab.classList.add('tab--active');
      mount.querySelector(`.panel[data-panel="${tab.dataset.tab}"]`).classList.add('panel--active');
    });
  });

  wireExport(analysis, mount);

  if (typeof context.onReloadAssets === 'function') {
    mount.querySelector('[data-action="reload-assets"]')?.addEventListener('click', (event) => {
      event.target.textContent = 'Reloading...';
      event.target.disabled = true;
      context.onReloadAssets();
    });
  }
}

/**
 * Fallback view when something downstream throws. Diagnostics is the one tab
 * that matters when the app cannot make sense of a replay, so it must render
 * even if everything else failed.
 */
export function renderFailure(error, mount, context = {}) {
  mount.innerHTML = `
    <section class="panel panel--active">
      <h2>Could not build the report</h2>
      <p class="status status--error">${esc(error && error.message ? error.message : String(error))}</p>
      <p class="muted">The replay parsed, but the analysis or rendering step failed. The raw parse
      results are below — copy this into a conversation with Claude and it can tell you what changed.</p>
      ${renderDiagnostics(null, context)}
      ${error && error.stack ? `<h3>Stack</h3><pre class="brief">${esc(error.stack)}</pre>` : ''}
    </section>`;
}

/* ------------------------------------------------------------------ */
/* overview                                                            */
/* ------------------------------------------------------------------ */

function renderOverview(analysis, ctx) {
  const { meta, focus, findings, farm, deaths } = analysis;

  const result = meta.winningTeam
    ? focus
      ? meta.winningTeam === focus.team
        ? '<span class="pill pill--win">Win</span>'
        : '<span class="pill pill--loss">Loss</span>'
      : `<span class="pill">${esc(ctx.teamName(meta.winningTeam))} won</span>`
    : '<span class="pill pill--muted">Result not recorded</span>';

  const myDeaths = focus ? deaths.filter((d) => d.isFocus) : [];

  const summary = `
    <div class="cards">
      <div class="card"><span class="card-label">Duration</span><span class="card-value">${formatClock(meta.duration)}</span></div>
      <div class="card"><span class="card-label">Result</span><span class="card-value">${result}</span></div>
      <div class="card"><span class="card-label">Kills in match</span><span class="card-value">${analysis.kills.length}</span></div>
      <div class="card"><span class="card-label">Teamfights</span><span class="card-value">${analysis.fights.filter((f) => !f.isPick).length}</span></div>
      ${focus ? `<div class="card"><span class="card-label">My deaths</span><span class="card-value">${myDeaths.length}</span></div>` : ''}
      ${focus ? `<div class="card"><span class="card-label">Solo deaths</span><span class="card-value">${myDeaths.filter((d) => d.flags.includes('solo')).length}</span></div>` : ''}
    </div>`;

  const findingsHtml = findings.length
    ? `<div class="findings">${findings
        .map(
          (f) => `<article class="finding ${severityClass(f.severity)}">
            <header><span class="finding-scope">${f.scope === 'you' ? 'You' : 'Team'}</span><h3>${esc(f.title)}</h3></header>
            <p>${esc(f.detail)}</p>
            ${f.evidence ? `<ul>${f.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
          </article>`
        )
        .join('')}</div>`
    : '<p class="muted">Nothing crossed the analyzer\'s thresholds — check the other tabs for the raw picture.</p>';

  const scoreboard = `
    <table class="table">
      <thead><tr><th>Player</th><th>Hero</th><th class="right">Souls</th><th class="right">K</th><th class="right">D</th><th class="right">A</th><th class="right">Hero dmg</th><th class="right">Obj dmg</th><th class="right">Healing</th></tr></thead>
      <tbody>
        ${ctx.ids
          .map(
            (team) => `
          <tr class="table-group"><td colspan="9" style="color:${ctx.teamColor(team)}">${esc(ctx.teamName(team))}</td></tr>
          ${(ctx.roster[team] || [])
            .slice()
            .sort((a, b) => (b.final?.netWorth ?? 0) - (a.final?.netWorth ?? 0))
            .map((p) => {
              const f = p.final || {};
              const me = focus && p.ctrl === focus.ctrl;
              return `<tr class="${me ? 'row--me' : ''}">
                <td><span class="dot" style="background:${ctx.playerColor(p.ctrl)}"></span>${esc(p.name)}${me ? ' <span class="tag">me</span>' : ''}</td>
                <td class="muted">${esc(p.hero || '—')}</td>
                <td class="right">${num(f.netWorth)}</td>
                <td class="right">${num(f.kills, '0')}</td>
                <td class="right">${num(f.deaths, '0')}</td>
                <td class="right">${num(f.assists, '0')}</td>
                <td class="right">${num(f.heroDamage, '0')}</td>
                <td class="right">${num(f.objectiveDamage, '0')}</td>
                <td class="right">${num(f.heroHealing, '0')}</td>
              </tr>`;
            })
            .join('')}`
          )
          .join('')}
      </tbody>
    </table>`;

  const objectiveMarkers = analysis.objectives
    .filter((o) => o.kind !== 'midboss_spawned' && o.takenByTeam !== null)
    .map((o) => ({
      t: o.t,
      label: `${formatClock(o.t)} objective to ${ctx.teamName(o.takenByTeam)}`,
      color: ctx.teamColor(o.takenByTeam)
    }));

  const degraded = meta.teamsDegraded
    ? `<p class="status status--error">No team numbering was found on the player controllers in this
       replay, so everyone is shown as one roster and anything team-relative (fight results,
       objective credit, soul lead) is unreliable. The Diagnostics tab has the field dump.</p>`
    : '';

  return `
    <h2>Overview</h2>
    ${degraded}
    ${summary}
    <h3>What the data flags</h3>
    ${findingsHtml}
    <h3>Soul lead over time</h3>
    <p class="muted">Above the line means ${esc(ctx.teamName(ctx.first))} is ahead. Dots mark objectives falling.</p>
    ${leadChart({
      points: farm.leadSeries,
      markers: objectiveMarkers,
      positiveLabel: `${ctx.teamName(ctx.first)} ahead`,
      negativeLabel: `${ctx.teamName(ctx.second)} ahead`
    })}
    <h3>Final scoreboard</h3>
    ${scoreboard}
  `;
}

/* ------------------------------------------------------------------ */
/* deaths                                                              */
/* ------------------------------------------------------------------ */

function renderDeaths(analysis, ctx) {
  const { deaths, focus, frame, players } = analysis;
  const mine = focus ? deaths.filter((d) => d.isFocus) : [];

  const flagHelp = `
    <details class="help">
      <summary>What the flags mean</summary>
      <ul>
        <li><b>solo</b> — no living teammate within roughly a fight's radius when you died.</li>
        <li><b>deep</b> — died more than 62% of the way toward the enemy base.</li>
        <li><b>outnumbered</b> — at least two more enemies than allies were close by.</li>
        <li><b>no-trade</b> — nobody on the other team died within 12 seconds either side.</li>
        <li><b>fresh-respawn</b> — died within 25 seconds of respawning.</li>
        <li><b>tilt-streak</b> — third or later death inside a three-minute window.</li>
      </ul>
    </details>`;

  const myTable = mine.length
    ? `<table class="table">
        <thead><tr><th>Time</th><th>Killed by</th><th class="right">Depth</th><th>Zone</th><th class="right">Allies near</th><th class="right">Enemies near</th><th class="right">Souls</th><th>Traded</th><th>Flags</th></tr></thead>
        <tbody>${mine
          .map(
            (d) => `<tr>
              <td>${formatClock(d.t)}</td>
              <td>${esc(d.killerName)}${d.assisters.length ? ` <span class="muted">+${d.assisters.length}</span>` : ''}</td>
              <td class="right">${d.depth === null ? '—' : d.depth.toFixed(2)}</td>
              <td class="muted">${esc(d.zone)}</td>
              <td class="right ${d.alliesNear === 0 ? 'warn' : ''}">${d.alliesNear}</td>
              <td class="right">${d.enemiesNear}</td>
              <td class="right">${num(d.netWorth)}</td>
              <td>${d.trade > 0 ? 'yes' : '<span class="warn">no</span>'}</td>
              <td>${d.flags.map((f) => `<span class="flag flag--${f}">${f}</span>`).join(' ')}</td>
            </tr>`
          )
          .join('')}</tbody>
      </table>`
    : '<p class="muted">No deaths recorded for the selected player.</p>';

  const myPoints = mine.map((d) => ({
    x: d.pos?.x ?? null,
    y: d.pos?.y ?? null,
    color: d.flags.includes('solo') ? COLORS.bad : COLORS.amber,
    emphasis: true,
    label: `${formatClock(d.t)} — killed by ${d.killerName} (${d.zone})`
  }));

  const allPoints = deaths
    .filter((d) => !d.isFocus)
    .map((d) => ({
      x: d.pos?.x ?? null,
      y: d.pos?.y ?? null,
      color: ctx.teamColor(d.team),
      emphasis: false,
      label: `${formatClock(d.t)} — ${d.name} killed by ${d.killerName}`
    }));

  const perPlayer = players
    .map((p) => ({
      label: p.name,
      value: deaths.filter((d) => d.ctrl === p.ctrl).length,
      color: ctx.playerColor(p.ctrl),
      emphasis: Boolean(focus && p.ctrl === focus.ctrl)
    }))
    .sort((a, b) => b.value - a.value);

  return `
    <h2>Deaths</h2>
    ${flagHelp}
    <h3>${focus ? `${esc(focus.name)}'s deaths (${mine.length})` : 'Select a player above to see their deaths'}</h3>
    ${myTable}
    <div class="split">
      <div>
        <h3>Where deaths happened</h3>
        <p class="muted">Bright dots are yours; red means you died with no teammate nearby. Rings mark each team's spawn.</p>
        ${mapPlot({
          points: [...allPoints, ...myPoints],
          bases: frame.bases,
          baseIds: frame.ids,
          caption: frame.ok ? '' : 'Base positions could not be derived, so distances are unscaled.'
        })}
      </div>
      <div>
        <h3>Deaths per player</h3>
        ${barRows({ rows: perPlayer, valueFormat: (v) => String(v) })}
      </div>
    </div>
  `;
}

/* ------------------------------------------------------------------ */
/* build                                                               */
/* ------------------------------------------------------------------ */

function priorityClass(priority) {
  return priority === 'high' ? 'finding--high' : priority === 'medium' ? 'finding--medium' : 'finding--good';
}

function renderBuild(analysis, ctx) {
  const build = analysis.build;
  const focus = analysis.focus;

  if (!build || !build.ok) {
    return '<h2>Build</h2><p class="muted">Select a player above to analyse their build.</p>';
  }

  const notes = build.notes.length
    ? `<p class="muted">${build.notes.map((n) => esc(n)).join(' ')}</p>`
    : '';

  /* ---- suggestions ---- */
  const suggestions = build.suggestions.length
    ? `<div class="findings">${build.suggestions
        .map(
          (s) => `<article class="finding ${priorityClass(s.priority)}">
            <header><span class="finding-scope">Build</span><h3>${esc(s.title)}</h3></header>
            <p>${esc(s.reason)}</p>
            ${s.evidence.length ? `<ul>${s.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
            ${
              s.items.length
                ? `<p class="suggest-items">Consider: ${s.items
                    .map(
                      (i) =>
                        `<span class="chip">${esc(i.name)}${Number.isFinite(i.winRate) ? ` <span class="muted">${Math.round(i.winRate * 100)}%</span>` : ''}</span>`
                    )
                    .join(' ')}</p>`
                : ''
            }
          </article>`
        )
        .join('')}</div>`
    : '<p class="muted">Nothing in this build crossed the thresholds the analyzer checks.</p>';

  /* ---- damage profile ---- */
  const taken = build.damage?.taken;
  const damageRows =
    taken && taken.total > 0
      ? barRows({
          rows: [
            { label: 'Weapon fire', value: Math.round(taken.weapon), color: COLORS.amber },
            { label: 'Ability / spirit', value: Math.round(taken.ability), color: '#8b95f6' },
            { label: 'Unclassified', value: Math.round(taken.mixed), color: COLORS.text }
          ].filter((r) => r.value > 0)
        })
      : '<p class="muted">No hero damage was captured against you.</p>';

  const threatRows = build.threats.length
    ? barRows({
        rows: build.threats.map((t) => ({
          label: `${t.name}${t.hero ? ` (${t.hero})` : ''}`,
          value: Math.round(t.dmg),
          color: ctx.teamColor(analysis.players.find((p) => p.ctrl === t.ctrl)?.team)
        }))
      })
    : '<p class="muted">No per-enemy damage captured.</p>';

  /* ---- purchases ---- */
  const purchaseRows = build.purchases.length
    ? build.purchases
        .map((p) => {
          const b = p.benchmark;
          const lateness =
            b && Number.isFinite(b.delta)
              ? b.delta > 240
                ? `<span class="warn">${Math.round(b.delta / 60)} min late</span>`
                : b.delta < -240
                  ? `<span class="ok">${Math.round(-b.delta / 60)} min early</span>`
                  : 'on time'
              : '—';
          return `<tr>
            <td class="mono">${formatClock(p.t)}</td>
            <td>${esc(p.name)}</td>
            <td class="muted">${esc(p.slotLabel)}${p.tier ? ` T${p.tier}` : ''}</td>
            <td class="right">${num(p.cost)}</td>
            <td class="right">${num(p.committedAfter)}</td>
            <td class="right">${b && Number.isFinite(b.avgBoughtAt) ? formatClock(b.avgBoughtAt) : '—'}</td>
            <td>${lateness}</td>
            <td class="right">${b && Number.isFinite(b.winRate) ? `${Math.round(b.winRate * 100)}%` : '—'}</td>
          </tr>`;
        })
        .join('')
    : '';

  const purchaseTable = build.purchases.length
    ? `<table class="table">
        <thead><tr><th>Time</th><th>Item</th><th>Slot</th><th class="right">Cost</th><th class="right">Spent so far</th><th class="right">Usual time</th><th>Timing</th><th class="right">Win rate</th></tr></thead>
        <tbody>${purchaseRows}</tbody>
      </table>`
    : '<p class="muted">No purchases were resolved for this player — check Diagnostics.</p>';

  /* ---- spend curve ---- */
  const spendChart = build.spend.series.length
    ? lineChart({
        series: [
          { label: 'Net worth', color: COLORS.sapphire, points: build.spend.series.map((s) => ({ t: s.t, v: s.netWorth })), emphasis: true },
          { label: 'Committed to items', color: COLORS.focus, points: build.spend.series.map((s) => ({ t: s.t, v: s.committed })), emphasis: true },
          { label: 'Unspent (estimated)', color: COLORS.bad, points: build.spend.series.map((s) => ({ t: s.t, v: Math.max(0, s.banked) })) }
        ],
        height: 280
      })
    : '<p class="muted">Not enough data to draw the spend curve.</p>';

  /* ---- categories ---- */
  const categoryRows = barRows({
    rows: [
      { label: 'Weapon', value: Math.round(build.categorySouls.weapon), color: COLORS.amber },
      { label: 'Vitality', value: Math.round(build.categorySouls.vitality), color: COLORS.good },
      { label: 'Spirit', value: Math.round(build.categorySouls.spirit), color: '#8b95f6' },
      { label: 'Unclassified', value: Math.round(build.categorySouls.unknown), color: COLORS.text }
    ].filter((r) => r.value > 0)
  });

  /* ---- what killed you ---- */
  const deathRows = build.deathContext.length
    ? `<table class="table table--compact">
        <thead><tr><th>Time</th><th>Killed by</th><th class="right">Items owned</th><th class="right">Unspent</th><th>Damage in the last 8s</th></tr></thead>
        <tbody>${build.deathContext
          .map(
            (d) => `<tr>
              <td class="mono">${formatClock(d.t)}</td>
              <td>${esc(d.killerName)}</td>
              <td class="right">${d.itemsOwned}</td>
              <td class="right ${d.soulsBanked !== null && d.soulsBanked > 2000 ? 'warn' : ''}">${num(d.soulsBanked)}</td>
              <td class="muted">${
                d.breakdown.length
                  ? d.breakdown.map((b) => `${esc(b.name)} ${num(b.dmg)} <span class="flag">${b.label}</span>`).join(', ')
                  : 'not captured'
              }</td>
            </tr>`
          )
          .join('')}</tbody>
      </table>`
    : '<p class="muted">No deaths to break down.</p>';

  /* ---- benchmark ---- */
  const bench = build.benchmark;
  const benchBlock = bench.available
    ? `
      <p class="muted">Compared against ${bench.sampleMatches.toLocaleString()} recent matches
      ${bench.scope && bench.scope.startsWith('hero:') ? `on ${esc(build.hero || 'this hero')}` : 'across all heroes'}
      (deadlock-api, last 30 days). Win rate is correlation, not proof — a losing game buys different items.</p>
      <div class="split">
        <div>
          <h3>Popular items you never bought</h3>
          ${
            bench.missed.length
              ? `<table class="table table--compact"><thead><tr><th>Item</th><th class="right">Pick</th><th class="right">Win</th><th class="right">Usually by</th></tr></thead><tbody>${bench.missed
                  .map(
                    (m) =>
                      `<tr><td>${esc(m.name)}</td><td class="right">${Math.round(m.pickRate * 100)}%</td><td class="right">${Math.round(m.winRate * 100)}%</td><td class="right">${Number.isFinite(m.avgBoughtAt) ? formatClock(m.avgBoughtAt) : '—'}</td></tr>`
                  )
                  .join('')}</tbody></table>`
              : '<p class="muted">None — you covered the popular picks.</p>'
          }
        </div>
        <div>
          <h3>Bought later than usual</h3>
          ${
            bench.late.length
              ? `<table class="table table--compact"><thead><tr><th>Item</th><th class="right">You</th><th class="right">Average</th><th class="right">Late by</th></tr></thead><tbody>${bench.late
                  .map(
                    (l) =>
                      `<tr><td>${esc(l.name)}</td><td class="right">${formatClock(l.yours)}</td><td class="right">${formatClock(l.median)}</td><td class="right warn">${Math.round(l.delta / 60)} min</td></tr>`
                  )
                  .join('')}</tbody></table>`
              : '<p class="muted">Nothing was significantly late.</p>'
          }
        </div>
      </div>`
    : `<p class="status status--error">Item win-rate data is unavailable, so timings and item choices are not
       benchmarked against real matches. Everything else on this tab comes from the replay itself.</p>`;

  return `
    <h2>Build${focus ? ` — ${esc(focus.name)}${build.hero ? ` (${esc(build.hero)})` : ''}` : ''}</h2>
    ${notes}

    <div class="cards">
      <div class="card"><span class="card-label">Items bought</span><span class="card-value">${build.purchases.length}</span></div>
      <div class="card"><span class="card-label">Souls committed</span><span class="card-value">${num(build.spend.totalCommitted)}</span></div>
      <div class="card"><span class="card-label">Damage taken: ability</span><span class="card-value">${taken && taken.abilityShare !== null ? `${Math.round(taken.abilityShare * 100)}%` : '—'}</span></div>
      <div class="card"><span class="card-label">Damage taken: weapon</span><span class="card-value">${taken && taken.weaponShare !== null ? `${Math.round(taken.weaponShare * 100)}%` : '—'}</span></div>
      <div class="card"><span class="card-label">Enemy healing</span><span class="card-value">${num(build.enemyHealing, '0')}</span></div>
      <div class="card"><span class="card-label">Longest soul bank</span><span class="card-value">${
        build.spend.worstBanking
          ? `${Math.round((build.spend.worstBanking.to - build.spend.worstBanking.from) / 60)} min`
          : '—'
      }</span></div>
    </div>

    <h3>What to change</h3>
    ${suggestions}

    <h3>Purchase order</h3>
    ${purchaseTable}

    <h3>Spending over time</h3>
    <p class="muted">Unspent is estimated as net worth minus what your purchases cost${build.spend.costsEstimated ? ', with some costs inferred from item tier' : ''}. Flat stretches of the green line are souls doing nothing.</p>
    ${spendChart}

    <div class="split">
      <div>
        <h3>Damage taken by kind</h3>
        <p class="muted">Classified by whether the damage carried an ability, not by a hardcoded type table.</p>
        ${damageRows}
      </div>
      <div>
        <h3>Who dealt it</h3>
        ${threatRows}
      </div>
    </div>

    <div class="split">
      <div>
        <h3>Souls by item category</h3>
        ${categoryRows}
      </div>
      <div>
        <h3>State at each death</h3>
        ${deathRows}
      </div>
    </div>

    <h3>Against real matches</h3>
    ${benchBlock}
  `;
}

/* ------------------------------------------------------------------ */
/* farm & items                                                        */
/* ------------------------------------------------------------------ */

function renderFarm(analysis, ctx) {
  const { farm, focus, items, meta } = analysis;

  const series = farm.rows.map((row) => ({
    label: row.name,
    color: ctx.playerColor(row.ctrl),
    points: row.series,
    emphasis: Boolean(focus && row.ctrl === focus.ctrl)
  }));

  const marks = farm.milestones.filter((m) => m <= meta.duration + 5);

  const table = `
    <table class="table">
      <thead><tr><th>Player</th>${marks.map((m) => `<th class="right">${formatClock(m)}</th>`).join('')}<th class="right">Final</th></tr></thead>
      <tbody>${farm.rows
        .slice()
        .sort((a, b) => (b.final ?? 0) - (a.final ?? 0))
        .map((row) => {
          const me = focus && row.ctrl === focus.ctrl;
          return `<tr class="${me ? 'row--me' : ''}">
            <td><span class="dot" style="background:${ctx.playerColor(row.ctrl)}"></span>${esc(row.name)}${me ? ' <span class="tag">me</span>' : ''}</td>
            ${marks.map((m) => `<td class="right">${num(row.marks[m])}</td>`).join('')}
            <td class="right">${num(row.final)}</td>
          </tr>`;
        })
        .join('')}</tbody>
    </table>`;

  let laneBlock = '';
  if (focus && farm.laneOpponent) {
    const me = farm.rows.find((r) => r.ctrl === focus.ctrl);
    const opp = farm.laneOpponent;
    laneBlock = `
      <h3>You vs your closest early opponent</h3>
      <p class="muted">${esc(opp.name)} spent more of the first ten minutes near you than anyone else on the enemy team.</p>
      ${lineChart({
        series: [
          { label: `${me?.name ?? 'You'} (you)`, color: COLORS.focus, points: me?.series || [], emphasis: true },
          { label: opp.name, color: ctx.teamColor(opp.team), points: opp.series, emphasis: true }
        ],
        height: 260
      })}`;
  }

  const buyers = focus ? items.filter((i) => i.ctrl === focus.ctrl) : [];
  const itemLanes = focus
    ? [
        {
          label: focus.name,
          color: COLORS.focus,
          events: buyers.map((i) => ({ t: i.t, label: `${formatClock(i.t)} — ${i.item}`, color: COLORS.focus }))
        },
        ...analysis.players
          .filter((p) => p.ctrl !== focus.ctrl)
          .map((p) => ({
            label: p.name,
            color: ctx.teamColor(p.team),
            events: items.filter((i) => i.ctrl === p.ctrl).map((i) => ({ t: i.t, label: `${formatClock(i.t)} — ${i.item}` }))
          }))
      ]
    : [];

  const unresolved = items.filter((i) => !i.resolved).length;

  const itemList = buyers.length
    ? `<ol class="item-list">${buyers
        .map((i) => `<li><span class="mono">${formatClock(i.t)}</span> ${esc(i.item)}${i.cost ? ` <span class="muted">${num(i.cost)}</span>` : ''}</li>`)
        .join('')}</ol>`
    : '<p class="muted">No purchases resolved to this player. If this is empty for everyone, check Diagnostics.</p>';

  return `
    <h2>Farm &amp; items</h2>
    <h3>Net worth over time</h3>
    ${lineChart({ series })}
    <h3>Net worth at milestones</h3>
    ${table}
    ${laneBlock}
    <h3>Item purchases</h3>
    ${unresolved ? `<p class="muted">${unresolved} purchase${unresolved === 1 ? '' : 's'} could not be matched to an item name — the asset lookup may be offline.</p>` : ''}
    ${itemLanes.length ? timeline({ lanes: itemLanes, duration: Math.max(meta.duration, 1) }) : ''}
    <h3>${focus ? `${esc(focus.name)}'s build order` : 'Build order'}</h3>
    ${itemList}
  `;
}

/* ------------------------------------------------------------------ */
/* teamfights                                                          */
/* ------------------------------------------------------------------ */

function renderFights(analysis, ctx) {
  const { fights, focus } = analysis;
  const realFights = fights.filter((f) => !f.isPick);
  const picks = fights.filter((f) => f.isPick);

  if (fights.length === 0) return '<h2>Teamfights</h2><p class="muted">No fights detected in this replay.</p>';

  const cards = fights
    .map((f) => {
      const firstSide = f.participation.filter((p) => p.team === ctx.first);
      const secondSide = f.participation.filter((p) => p.team === ctx.second);
      const myTeam = focus ? f.participation.filter((p) => p.team === focus.team) : [];
      const missing = myTeam.filter((p) => !p.present && p.alive !== false);
      const iWasThere = focus ? myTeam.find((p) => p.ctrl === focus.ctrl)?.present : null;

      const outcome = focus
        ? f.winner === null
          ? 'Even'
          : f.winner === focus.team
            ? 'Won'
            : 'Lost'
        : f.winner
          ? `${ctx.teamName(f.winner)} won`
          : 'Even';

      const roster = (list) =>
        list
          .map(
            (p) =>
              `<span class="chip${p.present ? '' : ' chip--absent'}" title="${p.damage ? `${num(p.damage)} hero damage` : 'no hero damage in this window'}"><span class="dot" style="background:${ctx.playerColor(p.ctrl)}"></span>${esc(p.name)}</span>`
          )
          .join('');

      return `
        <article class="fight fight--${String(outcome).toLowerCase().replace(/\s+/g, '-')}">
          <header>
            <span class="fight-time">${formatClock(f.start)}</span>
            <span class="fight-kind">${f.isPick ? 'Pick' : 'Fight'}</span>
            <span class="fight-score">${esc(ctx.teamName(ctx.first))} ${f.score[ctx.first]} – ${f.score[ctx.second]} ${esc(ctx.teamName(ctx.second))}</span>
            <span class="fight-outcome">${esc(outcome)}</span>
            ${focus ? `<span class="fight-attend ${iWasThere ? 'ok' : 'warn'}">${iWasThere ? 'you were there' : 'you were not there'}</span>` : ''}
          </header>
          <div class="fight-rosters">
            <div><span class="muted">${esc(ctx.teamName(ctx.first))}</span> ${roster(firstSide)}</div>
            <div><span class="muted">${esc(ctx.teamName(ctx.second))}</span> ${roster(secondSide)}</div>
          </div>
          ${missing.length ? `<p class="fight-missing">Alive but absent on your side: ${missing.map((p) => esc(p.name)).join(', ')}</p>` : ''}
          <ul class="fight-kills">${f.deaths
            .map((d) => `<li><span class="mono">${formatClock(d.t)}</span> ${esc(d.killerName)} killed ${esc(d.victimName)}</li>`)
            .join('')}</ul>
        </article>`;
    })
    .join('');

  const attendance =
    focus && realFights.length
      ? analysis.players
          .filter((p) => p.team === focus.team)
          .map((p) => ({
            label: p.name,
            value: realFights.filter((f) => f.participation.some((x) => x.ctrl === p.ctrl && x.present)).length,
            color: ctx.playerColor(p.ctrl),
            emphasis: p.ctrl === focus.ctrl
          }))
          .sort((a, b) => b.value - a.value)
      : [];

  return `
    <h2>Teamfights (${realFights.length})${picks.length ? ` <span class="muted">+ ${picks.length} pick${picks.length === 1 ? '' : 's'}</span>` : ''}</h2>
    <p class="muted">A fight is a cluster of kills close together in time and space; an isolated single kill is counted as a pick instead. "Present" means a player either dealt hero damage in the window or was standing close to the fight when it started.</p>
    ${attendance.length ? `<h3>Fight attendance on your team</h3>${barRows({ rows: attendance, valueFormat: (v) => `${v} / ${realFights.length}` })}` : ''}
    <div class="fights">${cards}</div>
  `;
}

/* ------------------------------------------------------------------ */
/* macro                                                               */
/* ------------------------------------------------------------------ */

const EMPTY_RATE = { won: 0, converted: 0, rate: null };

function renderMacro(analysis, ctx) {
  const { macro, focus, objectives, meta } = analysis;
  const focusTeam = focus && ctx.teams.includes(focus.team) ? focus.team : ctx.first;
  const enemyTeam = ctx.teams.other(focusTeam) ?? ctx.second;

  const mineConv = macro.conversionRate[focusTeam] || EMPTY_RATE;
  const theirConv = macro.conversionRate[enemyTeam] || EMPTY_RATE;
  const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);

  const objectiveLanes = ctx.ids.map((team) => ({
    label: ctx.teamName(team),
    color: ctx.teamColor(team),
    events: objectives
      .filter((o) => o.takenByTeam === team && o.kind !== 'midboss_spawned')
      .map((o) => ({ t: o.t, label: `${formatClock(o.t)} — ${o.kind}`, shape: o.kind === 'midboss' ? 'diamond' : 'circle' }))
  }));

  const unconverted = macro.conversions.filter((c) => c.winner === focusTeam && !c.converted);

  const spreadSeries = ctx.ids.map((team) => ({
    label: ctx.teamName(team),
    color: ctx.teamColor(team),
    points: macro.spread[team] || [],
    emphasis: team === focusTeam
  }));

  return `
    <h2>Team macro</h2>
    <div class="cards">
      <div class="card"><span class="card-label">Decisive fights won (you)</span><span class="card-value">${mineConv.won}</span></div>
      <div class="card"><span class="card-label">Converted into an objective</span><span class="card-value">${mineConv.converted} <span class="muted">(${pct(mineConv.rate)})</span></span></div>
      <div class="card"><span class="card-label">Enemy conversion</span><span class="card-value">${theirConv.converted}/${theirConv.won} <span class="muted">(${pct(theirConv.rate)})</span></span></div>
      <div class="card"><span class="card-label">Objectives taken</span><span class="card-value">${macro.objectiveCount[focusTeam] ?? 0} <span class="muted">vs ${macro.objectiveCount[enemyTeam] ?? 0}</span></span></div>
      <div class="card"><span class="card-label">Deaths while 3k+ ahead</span><span class="card-value">${macro.deathsWhileAhead[focusTeam] ?? 0}</span></div>
      <div class="card"><span class="card-label">Peak soul lead</span><span class="card-value">${num(Math.abs(macro.lead.peak.v))} <span class="muted">${formatClock(macro.lead.peak.t)}</span></span></div>
    </div>

    <h3>Objective timeline</h3>
    <p class="muted">Diamonds are the mid boss; circles are buildings.</p>
    ${timeline({ lanes: objectiveLanes, duration: Math.max(meta.duration, 1) })}

    <h3>Fights won that bought nothing</h3>
    ${
      unconverted.length
        ? `<ul class="plain">${unconverted
            .map((c) => `<li><span class="mono">${formatClock(c.t)}</span> won by ${c.margin} — no objective taken within 75 seconds</li>`)
            .join('')}</ul>`
        : '<p class="muted">Every decisive fight your team won was followed by an objective, or there were none to measure.</p>'
    }

    <h3>How spread out each team was</h3>
    <p class="muted">Average distance between living teammates, as a fraction of the map's length. Higher means more split.</p>
    ${lineChart({ series: spreadSeries, height: 240, yFormat: (v) => v.toFixed(2) })}
  `;
}

/* ------------------------------------------------------------------ */
/* export                                                              */
/* ------------------------------------------------------------------ */

function renderExport(analysis) {
  return `
    <h2>Ask Claude</h2>
    <p>Copy this brief and paste it into a Claude conversation. It contains every death with its
    context, the fight log, farm milestones, item timings and the objective log — enough for a
    written review without Claude needing the replay itself.</p>
    <div class="button-row">
      <button class="btn btn--primary" data-action="copy-md">Copy coaching brief (markdown)</button>
      <button class="btn" data-action="copy-json">Copy raw JSON</button>
      <button class="btn" data-action="download-md">Download .md</button>
      <button class="btn" data-action="download-json">Download .json</button>
      <span class="copy-status" data-role="copy-status"></span>
    </div>
    <textarea class="brief" data-role="brief" readonly spellcheck="false"></textarea>
  `;
}

function wireExport(analysis, mount) {
  const textarea = mount.querySelector('[data-role="brief"]');
  const status = mount.querySelector('[data-role="copy-status"]');
  if (!textarea) return;

  const markdown = buildMarkdownBrief(analysis);
  const json = buildJsonBrief(analysis);
  textarea.value = markdown;

  const say = (message) => {
    if (!status) return;
    status.textContent = message;
    setTimeout(() => {
      status.textContent = '';
    }, 2600);
  };

  const copy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      say(`${label} copied (${Math.round(text.length / 1024)} KB)`);
    } catch (_) {
      textarea.value = text;
      textarea.select();
      say('Clipboard blocked — the text is selected, press Ctrl+C');
    }
  };

  const download = (text, filename, type) => {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    say(`Saved ${filename}`);
  };

  const base = (analysis.meta.fileName || 'replay').replace(/\.dem$/i, '');

  mount.querySelector('[data-action="copy-md"]')?.addEventListener('click', () => copy(markdown, 'Brief'));
  mount.querySelector('[data-action="copy-json"]')?.addEventListener('click', () => copy(json, 'JSON'));
  mount.querySelector('[data-action="download-md"]')?.addEventListener('click', () =>
    download(markdown, `${base}-review.md`, 'text/markdown')
  );
  mount.querySelector('[data-action="download-json"]')?.addEventListener('click', () =>
    download(json, `${base}-review.json`, 'application/json')
  );
}

/* ------------------------------------------------------------------ */
/* diagnostics                                                         */
/* ------------------------------------------------------------------ */

function renderDiagnostics(analysis, context) {
  const raw = context.raw || {};
  const diagnostics = raw.diagnostics || {};
  const names = context.nameStatus || {};

  const counts = Object.entries(diagnostics.messageCounts || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="right">${v.toLocaleString()}</td></tr>`)
    .join('');

  const fields = diagnostics.controllerFieldSample || {};
  const fieldRows = Object.entries(fields)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td class="mono">${esc(String(v)).slice(0, 60)}</td></tr>`)
    .join('');

  // Team values as they actually appeared, which is the first thing to check
  // when a build renumbers them.
  const teamTally = new Map();
  for (const p of raw.players || []) {
    const key = p.team === null || p.team === undefined ? 'null' : String(p.team);
    if (!teamTally.has(key)) teamTally.set(key, []);
    teamTally.get(key).push(p.name);
  }
  const teamRows = Array.from(teamTally.entries())
    .map(
      ([team, names_]) =>
        `<tr><td class="mono">m_iTeamNum = ${esc(team)}</td><td>${names_.length} controller${names_.length === 1 ? '' : 's'}: ${esc(names_.slice(0, 8).join(', '))}</td></tr>`
    )
    .join('');

  const analysisRows = analysis
    ? `
        <tr><td>Teams in play</td><td class="mono">${esc(analysis.teamIds.join(' and '))} ${analysis.teams.ok ? '' : '<span class="warn">(fallback — could not derive)</span>'}</td></tr>
        <tr><td>Players on a team</td><td>${analysis.players.length}</td></tr>
        <tr><td>Controllers ignored as non-players</td><td>${analysis.nonPlayers.length}${analysis.nonPlayers.length ? `: ${esc(analysis.nonPlayers.map((p) => `${p.name} (team ${p.team})`).join(', '))}` : ''}</td></tr>
        <tr><td>Map scale derived</td><td>${analysis.frame.ok ? `yes (${Math.round(analysis.frame.span).toLocaleString()} units base to base)` : '<span class="warn">no — spatial analysis is degraded</span>'}</td></tr>`
    : '<tr><td>Analysis</td><td class="warn">did not complete</td></tr>';

  /* Item name resolution — the single most useful thing to see when items show
     as numeric ids. It separates "the fetch failed" from "the fetch worked but
     the replay's ids are from a different id space". */
  const purchaseIds = Array.from(new Set((raw.items || []).map((i) => i.abilityId).filter((v) => v !== null && v !== undefined)));
  const resolvedItems = analysis ? analysis.items.filter((i) => i.resolved) : [];
  const unresolvedIds = analysis
    ? Array.from(new Set(analysis.items.filter((i) => !i.resolved).map((i) => i.abilityId)))
    : purchaseIds;

  const lookupBlock = `
    <h3>Item name resolution</h3>
    <table class="table table--compact"><tbody>
      <tr><td>Distinct item ids in this replay</td><td>${purchaseIds.length}</td></tr>
      <tr><td>Resolved to a name</td><td class="${analysis && resolvedItems.length === 0 && purchaseIds.length > 0 ? 'warn' : ''}">${analysis ? `${resolvedItems.length} of ${analysis.items.length} purchases` : 'n/a'}</td></tr>
      <tr><td>Source used</td><td class="mono">${esc(names.source || 'none')}</td></tr>
      ${
        unresolvedIds.length
          ? `<tr><td>Unresolved ids (sample)</td><td class="mono">${esc(unresolvedIds.slice(0, 12).join(', '))}</td></tr>`
          : ''
      }
    </tbody></table>
    ${
      (names.itemAttempts || []).length
        ? `<p class="muted">Item endpoints tried:</p><ul class="plain mono">${names.itemAttempts.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`
        : ''
    }
    ${
      (names.heroAttempts || []).length
        ? `<p class="muted">Hero endpoints tried:</p><ul class="plain mono">${names.heroAttempts.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`
        : ''
    }
    ${
      names.itemSample
        ? `<details><summary>First entry the asset service returned</summary><pre class="brief">${esc(names.itemSample)}</pre></details>`
        : ''
    }
    <div class="button-row">
      <button class="btn" data-action="reload-assets">Reload item data</button>
      <span class="muted small">Clears the cached names and win rates and fetches them again.</span>
    </div>`;

  const classBlock = (diagnostics.itemLikeClasses || []).length
    ? `<h3>Item-like entity classes in this replay</h3>
       <p class="muted">${diagnostics.entityClassCount || 0} entity classes total. These are the ones whose
       names mention an item or upgrade — a route to item identity that needs no external service.</p>
       <details><summary>Show ${diagnostics.itemLikeClasses.length}</summary>
         <ul class="plain mono">${diagnostics.itemLikeClasses.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
       </details>`
    : '';

  return `
    <h2>Diagnostics</h2>
    <p class="muted">If a number looks wrong anywhere in the app, the answer is usually here. Copy this
    whole tab into a conversation with Claude and it can tell you which field changed.</p>
    ${lookupBlock}
    ${classBlock}

    <h3>Parse summary</h3>
    <table class="table table--compact">
      <tbody>
        <tr><td>File</td><td>${esc(raw.fileName || '—')} (${((raw.fileSize || 0) / 1048576).toFixed(1)} MB)</td></tr>
        <tr><td>Controllers found</td><td>${(raw.players || []).length}</td></tr>
        ${analysisRows}
        <tr><td>State samples</td><td>${(raw.samples || []).length.toLocaleString()}</td></tr>
        <tr><td>Kills captured</td><td>${(raw.kills || []).length.toLocaleString()}</td></tr>
        <tr><td>Hero id field</td><td class="mono">${esc(diagnostics.heroFieldGuess || 'not detected')}</td></tr>
        <tr><td>Player slot field</td><td class="mono">${esc(diagnostics.slotFieldGuess || 'not detected')}</td></tr>
        <tr><td>Item purchases unmatched to a player</td><td>${diagnostics.unresolvedItemUserIds ?? 0}</td></tr>
        <tr><td>Item name lookup</td><td>${esc(names.items || 'not attempted')}</td></tr>
        <tr><td>Hero name lookup</td><td>${esc(names.heroes || 'not attempted')}</td></tr>
        <tr><td>Item win-rate stats</td><td>${esc(names.itemStats || 'not attempted')}</td></tr>
        <tr><td>Damage types seen</td><td class="mono">${esc(
          Array.from(new Set((raw.damageByType || []).map((r) => r.type))).join(', ') || 'none'
        )}</td></tr>
        <tr><td>Message types missing from this parser build</td><td class="mono">${esc((diagnostics.missingMessageTypes || []).join(', ') || 'none')}</td></tr>
      </tbody>
    </table>

    <h3>Team numbering as it appeared</h3>
    <table class="table table--compact"><tbody>${teamRows || '<tr><td colspan="2" class="warn">No controllers found.</td></tr>'}</tbody></table>

    <h3>Messages seen</h3>
    <table class="table table--compact"><tbody>${counts || '<tr><td colspan="2" class="warn">No messages captured at all — the parser probably failed.</td></tr>'}</tbody></table>

    ${
      (diagnostics.errors || []).length
        ? `<h3>Errors (${diagnostics.errors.length})</h3><ul class="plain mono">${diagnostics.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`
        : '<h3>Errors</h3><p class="muted">None.</p>'
    }

    <h3>All replicated fields on one player controller</h3>
    <p class="muted">This is the schema this game build actually shipped. If souls or K/D/A read as
    zero, the field was renamed and the new name is in this list.</p>
    <details><summary>Show ${Object.keys(fields).length} fields</summary>
      <table class="table table--compact"><tbody>${fieldRows}</tbody></table>
    </details>
  `;
}
