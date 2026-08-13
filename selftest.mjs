/*
 * selftest.mjs — proves the analysis maths on a synthetic match.
 *
 * The parse layer needs a browser and a real replay, but everything downstream
 * of it is pure. This builds a match with known properties and checks the
 * analyzer reaches the conclusions it should.
 *
 *   node selftest.mjs
 */

import assert from 'node:assert/strict';
import { analyze, deriveTeams, deriveMapFrame, territoryDepth, formatClock, TEAM_AMBER, TEAM_SAPPHIRE } from './js/analyze.js';
import { buildMarkdownBrief, buildJsonBrief } from './js/export.js';

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
    process.exitCode = 1;
  }
};

import { raw, FOCUS, RIVAL, AMBER_BASE, SAPPHIRE_BASE, samples, itemsById, itemStats } from './tools/fixture.mjs';
import { analyzeBuild, labelDamageTypes } from './js/build.js';

/* ------------------------------------------------------------------ */
/* tests                                                               */
/* ------------------------------------------------------------------ */

console.log('\nDeadlock Replay Analyzer — self test\n');

const frame = deriveMapFrame(raw);

check('map frame is derived from spawn positions', () => {
  assert.equal(frame.ok, true);
  assert.ok(Math.abs(frame.span - 10000) < 50, `span was ${frame.span}`);
});

check('territory depth reads 0 at own base and 1 at enemy base', () => {
  assert.ok(Math.abs(territoryDepth(frame, TEAM_AMBER, AMBER_BASE) - 0) < 0.02);
  assert.ok(Math.abs(territoryDepth(frame, TEAM_AMBER, SAPPHIRE_BASE) - 1) < 0.02);
  assert.ok(Math.abs(territoryDepth(frame, TEAM_SAPPHIRE, AMBER_BASE) - 1) < 0.02);
});

const analysis = analyze(raw, {
  focusCtrl: FOCUS.ctrl,
  heroName: (id) => `Hero${id}`,
  itemName: (id) => ({ name: `Item${id}`, cost: id * 10, tier: 1, slot: 'weapon' })
});

check('every player is carried through', () => {
  assert.equal(analysis.players.length, 12);
  assert.equal(analysis.focus.name, 'A1');
  assert.equal(analysis.focus.hero, 'Hero10');
});

check('deaths are attributed to the right victim and killer', () => {
  const mine = analysis.deaths.filter((d) => d.isFocus);
  assert.equal(mine.length, 2);
  assert.equal(mine[0].killerName, 'S1');
  assert.equal(mine[1].assisters.length, 1);
});

check('a solo death deep in enemy territory is flagged as such', () => {
  const first = analysis.deaths.find((d) => d.isFocus);
  assert.ok(Math.abs(first.depth - 0.9) < 0.02, `depth was ${first.depth}`);
  assert.ok(first.flags.includes('deep'), `flags: ${first.flags}`);
  assert.ok(first.flags.includes('solo'), `flags: ${first.flags}`);
  assert.ok(first.flags.includes('outnumbered'), `flags: ${first.flags}`);
  assert.ok(first.flags.includes('no-trade'), `flags: ${first.flags}`);
  assert.equal(first.alliesNear, 0);
  assert.equal(first.enemiesNear, 3);
});

check('deaths inside a fight are not flagged solo', () => {
  const inFight = analysis.deaths.find((d) => d.t === 909);
  assert.ok(!inFight.flags.includes('solo'), `flags: ${inFight.flags}`);
  assert.ok(inFight.trade > 0, 'should have traded');
});

check('kills cluster into the right number of fights', () => {
  // 300 and 620 are isolated; 900-909 is one fight; 1200-1204 is another.
  assert.equal(analysis.fights.length, 4, `fights: ${analysis.fights.map((f) => formatClock(f.start)).join(', ')}`);
  const big = analysis.fights.find((f) => Math.round(f.start) === 900);
  assert.equal(big.deaths.length, 4);
  assert.equal(big.score[TEAM_AMBER], 3);
  assert.equal(big.score[TEAM_SAPPHIRE], 1);
  assert.equal(big.winner, TEAM_AMBER);
});

