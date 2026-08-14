/*
 * names.js — resolves numeric hero and item ids into readable names.
 *
 * The replay only carries ids. The community asset service publishes the
 * mapping, so we fetch it once and cache it. If the fetch fails (offline, API
 * moved, whatever) everything still works — items just show as "Item #1234"
 * and the app says so in Diagnostics rather than pretending.
 */

const CACHE_KEY = 'deadlock-analyzer-assets-v1';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/*
 * The asset service is reachable under two hostnames and the API's own docs
 * point at the api.deadlock-api.com one, so that is tried first. Each is tried
 * in turn until one returns a usable array — whichever wins is recorded in
 * Diagnostics so there is no guessing about where a name came from.
 */
const ITEM_ENDPOINTS = [
  'https://api.deadlock-api.com/v1/assets/items',
  'https://assets.deadlock-api.com/v2/items?language=english',
  'https://assets.deadlock-api.com/v2/items',
  'https://assets.deadlock-api.com/v1/items'
];

const HERO_ENDPOINTS = [
  'https://api.deadlock-api.com/v1/assets/heroes',
  'https://assets.deadlock-api.com/v2/heroes?language=english',
  'https://assets.deadlock-api.com/v2/heroes',
  'https://assets.deadlock-api.com/v1/heroes'
];

const STATS_BASE = 'https://api.deadlock-api.com/v1/analytics/item-stats';
const STATS_CACHE_PREFIX = 'deadlock-analyzer-itemstats-v1:';
const STATS_TTL_MS = 24 * 60 * 60 * 1000;

/* Tier prices, used only when the asset service does not publish a cost.
 * Verified against the live item list: every tier has exactly one price. */
const TIER_COST = { 1: 800, 2: 1600, 3: 3200, 4: 6400 };

function readCache() {
  try {
    const blob = window.localStorage.getItem(CACHE_KEY);
    if (!blob) return null;
    const parsed = JSON.parse(blob);
    if (!parsed.savedAt || Date.now() - parsed.savedAt > CACHE_TTL_MS) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function writeCache(payload) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ ...payload, savedAt: Date.now() }));
  } catch (_) {
    /* storage disabled or full — not worth failing over */
  }
}

async function fetchFirst(endpoints, attempts) {
  for (const url of endpoints) {
    try {
      const response = await fetch(url, { mode: 'cors' });
      if (!response.ok) {
        attempts.push(`${url} -> HTTP ${response.status}`);
        continue;
      }
      const data = await response.json();
      const list = Array.isArray(data) ? data : (data.items || data.heroes || data.data || data.results || null);
      if (Array.isArray(list) && list.length > 0) {
        attempts.push(`${url} -> ${list.length} entries`);
        return { list, url };
      }
      attempts.push(`${url} -> 200 but no usable array (keys: ${Object.keys(data || {}).slice(0, 6).join(', ')})`);
    } catch (err) {
      attempts.push(`${url} -> ${err && err.message ? err.message : 'request failed'}`);
    }
  }
  return null;
}

/**
 * Ids arrive as numbers from some services and numeric strings from others.
 * Everything downstream keys on numbers, so coerce once, here.
 */
