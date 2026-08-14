/*
 * build.js — item build analysis for one player.
 *
 * Two independent sources of truth, deliberately kept separate:
 *
 *   1. What the replay proves. What damage actually killed you and of what
 *      kind, who dealt it, how much healing the enemy team put out, how many
 *      souls you were sitting on and for how long. None of this is opinion.
 *
 *   2. What real matches say. Per-item win rate, popularity and average
 *      purchase time for your hero, from deadlock-api. The service returns raw
 *      counts, so win rate is wins/matches and popularity is relative to the
 *      most-bought item in the same scope. Optional: if the call fails,
 *      everything in (1) still works and the UI says benchmarking is off.
 *
 * A suggestion is only made where both point the same way, and every suggestion
 * carries the evidence that produced it. Where the item list does not contain a
 * recognisable counter-item, the advice stays generic rather than inventing a
 * name.
 */

import { formatClock } from './analyze.js';

/* Item roles, discovered by matching the live item list rather than hardcoded
 * ids — Valve renumbers, renames and reworks items constantly. If a pattern
 * matches nothing in the current list, that role is simply unavailable and the
 * advice degrades to a category description. */
export const ROLE_PATTERNS = {
  bulletResist: /\bbullet\s*(armou?r|resist)|improved\s+bullet\s+armou?r/i,
  spiritResist: /\bspirit\s*(armou?r|resist)|improved\s+spirit\s+armou?r/i,
  antiHeal: /\b(decay|healbane|toxic\s+bullets?|curse)\b/i,
  sustain: /\b(healing\s+rite|health\s+nova|restorative|lifestrike|leech|healbane|spirit\s+lifesteal|healing\s+booster|extra\s+regen)\b/i,
  escape: /\b(majestic\s+leap|phantom\s+strike|warp\s+stone|ethereal\s+shift|fleetfoot|enduring\s+speed|sprint\s+boots|debuff\s+remover|unstoppable|metal\s+skin)\b/i,
  health: /\b(extra\s+health|enduring\s+spirit|improved\s+bullet\s+armou?r|fortitude|rescue\s+beam)\b/i
};

const SLOT_LABEL = {
  weapon: 'Weapon',
  vitality: 'Vitality',
  spirit: 'Spirit'
};

/* ------------------------------------------------------------------ */
/* damage types                                                        */
/* ------------------------------------------------------------------ */

/**
 * Classify one damage event by the ability that caused it.
 *
 * The obvious heuristic — "damage carrying an ability id is ability damage" —
 * is wrong in Deadlock, because a hero's gun is an ability too, so every event
 * carries one and everything reads as 100% ability. The asset list does draw
 * the distinction: weapons, abilities and items are separate `type` values
 * there. So resolve the ability id and use what the game itself says it is.
 *
 * Anything that cannot be resolved stays 'unclassified' rather than being
 * guessed into a bucket that drives resist advice.
 *
 * @returns {'weapon'|'ability'|'item'|'unclassified'}
 */
export function classifyAbility(abilityId, itemsById) {
  // No ability at all is plain weapon fire on the builds that report it that way.
  if (!abilityId) return 'weapon';
  const meta = itemsById ? itemsById.get(abilityId) : null;
  if (!meta) return 'unclassified';

  const kind = (meta.kind || '').toLowerCase();
  if (kind === 'weapon') return 'weapon';
  if (kind === 'ability') return 'ability';
  if (kind === 'upgrade') return 'item';

  // Fall back to the class name when the asset entry has no type.
  const cls = (meta.className || meta.name || '').toLowerCase();
  if (/weapon/.test(cls)) return 'weapon';
  if (/^upgrade_/.test(cls)) return 'item';
  if (/ability/.test(cls)) return 'ability';
  return 'unclassified';
}

/**
 * Aggregates the whole match's damage by ability so Diagnostics can show what
 * each source actually was — the fastest way to see a misclassification.
 */