check('fight participation separates who was there from who was not', () => {
  const big = analysis.fights.find((f) => Math.round(f.start) === 900);
  const present = big.participation.filter((p) => p.present).map((p) => p.name).sort();
  assert.deepEqual(present, ['A1', 'A2', 'A3', 'S1', 'S2', 'S3']);
  const absent = big.participation.filter((p) => !p.present).map((p) => p.name).sort();
  assert.deepEqual(absent, ['A4', 'A5', 'A6', 'S4', 'S5', 'S6']);
});

check('net worth milestones line up with the synthetic growth rate', () => {
  const me = analysis.farm.rows.find((r) => r.ctrl === FOCUS.ctrl);
  assert.equal(me.marks[600], 500 + 600 * 5);
  const rival = analysis.farm.rows.find((r) => r.ctrl === RIVAL.ctrl);
  assert.equal(rival.marks[600], 500 + 600 * 9);
});

check('the lane opponent is the enemy who stayed closest early', () => {
  assert.ok(analysis.farm.laneOpponent, 'no lane opponent found');
  assert.equal(analysis.farm.laneOpponent.name, 'S1');
});

check('sold items are excluded from the build order', () => {
  const mine = analysis.items.filter((i) => i.ctrl === FOCUS.ctrl);
  assert.equal(mine.length, 4, 'four bought, one sold');
  assert.equal(mine[0].item, 'Item111');
  assert.equal(mine[0].cost, 1110);
  assert.ok(!mine.some((i) => i.abilityId === 333), 'the sold item should not appear');
});

check('objective credit goes to the team that did not lose the building', () => {
  assert.equal(analysis.objectives[0].takenByTeam, TEAM_SAPPHIRE);
  assert.equal(analysis.objectives[1].takenByTeam, TEAM_AMBER);
  assert.equal(analysis.macro.objectiveCount[TEAM_AMBER], 1);
  assert.equal(analysis.macro.objectiveCount[TEAM_SAPPHIRE], 1);
});

check('fight-to-objective conversion is measured correctly', () => {
  const conv = analysis.macro.conversionRate[TEAM_AMBER];
  // Two decisive Amber wins (900 by +2, 1200 by +2); only the second converts.
  assert.equal(conv.won, 2, `won: ${conv.won}`);
  assert.equal(conv.converted, 1, `converted: ${conv.converted}`);
  assert.ok(Math.abs(conv.rate - 0.5) < 1e-9);
});

check('soul lead tracks the team totals', () => {
  const lead = analysis.macro.lead;
  // Sapphire out-farms Amber by 4/s from the rival alone.
  assert.ok(lead.finalLead < 0, `final lead ${lead.finalLead}`);
  assert.equal(analysis.farm.leadSeries.length, samples.length);
});

check('findings surface the deficit and the solo deaths', () => {
  const titles = analysis.findings.map((f) => f.title).join(' | ');
  assert.ok(/souls to S1 at 10:00/.test(titles), titles);
  assert.ok(/no living teammate nearby/.test(titles), titles);
});

check('the markdown brief builds and contains the key sections', () => {
  const md = buildMarkdownBrief(analysis);
  for (const heading of ['## Match', '## Final scoreboard', '## My deaths', '## Teamfights', '## Macro summary']) {
    assert.ok(md.includes(heading), `missing ${heading}`);
  }
  assert.ok(md.includes('**A1**'), 'focus player not marked');
  assert.ok(md.length > 1500 && md.length < 200000, `brief was ${md.length} chars`);
});

check('the json brief is valid json', () => {
  const parsed = JSON.parse(buildJsonBrief(analysis));
  assert.equal(parsed.players.length, 12);
  assert.equal(parsed.focus.name, 'A1');
  assert.ok(Array.isArray(parsed.deaths));
});

check('analysis survives a match with no positional data', () => {
  const blind = {
    ...raw,
    samples: raw.samples.map((s) => ({ t: s.t, players: s.players.map((p) => ({ ...p, x: null, y: null, z: null })) })),
    kills: raw.kills.map((k) => ({ ...k, positions: {} }))
  };
  const result = analyze(blind, { focusCtrl: FOCUS.ctrl });
  assert.equal(result.frame.ok, false);
  assert.equal(result.deaths.length, raw.kills.length);
  assert.ok(buildMarkdownBrief(result).length > 500);
});

