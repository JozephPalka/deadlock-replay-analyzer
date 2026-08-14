/*
 * parse.js — turns a Deadlock .dem file into a structured RawMatch object.
 *
 * Built on `deadem` (https://github.com/Igor-Losev/deadem), loaded as a UMD
 * bundle from jsDelivr, so nothing needs installing.
 *
 * Everything here is defensive on purpose: Valve renames schema fields between
 * game builds, so instead of hardcoding field names we probe a list of
 * candidates and auto-detect what we can. Whatever we could not resolve is
 * reported in `raw.diagnostics` and shown in the Diagnostics tab.
 */

export const TEAM_AMBER = 2;
export const TEAM_SAPPHIRE = 3;
export const TEAM_NEUTRAL = 4;

const MAX_COORD = 16384;

// Controller fields confirmed against deadem's own UI helper.
const CTRL_FIELDS = {
  name: ['m_iszPlayerName'],
  team: ['m_iTeamNum'],
  netWorth: ['m_iGoldNetWorth', 'm_iNetWorth', 'm_nGoldNetWorth'],
  kills: ['m_iPlayerKills', 'm_iKills'],
  deaths: ['m_iDeaths'],
  assists: ['m_iPlayerAssists', 'm_iAssists'],
  heroDamage: ['m_iHeroDamage'],
  heroHealing: ['m_iHeroHealing'],
  objectiveDamage: ['m_iObjectiveDamage'],
  lastHits: ['m_iLastHits', 'm_iLastHitCount'],
  denies: ['m_iDenies', 'm_iDenyCount'],
  level: ['m_nLevel', 'm_iLevel'],
  unspent: ['m_iGold', 'm_iCurrentGold', 'm_iGoldCurrent']
};

const PAWN_HEALTH = ['m_iHealth', 'm_flHealth'];
const PAWN_MAX_HEALTH = ['m_iMaxHealth', 'm_flMaxHealth'];
const PAWN_LIFE_STATE = ['m_lifeState', 'm_nLifeState'];

/* ------------------------------------------------------------------ */
/* small safe accessors                                                */
/* ------------------------------------------------------------------ */

function field(entity, name) {
  if (!entity) return undefined;
  try {
    if (typeof entity.hasField === 'function' && !entity.hasField(name)) return undefined;
    const v = entity.getField(name);
    return v === null ? undefined : v;
  } catch (_) {
    return undefined;
  }
}

function firstField(entity, names) {
  for (const n of names) {
    const v = field(entity, n);
    if (v !== undefined) return v;
  }
  return undefined;
}

function className(entity) {
  try {
    return entity && entity.class ? entity.class.name : null;
  } catch (_) {
    return null;
  }
}