export function damageSources(damageByType = [], itemsById = new Map()) {
  const byAbility = new Map();
  for (const row of damageByType) {
    const id = row.abilityId ?? 0;
    let entry = byAbility.get(id);
    if (!entry) {
      const meta = itemsById.get(id) || null;
      entry = {
        abilityId: id,
        name: meta?.name ?? (id ? `#${id}` : 'no ability id'),
        kind: meta?.kind ?? null,
        label: classifyAbility(id, itemsById),
        types: new Set(),
        dmg: 0,
        hits: 0
      };
      byAbility.set(id, entry);
    }
    entry.dmg += row.dmg;
    entry.hits += row.hits;
    entry.types.add(row.type);
  }
  return Array.from(byAbility.values())
    .map((e) => ({ ...e, types: Array.from(e.types) }))
    .sort((a, b) => b.dmg - a.dmg);
}

function damageProfileFor(raw, ctrl, direction, itemsById) {
  const rows = (raw.damageByType || []).filter((r) => r.ctrl === ctrl && r.dir === direction);
  const total = rows.reduce((sum, r) => sum + r.dmg, 0);

  const byLabel = { weapon: 0, ability: 0, item: 0, unclassified: 0 };
  const detail = new Map();

  for (const row of rows) {
    const label = classifyAbility(row.abilityId ?? 0, itemsById);
    byLabel[label] = (byLabel[label] || 0) + row.dmg;

    const meta = itemsById.get(row.abilityId ?? 0) || null;
    const key = row.abilityId ?? 0;
    let entry = detail.get(key);
    if (!entry) {
      entry = {
        abilityId: key,
        name: meta?.name ?? (key ? `#${key}` : 'weapon fire'),
        label,
        dmg: 0,
        hits: 0
      };
      detail.set(key, entry);
    }
    entry.dmg += row.dmg;
    entry.hits += row.hits;
  }

  const classified = (byLabel.weapon || 0) + (byLabel.ability || 0) + (byLabel.item || 0);

  return {
    total,
    detail: Array.from(detail.values())
      .map((d) => ({ ...d, share: total > 0 ? d.dmg / total : 0 }))
      .sort((a, b) => b.dmg - a.dmg),
    weapon: byLabel.weapon || 0,
    ability: byLabel.ability || 0,
    item: byLabel.item || 0,
    unclassified: byLabel.unclassified || 0,
    classified,
    // Shares are of the damage we could actually classify, so an unresolved
    // ability id does not silently inflate the other side.
    weaponShare: classified > 0 ? (byLabel.weapon || 0) / classified : null,
    abilityShare: classified > 0 ? (byLabel.ability || 0) / classified : null,
    itemShare: classified > 0 ? (byLabel.item || 0) / classified : null
  };
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function valueAt(series, t) {
  if (!series || series.length === 0) return null;
  let best = null;
  for (const point of series) {
    if (point.t <= t) best = point;
    else break;
  }
  return best ? best.v : series[0].v;
}

function findRole(role, itemsById) {
  const pattern = ROLE_PATTERNS[role];
  if (!pattern) return [];
  const hits = [];
  for (const meta of itemsById.values()) {
    if (meta.name && pattern.test(meta.name)) hits.push(meta);
  }
  return hits;
}

function pct(value) {
  return value === null || value === undefined ? null : Math.round(value * 100);
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

/**
 * @param {Object} analysis  from analyze()
 * @param {Object} raw       from parseReplay()
 * @param {Object} options
 * @param {Map}    options.itemsById   id -> item metadata (name, cost, tier, slot)
 * @param {Object} options.itemStats   {stats: Map, scope, sampleMatches} or null
 */
export function analyzeBuild(analysis, raw, options = {}) {
  const { itemsById = new Map(), itemStats = null } = options;
  const focus = analysis.focus;


  const result = {
    ok: Boolean(focus),
    hero: focus?.hero ?? null,
    heroId: focus?.heroId ?? null,
    purchases: [],
    categories: { weapon: 0, vitality: 0, spirit: 0, unknown: 0 },
    categorySouls: { weapon: 0, vitality: 0, spirit: 0, unknown: 0 },
    spend: { series: [], totalCommitted: 0, worstBanking: null, costsEstimated: false, method: 'unavailable' },
    damage: null,
    threats: [],
    enemyHealing: 0,
    deathContext: [],
    benchmark: { available: false, scope: null, sampleMatches: 0, missed: [], late: [], lowValue: [], matched: 0 },
    suggestions: [],
    notes: []
  };

  if (!focus) {
    result.notes.push('No player selected, so there is no build to analyse.');
    return result;
  }

  /* ---------------- purchases ---------------- */

  const mine = analysis.items.filter((i) => i.ctrl === focus.ctrl).sort((a, b) => a.t - b.t);
  let committed = 0;
  let previousAt = 0;

  for (const purchase of mine) {
    const meta = itemsById.get(purchase.abilityId) || null;
    const cost = meta?.cost ?? purchase.cost ?? null;
    if (Number.isFinite(cost)) committed += cost;
    if (meta?.costIsEstimated) result.spend.costsEstimated = true;

    const slot = (meta?.slot || '').toLowerCase();
    const bucket = slot === 'weapon' || slot === 'vitality' || slot === 'spirit' ? slot : 'unknown';
    result.categories[bucket] += 1;
    if (Number.isFinite(cost)) result.categorySouls[bucket] += cost;

    const stat = itemStats?.stats?.get(purchase.abilityId) || null;

    result.purchases.push({
      t: purchase.t,
      id: purchase.abilityId,
      name: meta?.name || purchase.item,
      cost,
      tier: meta?.tier ?? null,
      slot: bucket === 'unknown' ? null : bucket,
      slotLabel: SLOT_LABEL[bucket] || 'Unknown',
      committedAfter: committed,
      gapBefore: purchase.t - previousAt,
      benchmark: stat
        ? {
            winRate: stat.winRate,
            popularity: stat.popularity,
            avgBoughtAt: stat.avgBoughtAt,
            delta: Number.isFinite(stat.avgBoughtAt) ? purchase.t - stat.avgBoughtAt : null,
            matches: stat.matches
          }
        : null
    });

    previousAt = purchase.t;
  }

  result.spend.totalCommitted = committed;

  /* ---------------- soul banking ---------------- */

  const netWorth = analysis.farm.rows.find((r) => r.ctrl === focus.ctrl)?.series || [];

  /*
   * Unspent souls come from one of two places, in order of trust:
   *
   *   measured — the replay replicates a current-souls field, which is exact.
   *   derived  — net worth minus what the purchases cost.
   *
   * The derived route is only valid if every purchase has a known cost. If item
   * metadata failed to load, costs are null, spend reads as zero and "unspent"
   * becomes the player's entire net worth — which is how this metric once
   * announced someone sat on 30,000 souls for a whole match. So it is gated:
   * no trustworthy spend figure, no claim.
   */
  const measured = [];
  for (const sample of raw.samples || []) {
    const row = sample.players.find((p) => p.ctrl === focus.ctrl);
    if (row && row.un !== null && row.un !== undefined) measured.push({ t: sample.t, v: row.un });
  }

  const pricedPurchases = result.purchases.filter((p) => Number.isFinite(p.cost) && p.cost > 0);
  const unpriced = result.purchases.length - pricedPurchases.length;

  /*
   * The gate is whether every purchase has a known cost — not whether the
   * spend looks large enough. A low spend relative to net worth is exactly what
   * genuine hoarding looks like, so judging by ratio would suppress the very
   * thing this metric exists to find. Missing costs, on the other hand, make
   * the arithmetic silently wrong.
   */
  const allPriced = result.purchases.length > 0 && unpriced === 0;

  if (measured.length > 0) {
    result.spend.method = 'measured';
  } else if (netWorth.length > 0 && allPriced) {
    result.spend.method = 'derived';
  } else {
    result.spend.method = 'unavailable';
    if (result.purchases.length === 0) {
      result.notes.push(
        'No purchases were matched to you, so unspent souls cannot be worked out and the spend curve shows net worth only.'
      );
    } else {
      result.notes.push(
        `${unpriced} of your ${result.purchases.length} purchases have no known cost, so unspent souls cannot be worked out — the figure would just be your net worth. Check item name resolution in Diagnostics.`
      );
    }
  }

  if (netWorth.length > 0 && result.spend.method !== 'unavailable') {
    const spendAt = (t) => {
      let total = 0;
      for (const p of result.purchases) {
        if (p.t > t) break;
        if (Number.isFinite(p.cost)) total += p.cost;
      }
      return total;
    };

    const measuredAt = (t) => {
      if (measured.length === 0) return null;
      let best = measured[0].v;
      for (const point of measured) {
        if (point.t <= t) best = point.v;
        else break;
      }
      return best;
    };

    let run = null;
    for (const point of netWorth) {
      const banked = result.spend.method === 'measured' ? measuredAt(point.t) : point.v - spendAt(point.t);
      result.spend.series.push({ t: point.t, netWorth: point.v, committed: spendAt(point.t), banked });

      // A "banking" run is a stretch sitting on enough souls to have bought
      // something meaningful. Early game is excluded: everyone banks at the start.
      const meaningful = point.t > 240 && Number.isFinite(banked) && banked > 1500;
      if (meaningful) {
        if (!run) run = { from: point.t, to: point.t, peak: banked };
        else {
          run.to = point.t;
          run.peak = Math.max(run.peak, banked);
        }
      } else if (run) {
        if (!result.spend.worstBanking || run.to - run.from > result.spend.worstBanking.to - result.spend.worstBanking.from) {
          result.spend.worstBanking = run;
        }
        run = null;
      }
    }
    if (run && (!result.spend.worstBanking || run.to - run.from > result.spend.worstBanking.to - result.spend.worstBanking.from)) {
      result.spend.worstBanking = run;
    }
  }

  /* ---------------- damage profile ---------------- */

  result.damage = {
    sources: damageSources(raw.damageByType || [], itemsById),
    taken: damageProfileFor(raw, focus.ctrl, 'taken', itemsById),
    dealt: damageProfileFor(raw, focus.ctrl, 'dealt', itemsById)
  };

  const takenTotal = result.damage.taken.total;
  const threats = [];
  for (const [key, dmg] of Object.entries(raw.damageTotals || {})) {
    const [attacker, victim] = key.split('>').map(Number);
    if (victim !== focus.ctrl) continue;
    const player = analysis.players.find((p) => p.ctrl === attacker);
    if (!player) continue;
    threats.push({
      ctrl: attacker,
      name: player.name,
      hero: player.hero,
      dmg,
      share: takenTotal > 0 ? dmg / takenTotal : null
    });
  }
  result.threats = threats.sort((a, b) => b.dmg - a.dmg).slice(0, 5);

  result.enemyHealing = analysis.players
    .filter((p) => p.team !== focus.team)
    .reduce((sum, p) => sum + (p.final?.heroHealing || 0), 0);

  /* ---------------- what killed you ---------------- */

  const myDeaths = analysis.deaths.filter((d) => d.isFocus);
  const rawByTime = new Map((raw.kills || []).map((k) => [Math.round(k.t), k]));

  for (const death of myDeaths) {
    const rawKill = rawByTime.get(Math.round(death.t));
    const breakdown = (rawKill?.preDeathDamage || []).map((entry) => {
      const player = analysis.players.find((p) => p.ctrl === entry.attacker);
      const meta = itemsById.get(entry.abilityId ?? 0) || null;
      return {
        name: player?.name ?? `#${entry.attacker}`,
        hero: player?.hero ?? null,
        dmg: entry.dmg,
        source: meta?.name ?? null,
        label: classifyAbility(entry.abilityId ?? 0, itemsById)
      };
    });
    const total = breakdown.reduce((s, b) => s + b.dmg, 0);
    const abilityDmg = breakdown.filter((b) => b.label === 'ability').reduce((s, b) => s + b.dmg, 0);

    result.deathContext.push({
      t: death.t,
      killerName: death.killerName,
      itemsOwned: result.purchases.filter((p) => p.t <= death.t).length,
      soulsBanked: (() => {
        const point = result.spend.series.filter((s) => s.t <= death.t).pop();
        return point ? Math.round(point.banked) : null;
      })(),
      breakdown: breakdown.slice(0, 4),
      total,
      abilityShare: total > 0 ? abilityDmg / total : null
    });
  }

  /* ---------------- benchmark against real matches ---------------- */

  if (itemStats && itemStats.stats && itemStats.stats.size > 0) {
    result.benchmark.available = true;
    result.benchmark.scope = itemStats.scope;
    result.benchmark.sampleMatches = itemStats.sampleMatches;
    result.benchmark.baselineWinRate = itemStats.baselineWinRate ?? null;

    const bought = new Set(mine.map((i) => i.abilityId));

    /*
     * Win rates across all items sit in a narrow band around the baseline, so
     * an absolute cutoff like "52%" would either catch everything or nothing
     * depending on the patch. Judge each item against the scope's own baseline
     * instead. Popularity is relative to the most-bought item in the scope.
     */
    const baseline = itemStats.baselineWinRate;
    const GOOD_MARGIN = 0.01;
    const BAD_MARGIN = 0.015;

    for (const [id, stat] of itemStats.stats.entries()) {
      const meta = itemsById.get(id);
      const name = meta?.name || `Item #${id}`;
      const above = baseline !== null && stat.winRate !== null ? stat.winRate - baseline : null;

      if (bought.has(id)) {
        result.benchmark.matched += 1;
        if (above !== null && above < -BAD_MARGIN && stat.matches >= 500) {
          result.benchmark.lowValue.push({
            id,
            name,
            winRate: stat.winRate,
            vsBaseline: above,
            popularity: stat.popularity,
            matches: stat.matches
          });
        }
      } else if (stat.popularity !== null && stat.popularity >= 0.25 && above !== null && above > GOOD_MARGIN) {
        result.benchmark.missed.push({
          id,
          name,
          slot: meta?.slot ?? null,
          winRate: stat.winRate,
          vsBaseline: above,
          popularity: stat.popularity,
          avgBoughtAt: stat.avgBoughtAt,
          matches: stat.matches
        });
      }
    }

    result.benchmark.missed.sort((a, b) => b.popularity - a.popularity).splice(8);
    result.benchmark.lowValue.sort((a, b) => a.vsBaseline - b.vsBaseline).splice(5);

    for (const purchase of result.purchases) {
      const b = purchase.benchmark;
      if (!b || !Number.isFinite(b.delta)) continue;
      if (b.delta > 240) {
        result.benchmark.late.push({
          id: purchase.id,
          name: purchase.name,
          yours: purchase.t,
          median: b.avgBoughtAt,
          delta: b.delta,
          winRate: b.winRate
        });
      }
    }
    result.benchmark.late.sort((a, b) => b.delta - a.delta).splice(6);
  } else {
    result.notes.push('Item win-rate data could not be loaded, so nothing here is compared against real matches.');
  }

  const taken = result.damage.taken;
  if (taken.total > 0 && taken.classified / taken.total < 0.6) {
    result.notes.push(
      `Only ${Math.round((taken.classified / taken.total) * 100)}% of the damage you took could be attributed to a known weapon or ability, so the weapon/ability split is unreliable and resist advice is withheld. The Diagnostics tab lists the unresolved sources.`
    );
  }

  result.suggestions = buildSuggestions(result, analysis, itemsById, itemStats);
  return result;
}

/* ------------------------------------------------------------------ */
/* suggestions                                                         */
/* ------------------------------------------------------------------ */

function buildSuggestions(build, analysis, itemsById, itemStats) {
  const suggestions = [];
  const focus = analysis.focus;
  const add = (priority, title, reason, evidence, items) =>
    suggestions.push({ priority, title, reason, evidence: evidence || [], items: items || [] });

  const owned = new Set(build.purchases.map((p) => p.id));
  const ownedNames = build.purchases.map((p) => (p.name || '').toLowerCase());

  const hasRole = (role) => {
    const pattern = ROLE_PATTERNS[role];
    return ownedNames.some((n) => pattern.test(n));
  };
  const firstOfRole = (role) => {
    const pattern = ROLE_PATTERNS[role];
    const hit = build.purchases.find((p) => pattern.test(p.name || ''));
    return hit || null;
  };
  const suggestRole = (role) =>
    findRole(role, itemsById)
      .filter((meta) => !owned.has(meta.id))
      .map((meta) => {
        const stat = itemStats?.stats?.get(meta.id) || null;
        return { id: meta.id, name: meta.name, tier: meta.tier, cost: meta.cost, winRate: stat?.winRate ?? null };
      })
      // Prefer things the stats actually like, then cheaper tiers.
      .sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0) || (a.tier ?? 9) - (b.tier ?? 9))
      .slice(0, 3);

  /* ---- resistances vs the damage that actually hit you ---- */

  const taken = build.damage?.taken;
  // Only advise on resistances when most of the damage could actually be
  // attributed to a weapon or an ability. Advising off a mostly-unclassified
  // sample would be guessing with extra steps.
  const coverage = taken && taken.total > 0 ? taken.classified / taken.total : 0;
  if (taken && taken.total > 0 && coverage >= 0.6) {
    const abilityShare = taken.abilityShare ?? 0;
    const weaponShare = taken.weaponShare ?? 0;

    if (abilityShare >= 0.55) {
      const held = firstOfRole('spiritResist');
      const deathsBefore = held
        ? build.deathContext.filter((d) => d.t < held.t).length
        : build.deathContext.length;
      add(
        held ? 'medium' : 'high',
        held
          ? `Spirit resist came at ${formatClock(held.t)}, after ${deathsBefore} of your ${build.deathContext.length} deaths`
          : 'You never bought spirit resistance',
        `${Math.round(abilityShare * 100)}% of the damage you took was ability damage. Spirit resist is the item slot that directly reduces it, and it is cheap relative to what it saves.`,
        [
          `Ability damage taken: ${Math.round(taken.ability).toLocaleString()} of ${Math.round(taken.total).toLocaleString()}`,
          held ? `You bought ${held.name} at ${formatClock(held.t)}` : 'No spirit resist item found in your build'
        ],
        suggestRole('spiritResist')
      );
    }

    if (weaponShare >= 0.55) {
      const held = firstOfRole('bulletResist');
      const deathsBefore = held
        ? build.deathContext.filter((d) => d.t < held.t).length
        : build.deathContext.length;
      add(
        held ? 'medium' : 'high',
        held
          ? `Bullet resist came at ${formatClock(held.t)}, after ${deathsBefore} of your ${build.deathContext.length} deaths`
          : 'You never bought bullet resistance',
        `${Math.round(weaponShare * 100)}% of the damage you took was weapon fire. Bullet resist is the direct counter and scales with how much you are being shot.`,
        [
          `Weapon damage taken: ${Math.round(taken.weapon).toLocaleString()} of ${Math.round(taken.total).toLocaleString()}`,
          held ? `You bought ${held.name} at ${formatClock(held.t)}` : 'No bullet resist item found in your build'
        ],
        suggestRole('bulletResist')
      );
    }
  }

  /* ---- one enemy doing most of the killing ---- */

  const topThreat = build.threats[0];
  if (topThreat && topThreat.share !== null && topThreat.share >= 0.32) {
    add(
      'medium',
      `${topThreat.name} alone dealt ${Math.round(topThreat.share * 100)}% of the damage you took`,
      `When a single enemy is this much of your damage intake, the build should answer them specifically${topThreat.hero ? ` — they were on ${topThreat.hero}` : ''}. Match the resist to their damage type and consider an escape or cleanse for their opening move.`,
      [
        `${topThreat.name}: ${Math.round(topThreat.dmg).toLocaleString()} damage to you`,
        ...build.threats.slice(1, 3).map((t) => `${t.name}: ${Math.round(t.dmg).toLocaleString()}`)
      ],
      suggestRole('escape')
    );
  }

  /* ---- enemy healing ---- */

  if (build.enemyHealing >= 8000 && !hasRole('antiHeal')) {
    add(
      'medium',
      `The enemy team healed ${Math.round(build.enemyHealing).toLocaleString()} and nobody built anti-heal`,
      'Healing at that volume undoes a whole fight\'s worth of damage. One anti-heal item on the person who lands the most damage flips those fights.',
      [`Enemy hero healing total: ${Math.round(build.enemyHealing).toLocaleString()}`],
      suggestRole('antiHeal')
    );
  }

  /* ---- sitting on souls ---- */

  const banking = build.spend.worstBanking;
  if (banking && banking.to - banking.from >= 120) {
    const deathsDuring = build.deathContext.filter((d) => d.t >= banking.from && d.t <= banking.to).length;
    add(
      deathsDuring > 0 ? 'high' : 'medium',
      `You sat on roughly ${Math.round(banking.peak).toLocaleString()} unspent souls for ${Math.round((banking.to - banking.from) / 60)} minutes`,
      'Unspent souls do nothing and are partly lost on death. Buying the moment you can afford the next component is almost always stronger than saving for the big item.',
      [
        `From ${formatClock(banking.from)} to ${formatClock(banking.to)}`,
        deathsDuring > 0 ? `You died ${deathsDuring} time${deathsDuring === 1 ? '' : 's'} during that stretch` : 'No deaths during that stretch',
        build.spend.method === 'measured'
          ? 'Unspent souls read directly from the replay'
          : build.spend.costsEstimated
            ? 'Derived from net worth minus purchase costs, some inferred from item tier, so treat the figure as approximate'
            : 'Derived from net worth minus what your purchases cost'
      ].filter(Boolean),
      []
    );
  }

  /* ---- category balance ---- */

  const totalItems = build.purchases.length;
  const vit = build.categories.vitality;

  // Zero vitality is worth saying as soon as there is a build to speak of and
  // the player has actually been dying; the ratio check needs a fuller build.
  if (totalItems >= 4 && vit === 0 && build.deathContext.length >= 2) {
    add(
      'high',
      'Your build had no vitality items at all',
      'With nothing in the vitality slot you die to any focused attention regardless of how much damage you deal. One vitality item usually buys more value than a third damage item.',
      [
        `${totalItems} items bought: ${build.categories.weapon} weapon, ${build.categories.spirit} spirit, ${vit} vitality`,
        `You died ${build.deathContext.length} time${build.deathContext.length === 1 ? '' : 's'}`
      ],
      []
    );
  } else if (totalItems >= 6) {
    if (vit / totalItems < 0.2 && build.deathContext.length >= 6) {
      add(
        'medium',
        `Only ${vit} of your ${totalItems} items were vitality, and you died ${build.deathContext.length} times`,
        'The death count says survivability was the constraint, not damage. Shifting one or two purchases into vitality usually raises damage output too, because you live long enough to use it.',
        [`Souls by category — weapon ${Math.round(build.categorySouls.weapon).toLocaleString()}, spirit ${Math.round(build.categorySouls.spirit).toLocaleString()}, vitality ${Math.round(build.categorySouls.vitality).toLocaleString()}`],
        []
      );
    }
  }

  /* ---- benchmark-driven ---- */

  if (build.benchmark.available) {
    const scopeNote =
      build.benchmark.scope && build.benchmark.scope.startsWith('hero:')
        ? `on ${build.hero || 'your hero'}`
        : 'across all heroes';

    if (build.benchmark.missed.length > 0) {
      add(
        'medium',
        `${build.benchmark.missed.length} popular, high-win-rate items never appeared in your build`,
        `These are commonly bought ${scopeNote} and win more often than the average item there. That does not make them mandatory, but skipping all of them is worth a second look.`,
        build.benchmark.missed
          .slice(0, 5)
          .map(
            (m) =>
              `${m.name} — ${pct(m.winRate)}% win (${m.vsBaseline > 0 ? '+' : ''}${(m.vsBaseline * 100).toFixed(1)} vs baseline), popularity ${pct(m.popularity)}% of the most-bought item${Number.isFinite(m.avgBoughtAt) ? `, usually by ${formatClock(m.avgBoughtAt)}` : ''}`
          ),
        build.benchmark.missed.slice(0, 3).map((m) => ({ id: m.id, name: m.name, winRate: m.winRate, cost: null, tier: null }))
      );
    }

    if (build.benchmark.late.length > 0) {
      const worst = build.benchmark.late[0];
      add(
        'medium',
        `${build.benchmark.late.length} item${build.benchmark.late.length === 1 ? ' was' : 's were'} bought well after the usual timing`,
        `Timing is most of an item's value: a resist bought after the fights it was meant to survive is a wasted purchase. The comparison is against average purchase times ${scopeNote}.`,
        build.benchmark.late
          .slice(0, 5)
          .map((l) => `${l.name} — you at ${formatClock(l.yours)}, average ${formatClock(l.median)} (${Math.round(l.delta / 60)} min late)`),
        []
      );
      void worst;
    }

    if (build.benchmark.lowValue.length > 0) {
      add(
        'good',
        `${build.benchmark.lowValue.length} of your purchases underperform in real matches`,
        `These win less often than the average item ${scopeNote}. Win rate is not causation — a losing game buys different items — but a consistent pattern across replays is worth acting on.`,
        build.benchmark.lowValue.map(
          (l) => `${l.name} — ${pct(l.winRate)}% win (${(l.vsBaseline * 100).toFixed(1)} vs baseline) over ${l.matches.toLocaleString()} matches`
        ),
        []
      );
    }
  }

  const order = { high: 0, medium: 1, good: 2 };
  suggestions.sort((a, b) => (order[a.priority] ?? 3) - (order[b.priority] ?? 3));
  return suggestions;
}

export { damageProfileFor, valueAt, pct };