check('analysis survives an empty replay', () => {
  const empty = {
    fileName: 'empty.dem', fileSize: 0, parsedAt: '', duration: 0, winningTeam: null,
    players: [], samples: [], kills: [], damage: [], damageTotals: {}, items: [],
    objectives: [], respawns: [], chat: [], userInfo: [], diagnostics: {}
  };
  const result = analyze(empty, { focusCtrl: null });
  assert.equal(result.players.length, 0);
  assert.equal(result.fights.length, 0);
  assert.ok(buildMarkdownBrief(result).includes('## Match'));
});

/* ------------------------------------------------------------------ */
/* UI smoke test — renders every tab against a stub DOM                */
/* ------------------------------------------------------------------ */

const { renderAll, renderFailure } = await import('./js/ui.js');

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

function tagBalance(html, tag) {
  const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
  const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  return { open, close };
}

check('every tab renders without throwing', () => {
  const mount = new StubElement();
  renderAll(analysis, mount, { raw, nameStatus: { items: 'loaded (900)', heroes: 'loaded (30)' } });
  const html = mount.innerHTML;
  assert.ok(html.length > 5000, `rendered only ${html.length} chars`);
  for (const label of ['Overview', 'Deaths', 'Farm &amp; items', 'Teamfights', 'Macro', 'Ask Claude', 'Diagnostics']) {
    assert.ok(html.includes(label), `tab missing: ${label}`);
  }
});

check('rendered markup has balanced containers', () => {
  const mount = new StubElement();
  renderAll(analysis, mount, { raw, nameStatus: {} });
  const html = mount.innerHTML;
  for (const tag of ['div', 'table', 'tbody', 'tr', 'svg', 'section', 'article']) {
    const { open, close } = tagBalance(html, tag);
    assert.equal(open, close, `<${tag}> opened ${open} times, closed ${close}`);
  }
});

check('the focused player is highlighted in the rendered scoreboard', () => {
  const mount = new StubElement();
  renderAll(analysis, mount, { raw, nameStatus: {} });
  assert.ok(mount.innerHTML.includes('row--me'), 'no highlighted row');
  assert.ok(mount.innerHTML.includes('>me</span>'), 'no "me" tag');
});

check('UI renders for a match with no positional data', () => {
  const blind = {
    ...raw,
    samples: raw.samples.map((s) => ({ t: s.t, players: s.players.map((p) => ({ ...p, x: null, y: null })) })),
    kills: raw.kills.map((k) => ({ ...k, positions: {} }))
  };
  const result = analyze(blind, { focusCtrl: FOCUS.ctrl });
  const mount = new StubElement();
  renderAll(result, mount, { raw: blind, nameStatus: {} });
  assert.ok(mount.innerHTML.includes('No positional data captured') || mount.innerHTML.length > 3000);
});

check('UI renders for an empty replay without a focus player', () => {
  const empty = {
    fileName: 'empty.dem', fileSize: 0, parsedAt: '', duration: 0, winningTeam: null,
    players: [], samples: [], kills: [], damage: [], damageTotals: {}, items: [],
    objectives: [], respawns: [], chat: [], userInfo: [], diagnostics: {}
  };
  const result = analyze(empty, { focusCtrl: null });
  const mount = new StubElement();
  renderAll(result, mount, { raw: empty, nameStatus: {} });
  assert.ok(mount.innerHTML.length > 1000);
});


check('single isolated kills are classified as picks, not fights', () => {
  const picks = analysis.fights.filter((f) => f.isPick);
  const real = analysis.fights.filter((f) => !f.isPick);
  assert.equal(picks.length, 2, 'the two solo deaths should be picks');
  assert.equal(real.length, 2, 'the two multi-kill clusters should be fights');
  assert.ok(real.every((f) => f.deaths.length > 1));
});


/* ------------------------------------------------------------------ */
/* team numbering — regression cover for the crash on a real replay    */
/* ------------------------------------------------------------------ */

