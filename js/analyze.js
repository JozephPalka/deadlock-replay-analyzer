/*
 * analyze.js — turns a RawMatch (from parse.js) into an Analysis object.
 *
 * Pure functions only: no DOM, no network, no globals. That keeps it testable
 * outside the browser (see selftest.mjs) and keeps the parse layer swappable.
 *
 * Two things here are deliberately derived from the match rather than
 * hardcoded, because both have burned us:
 *
 *   Team ids. Source engine team numbers are not stable across Valve's games
 *   or across Deadlock builds, and a replay's controller list can also contain
 *   spectators and casters. So the two playing teams are worked out by looking
 *   at which team values actually hold a roster.
 *
 *   Distances. Deadlock world units are not documented anywhere reliable, so
 *   the map scale comes from the distance between the two teams' spawns and
 *   every threshold is a fraction of that.
 */

/* Conventional Source values, used only as a last-resort fallback. */
export const TEAM_AMBER = 2;
export const TEAM_SAPPHIRE = 3;

export const TEAM_LABEL = {
  [TEAM_AMBER]: 'Amber',
  [TEAM_SAPPHIRE]: 'Sapphire'
};

/* Thresholds, as fractions of the base-to-base distance. */
const NEARBY = 0.09;        // "in this fight with me"
const FIGHT_RADIUS = 0.13;  // kills this close belong to the same fight
const FIGHT_GAP = 18;       // seconds between kills before a new fight starts
const FIGHT_PAD = 8;        // seconds of context either side of a fight

/* ------------------------------------------------------------------ */
/* teams                                                               */
/* ------------------------------------------------------------------ */

/**
 * Works out which team ids are actually playing.
 *
 * A Deadlock replay's controller list can include spectators, casters and
 * whatever else Valve attaches, and their team values are not the playing
 * teams. Rather than trusting a constant, take the team values that hold a
 * real roster: the two most populated, preferring rosters of six.
 *
 * @returns {{ids: number[], label: Function, other: Function, ok: boolean}}
 */
export function deriveTeams(raw) {
  const counts = new Map();
  for (const player of raw.players || []) {
    const team = player.team;
    if (team === null || team === undefined || !Number.isFinite(team)) continue;
    counts.set(team, (counts.get(team) || 0) + 1);
  }

  const ranked = Array.from(counts.entries())
    // A six-player roster beats anything else; ties break on headcount, then
    // on the lower id so the ordering is stable.
    .sort((a, b) => {
      const sixA = a[1] === 6 ? 1 : 0;
      const sixB = b[1] === 6 ? 1 : 0;
      return sixB - sixA || b[1] - a[1] || a[0] - b[0];
    })
    .map(([team]) => team);

  let ids = ranked.slice(0, 2).sort((a, b) => a - b);
  let ok = ids.length === 2;
  if (!ok) ids = [TEAM_AMBER, TEAM_SAPPHIRE];

  // The lower id is always the first team in Valve's numbering, whichever
  // base value the build happens to use.
  const labels = { [ids[0]]: 'Amber', [ids[1]]: 'Sapphire' };

  return {
    ids,
    ok,
    label: (team) => labels[team] || (team === null || team === undefined ? 'unknown' : `Team ${team}`),
    other: (team) => (team === ids[0] ? ids[1] : team === ids[1] ? ids[0] : null),
    includes: (team) => team === ids[0] || team === ids[1]
  };
}

/* ------------------------------------------------------------------ */
/* geometry                                                            */
/* ------------------------------------------------------------------ */

