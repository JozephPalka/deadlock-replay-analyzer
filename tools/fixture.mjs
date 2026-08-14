/*
 * fixture.mjs — a synthetic Deadlock match with known properties.
 *
 * Used by selftest.mjs to assert the analyser's maths, and by preview.mjs to
 * render the UI without needing a real replay.
 */

import { TEAM_AMBER, TEAM_SAPPHIRE } from '../js/analyze.js';

/* ------------------------------------------------------------------ */
/* synthetic match                                                     */
/* ------------------------------------------------------------------ */

const AMBER_BASE = { x: 0, y: 0 };
const SAPPHIRE_BASE = { x: 10000, y: 0 };
const DURATION = 1500;

const players = [];
for (let i = 0; i < 12; i += 1) {
  const team = i < 6 ? TEAM_AMBER : TEAM_SAPPHIRE;
  players.push({
    ctrl: i + 1,
    name: `${team === TEAM_AMBER ? 'A' : 'S'}${(i % 6) + 1}`,
    team,
    heroId: 10 + i,
    slot: i,
    final: {}
  });
}

const FOCUS = players[0]; // A1, Amber
const RIVAL = players[6]; // S1, Sapphire — will be the lane opponent

/* net worth: focus is deliberately behind its rival */
const rate = (ctrl) => (ctrl === FOCUS.ctrl ? 5.0 : ctrl === RIVAL.ctrl ? 9.0 : 7.0);

const samples = [];
for (let t = 0; t <= DURATION; t += 1) {
  const row = [];
  for (const p of players) {
    const home = p.team === TEAM_AMBER ? AMBER_BASE : SAPPHIRE_BASE;
    const away = p.team === TEAM_AMBER ? SAPPHIRE_BASE : AMBER_BASE;

    // Everyone sits in base for the first 30s, then walks toward mid.
    const progress = t < 30 ? 0 : Math.min(0.45, (t - 30) / 3000);
    // Keep the focus player and rival on the same lateral line so the lane
    // opponent detector has something unambiguous to find.
    const lateral = p.ctrl === FOCUS.ctrl || p.ctrl === RIVAL.ctrl ? 0 : ((p.ctrl % 5) - 2) * 900;

    row.push({
      ctrl: p.ctrl,
      nw: Math.round(500 + t * rate(p.ctrl)),
      k: 0,
      d: 0,
      a: 0,
      hd: Math.round(t * 12),
      x: Math.round(home.x + (away.x - home.x) * progress),
      y: Math.round(home.y + (away.y - home.y) * progress + lateral),
      z: 0,
      hp: 1000,
      maxHp: 1000,
      alive: true
    });
  }
  samples.push({ t, players: row });
}

/* helper to build the positions blob a kill carries */
function positionsAt(overrides = {}) {
  const out = {};
  for (const p of players) {
    const home = p.team === TEAM_AMBER ? AMBER_BASE : SAPPHIRE_BASE;
    out[p.ctrl] = [home.x, home.y, 0, 1];
  }
  for (const [ctrl, value] of Object.entries(overrides)) out[ctrl] = value;
  return out;
}

const kills = [];

/* 1. Focus dies alone, deep in enemy territory, nobody trades for it. */
kills.push({
  t: 300,
  tick: 300 * 60,
  victim: FOCUS.ctrl,
  victimTeam: TEAM_AMBER,
  killer: RIVAL.ctrl,
  killerIsPlayer: true,
  assisters: [],
  victimNetWorth: 2000,
  positions: positionsAt({
    [FOCUS.ctrl]: [9000, 0, 0, 1],
    [RIVAL.ctrl]: [9050, 0, 0, 1],
    8: [9100, 100, 0, 1],
    9: [9150, 200, 0, 1]
  })
});

/* 2. Focus dies again, deep and alone, 320s later (no tilt streak). */
kills.push({
  t: 620,
  tick: 620 * 60,
  victim: FOCUS.ctrl,
  victimTeam: TEAM_AMBER,
  killer: RIVAL.ctrl,
  killerIsPlayer: true,
  assisters: [8],
  victimNetWorth: 3600,
  positions: positionsAt({
    [FOCUS.ctrl]: [8800, 200, 0, 1],
    [RIVAL.ctrl]: [8850, 200, 0, 1],
    8: [8900, 250, 0, 1]
  })
});