function remapTeams(source, mapping) {
  const map = (v) => (mapping[v] !== undefined ? mapping[v] : v);
  return {
    ...source,
    winningTeam: map(source.winningTeam),
    players: source.players.map((p) => ({ ...p, team: map(p.team) })),
    kills: source.kills.map((k) => ({ ...k, victimTeam: map(k.victimTeam) })),
    objectives: source.objectives.map((o) => ({ ...o, team: map(o.team), entityTeam: map(o.entityTeam) }))
  };
}

check('teams are derived from the roster, not assumed to be 2 and 3', () => {
  const zeroOne = remapTeams(raw, { 2: 0, 3: 1 });
  const teams = deriveTeams(zeroOne);
  assert.deepEqual(teams.ids, [0, 1]);
  assert.equal(teams.label(0), 'Amber');
  assert.equal(teams.label(1), 'Sapphire');
  assert.equal(teams.other(0), 1);
});

check('a replay numbering teams 0 and 1 analyses end to end', () => {
  const zeroOne = remapTeams(raw, { 2: 0, 3: 1 });
  const result = analyze(zeroOne, { focusCtrl: FOCUS.ctrl });
  assert.deepEqual(result.teamIds, [0, 1]);
  assert.equal(result.players.length, 12);
  assert.equal(result.focus.team, 0);
  // The same conclusions as the 2/3 fixture, just renumbered.
  assert.equal(result.macro.conversionRate[0].won, 2);
  assert.equal(result.macro.conversionRate[0].converted, 1);
  assert.equal(result.macro.objectiveCount[0], 1);
  assert.equal(result.macro.objectiveCount[1], 1);
  assert.equal(result.fights.filter((f) => !f.isPick).length, 2);
});

check('unusual team ids still work', () => {
  const odd = remapTeams(raw, { 2: 5, 3: 7 });
  const result = analyze(odd, { focusCtrl: FOCUS.ctrl });
  assert.deepEqual(result.teamIds, [5, 7]);
  assert.equal(result.macro.conversionRate[5].won, 2);
  assert.ok(buildMarkdownBrief(result).includes('## Macro summary'));
});

check('spectators and casters are excluded from the rosters', () => {
  const withExtras = {
    ...raw,
    players: [
      { ctrl: 99, name: 'CASTER', team: 1, heroId: null, slot: null, final: {} },
      { ctrl: 98, name: 'OBSERVER', team: 16, heroId: null, slot: null, final: {} },
      ...raw.players
    ]
  };
  const teams = deriveTeams(withExtras);
  assert.deepEqual(teams.ids, [2, 3], 'the six-player rosters should win over the singletons');

  const result = analyze(withExtras, { focusCtrl: FOCUS.ctrl });
  assert.equal(result.players.length, 12);
  assert.equal(result.nonPlayers.length, 2);
  assert.equal(result.focus.name, 'A1');
});

check('selecting a spectator as the focus does not throw', () => {
  // This is the exact shape that produced "Cannot read properties of
  // undefined (reading 'won')" on a real replay.
  const withExtras = {
    ...raw,
    players: [{ ctrl: 99, name: 'CASTER', team: 1, heroId: null, slot: null, final: {} }, ...raw.players]
  };
  const result = analyze(withExtras, { focusCtrl: 99 });
  assert.equal(result.focus, null);

  const mount = new StubElement();
  renderAll(result, mount, { raw: withExtras, nameStatus: {} });
  assert.ok(mount.innerHTML.includes('Diagnostics'));
  assert.ok(mount.innerHTML.length > 5000);

  assert.ok(buildMarkdownBrief(result).includes('## Macro summary'));
  assert.ok(JSON.parse(buildJsonBrief(result)).focus === null);
});

check('every tab renders with teams numbered 0 and 1', () => {
  const zeroOne = remapTeams(raw, { 2: 0, 3: 1 });
  const result = analyze(zeroOne, { focusCtrl: FOCUS.ctrl });
  const mount = new StubElement();
  renderAll(result, mount, { raw: zeroOne, nameStatus: {} });
  const html = mount.innerHTML;
  assert.ok(html.includes('Amber') && html.includes('Sapphire'), 'team labels missing');
  for (const tag of ['div', 'table', 'tbody', 'tr', 'svg', 'section', 'article']) {
    const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
    const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    assert.equal(open, close, `<${tag}> unbalanced`);
  }
});