function toId(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function prettifyClassName(value) {
  if (typeof value !== 'string') return null;
  return value
    .replace(/^(upgrade_|ability_|hero_|citadel_)/i, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function normalise(list) {
  const byId = new Map();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const id = toId(entry.id ?? entry.item_id ?? entry.hero_id ?? entry.ability_id ?? entry.upgrade_id);
    if (id === null) continue;

    // Some entries carry a raw class name in the name field ("citadel_weapon_
    // bosstier2_set"). Those are internal, not display names, so tidy them up
    // rather than showing engine identifiers in the report.
    const rawName = typeof entry.name === 'string' && entry.name ? entry.name : null;
    const looksInternal = rawName !== null && /^(citadel|upgrade|hero|ability)_/i.test(rawName);
    const name = (looksInternal ? null : rawName) ||
      prettifyClassName(entry.class_name || entry.className || rawName) ||
      null;

    const cost = entry.cost ?? entry.item_cost ?? entry.properties?.cost ?? null;
    const tier = entry.item_tier ?? entry.tier ?? null;

    byId.set(id, {
      id,
      name,
      // Cost is not always published per item, but tier maps to a fixed price,
      // so fall back to that rather than losing the spend curve entirely.
      cost: Number.isFinite(cost) && cost > 0 ? cost : TIER_COST[tier] ?? null,
      costIsEstimated: !(Number.isFinite(cost) && cost > 0) && TIER_COST[tier] !== undefined,
      tier,
      slot: entry.item_slot_type ?? entry.slot ?? null,
      kind: entry.type ?? entry.item_type ?? null,
      className: entry.class_name ?? entry.className ?? null
    });
  }
  return byId;
}

export class NameResolver {
  constructor() {
    this.items = new Map();
    this.heroes = new Map();
    this.itemStats = new Map(); // scope -> {stats, scope, sampleMatches}
    this.status = { items: 'not loaded', heroes: 'not loaded', itemStats: 'not loaded', source: null };
  }

  /**
   * @param {Object} options
   * @param {boolean} options.force  ignore the cache and refetch
   */
  async load(options = {}) {
    const cached = options.force ? null : readCache();
    if (cached && cached.items && cached.heroes) {
      this.items = new Map(cached.items.map((i) => [i.id, i]));
      this.heroes = new Map(cached.heroes.map((h) => [h.id, h]));
      this.status = {
        ...this.status,
        items: `cached (${this.items.size})`,
        heroes: `cached (${this.heroes.size})`,
        source: 'localStorage — use "Reload item data" in Diagnostics to refetch'
      };
      return this;
    }

    const itemAttempts = [];
    const heroAttempts = [];
    const [itemsResult, heroesResult] = await Promise.all([
      fetchFirst(ITEM_ENDPOINTS, itemAttempts),
      fetchFirst(HERO_ENDPOINTS, heroAttempts)
    ]);
    this.status.itemAttempts = itemAttempts;
    this.status.heroAttempts = heroAttempts;

    if (itemsResult) {
      this.items = normalise(itemsResult.list);
      this.status.items = `loaded ${this.items.size} of ${itemsResult.list.length} entries`;
      this.status.source = itemsResult.url;
      // Keep one raw entry so Diagnostics can show the shape we actually got.
      this.status.itemSample = JSON.stringify(itemsResult.list[0] || {}).slice(0, 600);
      if (this.items.size === 0) {
        this.status.items = `fetched ${itemsResult.list.length} entries but none had a usable id — see the sample below`;
      }
    } else {
      this.status.items = 'unavailable — items will show as numeric ids';
    }

    if (heroesResult) {
      this.heroes = normalise(heroesResult.list);
      this.status.heroes = `loaded ${this.heroes.size} of ${heroesResult.list.length} entries`;
    } else {
      this.status.heroes = 'unavailable — heroes will show as numeric ids';
    }

    if (this.items.size || this.heroes.size) {
      writeCache({
        items: Array.from(this.items.values()),
        heroes: Array.from(this.heroes.values())
      });
    }

    return this;
  }

  itemName(abilityId) {
    const hit = this.items.get(abilityId);
    if (!hit) return null;
    return { name: hit.name || `Item #${abilityId}`, cost: hit.cost, tier: hit.tier, slot: hit.slot };
  }

  heroName(heroId) {
    if (heroId === null || heroId === undefined) return null;
    const hit = this.heroes.get(heroId);
    return hit ? hit.name : null;
  }

  itemMeta(abilityId) {
    return this.items.get(abilityId) || null;
  }

  /** Whatever item stats are already in memory for this hero, without fetching. */
  cachedItemStats(heroId) {
    const scope = Number.isFinite(heroId) ? `hero:${heroId}` : 'all-heroes';
    return this.itemStats.get(scope) ?? null;
  }

  /**
   * Per-item win rate, pick rate and average purchase time, from real matches.
   *
   * With a hero id this is scoped to that hero, which is what makes the
   * benchmark meaningful — Bullet Armor is not equally good on every character.
   * Without one it falls back to an all-hero baseline, and the UI says so.
   *
   * @returns {Promise<{stats: Map, scope: string, sampleMatches: number}|null>}
   */
  async loadItemStats(heroId, options = {}) {
    const { minMatches = 20 } = options;
    const scope = Number.isFinite(heroId) ? `hero:${heroId}` : 'all-heroes';
    const cacheKey = `${STATS_CACHE_PREFIX}${scope}`;

    if (this.itemStats.has(scope)) return this.itemStats.get(scope);

    try {
      const blob = window.localStorage.getItem(cacheKey);
      if (blob) {
        const parsed = JSON.parse(blob);
        if (parsed.savedAt && Date.now() - parsed.savedAt < STATS_TTL_MS) {
          const restored = {
            stats: new Map(parsed.rows.map((r) => [r.id, r])),
            scope,
            sampleMatches: parsed.sampleMatches,
            baselineWinRate: parsed.baselineWinRate ?? null,
            cached: true
          };
          this.itemStats.set(scope, restored);
          this.status.itemStats = `cached (${restored.stats.size} items, ${scope})`;
          return restored;
        }
      }
    } catch (_) {
      /* cache is optional */
    }

    const params = new URLSearchParams({ min_matches: String(minMatches) });
    if (Number.isFinite(heroId)) {
      params.set('bucket', 'hero');
      params.set('hero_ids', String(heroId));
    } else {
      params.set('bucket', 'no_bucket');
    }

    let list = null;
    try {
      const response = await fetch(`${STATS_BASE}?${params.toString()}`, { mode: 'cors' });
      if (response.ok) {
        const data = await response.json();
        list = Array.isArray(data) ? data : data?.data ?? null;
      }
    } catch (_) {
      list = null;
    }

    if (!Array.isArray(list) || list.length === 0) {
      this.status.itemStats = 'unavailable — build benchmarking is off';
      this.itemStats.set(scope, null);
      return null;
    }

    /*
     * The service returns raw counts, not rates: wins/losses/matches/players
     * plus average buy and sell times. Win rate is wins over matches. There is
     * no absolute pick rate available, so popularity is expressed relative to
     * the most-bought item in the same scope — enough to rank and threshold on,
     * and labelled as such everywhere it is shown.
     */
    const rows = [];
    let sampleMatches = 0;
    for (const row of list) {
      const id = toId(row.item_id ?? row.itemId);
      if (id === null) continue;
      // When bucketed by hero the response carries the hero id in `bucket`.
      if (Number.isFinite(heroId) && row.bucket !== undefined && row.bucket !== null) {
        if (Number(row.bucket) !== Number(heroId)) continue;
      }
      const matches = row.matches ?? 0;
      const wins = row.wins ?? 0;
      sampleMatches = Math.max(sampleMatches, matches);
      rows.push({
        id,
        matches,
        wins,
        players: row.players ?? null,
        winRate: matches > 0 ? wins / matches : null,
        avgBoughtAt: row.avg_buy_time_s ?? null,
        avgSoldAt: row.avg_sell_time_s ?? null
      });
    }

    const maxMatches = rows.reduce((m, r) => Math.max(m, r.matches), 0);
    let weightedWins = 0;
    let weightedMatches = 0;
    for (const row of rows) {
      row.popularity = maxMatches > 0 ? row.matches / maxMatches : null;
      weightedWins += row.wins;
      weightedMatches += row.matches;
    }
    // The baseline every item is judged against, weighted by how often each is
    // actually bought rather than treating a fringe item as equal to a staple.
    const baselineWinRate = weightedMatches > 0 ? weightedWins / weightedMatches : null;
    for (const row of rows) {
      row.winRateVsBaseline = row.winRate !== null && baselineWinRate !== null ? row.winRate - baselineWinRate : null;
    }

    if (rows.length === 0) {
      this.status.itemStats = 'no rows for this hero — build benchmarking is off';
      this.itemStats.set(scope, null);
      return null;
    }

    const result = {
      stats: new Map(rows.map((r) => [r.id, r])),
      scope,
      sampleMatches,
      baselineWinRate,
      cached: false
    };
    this.itemStats.set(scope, result);
    this.status.itemStats = `loaded (${rows.length} items, ${scope}, baseline win rate ${
      baselineWinRate === null ? 'n/a' : `${(baselineWinRate * 100).toFixed(1)}%`
    })`;

    try {
      window.localStorage.setItem(
        cacheKey,
        JSON.stringify({ savedAt: Date.now(), rows, sampleMatches, baselineWinRate })
      );
    } catch (_) {
      /* ignore */
    }

    return result;
  }
}