function entitiesOf(demo, name) {
  try {
    if (typeof demo.getEntitiesByClassNameIterator === 'function') {
      return Array.from(demo.getEntitiesByClassNameIterator(name));
    }
    return demo.getEntitiesByClassName(name) || [];
  } catch (_) {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* world position                                                      */
/* ------------------------------------------------------------------ */

/**
 * Source 2 splits positions into a coarse "cell" plus an offset inside it.
 * cellBits is 9 on every Source 2 title shipped so far (512-unit cells), but
 * it is configurable here in case that ever changes.
 */
export function pawnPosition(entity, cellBits = 9) {
  const cellSize = 1 << cellBits;

  const cx = field(entity, 'CBodyComponent.m_cellX');
  const cy = field(entity, 'CBodyComponent.m_cellY');
  const cz = field(entity, 'CBodyComponent.m_cellZ');
  const vx = field(entity, 'CBodyComponent.m_vecX');
  const vy = field(entity, 'CBodyComponent.m_vecY');
  const vz = field(entity, 'CBodyComponent.m_vecZ');

  if (cx !== undefined && vx !== undefined) {
    return {
      x: cx * cellSize - MAX_COORD + vx,
      y: cy * cellSize - MAX_COORD + vy,
      z: cz * cellSize - MAX_COORD + vz
    };
  }

  // Fallbacks for builds that replicate a plain origin vector.
  const origin =
    field(entity, 'CBodyComponent.m_vecOrigin') ||
    field(entity, 'm_vecOrigin') ||
    field(entity, 'CBodyComponent.m_vecAbsOrigin');

  if (origin && typeof origin === 'object') {
    const x = origin.x ?? origin[0];
    const y = origin.y ?? origin[1];
    const z = origin.z ?? origin[2];
    if (typeof x === 'number') return { x, y, z: z ?? 0 };
  }

  return null;
}

function vecOf(msgVector) {
  if (!msgVector || typeof msgVector !== 'object') return null;
  const x = msgVector.x ?? msgVector[0];
  const y = msgVector.y ?? msgVector[1];
  const z = msgVector.z ?? msgVector[2];
  if (typeof x !== 'number') return null;
  return { x, y, z: z ?? 0 };
}

/* ------------------------------------------------------------------ */
/* game clock                                                          */
/* ------------------------------------------------------------------ */

/**
 * Reimplementation of deadem's example DeadlockGameObserver (that class lives
 * in an internal examples package and is not published).
 */
class GameClock {
  constructor(parser, InterceptorStage, MessagePacketType) {
    this._parser = parser;
    this._MessagePacketType = MessagePacketType;
    this._rulesIndex = null;
    this._lastPacket = null;
    this._gameTick = null;

    this.clockGame = 0;
    this.clockTotal = 0;
    this.paused = false;
    this.tick = null;
    this._computedForTick = null;

    parser.registerPreInterceptor(InterceptorStage.DEMO_PACKET, (packet) => {
      this._lastPacket = packet;
      const t = this._extractGameTick(packet);
      if (t !== null) this._gameTick = t;
    });

    parser.registerPostInterceptor(InterceptorStage.DEMO_PACKET, (packet) => {
      this._lastPacket = packet;
      if (this._rulesIndex === null) {
        const found = entitiesOf(parser.getDemo(), 'CCitadelGameRulesProxy');
        if (found.length > 0) this._rulesIndex = found[0].index;
      }
    });
  }

  _extractGameTick(packet) {
    const messages = packet?.data?.messagePackets;
    if (!Array.isArray(messages)) return null;
    const entities = messages.findLast
      ? messages.findLast((m) => m.type === this._MessagePacketType.SVC_PACKET_ENTITIES)
      : null;
    if (!entities) return null;
    return entities.data?.serverTick ?? null;
  }

  update() {
    if (this._lastPacket === null) return;

    // The clock only moves between demo packets, but damage messages arrive in
    // their thousands. Recomputing per message would dominate the parse time.
    if (this._computedForTick === this._lastPacket.tick) return;
    this._computedForTick = this._lastPacket.tick;

    const demoTick = this._lastPacket.tick;
    const gameTick = this._gameTick ?? demoTick;
    this.tick = gameTick;

    const demo = this._parser.getDemo();
    if (!demo || !demo.server) return;

    const interval = demo.server.tickInterval || 1 / 60;
    this.clockTotal = Math.max(demoTick * interval, 0);

    if (this._rulesIndex === null) return;
    const rules = demo.getEntity(this._rulesIndex);
    if (!rules) return;

    this.paused = field(rules, 'm_pGameRules.m_bGamePaused') || false;
    const at = field(rules, 'm_pGameRules.m_flMatchClockAtLastUpdate');
    const atTick = field(rules, 'm_pGameRules.m_nMatchClockUpdateTick');
    if (at === undefined || atTick === undefined) return;

    if (this.paused) {
      this.clockGame = Math.max(at, 0);
    } else {
      const delta = Math.max(gameTick - atTick, 0);
      this.clockGame = Math.max(at + delta * interval, 0);
    }
  }
}

/* ------------------------------------------------------------------ */
/* main entry point                                                    */
/* ------------------------------------------------------------------ */

/**
 * @param {File|Blob} file            the .dem
 * @param {Object}    options
 * @param {Function}  options.onProgress  called with (fraction, label)
 * @param {number}    options.sampleIntervalSec  how often to snapshot state
 * @param {number}    options.cellBits
 * @returns {Promise<Object>} RawMatch
 */
export async function parseReplay(file, options = {}) {
  const {
    onProgress = () => {},
    sampleIntervalSec = 1.0,
    cellBits = 9
  } = options;

  const lib = window.deadem;
  if (!lib) throw new Error('The deadem parser library did not load. Check your internet connection and reload.');

  const { Parser, ParserConfiguration, InterceptorStage, MessagePacketType, StringTableType, Logger } = lib;

  const wantedMessageNames = [
    'SVC_PACKET_ENTITIES',
    'CITADEL_USER_MESSAGE_HERO_KILLED',
    'CITADEL_USER_MESSAGE_DAMAGE',
    'CITADEL_USER_MESSAGE_ITEM_PURCHASE_NOTIFICATION',
    'CITADEL_USER_MESSAGE_CURRENCY_CHANGED',
    'CITADEL_USER_MESSAGE_BOSS_KILLED',
    'CITADEL_USER_MESSAGE_MID_BOSS_SPAWNED',
    'CITADEL_USER_MESSAGE_PLAYER_RESPAWNED',
    'CITADEL_USER_MESSAGE_CHAT_MESSAGE',
    'CITADEL_USER_MESSAGE_GAME_OVER',
    'CITADEL_USER_MESSAGE_OBJECTIVE_MASK'
  ];

  const messagePacketTypes = [];
  const missingMessageTypes = [];
  for (const name of wantedMessageNames) {
    const type = MessagePacketType[name];
    if (type) messagePacketTypes.push(type);
    else missingMessageTypes.push(name);
  }

  const M = (name) => MessagePacketType[name];

  const configuration = new ParserConfiguration({
    messagePacketTypes,
    entityClasses: ['CCitadelGameRulesProxy', 'CCitadelPlayerController', 'CCitadelPlayerPawn'],
    breakInterval: 100
  });

  const parser = new Parser(configuration, Logger ? Logger.CONSOLE_WARN : undefined);
  const clock = new GameClock(parser, InterceptorStage, MessagePacketType);

  /* ---------------- collected state ---------------- */

  const raw = {
    fileName: file.name || 'replay.dem',
    fileSize: file.size || 0,
    parsedAt: new Date().toISOString(),
    parserVersion: (lib.version || 'deadem UMD'),
    duration: 0,
    winningTeam: null,
    players: [],            // {ctrl, name, team, heroId, slot, final:{...}}
    samples: [],            // {t, players:[{ctrl,x,y,z,hp,alive,nw,k,d,a,hd}]}
    kills: [],              // {t, tick, victim, killer, assisters[], victimPos, killerPos}
    damage: [],             // {a, v, t, dmg, hits}  (2s buckets, hero->hero only)
    damageTotals: {},       // "a>v" -> total
    damageByType: [],       // {ctrl, dir:'taken'|'dealt', type, dmg, hits, abilityHits}
    items: [],              // {t, ctrl, abilityId, sell, quickbuy}
    objectives: [],         // {t, kind, team, pos, killerCtrl, classIndex}
    respawns: [],           // {t, ctrl}
    chat: [],
    userInfo: [],
    diagnostics: {
      missingMessageTypes,
      messageCounts: {},
      errors: [],
      unresolvedItemUserIds: 0,
      heroFieldGuess: null,
      slotFieldGuess: null,
      controllerFieldSample: null,
      pawnFieldSample: null,
      cellBits
    }
  };

  const countMessage = (label) => {
    raw.diagnostics.messageCounts[label] = (raw.diagnostics.messageCounts[label] || 0) + 1;
  };

  const noteError = (where, err) => {
    if (raw.diagnostics.errors.length < 40) {
      raw.diagnostics.errors.push(`${where}: ${err && err.message ? err.message : String(err)}`);
    }
  };

  // controller entity index -> player record
  const playersByCtrl = new Map();
  const damageBuckets = new Map(); // "a|v|bucket" -> {dmg, hits}

  /*
   * Damage is aggregated per (player, direction, damage type, ability id).
   *
   * Keeping the ability id is the whole point: in Deadlock a hero's gun is
   * itself an ability, so "did this carry an ability id" tells you nothing —
   * everything does. The ability id, though, can be looked up in the asset
   * list, where weapons and abilities are distinct types. That lookup happens
   * in build.js, which is where the item metadata lives; the parser just
   * records the facts.
   */
  const typeTotals = new Map(); // "ctrl|dir|type|ability" -> {dmg, hits}

  const addTypeTotal = (ctrl, dir, type, abilityId, dmg, hits) => {
    const key = `${ctrl}|${dir}|${type}|${abilityId}`;
    let entry = typeTotals.get(key);
    if (!entry) {
      entry = { ctrl, dir, type, abilityId, dmg: 0, hits: 0 };
      typeTotals.set(key, entry);
    }
    entry.dmg += dmg;
    entry.hits += hits;
  };

  // A short rolling window of incoming damage per player, so that when someone
  // dies we can say what actually killed them rather than just who got credit.
  const PRE_DEATH_WINDOW = 8;
  const recentDamage = new Map(); // victim ctrl -> [{t, a, dmg, type, ability}]

  const rememberDamage = (victim, event) => {
    let list = recentDamage.get(victim);
    if (!list) {
      list = [];
      recentDamage.set(victim, list);
    }
    list.push(event);
    // Prune anything outside the window; the list stays tiny.
    const cutoff = event.t - PRE_DEATH_WINDOW;
    while (list.length > 0 && list[0].t < cutoff) list.shift();
  };

  const preDeathBreakdown = (victim, at) => {
    const list = recentDamage.get(victim) || [];
    const totals = new Map();
    for (const event of list) {
      if (event.t < at - PRE_DEATH_WINDOW) continue;
      const key = `${event.a}|${event.type}|${event.abilityId}`;
      let entry = totals.get(key);
      if (!entry) {
        entry = { attacker: event.a, type: event.type, abilityId: event.abilityId, dmg: 0, hits: 0 };
        totals.set(key, entry);
      }
      entry.dmg += event.dmg;
      entry.hits += 1;
    }
    return Array.from(totals.values()).sort((x, y) => y.dmg - x.dmg);
  };

  const registerPlayer = (ctrlEntity) => {
    if (!ctrlEntity) return null;
    const idx = ctrlEntity.index;
    let rec = playersByCtrl.get(idx);
    if (!rec) {
      rec = { ctrl: idx, name: null, team: null, heroId: null, slot: null, final: {} };
      playersByCtrl.set(idx, rec);
    }
    const name = firstField(ctrlEntity, CTRL_FIELDS.name);
    const team = firstField(ctrlEntity, CTRL_FIELDS.team);
    if (name !== undefined && name !== '') rec.name = name;
    if (team !== undefined) rec.team = team;
    return rec;
  };

  const controllerOf = (demo, entityIndex) => {
    if (entityIndex === undefined || entityIndex === null || entityIndex < 0) return null;
    let entity;
    try {
      entity = demo.getEntity(entityIndex);
    } catch (_) {
      return null;
    }
    if (!entity) return null;

    const cls = className(entity);
    if (cls === 'CCitadelPlayerController') return entity;
    if (cls === 'CCitadelPlayerPawn') {
      const owner = field(entity, 'm_hOwnerEntity');
      if (owner === undefined) return null;
      try {
        const ctrl = demo.getEntityByHandle(owner);
        return className(ctrl) === 'CCitadelPlayerController' ? ctrl : null;
      } catch (_) {
        return null;
      }
    }
    return null;
  };

  const controllerByHandle = (demo, handle) => {
    if (handle === undefined || handle === null) return null;
    let entity;
    try {
      entity = demo.getEntityByHandle(handle);
    } catch (_) {
      return null;
    }
    if (!entity) return null;
    const cls = className(entity);
    if (cls === 'CCitadelPlayerController') return entity;
    if (cls === 'CCitadelPlayerPawn') {
      return controllerOf(demo, entity.index);
    }
    return null;
  };

  /* ---------------- periodic state snapshot ---------------- */

  let lastSampleAt = -Infinity;

  const snapshot = (force = false) => {
    clock.update();
    const t = clock.clockGame;
    if (!force && t - lastSampleAt < sampleIntervalSec) return null;
    lastSampleAt = t;

    const demo = parser.getDemo();
    if (!demo) return null;

    const controllers = entitiesOf(demo, 'CCitadelPlayerController');
    for (const c of controllers) registerPlayer(c);

    const byCtrl = new Map();
    for (const c of controllers) {
      byCtrl.set(c.index, {
        ctrl: c.index,
        nw: firstField(c, CTRL_FIELDS.netWorth) ?? null,
        k: firstField(c, CTRL_FIELDS.kills) ?? null,
        d: firstField(c, CTRL_FIELDS.deaths) ?? null,
        a: firstField(c, CTRL_FIELDS.assists) ?? null,
        hd: firstField(c, CTRL_FIELDS.heroDamage) ?? null,
        // Unspent souls, when the build replicates it. This is ground truth for
        // the spend curve; deriving it from net worth minus purchases is only a
        // fallback and is wrong the moment an item cost fails to resolve.
        un: firstField(c, CTRL_FIELDS.unspent) ?? null,
        x: null, y: null, z: null, hp: null, maxHp: null, alive: null
      });
    }

    for (const pawn of entitiesOf(demo, 'CCitadelPlayerPawn')) {
      const ctrl = controllerOf(demo, pawn.index);
      if (!ctrl) continue;
      const row = byCtrl.get(ctrl.index);
      if (!row) continue;

      const pos = pawnPosition(pawn, cellBits);
      if (pos) {
        row.x = Math.round(pos.x);
        row.y = Math.round(pos.y);
        row.z = Math.round(pos.z);
      }
      const hp = firstField(pawn, PAWN_HEALTH);
      const maxHp = firstField(pawn, PAWN_MAX_HEALTH);
      const lifeState = firstField(pawn, PAWN_LIFE_STATE);
      row.hp = hp ?? null;
      row.maxHp = maxHp ?? null;
      row.alive = lifeState !== undefined ? lifeState === 0 : (hp !== undefined ? hp > 0 : null);

      if (!raw.diagnostics.pawnFieldSample) {
        raw.diagnostics.pawnFieldSample = dumpFields(pawn);
      }
    }

    const sample = { t, players: Array.from(byCtrl.values()) };
    raw.samples.push(sample);
    return sample;
  };

  const positionsNow = () => {
    const demo = parser.getDemo();
    const out = new Map();
    if (!demo) return out;
    for (const pawn of entitiesOf(demo, 'CCitadelPlayerPawn')) {
      const ctrl = controllerOf(demo, pawn.index);
      if (!ctrl) continue;
      const pos = pawnPosition(pawn, cellBits);
      const hp = firstField(pawn, PAWN_HEALTH);
      const lifeState = firstField(pawn, PAWN_LIFE_STATE);
      out.set(ctrl.index, {
        pos: pos ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } : null,
        hp: hp ?? null,
        alive: lifeState !== undefined ? lifeState === 0 : (hp !== undefined ? hp > 0 : null)
      });
    }
    return out;
  };

  /* ---------------- interceptors ---------------- */

  parser.registerPostInterceptor(InterceptorStage.DEMO_PACKET, () => {
    try {
      snapshot(false);
    } catch (err) {
      noteError('snapshot', err);
    }
  });

  const TYPE = {
    heroKilled: M('CITADEL_USER_MESSAGE_HERO_KILLED'),
    damage: M('CITADEL_USER_MESSAGE_DAMAGE'),
    itemPurchase: M('CITADEL_USER_MESSAGE_ITEM_PURCHASE_NOTIFICATION'),
    currency: M('CITADEL_USER_MESSAGE_CURRENCY_CHANGED'),
    bossKilled: M('CITADEL_USER_MESSAGE_BOSS_KILLED'),
    midBossSpawned: M('CITADEL_USER_MESSAGE_MID_BOSS_SPAWNED'),
    respawned: M('CITADEL_USER_MESSAGE_PLAYER_RESPAWNED'),
    chat: M('CITADEL_USER_MESSAGE_CHAT_MESSAGE'),
    gameOver: M('CITADEL_USER_MESSAGE_GAME_OVER')
  };

  parser.registerPostInterceptor(InterceptorStage.MESSAGE_PACKET, (demoPacket, messagePacket) => {
    const type = messagePacket.type;
    const data = messagePacket.data;
    if (!data) return;
    const demo = parser.getDemo();

    try {
      /* ---- hero kills ---- */
      if (type === TYPE.heroKilled) {
        countMessage('heroKilled');
        clock.update();

        const victimCtrl = controllerOf(demo, data.entindexVictim ?? data.entindex_victim);
        const scorerCtrl = controllerOf(demo, data.entindexScorer ?? data.entindex_scorer);
        const attackerCtrl = controllerOf(demo, data.entindexAttacker ?? data.entindex_attacker);
        if (!victimCtrl) return;

        registerPlayer(victimCtrl);
        const killerCtrl = scorerCtrl || attackerCtrl;
        if (killerCtrl) registerPlayer(killerCtrl);

        const assisterIndexes = data.entindexAssisters || data.entindex_assisters || [];
        const assisters = [];
        for (const ai of assisterIndexes) {
          const c = controllerOf(demo, ai);
          if (c) {
            registerPlayer(c);
            assisters.push(c.index);
          }
        }

        const snap = positionsNow();
        const positions = {};
        for (const [ctrl, info] of snap.entries()) {
          positions[ctrl] = info.pos ? [info.pos.x, info.pos.y, info.pos.z, info.alive ? 1 : 0] : null;
        }

        raw.kills.push({
          t: clock.clockGame,
          tick: clock.tick,
          preDeathDamage: preDeathBreakdown(victimCtrl.index, clock.clockGame),
          victim: victimCtrl.index,
          victimTeam: firstField(victimCtrl, CTRL_FIELDS.team) ?? null,
          killer: killerCtrl ? killerCtrl.index : null,
          killerIsPlayer: Boolean(killerCtrl),
          assisters,
          victimNetWorth: firstField(victimCtrl, CTRL_FIELDS.netWorth) ?? null,
          positions
        });
        return;
      }

      /* ---- hero damage ---- */
      if (type === TYPE.damage) {
        const attackerCtrl = controllerOf(demo, data.entindexAttacker ?? data.entindex_attacker);
        if (!attackerCtrl) return;
        const victimCtrl = controllerOf(demo, data.entindexVictim ?? data.entindex_victim);
        if (!victimCtrl) return;
        if (attackerCtrl.index === victimCtrl.index) return;

        countMessage('heroDamage');
        clock.update();

        const amount = data.damage ?? 0;
        if (!amount) return;

        const a = attackerCtrl.index;
        const v = victimCtrl.index;
        const bucket = Math.floor(clock.clockGame / 2);
        const key = `${a}|${v}|${bucket}`;
        let entry = damageBuckets.get(key);
        if (!entry) {
          entry = { a, v, t: bucket * 2, dmg: 0, hits: 0 };
          damageBuckets.set(key, entry);
        }
        entry.dmg += amount;
        entry.hits += 1;

        const totalKey = `${a}>${v}`;
        raw.damageTotals[totalKey] = (raw.damageTotals[totalKey] || 0) + amount;

        const type = data.citadelType ?? data.citadel_type ?? data.type ?? -1;
        const abilityId = data.abilityId ?? data.ability_id ?? 0;
        const hits = data.hits && data.hits > 0 ? data.hits : 1;

        addTypeTotal(v, 'taken', type, abilityId, amount, hits);
        addTypeTotal(a, 'dealt', type, abilityId, amount, hits);
        rememberDamage(v, { t: clock.clockGame, a, dmg: amount, type, abilityId });
        return;
      }

      /* ---- item purchases ---- */
      if (type === TYPE.itemPurchase) {
        countMessage('itemPurchase');
        clock.update();
        raw.items.push({
          t: clock.clockGame,
          userid: data.userid ?? -1,
          ctrl: null, // resolved after parse via userinfo
          abilityId: data.abilityId ?? data.ability_id ?? null,
          sell: Boolean(data.sell),
          quickbuy: Boolean(data.quickbuy)
        });
        return;
      }

      /* ---- boss / objective kills ---- */
      if (type === TYPE.bossKilled) {
        countMessage('bossKilled');
        clock.update();

        let entityTeam = null;
        try {
          const killedEntity = demo.getEntityByHandle(data.entityKilled ?? data.entity_killed);
          entityTeam = field(killedEntity, 'm_iTeamNum') ?? null;
        } catch (_) { /* entity class may not be decoded */ }

        const killerCtrl = controllerByHandle(demo, data.entityKiller ?? data.entity_killer);

        raw.objectives.push({
          t: data.gametime !== undefined && data.gametime > 0 ? data.gametime : clock.clockGame,
          kind: entityTeam === TEAM_NEUTRAL ? 'midboss' : 'building',
          team: data.objectiveTeam ?? data.objective_team ?? null,
          entityTeam,
          classIndex: data.entityKilledClass ?? data.entity_killed_class ?? null,
          bossesRemaining: data.bossesRemaining ?? data.bosses_remaining ?? null,
          killerCtrl: killerCtrl ? killerCtrl.index : null,
          pos: vecOf(data.entityPosition || data.entity_position)
        });
        return;
      }

      if (type === TYPE.midBossSpawned) {
        countMessage('midBossSpawned');
        clock.update();
        raw.objectives.push({ t: clock.clockGame, kind: 'midboss_spawned', team: null, pos: null });
        return;
      }

      if (type === TYPE.respawned) {
        countMessage('respawned');
        clock.update();
        const ctrl = controllerByHandle(demo, data.playerPawn ?? data.player_pawn);
        if (ctrl) raw.respawns.push({ t: clock.clockGame, ctrl: ctrl.index });
        return;
      }

      if (type === TYPE.chat) {
        countMessage('chat');
        clock.update();
        raw.chat.push({
          t: clock.clockGame,
          text: data.text ?? data.message ?? '',
          allChat: Boolean(data.allChat ?? data.all_chat)
        });
        return;
      }

      if (type === TYPE.gameOver) {
        countMessage('gameOver');
        raw.winningTeam = data.winningTeam ?? data.winning_team ?? null;
      }
    } catch (err) {
      noteError('message', err);
    }
  });

  /* ---------------- run ---------------- */

  onProgress(0, 'Reading file');

  const total = file.size || 0;
  let read = 0;
  let lastReport = 0;

  const source = file.stream().pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        read += chunk.byteLength || chunk.length || 0;
        const now = performance.now();
        if (total && now - lastReport > 120) {
          lastReport = now;
          onProgress(Math.min(read / total, 0.99), 'Parsing replay');
        }
        controller.enqueue(chunk);
      }
    })
  );

  await parser.parse(source);

  onProgress(0.99, 'Finalising');

  /* ---------------- post-processing ---------------- */

  const demo = parser.getDemo();

  // Final scoreboard straight off the controllers at the last tick.
  const controllers = entitiesOf(demo, 'CCitadelPlayerController');
  for (const c of controllers) {
    const rec = registerPlayer(c);
    if (!rec) continue;
    rec.final = {
      netWorth: firstField(c, CTRL_FIELDS.netWorth) ?? null,
      kills: firstField(c, CTRL_FIELDS.kills) ?? null,
      deaths: firstField(c, CTRL_FIELDS.deaths) ?? null,
      assists: firstField(c, CTRL_FIELDS.assists) ?? null,
      heroDamage: firstField(c, CTRL_FIELDS.heroDamage) ?? null,
      heroHealing: firstField(c, CTRL_FIELDS.heroHealing) ?? null,
      objectiveDamage: firstField(c, CTRL_FIELDS.objectiveDamage) ?? null,
      lastHits: firstField(c, CTRL_FIELDS.lastHits) ?? null,
      denies: firstField(c, CTRL_FIELDS.denies) ?? null,
      level: firstField(c, CTRL_FIELDS.level) ?? null
    };
  }

  if (controllers.length > 0) {
    raw.diagnostics.controllerFieldSample = dumpFields(controllers[0]);
  }

  // The demo's own class registry. Item and ability entities carry their
  // identity in the class name, which is a route to item names that needs no
  // external service at all — record what this build actually ships.
  try {
    const classes = typeof demo.getClasses === 'function' ? demo.getClasses() : [];
    const names = [];
    for (const entry of classes) {
      const name = typeof entry === 'string' ? entry : entry?.name;
      if (typeof name === 'string') names.push(name);
    }
    names.sort();
    raw.diagnostics.entityClassCount = names.length;
    raw.diagnostics.itemLikeClasses = names.filter((n) => /item|upgrade/i.test(n)).slice(0, 60);
  } catch (err) {
    noteError('classes', err);
  }

  // Auto-detect hero / slot fields rather than hardcoding a schema name.
  const heroField = detectField(controllers, /hero/i, { distinct: true, numeric: true });
  const slotField = detectField(controllers, /slot/i, { distinct: true, numeric: true });
  raw.diagnostics.heroFieldGuess = heroField;
  raw.diagnostics.slotFieldGuess = slotField;

  // Every currency-ish field this build ships, with its final value. Net worth
  // only ever climbs; unspent souls go down when you buy something, so the two
  // are easy to tell apart once you can see both.
  if (controllers.length > 0) {
    const flat = dumpFields(controllers[0]);
    raw.diagnostics.currencyFields = Object.entries(flat)
      .filter(([k, v]) => typeof v === 'number' && /gold|soul|currenc|cash|money/i.test(k))
      .map(([k, v]) => ({ field: k, value: v }))
      .sort((a, b) => b.value - a.value);
  }

  for (const c of controllers) {
    const rec = playersByCtrl.get(c.index);
    if (!rec) continue;
    if (heroField) rec.heroId = field(c, heroField) ?? null;
    if (slotField) rec.slot = field(c, slotField) ?? null;
  }

  // userinfo string table: userid -> name, so item purchases can find an owner.
  try {
    const table = demo.stringTableContainer.getByType(StringTableType.USER_INFO);
    if (table) {
      for (const entry of table.getEntries()) {
        const v = entry.value;
        if (!v) continue;
        raw.userInfo.push({
          key: entry.key,
          name: v.name ?? null,
          userid: v.userid ?? null,
          steamid: v.steamid !== undefined && v.steamid !== null ? String(v.steamid) : null
        });
      }
    }
  } catch (err) {
    noteError('userinfo', err);
  }

  raw.players = Array.from(playersByCtrl.values()).filter((p) => p.name);

  // Map item purchases to a controller via userid -> userinfo name -> player name.
  const byUserId = new Map();
  for (const info of raw.userInfo) {
    if (info.userid === null || !info.name) continue;
    const match = raw.players.find((p) => p.name === info.name);
    if (match) byUserId.set(info.userid, match.ctrl);
  }
  // Some builds index userinfo by slot rather than carrying a userid.
  const bySlot = new Map();
  for (const p of raw.players) {
    if (p.slot !== null && p.slot !== undefined) bySlot.set(p.slot, p.ctrl);
  }

  for (const item of raw.items) {
    const viaUser = byUserId.get(item.userid);
    const viaSlot = bySlot.get(item.userid);
    item.ctrl = viaUser ?? viaSlot ?? null;
    if (item.ctrl === null) raw.diagnostics.unresolvedItemUserIds += 1;
  }

  raw.damage = Array.from(damageBuckets.values()).sort((x, y) => x.t - y.t);
  raw.damageByType = Array.from(typeTotals.values()).sort((x, y) => y.dmg - x.dmg);
  raw.duration = raw.samples.length > 0 ? raw.samples[raw.samples.length - 1].t : clock.clockGame;

  await parser.dispose();
  onProgress(1, 'Done');

  return raw;
}