check('the failure view still renders diagnostics', async () => {
  const mount = new StubElement();
  renderFailure(new Error('boom'), mount, { raw, nameStatus: {} });
  assert.ok(mount.innerHTML.includes('boom'));
  assert.ok(mount.innerHTML.includes('Diagnostics'));
  assert.ok(mount.innerHTML.includes('Team numbering as it appeared'));
});

check('diagnostics reports the team values it actually saw', () => {
  const mount = new StubElement();
  renderAll(analysis, mount, { raw, nameStatus: {} });
  assert.ok(mount.innerHTML.includes('m_iTeamNum = 2'));
  assert.ok(mount.innerHTML.includes('m_iTeamNum = 3'));
});


check('a replay with no team field at all still produces a report', () => {
  const noTeams = {
    ...raw,
    players: raw.players.map((p) => ({ ...p, team: null })),
    kills: raw.kills.map((k) => ({ ...k, victimTeam: null }))
  };
  const result = analyze(noTeams, { focusCtrl: FOCUS.ctrl });
  assert.equal(result.meta.teamsDegraded, true);
  assert.equal(result.players.length, 12, 'everyone should still be listed');
  assert.ok(result.focus, 'focus should still resolve');

  const mount = new StubElement();
  renderAll(result, mount, { raw: noTeams, nameStatus: {} });
  assert.ok(mount.innerHTML.includes('No team numbering was found'), 'should warn the user');
  assert.ok(buildMarkdownBrief(result).includes('## Match'));
});


/* ------------------------------------------------------------------ */
/* build analysis                                                      */
/* ------------------------------------------------------------------ */

const buildAnalysis = analyze(raw, {
  focusCtrl: FOCUS.ctrl,
  heroName: () => 'Haze',
  itemName: (id) => itemsById.get(id) || null
});
const build = analyzeBuild(buildAnalysis, raw, { itemsById, itemStats });
const buildNoStats = analyzeBuild(buildAnalysis, raw, { itemsById, itemStats: null });

check('damage types are classified by ability presence, not a hardcoded table', () => {
  const labels = labelDamageTypes(raw.damageByType);
  assert.equal(labels.get(1).label, 'weapon', 'type 1 carried no ability ids');
  assert.equal(labels.get(3).label, 'ability', 'type 3 was all ability hits');
});

check('the damage profile splits what actually hit you', () => {
  const taken = build.damage.taken;
  assert.equal(taken.total, 10000);
  assert.equal(taken.weapon, 3000);
  assert.equal(taken.ability, 7000);
  assert.ok(Math.abs(taken.abilityShare - 0.7) < 1e-9, `share ${taken.abilityShare}`);
});

check('purchases are ordered with running spend and slot categories', () => {
  assert.equal(build.purchases.length, 4, 'the sold item is excluded');
  assert.deepEqual(build.purchases.map((p) => p.name), [
    'Headshot Booster', 'Extra Charge', 'Mystic Burst', 'Burst Fire'
  ]);
  assert.equal(build.purchases[0].committedAfter, 500);
  assert.equal(build.purchases[3].committedAfter, 500 + 1250 + 1250 + 3000);
  assert.equal(build.categories.weapon, 3);
  assert.equal(build.categories.spirit, 1);
  assert.equal(build.categories.vitality, 0);
  assert.equal(build.spend.totalCommitted, 6000);
});

check('a missing resist against the damage you actually took is the top flag', () => {
  const top = build.suggestions[0];
  assert.equal(top.priority, 'high');
  assert.ok(/never bought spirit resistance/i.test(top.title), top.title);
  assert.ok(/70% of the damage/.test(top.reason), top.reason);
  // The candidate must be a real item from the live list, not an invented name.
  assert.ok(top.items.some((i) => i.name === 'Spirit Armor'), JSON.stringify(top.items));
});

check('no bullet-resist flag is raised when weapon damage was only 30%', () => {
  const titles = build.suggestions.map((s) => s.title).join(' | ');
  assert.ok(!/bullet resist/i.test(titles), titles);
});