/* 3. A real teamfight at 900s that Amber wins 3-1, near mid. */
const fightPositions = positionsAt({
  1: [5000, 0, 0, 1], 2: [5100, 100, 0, 1], 3: [5200, 200, 0, 1],
  7: [5050, 50, 0, 1], 8: [5150, 150, 0, 1], 9: [5250, 250, 0, 1]
});
kills.push({ t: 900, tick: 54000, victim: 7, victimTeam: TEAM_SAPPHIRE, killer: 1, killerIsPlayer: true, assisters: [2], victimNetWorth: 8000, positions: fightPositions });
kills.push({ t: 903, tick: 54180, victim: 8, victimTeam: TEAM_SAPPHIRE, killer: 2, killerIsPlayer: true, assisters: [], victimNetWorth: 7800, positions: fightPositions });
kills.push({ t: 907, tick: 54420, victim: 9, victimTeam: TEAM_SAPPHIRE, killer: 3, killerIsPlayer: true, assisters: [], victimNetWorth: 7600, positions: fightPositions });
kills.push({ t: 909, tick: 54540, victim: 3, victimTeam: TEAM_AMBER, killer: 9, killerIsPlayer: true, assisters: [], victimNetWorth: 7000, positions: fightPositions });

/* 4. A second fight at 1200s that Amber also wins 2-0 — and converts. */
const fight2 = positionsAt({ 1: [6000, 0, 0, 1], 2: [6100, 0, 0, 1], 7: [6050, 0, 0, 1], 8: [6150, 0, 0, 1] });
kills.push({ t: 1200, tick: 72000, victim: 7, victimTeam: TEAM_SAPPHIRE, killer: 1, killerIsPlayer: true, assisters: [], victimNetWorth: 11000, positions: fight2 });
kills.push({ t: 1204, tick: 72240, victim: 8, victimTeam: TEAM_SAPPHIRE, killer: 2, killerIsPlayer: true, assisters: [], victimNetWorth: 10800, positions: fight2 });

const raw = {
  fileName: 'synthetic.dem',
  fileSize: 123456789,
  parsedAt: new Date().toISOString(),
  duration: DURATION,
  winningTeam: TEAM_SAPPHIRE,
  players,
  samples,
  kills,
  damage: [
    { a: 1, v: 7, t: 900, dmg: 4000, hits: 30 },
    { a: 2, v: 8, t: 902, dmg: 3500, hits: 25 },
    { a: 3, v: 9, t: 906, dmg: 3000, hits: 20 },
    { a: 9, v: 3, t: 908, dmg: 2800, hits: 18 },
    { a: 1, v: 7, t: 1200, dmg: 5000, hits: 30 },
    { a: 2, v: 8, t: 1203, dmg: 4500, hits: 28 }
  ],
  damageTotals: { '1>7': 9000, '2>8': 8000 },
  items: [
    { t: 120, userid: 0, ctrl: FOCUS.ctrl, abilityId: 111, sell: false, quickbuy: false },
    { t: 400, userid: 0, ctrl: FOCUS.ctrl, abilityId: 222, sell: false, quickbuy: false },
    { t: 800, userid: 0, ctrl: FOCUS.ctrl, abilityId: 333, sell: true, quickbuy: false }
  ],
  objectives: [
    // Sapphire takes a building at 500 (Amber lost it).
    { t: 500, kind: 'building', team: TEAM_AMBER, entityTeam: TEAM_AMBER, killerCtrl: RIVAL.ctrl, pos: { x: 2000, y: 0, z: 0 } },
    // Amber converts the 1200 fight at 1240.
    { t: 1240, kind: 'building', team: TEAM_SAPPHIRE, entityTeam: TEAM_SAPPHIRE, killerCtrl: 1, pos: { x: 8000, y: 0, z: 0 } }
  ],
  respawns: [{ t: 330, ctrl: FOCUS.ctrl }, { t: 650, ctrl: FOCUS.ctrl }],
  chat: [],
  userInfo: [],
  diagnostics: { messageCounts: { heroKilled: kills.length }, errors: [], missingMessageTypes: [] }
};


export { raw, players, FOCUS, RIVAL, AMBER_BASE, SAPPHIRE_BASE, DURATION, samples };

/* ------------------------------------------------------------------ */
/* build-analysis fixtures                                             */
/* ------------------------------------------------------------------ */

/*
 * The focus player takes 70% ability damage and never buys spirit resist,
 * with one enemy (S1) responsible for 60% of the damage. Those are the two
 * things the build suggestions should notice.
 */