/* ------------------------------------------------------------------ */
/* diagnostics helpers                                                 */
/* ------------------------------------------------------------------ */

function dumpFields(entity) {
  const out = {};
  try {
    if (typeof entity.unpackFlattened === 'function') {
      const flat = entity.unpackFlattened();
      for (const [k, v] of Object.entries(flat)) {
        if (typeof v === 'object' && v !== null) continue;
        out[k] = v;
      }
      return out;
    }
    if (typeof entity.fieldEntries === 'function') {
      for (const [k, v] of entity.fieldEntries()) {
        if (typeof v === 'object' && v !== null) continue;
        out[k] = v;
      }
    }
  } catch (_) { /* ignore */ }
  return out;
}

/**
 * Finds a replicated field whose name matches `pattern` and whose values look
 * like a per-player identifier. Lets the app survive Valve renaming things.
 */
function detectField(entities, pattern, { distinct = true, numeric = true } = {}) {
  if (!entities || entities.length < 2) return null;

  const candidates = new Map();
  for (const entity of entities) {
    const flat = dumpFields(entity);
    for (const [k, v] of Object.entries(flat)) {
      if (!pattern.test(k)) continue;
      if (numeric && typeof v !== 'number') continue;
      if (!candidates.has(k)) candidates.set(k, []);
      candidates.get(k).push(v);
    }
  }

  let best = null;
  let bestScore = 0;
  for (const [k, values] of candidates.entries()) {
    if (values.length !== entities.length) continue;
    const unique = new Set(values).size;
    if (distinct && unique < 2) continue;
    // Prefer fields that are near-unique per player and hold small positive ints.
    const plausible = values.every((v) => Number.isFinite(v) && v >= 0 && v < 100000);
    if (!plausible) continue;
    const score = unique + (/id$/i.test(k) ? 2 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = k;
    }
  }
  return best;
}