export function dist2d(a, b) {
  if (!a || !b) return Infinity;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function mean(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((s, v) => s + v, 0) / nums.length;
}

function median(values) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

export function formatClock(seconds) {
  if (!Number.isFinite(seconds)) return '--:--';
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* map frame of reference                                              */
/* ------------------------------------------------------------------ */

/**
 * Works out where each team starts, which gives us a base-to-base axis.
 * Everything spatial is then expressed along that axis, so "how far into enemy
 * territory was I" becomes a number between 0 and 1 without needing a map file.
 */
export function deriveMapFrame(raw, teams = null) {
  const resolved = teams || deriveTeams(raw);

  const early = raw.samples.filter((s) => s.t <= 45).slice(0, 40);
  const source = early.length >= 3 ? early : raw.samples.slice(0, 40);

  const teamOf = new Map((raw.players || []).map((p) => [p.ctrl, p.team]));
  const acc = new Map();

  for (const sample of source) {
    for (const row of sample.players) {
      if (row.x === null || row.x === undefined) continue;
      const team = teamOf.get(row.ctrl);
      if (!resolved.includes(team)) continue;
      if (!acc.has(team)) acc.set(team, { xs: [], ys: [] });
      acc.get(team).xs.push(row.x);
      acc.get(team).ys.push(row.y);
    }
  }

  const bases = {};
  for (const [team, v] of acc.entries()) {
    bases[team] = { x: median(v.xs), y: median(v.ys) };
  }

  const a = bases[resolved.ids[0]];
  const b = bases[resolved.ids[1]];
  const span = a && b ? dist2d(a, b) : null;

  return {
    bases,
    teams: resolved,
    ids: resolved.ids,
    span: span && span > 1 ? span : null,
    ok: Boolean(span && span > 1)
  };
}

/**
 * 0 = deep in your own base, 0.5 = mid, 1 = standing in the enemy base.
 * Returns null when positions are unavailable.
 */
export function territoryDepth(frame, team, pos) {
  if (!frame.ok || !pos) return null;
  const enemyTeam = frame.teams.other(team);
  if (enemyTeam === null) return null;

  const own = frame.bases[team];
  const enemy = frame.bases[enemyTeam];
  if (!own || !enemy) return null;

  const ax = enemy.x - own.x;
  const ay = enemy.y - own.y;
  const len2 = ax * ax + ay * ay;
  if (len2 === 0) return null;

  const t = ((pos.x - own.x) * ax + (pos.y - own.y) * ay) / len2;
  return Math.max(-0.2, Math.min(1.2, t));
}

export function depthLabel(depth) {
  if (depth === null) return 'unknown';
  if (depth < 0.18) return 'your base';
  if (depth < 0.38) return 'your half';
  if (depth < 0.62) return 'mid / contested';
  if (depth < 0.82) return 'enemy half';
  return 'enemy base';
}

/* ------------------------------------------------------------------ */
/* sample helpers                                                      */
/* ------------------------------------------------------------------ */

function seriesFor(raw, ctrl, key) {
  const out = [];
  for (const sample of raw.samples) {
    const row = sample.players.find((p) => p.ctrl === ctrl);
    if (!row) continue;
    const v = row[key];
    if (v === null || v === undefined) continue;
    out.push({ t: sample.t, v });
  }
  return out;
}

function valueAt(series, t) {
  if (series.length === 0) return null;
  let best = null;
  for (const point of series) {
    if (point.t <= t) best = point;
    else break;
  }
  return best ? best.v : series[0].v;
}

function positionsFromKill(kill) {
  const out = new Map();
  if (!kill.positions) return out;
  for (const [ctrl, value] of Object.entries(kill.positions)) {
    if (!value) continue;
    out.set(Number(ctrl), { x: value[0], y: value[1], z: value[2], alive: value[3] === 1 });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

/**
 * @param {Object} raw          from parseReplay
 * @param {Object} options
 * @param {number} options.focusCtrl   controller index of the player to focus on
 * @param {Function} options.heroName  (heroId) => string|null
 * @param {Function} options.itemName  (abilityId) => {name, cost}|null
 */
export function analyze(raw, options = {}) {
  const { focusCtrl = null, heroName = () => null, itemName = () => null } = options;

  const teams = deriveTeams(raw);
  const [TEAM_A, TEAM_B] = teams.ids;
  const frame = deriveMapFrame(raw, teams);

  const allControllers = (raw.players || []).map((p) => ({
    ctrl: p.ctrl,
    name: p.name,
    team: p.team,
    heroId: p.heroId,
    hero: heroName(p.heroId) || null,
    slot: p.slot,
    final: p.final || {},
    netWorthSeries: seriesFor(raw, p.ctrl, 'nw')
  }));

  // Anything not on a playing team is a spectator, caster or leftover entity.
  let players = allControllers.filter((p) => teams.includes(p.team));
  let nonPlayers = allControllers.filter((p) => !teams.includes(p.team));

  // If the build stopped replicating a team field at all, we would otherwise
  // end up with an empty report. Better to show one undivided roster and say so
  // than to show nothing.
  const teamsDegraded = players.length === 0 && allControllers.length > 0;
  if (teamsDegraded) {
    players = allControllers.map((p) => ({ ...p, team: teams.ids[0] }));
    nonPlayers = [];
  }

  const byCtrl = new Map(players.map((p) => [p.ctrl, p]));
  const roster = {
    [TEAM_A]: players.filter((p) => p.team === TEAM_A),
    [TEAM_B]: players.filter((p) => p.team === TEAM_B)
  };

  // Never let a spectator become the focus — that used to blow up downstream.
  let focus = focusCtrl !== null ? byCtrl.get(focusCtrl) || null : null;
  if (focus === null && focusCtrl !== null && players.length > 0) focus = null;

  const analysis = {
    meta: {
      fileName: raw.fileName,
      fileSize: raw.fileSize,
      duration: raw.duration,
      winningTeam: teams.includes(raw.winningTeam) ? raw.winningTeam : null,
      rawWinningTeam: raw.winningTeam,
      parsedAt: raw.parsedAt,
      mapScale: frame.span,
      mapFrameOk: frame.ok,
      teamsDegraded
    },
    teams,
    teamIds: teams.ids,
    frame,
    players,
    nonPlayers,
    teamRoster: roster,
    focus,
    deaths: [],
    kills: [],
    fights: [],
    farm: null,
    items: [],
    objectives: [],
    macro: null,
    findings: []
  };

  analysis.kills = raw.kills.map((k) => ({
    t: k.t,
    victim: k.victim,
    victimName: byCtrl.get(k.victim)?.name ?? `#${k.victim}`,
    victimTeam: byCtrl.get(k.victim)?.team ?? k.victimTeam,
    killer: k.killer,
    killerName: k.killer !== null ? (byCtrl.get(k.killer)?.name ?? `#${k.killer}`) : 'non-player',
    assisters: k.assisters,
    pos: positionsFromKill(k).get(k.victim) || null
  }));

  analysis.objectives = buildObjectives(raw, byCtrl, teams);
  analysis.fights = buildFights(raw, byCtrl, frame, roster, teams);
  analysis.farm = buildFarm(raw, players, teams, focus);
  analysis.items = buildItems(raw, byCtrl, itemName);
  analysis.deaths = buildDeaths(raw, byCtrl, frame, analysis.objectives, focus, teams);
  analysis.macro = buildMacro(raw, analysis, teams, frame);
  analysis.findings = buildFindings(analysis, focus, teams);

  return analysis;
}

/* ------------------------------------------------------------------ */
/* objectives                                                          */
/* ------------------------------------------------------------------ */

/**
 * Objective messages carry two different team numbering schemes depending on
 * the field: the destroyed entity's own team number (engine space) and Valve's
 * lobby team enum (0/1). Prefer the entity's team; fall back to mapping the
 * lobby value onto the playing team ids by ordering.
 */
function buildObjectives(raw, byCtrl, teams) {
  const source = raw.objectives || [];

  const lobbyValues = Array.from(
    new Set(source.map((o) => o.team).filter((v) => Number.isFinite(v)))
  ).sort((a, b) => a - b);
  const lobbyMap = new Map();
  if (lobbyValues.length <= 2) {
    lobbyValues.forEach((value, i) => lobbyMap.set(value, teams.ids[i]));
  }

  return source
    .map((o) => {
      const entityIsPlayerTeam = teams.includes(o.entityTeam);
      const lostBy = entityIsPlayerTeam ? o.entityTeam : (lobbyMap.get(o.team) ?? null);

      let kind = o.kind;
      if (kind !== 'midboss_spawned') {
        const neutral = o.entityTeam !== null && o.entityTeam !== undefined && !entityIsPlayerTeam;
        kind = neutral ? 'midboss' : 'building';
      }

      return {
        t: o.t,
        kind,
        // Valve's message names the team that *lost* the building, so credit
        // goes to the other side. Both are kept so nothing is guessed silently.
        lostByTeam: lostBy,
        takenByTeam: lostBy === null ? null : teams.other(lostBy),
        killerCtrl: o.killerCtrl ?? null,
        killerName:
          o.killerCtrl !== null && o.killerCtrl !== undefined
            ? (byCtrl.get(o.killerCtrl)?.name ?? null)
            : null,
        bossesRemaining: o.bossesRemaining ?? null,
        pos: o.pos || null
      };
    })
    .sort((a, b) => a.t - b.t);
}

/* ------------------------------------------------------------------ */
/* teamfights                                                          */
/* ------------------------------------------------------------------ */

function buildFights(raw, byCtrl, frame, roster, teams) {
  const [TEAM_A, TEAM_B] = teams.ids;
  const kills = raw.kills.slice().sort((a, b) => a.t - b.t);
  const radius = frame.ok ? frame.span * FIGHT_RADIUS : Infinity;

  const clusters = [];
  for (const kill of kills) {
    const positions = positionsFromKill(kill);
    const at = positions.get(kill.victim) || null;

    const last = clusters[clusters.length - 1];
    const closeInTime = last && kill.t - last.end <= FIGHT_GAP;
    const closeInSpace = last && (!last.center || !at ? true : dist2d(last.center, at) <= radius);

    if (last && closeInTime && closeInSpace) {
      last.kills.push(kill);
      last.end = kill.t;
      if (at) {
        const n = last.positionCount + 1;
        last.center = {
          x: (last.center.x * last.positionCount + at.x) / n,
          y: (last.center.y * last.positionCount + at.y) / n
        };
        last.positionCount = n;
      }
    } else {
      clusters.push({
        kills: [kill],
        start: kill.t,
        end: kill.t,
        center: at ? { x: at.x, y: at.y } : null,
        positionCount: at ? 1 : 0
      });
    }
  }

  const damageByWindow = (from, to) => {
    const totals = new Map();
    for (const d of raw.damage) {
      if (d.t < from - 2 || d.t > to + 2) continue;
      totals.set(d.a, (totals.get(d.a) || 0) + d.dmg);
    }
    return totals;
  };

  return clusters.map((cluster, i) => {
    const from = cluster.start - FIGHT_PAD;
    const to = cluster.end + FIGHT_PAD;
    const dmg = damageByWindow(from, to);

    const score = { [TEAM_A]: 0, [TEAM_B]: 0 };
    const deaths = [];
    for (const kill of cluster.kills) {
      const victim = byCtrl.get(kill.victim);
      const victimTeam = victim?.team ?? kill.victimTeam;
      const scoringTeam = teams.other(victimTeam);
      if (scoringTeam !== null) score[scoringTeam] += 1;
      deaths.push({
        t: kill.t,
        victim: kill.victim,
        victimName: victim?.name ?? `#${kill.victim}`,
        victimTeam,
        killer: kill.killer,
        killerName: kill.killer !== null ? (byCtrl.get(kill.killer)?.name ?? 'non-player') : 'non-player'
      });
    }

    const positions = positionsFromKill(cluster.kills[0]);
    const nearRadius = frame.ok ? frame.span * NEARBY : Infinity;
    const center = cluster.center;

    const participation = [];
    for (const player of [...roster[TEAM_A], ...roster[TEAM_B]]) {
      const p = positions.get(player.ctrl);
      const distance = center && p ? dist2d(center, p) : null;
      const damage = dmg.get(player.ctrl) || 0;
      const present = damage > 0 || (distance !== null && distance <= nearRadius);
      participation.push({
        ctrl: player.ctrl,
        name: player.name,
        team: player.team,
        damage,
        distance,
        alive: p ? p.alive : null,
        present
      });
    }

    const diff = score[TEAM_A] - score[TEAM_B];
    const winner = diff > 0 ? TEAM_A : diff < 0 ? TEAM_B : null;

    return {
      id: i,
      // A single isolated kill is a pick, not a teamfight. Counting picks as
      // fights would wreck the attendance percentages.
      isPick: cluster.kills.length === 1,
      start: cluster.start,
      end: cluster.end,
      center,
      depth: center
        ? {
            [TEAM_A]: territoryDepth(frame, TEAM_A, center),
            [TEAM_B]: territoryDepth(frame, TEAM_B, center)
          }
        : null,
      score,
      winner,
      deaths,
      participation
    };
  });
}

/* ------------------------------------------------------------------ */
/* farm                                                                */
/* ------------------------------------------------------------------ */

function buildFarm(raw, players, teams, focus) {
  const milestones = [300, 600, 900, 1200, 1500, 1800, 2400];

  const rows = players.map((p) => {
    const series = p.netWorthSeries;
    const marks = {};
    for (const m of milestones) {
      if (raw.duration + 5 < m) continue;
      marks[m] = valueAt(series, m);
    }
    return {
      ctrl: p.ctrl,
      name: p.name,
      team: p.team,
      hero: p.hero,
      series,
      marks,
      final: p.final?.netWorth ?? (series.length ? series[series.length - 1].v : null)
    };
  });

  // Lane opponent: the enemy who spent the most early-game time closest to you.
  let laneOpponent = null;
  if (focus) {
    const enemies = players.filter((p) => p.team !== focus.team);
    const tally = new Map(enemies.map((e) => [e.ctrl, []]));
    for (const sample of raw.samples) {
      if (sample.t > 600) break;
      const me = sample.players.find((r) => r.ctrl === focus.ctrl);
      if (!me || me.x === null) continue;
      for (const enemy of enemies) {
        const row = sample.players.find((r) => r.ctrl === enemy.ctrl);
        if (!row || row.x === null) continue;
        tally.get(enemy.ctrl).push(dist2d(me, row));
      }
    }
    let best = null;
    for (const [ctrl, distances] of tally.entries()) {
      if (distances.length < 5) continue;
      const score = median(distances);
      if (score !== null && (best === null || score < best.score)) best = { ctrl, score };
    }
    if (best) laneOpponent = rows.find((r) => r.ctrl === best.ctrl) || null;
  }

  const teamOf = new Map(players.map((p) => [p.ctrl, p.team]));
  const teamTotals = {};
  for (const team of teams.ids) {
    const series = [];
    for (const sample of raw.samples) {
      let total = 0;
      let seen = 0;
      for (const row of sample.players) {
        if (teamOf.get(row.ctrl) !== team) continue;
        if (row.nw === null || row.nw === undefined) continue;
        total += row.nw;
        seen += 1;
      }
      if (seen > 0) series.push({ t: sample.t, v: total });
    }
    teamTotals[team] = series;
  }

  const leadSeries = [];
  const first = teamTotals[teams.ids[0]] || [];
  const second = teamTotals[teams.ids[1]] || [];
  for (let i = 0; i < Math.min(first.length, second.length); i += 1) {
    leadSeries.push({ t: first[i].t, v: first[i].v - second[i].v });
  }

  return { rows, laneOpponent, teamTotals, leadSeries, milestones };
}

/* ------------------------------------------------------------------ */
/* items                                                               */
/* ------------------------------------------------------------------ */

function buildItems(raw, byCtrl, itemName) {
  return (raw.items || [])
    .filter((i) => !i.sell)
    .map((i) => {
      const meta = i.abilityId !== null && i.abilityId !== undefined ? itemName(i.abilityId) : null;
      return {
        t: i.t,
        ctrl: i.ctrl,
        name: byCtrl.get(i.ctrl)?.name ?? null,
        team: byCtrl.get(i.ctrl)?.team ?? null,
        abilityId: i.abilityId,
        item: meta?.name || (i.abilityId !== null && i.abilityId !== undefined ? `Item #${i.abilityId}` : 'Unknown item'),
        cost: meta?.cost ?? null,
        tier: meta?.tier ?? null,
        slot: meta?.slot ?? null,
        resolved: Boolean(meta)
      };
    })
    .sort((a, b) => a.t - b.t);
}

/* ------------------------------------------------------------------ */
/* deaths                                                              */
/* ------------------------------------------------------------------ */

function buildDeaths(raw, byCtrl, frame, objectives, focus, teams) {
  const kills = raw.kills.slice().sort((a, b) => a.t - b.t);
  const nearRadius = frame.ok ? frame.span * NEARBY : Infinity;

  const respawnsByCtrl = new Map();
  for (const r of raw.respawns || []) {
    if (!respawnsByCtrl.has(r.ctrl)) respawnsByCtrl.set(r.ctrl, []);
    respawnsByCtrl.get(r.ctrl).push(r.t);
  }

  const deathsOf = new Map();
  for (const kill of kills) {
    if (!deathsOf.has(kill.victim)) deathsOf.set(kill.victim, []);
    deathsOf.get(kill.victim).push(kill.t);
  }

  return kills.map((kill, i) => {
    const victim = byCtrl.get(kill.victim);
    const team = victim?.team ?? kill.victimTeam;
    const positions = positionsFromKill(kill);
    const pos = positions.get(kill.victim) || null;
    const depth = territoryDepth(frame, team, pos);

    let alliesNear = 0;
    let enemiesNear = 0;
    const alliesNearList = [];
    const enemiesNearList = [];

    for (const [ctrl, p] of positions.entries()) {
      if (ctrl === kill.victim) continue;
      const other = byCtrl.get(ctrl);
      if (!other || !p) continue;
      if (p.alive === false) continue;
      const d = dist2d(pos, p);
      if (d > nearRadius) continue;
      if (other.team === team) {
        alliesNear += 1;
        alliesNearList.push(other.name);
      } else {
        enemiesNear += 1;
        enemiesNearList.push(other.name);
      }
    }

    const tradeWindow = 12;
    let trade = 0;
    for (const other of kills) {
      if (other === kill) continue;
      if (Math.abs(other.t - kill.t) > tradeWindow) continue;
      const otherTeam = byCtrl.get(other.victim)?.team ?? other.victimTeam;
      if (otherTeam !== team) trade += 1;
    }

    const respawnTimes = respawnsByCtrl.get(kill.victim) || [];
    const lastRespawn = respawnTimes.filter((t) => t < kill.t).pop() ?? null;
    const sinceRespawn = lastRespawn !== null ? kill.t - lastRespawn : null;

    const myDeaths = deathsOf.get(kill.victim) || [];
    const recentDeaths = myDeaths.filter((t) => t <= kill.t && t > kill.t - 180).length;

    const followUpObjective =
      objectives.find(
        (o) => o.takenByTeam === team && o.t > kill.t && o.t <= kill.t + 45 && o.kind !== 'midboss_spawned'
      ) || null;

    const flags = [];
    if (alliesNear === 0 && enemiesNear > 0) flags.push('solo');
    if (enemiesNear >= alliesNear + 2) flags.push('outnumbered');
    if (depth !== null && depth > 0.62) flags.push('deep');
    if (sinceRespawn !== null && sinceRespawn < 25) flags.push('fresh-respawn');
    if (recentDeaths >= 3) flags.push('tilt-streak');
    if (trade === 0) flags.push('no-trade');

    return {
      id: i,
      t: kill.t,
      ctrl: kill.victim,
      name: victim?.name ?? `#${kill.victim}`,
      team,
      isFocus: focus ? kill.victim === focus.ctrl : false,
      killer: kill.killer,
      killerName: kill.killer !== null ? (byCtrl.get(kill.killer)?.name ?? 'non-player') : 'non-player',
      assisters: kill.assisters.map((a) => byCtrl.get(a)?.name ?? `#${a}`),
      pos,
      depth,
      zone: depthLabel(depth),
      alliesNear,
      enemiesNear,
      alliesNearList,
      enemiesNearList,
      netWorth: kill.victimNetWorth ?? null,
      trade,
      sinceRespawn,
      recentDeaths,
      followUpObjective,
      flags
    };
  });
}

/* ------------------------------------------------------------------ */
/* macro                                                               */
/* ------------------------------------------------------------------ */

function buildMacro(raw, analysis, teams, frame) {
  const [TEAM_A, TEAM_B] = teams.ids;
  const { fights, objectives, farm } = analysis;

  /* Objective conversion: after clearly winning a fight, did anything happen? */
  const conversions = [];
  for (const fight of fights) {
    const diff = fight.score[TEAM_A] - fight.score[TEAM_B];
    if (Math.abs(diff) < 2) continue;
    const winner = diff > 0 ? TEAM_A : TEAM_B;
    const taken =
      objectives.find(
        (o) => o.takenByTeam === winner && o.t > fight.end && o.t <= fight.end + 75 && o.kind !== 'midboss_spawned'
      ) || null;
    conversions.push({
      fightId: fight.id,
      t: fight.end,
      winner,
      margin: Math.abs(diff),
      converted: Boolean(taken),
      objective: taken
    });
  }

  const conversionRate = {};
  for (const team of teams.ids) {
    const own = conversions.filter((c) => c.winner === team);
    conversionRate[team] = {
      won: own.length,
      converted: own.filter((c) => c.converted).length,
      rate: own.length ? own.filter((c) => c.converted).length / own.length : null
    };
  }

  /* Team spread: how far apart the team was, sampled per 30s. */
  const spread = {};
  for (const team of teams.ids) spread[team] = [];
  if (frame.ok) {
    const teamOf = new Map(analysis.players.map((p) => [p.ctrl, p.team]));
    let lastBucket = -1;
    for (const sample of raw.samples) {
      const bucket = Math.floor(sample.t / 30);
      if (bucket === lastBucket) continue;
      lastBucket = bucket;
      for (const team of teams.ids) {
        const points = sample.players
          .filter((r) => teamOf.get(r.ctrl) === team && r.x !== null && r.alive !== false)
          .map((r) => ({ x: r.x, y: r.y }));
        if (points.length < 2) continue;
        let total = 0;
        let pairs = 0;
        for (let i = 0; i < points.length; i += 1) {
          for (let j = i + 1; j < points.length; j += 1) {
            total += dist2d(points[i], points[j]);
            pairs += 1;
          }
        }
        spread[team].push({ t: sample.t, v: total / pairs / frame.span });
      }
    }
  }

  /* Soul lead: peak and where it went. Positive means the first team is ahead. */
  const lead = farm.leadSeries;
  let peak = { t: 0, v: 0 };
  for (const point of lead) {
    if (Math.abs(point.v) > Math.abs(peak.v)) peak = point;
  }
  const finalLead = lead.length ? lead[lead.length - 1].v : 0;

  let collapse = null;
  if (lead.length) {
    const after = lead.filter((p) => p.t >= peak.t);
    let worst = null;
    for (const point of after) {
      const swing = peak.v - point.v;
      if (worst === null || Math.abs(swing) > Math.abs(worst.swing)) {
        worst = { t: point.t, swing, value: point.v };
      }
    }
    collapse = worst;
  }

  /* Deaths while holding a lead — the classic way to throw one. */
  const deathsWhileAhead = {};
  for (const team of teams.ids) deathsWhileAhead[team] = 0;
  for (const death of analysis.deaths) {
    if (!teams.includes(death.team)) continue;
    const leadAt = valueAt(lead, death.t) ?? 0;
    const teamLead = death.team === TEAM_A ? leadAt : -leadAt;
    if (teamLead > 3000) deathsWhileAhead[death.team] += 1;
  }

  const objectiveCount = {};
  for (const team of teams.ids) objectiveCount[team] = 0;
  for (const o of objectives) {
    if (o.kind === 'midboss_spawned') continue;
    if (teams.includes(o.takenByTeam)) objectiveCount[o.takenByTeam] += 1;
  }

  return {
    conversions,
    conversionRate,
    spread,
    lead: { series: lead, peak, finalLead, collapse },
    deathsWhileAhead,
    objectiveCount
  };
}

/* ------------------------------------------------------------------ */
/* findings — the plain-English takeaways                              */
/* ------------------------------------------------------------------ */

const EMPTY_RATE = { won: 0, converted: 0, rate: null };

function buildFindings(analysis, focus, teams) {
  const findings = [];
  const add = (scope, severity, title, detail, evidence) =>
    findings.push({ scope, severity, title, detail, evidence: evidence || null });

  const { deaths, fights, farm, macro } = analysis;

  /* ---------- individual ---------- */
  if (focus) {
    const mine = deaths.filter((d) => d.isFocus);
    const total = mine.length;

    if (total > 0) {
      const solo = mine.filter((d) => d.flags.includes('solo'));
      if (solo.length >= Math.max(2, total * 0.3)) {
        add(
          'you',
          solo.length >= total * 0.5 ? 'high' : 'medium',
          `${solo.length} of your ${total} deaths came with no living teammate nearby`,
          'Dying alone means the enemy pays nothing for the kill. Before taking a fight, check whether anyone is close enough to punish a collapse on you.',
          solo.slice(0, 5).map((d) => `${formatClock(d.t)} — killed by ${d.killerName} in ${d.zone}`)
        );
      }

      const deep = mine.filter((d) => d.flags.includes('deep'));
      if (deep.length >= 2) {
        add(
          'you',
          deep.length >= 4 ? 'high' : 'medium',
          `${deep.length} deaths happened deep in enemy territory`,
          'Deaths past the midpoint of the map usually mean farming or chasing without vision or an escape route.',
          deep.slice(0, 5).map((d) => `${formatClock(d.t)} — ${Math.round(d.depth * 100)}% into enemy side, ${d.enemiesNear} enemies nearby`)
        );
      }

      const noTrade = mine.filter((d) => d.flags.includes('no-trade'));
      if (noTrade.length >= Math.max(2, total * 0.5)) {
        add(
          'you',
          'medium',
          `${noTrade.length} of your deaths bought nothing`,
          'No enemy died within 12 seconds either side of these deaths. They were pure losses of time and souls.',
          noTrade.slice(0, 5).map((d) => `${formatClock(d.t)} — killed by ${d.killerName}, ${d.alliesNear} allies nearby`)
        );
      }

      const fresh = mine.filter((d) => d.flags.includes('fresh-respawn'));
      if (fresh.length >= 2) {
        add(
          'you',
          'medium',
          `${fresh.length} deaths within 25 seconds of respawning`,
          'Walking straight back into a lost fight compounds the problem. After a death, take the safe farm first.',
          fresh.map((d) => `${formatClock(d.t)} — ${Math.round(d.sinceRespawn)}s after respawn`)
        );
      }

      const outnumbered = mine.filter((d) => d.flags.includes('outnumbered'));
      if (outnumbered.length >= 2) {
        add(
          'you',
          'medium',
          `${outnumbered.length} deaths while clearly outnumbered`,
          'These are the most avoidable deaths in the match: the numbers were visible before the fight started.',
          outnumbered.slice(0, 5).map((d) => `${formatClock(d.t)} — ${d.enemiesNear}v${d.alliesNear + 1} against you`)
        );
      }
    }

    /* farm gap */
    if (farm.laneOpponent) {
      const me = farm.rows.find((r) => r.ctrl === focus.ctrl);
      const opp = farm.laneOpponent;
      if (me) {
        const mineAt = me.marks[600];
        const oppAt = opp.marks[600];
        const at600 = Number.isFinite(mineAt) && Number.isFinite(oppAt) ? mineAt - oppAt : null;
        if (at600 !== null && at600 < -1500) {
          add(
            'you',
            'high',
            `Down ${Math.abs(Math.round(at600)).toLocaleString()} souls to ${opp.name} at 10:00`,
            'The early deficit against your lane opponent is the single biggest lever on the rest of your game.',
            [`You: ${Math.round(mineAt).toLocaleString()} · ${opp.name}: ${Math.round(oppAt).toLocaleString()}`]
          );
        } else if (at600 !== null && at600 > 1500) {
          add(
            'you',
            'good',
            `Up ${Math.round(at600).toLocaleString()} souls on ${opp.name} at 10:00`,
            'The lane went your way. The question the rest of this report answers is whether that lead was spent well.',
            null
          );
        }
      }
    }

    /* fight attendance — picks excluded, they are not fights to show up to */
    const realFights = fights.filter((f) => !f.isPick);
    const attended = realFights.filter((f) =>
      f.participation.some((p) => p.ctrl === focus.ctrl && p.present)
    ).length;
    if (realFights.length >= 4) {
      const rate = attended / realFights.length;
      if (rate < 0.5) {
        add(
          'you',
          'high',
          `You were present for only ${attended} of ${realFights.length} teamfights`,
          'Missing half the fights means your team plays most of the match a player down, regardless of how well you farm.',
          null
        );
      }
    }
  }

  /* ---------- team ---------- */
  const focusTeam = focus && teams.includes(focus.team) ? focus.team : teams.ids[0];
  const enemyTeam = teams.other(focusTeam) ?? teams.ids[1];

  const conv = macro.conversionRate[focusTeam] || EMPTY_RATE;
  if (conv.won >= 3 && conv.rate !== null && conv.rate < 0.5) {
    add(
      'team',
      'high',
      `Your team converted only ${conv.converted} of ${conv.won} clearly won fights into an objective`,
      'Winning a fight by 2+ and then walking away resets the map. This is usually the difference between a long game and a closed one.',
      macro.conversions
        .filter((c) => c.winner === focusTeam && !c.converted)
        .slice(0, 5)
        .map((c) => `${formatClock(c.t)} — won by ${c.margin}, nothing taken within 75s`)
    );
  }

  const enemyConv = macro.conversionRate[enemyTeam] || EMPTY_RATE;
  if (enemyConv.rate !== null && conv.rate !== null && enemyConv.rate - conv.rate > 0.3) {
    add(
      'team',
      'medium',
      'The enemy team turned fight wins into map control far more often than you did',
      `They converted ${Math.round(enemyConv.rate * 100)}% of their decisive fights against your ${Math.round(conv.rate * 100)}%.`,
      null
    );
  }

  const spread = macro.spread[focusTeam];
  if (spread && spread.length > 5) {
    const avg = mean(spread.map((s) => s.v));
    if (avg !== null && avg > 0.34) {
      add(
        'team',
        'medium',
        'Your team spent the match spread thin across the map',
        `Average distance between teammates was ${Math.round(avg * 100)}% of the map's length. Split like that, fights start before everyone can join.`,
        null
      );
    }
  }

  const lead = macro.lead;
  const focusSign = focusTeam === teams.ids[0] ? 1 : -1;
  const peakForFocus = lead.peak.v * focusSign;
  const finalForFocus = lead.finalLead * focusSign;
  if (peakForFocus > 8000 && finalForFocus < 0) {
    add(
      'team',
      'high',
      `Your team peaked at a ${Math.round(peakForFocus).toLocaleString()} soul lead at ${formatClock(lead.peak.t)} and finished behind`,
      'The lead was real and then it was gone. The fights and objectives between those two points are where the game was lost.',
      null
    );
  }

  const ahead = macro.deathsWhileAhead[focusTeam] ?? 0;
  if (ahead >= 6) {
    add(
      'team',
      'medium',
      `${ahead} deaths happened while your team was more than 3,000 souls ahead`,
      'When ahead, the cheapest play is to take the objective the lead already earned rather than hunting for more kills.',
      null
    );
  }

  const mineObjectives = macro.objectiveCount[focusTeam] ?? 0;
  const theirObjectives = macro.objectiveCount[enemyTeam] ?? 0;
  if (mineObjectives - theirObjectives <= -3) {
    add(
      'team',
      'high',
      `You lost the objective race ${mineObjectives} to ${theirObjectives}`,
      'Objectives, not kills, are what actually end the game. Losing this badly usually traces back to fights taken away from anything worth taking.',
      null
    );
  }

  const order = { high: 0, medium: 1, good: 2 };
  findings.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
  return findings;
}

export { mean, median, valueAt, seriesFor, EMPTY_RATE };