check('a single dominant threat is called out', () => {
  assert.equal(build.threats[0].name, 'S1');
  assert.ok(Math.abs(build.threats[0].share - 0.6) < 1e-9);
  const flag = build.suggestions.find((s) => /dealt 60% of the damage/.test(s.title));
  assert.ok(flag, build.suggestions.map((s) => s.title).join(' | '));
});

check('an all-weapon build with no vitality items is flagged', () => {
  const flag = build.suggestions.find((s) => /no vitality items/i.test(s.title));
  assert.ok(flag, build.suggestions.map((s) => s.title).join(' | '));
});

check('short soul banks are measured but not nagged about', () => {
  // The fixture player buys steadily, so every bank is under two minutes.
  assert.ok(build.spend.worstBanking, 'no banking run found');
  assert.ok(build.spend.worstBanking.to - build.spend.worstBanking.from < 120);
  assert.ok(!build.suggestions.some((s) => /unspent souls/i.test(s.title)), 'should not flag a short bank');
});

check('a long stretch of unspent souls is flagged with its time range', () => {
  // Same player, but they stop buying after 06:40 while souls keep coming in.
  const hoarder = { ...raw, items: raw.items.filter((i) => i.t <= 400) };
  const hoarderAnalysis = analyze(hoarder, {
    focusCtrl: FOCUS.ctrl,
    heroName: () => 'Haze',
    itemName: (id) => itemsById.get(id) || null
  });
  const result = analyzeBuild(hoarderAnalysis, hoarder, { itemsById, itemStats });

  const bank = result.spend.worstBanking;
  assert.ok(bank, 'no banking run found');
  assert.ok(bank.to - bank.from > 600, `run was only ${Math.round(bank.to - bank.from)}s`);
  // Net worth 500+5t, committed 1750 after 06:40 -> banked crosses 1500 at t=550.
  assert.ok(Math.abs(bank.from - 551) < 5, `run started at ${bank.from}`);
  assert.ok(Math.abs(bank.peak - (500 + 5 * 1500 - 1750)) < 20, `peak ${bank.peak}`);

  const flag = result.suggestions.find((s) => /unspent souls/i.test(s.title));
  assert.ok(flag, 'expected a banking suggestion');
  // The 10:20 death falls inside the run, which raises the priority.
  assert.equal(flag.priority, 'high');
  assert.ok(flag.evidence.some((e) => /You died 1 time during that stretch/.test(e)), flag.evidence.join(' | '));
  assert.ok(flag.evidence.some((e) => /From 09:1\d to 25:00/.test(e)), flag.evidence.join(' | '));
});

check('purchases are benchmarked against average purchase times', () => {
  assert.equal(build.benchmark.available, true);
  const extraCharge = build.purchases.find((p) => p.name === 'Extra Charge');
  assert.ok(Math.abs(extraCharge.benchmark.delta - (400 - 90)) < 1e-9);
  const late = build.benchmark.late.map((l) => l.name);
  assert.ok(late.includes('Extra Charge'), late.join(', '));
});

check('popular high-win-rate items you skipped are surfaced', () => {
  const missed = build.benchmark.missed.map((m) => m.name);
  assert.ok(missed.includes('Spirit Armor'), missed.join(', '));
  assert.ok(missed.includes('Bullet Armor'), missed.join(', '));
  // Bought items must never appear as missed.
  assert.ok(!missed.includes('Headshot Booster'), missed.join(', '));
});

check('items you bought that underperform are surfaced', () => {
  const low = build.benchmark.lowValue.map((l) => l.name);
  assert.deepEqual(low, ['Burst Fire'], low.join(', '));
});

check('what killed you is broken down per death', () => {
  assert.equal(build.deathContext.length, 2);
  const first = build.deathContext[0];
  assert.equal(first.breakdown[0].name, 'S1');
  assert.equal(first.breakdown[0].label, 'ability');
  assert.equal(first.itemsOwned, 1, 'only the 02:00 item was owned by 05:00');
  assert.ok(Math.abs(first.abilityShare - 0.75) < 1e-9, `share ${first.abilityShare}`);
});

