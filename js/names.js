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

const ITEM_ENDPOINTS = [
  'https://assets.deadlock-api.com/v2/items?language=english',
  'https://assets.deadlock-api.com/v2/items',
  'https://assets.deadlock-api.com/v1/items'
];

const HERO_ENDPOINTS = [
  'https://assets.deadlock-api.com/v2/heroes?language=english',
  'https://assets.deadlock-api.com/v2/heroes',
  'https://assets.deadlock-api.com/v1/heroes'
];

const STATS_BASE = 'https://api.deadlock-api.com/v1/analytics/item-stats';
const STATS_CACHE_PREFIX = 'deadlock-analyzer-itemstats-v1:';
const STATS_TTL_MS = 24 * 60 * 60 * 1000;

/* Tier prices, used only when the asset service does not publish a cost. */
const TIER_COST = { 1: 500, 2: 1250, 3: 3000, 4: 6200 };

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

async function fetchFirst(endpoints) {
  for (const url of endpoints) {
    try {
      const response = await fetch(url, { mode: 'cors' });
      if (!response.ok) continue;
      const data = await response.json();
      const list = Array.isArray(data) ? data : (data.items || data.heroes || data.data || null);
      if (Array.isArray(list) && list.length > 0) return { list, url };
    } catch (_) {
      /* try the next one */
    }
  }
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
    const id = entry.id ?? entry.item_id ?? entry.hero_id ?? entry.ability_id;
    if (!Number.isFinite(id)) continue;

    const name =
      (typeof entry.name === 'string' && entry.name) ||
      prettifyClassName(entry.class_name || entry.className) ||
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

  async load() {
    const cached = readCache();
    if (cached && cached.items && cached.heroes) {
      this.items = new Map(cached.items.map((i) => [i.id, i]));
      this.heroes = new Map(cached.heroes.map((h) => [h.id, h]));
      this.status = { items: `cached (${this.items.size})`, heroes: `cached (${this.heroes.size})`, source: 'localStorage' };
      return this;
    }

    const [itemsResult, heroesResult] = await Promise.all([
      fetchFirst(ITEM_ENDPOINTS),
      fetchFirst(HERO_ENDPOINTS)
    ]);

    if (itemsResult) {
      this.items = normalise(itemsResult.list);
      this.status.items = `loaded (${this.items.size})`;
      this.status.source = itemsResult.url;
    } else {
      this.status.items = 'unavailable — items will show as numeric ids';
    }

    if (heroesResult) {
      this.heroes = normalise(heroesResult.list);
      this.status.heroes = `loaded (${this.heroes.size})`;
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

    const rows = [];
    let sampleMatches = 0;
    for (const row of list) {
      const id = row.item_id ?? row.itemId;
      if (!Number.isFinite(id)) continue;
      // When bucketed by hero the response can carry other heroes too.
      if (Number.isFinite(heroId) && row.bucket_value !== undefined && row.bucket_value !== null) {
        if (Number(row.bucket_value) !== Number(heroId)) continue;
      }
      const matches = row.matches ?? 0;
      sampleMatches = Math.max(sampleMatches, matches);
      rows.push({
        id,
        matches,
        winRate: row.win_rate ?? null,
        pickRate: row.pick_rate ?? null,
        avgBoughtAt: row.avg_bought_at_s ?? null,
        avgNetWorth: row.avg_networth ?? null
      });
    }

    if (rows.length === 0) {
      this.status.itemStats = 'no rows for this hero — build benchmarking is off';
      this.itemStats.set(scope, null);
      return null;
    }

    const result = { stats: new Map(rows.map((r) => [r.id, r])), scope, sampleMatches, cached: false };
    this.itemStats.set(scope, result);
    this.status.itemStats = `loaded (${rows.length} items, ${scope})`;

    try {
      window.localStorage.setItem(cacheKey, JSON.stringify({ savedAt: Date.now(), rows, sampleMatches }));
    } catch (_) {
      /* ignore */
    }

    return result;
  }
}