export const ITEMS = [
  { id: 111, name: 'Headshot Booster', cost: 500, tier: 1, slot: 'weapon' },
  { id: 222, name: 'Extra Charge', cost: 1250, tier: 2, slot: 'weapon' },
  { id: 333, name: 'Sprint Boots', cost: 500, tier: 1, slot: 'vitality' },
  { id: 444, name: 'Burst Fire', cost: 3000, tier: 3, slot: 'weapon' },
  { id: 555, name: 'Mystic Burst', cost: 1250, tier: 2, slot: 'spirit' },
  { id: 777, name: 'Spirit Armor', cost: 1250, tier: 2, slot: 'vitality' },
  { id: 888, name: 'Bullet Armor', cost: 1250, tier: 2, slot: 'vitality' },
  { id: 999, name: 'Decay', cost: 3000, tier: 3, slot: 'spirit' }
];

export const itemsById = new Map(ITEMS.map((i) => [i.id, i]));

export const itemStats = {
  scope: 'hero:10',
  sampleMatches: 4210,
  // The service returns raw counts; the resolver derives these. Popularity is
  // relative to the most-bought item, win rate is judged against the baseline.
  baselineWinRate: 0.5,
  stats: new Map([
    [111, { id: 111, matches: 4000, wins: 2120, winRate: 0.53, popularity: 0.62, avgBoughtAt: 110 }],
    // Bought at 400 but usually bought by 90 -> five minutes late.
    [222, { id: 222, matches: 3800, wins: 1938, winRate: 0.51, popularity: 0.55, avgBoughtAt: 90 }],
    [444, { id: 444, matches: 2100, wins: 882, winRate: 0.42, popularity: 0.31, avgBoughtAt: 700 }],
    // Popular and winning, never bought -> should surface as missed.
    [777, { id: 777, matches: 3900, wins: 2184, winRate: 0.56, popularity: 0.48, avgBoughtAt: 780 }],
    [888, { id: 888, matches: 3600, wins: 1944, winRate: 0.54, popularity: 0.41, avgBoughtAt: 820 }],
    [999, { id: 999, matches: 900, wins: 495, winRate: 0.55, popularity: 0.27, avgBoughtAt: 1500 }]
  ])
};

/* Purchases for the focus player: weapon-heavy, no resist, one late item. */
raw.items = [
  { t: 120, userid: 0, ctrl: FOCUS.ctrl, abilityId: 111, sell: false, quickbuy: false },
  { t: 400, userid: 0, ctrl: FOCUS.ctrl, abilityId: 222, sell: false, quickbuy: false },
  { t: 640, userid: 0, ctrl: FOCUS.ctrl, abilityId: 555, sell: false, quickbuy: false },
  { t: 900, userid: 0, ctrl: FOCUS.ctrl, abilityId: 444, sell: false, quickbuy: false },
  { t: 950, userid: 0, ctrl: FOCUS.ctrl, abilityId: 333, sell: true, quickbuy: false },
  { t: 200, userid: 1, ctrl: RIVAL.ctrl, abilityId: 777, sell: false, quickbuy: false }
];

/* 30% weapon fire (type 1), 70% ability damage (type 3). */
raw.damageByType = [
  { ctrl: FOCUS.ctrl, dir: 'taken', type: 1, dmg: 3000, hits: 120, abilityHits: 0 },
  { ctrl: FOCUS.ctrl, dir: 'taken', type: 3, dmg: 7000, hits: 40, abilityHits: 40 },
  { ctrl: FOCUS.ctrl, dir: 'dealt', type: 1, dmg: 9000, hits: 300, abilityHits: 0 },
  { ctrl: FOCUS.ctrl, dir: 'dealt', type: 3, dmg: 2000, hits: 20, abilityHits: 20 },
  { ctrl: RIVAL.ctrl, dir: 'dealt', type: 3, dmg: 6000, hits: 30, abilityHits: 30 }
];

/* One enemy responsible for most of it. */
raw.damageTotals = {
  ...raw.damageTotals,
  [`${RIVAL.ctrl}>${FOCUS.ctrl}`]: 6000,
  [`8>${FOCUS.ctrl}`]: 2500,
  [`9>${FOCUS.ctrl}`]: 1500
};

/* What was hitting the focus player in the seconds before each of their deaths. */
raw.kills[0].preDeathDamage = [
  { attacker: RIVAL.ctrl, type: 3, dmg: 900, hits: 4, abilityHits: 4 },
  { attacker: 8, type: 1, dmg: 300, hits: 12, abilityHits: 0 }
];
raw.kills[1].preDeathDamage = [{ attacker: RIVAL.ctrl, type: 3, dmg: 1100, hits: 5, abilityHits: 5 }];

/* The enemy team healed a lot, and nobody on our side bought anti-heal. */
for (const player of players) {
  if (player.team === TEAM_SAPPHIRE) player.final = { ...player.final, heroHealing: 2000 };
}