check('build analysis still works with no win-rate data', () => {
  assert.equal(buildNoStats.benchmark.available, false);
  assert.equal(buildNoStats.purchases.length, 4);
  // The replay-derived flags must survive without the API.
  assert.ok(buildNoStats.suggestions.some((s) => /spirit resistance/i.test(s.title)));
  assert.ok(buildNoStats.suggestions.every((s) => !/win-rate|underperform/i.test(s.title)));
  assert.ok(buildNoStats.notes.some((n) => /could not be loaded/i.test(n)));
});

check('build analysis is a no-op without a focus player', () => {
  const noFocus = analyze(raw, { focusCtrl: null });
  const result = analyzeBuild(noFocus, raw, { itemsById, itemStats });
  assert.equal(result.ok, false);
  assert.equal(result.purchases.length, 0);
});

check('the coaching brief carries the build section', () => {
  const withBuild = { ...buildAnalysis, build };
  const md = buildMarkdownBrief(withBuild);
  assert.ok(md.includes('## My build'), 'no build section');
  assert.ok(md.includes('### Damage I took, by kind'));
  assert.ok(md.includes('### What I had, and what hit me, at each death'));
  assert.ok(md.includes('### Against real matches'));
  assert.ok(md.includes('Spirit Armor'), 'benchmark items missing');
  assert.ok(md.includes('Headshot Booster'), 'purchase table missing');

  const json = JSON.parse(buildJsonBrief(withBuild));
  assert.equal(json.build.purchases.length, 4);
  assert.equal(json.build.damageTaken.ability, 7000);
});

check('the Build tab renders', () => {
  const withBuild = { ...buildAnalysis, build };
  const mount = new StubElement();
  renderAll(withBuild, mount, { raw, nameStatus: {} });
  const html = mount.innerHTML;
  assert.ok(html.includes('>Build</button>'), 'no Build tab');
  assert.ok(html.includes('Headshot Booster'), 'purchase table missing');
  assert.ok(html.includes('Spirit Armor'), 'suggestions missing');
  assert.ok(html.includes('Purchase order'));
  for (const tag of ['div', 'table', 'tbody', 'tr', 'svg', 'section', 'article']) {
    const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
    const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    assert.equal(open, close, `<${tag}> unbalanced`);
  }
});

check('the Build tab renders when no build analysis was attached', () => {
  const mount = new StubElement();
  renderAll(buildAnalysis, mount, { raw, nameStatus: {} });
  assert.ok(mount.innerHTML.includes('Select a player above to analyse their build'));
});


check('diagnostics reports item-name resolution and unresolved ids', () => {
  // Nothing resolves when the asset service gave us nothing.
  const blindNames = analyze(raw, { focusCtrl: FOCUS.ctrl, itemName: () => null });
  const mount = new StubElement();
  renderAll(blindNames, mount, {
    raw,
    nameStatus: {
      items: 'unavailable',
      itemAttempts: ['https://api.deadlock-api.com/v1/assets/items -> HTTP 500'],
      source: null
    }
  });
  const html = mount.innerHTML;
  assert.ok(html.includes('Item name resolution'), 'no resolution section');
  assert.ok(html.includes('Unresolved ids'), 'unresolved ids not listed');
  assert.ok(html.includes('111'), 'the actual ids should be shown so they can be checked');
  assert.ok(html.includes('HTTP 500'), 'endpoint attempts not surfaced');
  assert.ok(html.includes('Reload item data'), 'no reload button');
});

check('diagnostics shows full resolution when names are available', () => {
  const mount = new StubElement();
  renderAll({ ...buildAnalysis, build }, mount, {
    raw,
    nameStatus: { items: 'loaded 900 of 950 entries', source: 'https://api.deadlock-api.com/v1/assets/items' }
  });
  const html = mount.innerHTML;
  // Four purchases by the focus player plus one by the rival, all resolved.
  assert.ok(html.includes('5 of 5 purchases'), 'resolution count wrong');
  assert.ok(!html.includes('Unresolved ids'), 'should not list unresolved ids when all resolve');
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — with failures above' : ''}\n`);
