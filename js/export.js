/*
 * export.js — builds the coaching brief you paste into Claude.
 *
 * The goal is a document small enough to paste comfortably but complete enough
 * that Claude can reason about the match without seeing the replay: every death
 * with its spatial context, every fight with who showed up, the farm curve at
 * fixed milestones, and the objective log.
 */

import { formatClock } from './analyze.js';

const EMPTY_RATE = { won: 0, converted: 0, rate: null };

function num(value, fallback = '?') {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  return Math.round(value).toLocaleString();
}

export function buildMarkdownBrief(analysis) {
  const { meta, teams, teamRoster, focus, deaths, fights, farm, items, objectives, macro, findings } = analysis;
  const [FIRST, SECOND] = teams.ids;
  const teamName = (team) => teams.label(team);

  const lines = [];
  const push = (line = '') => lines.push(line);

  push('# Deadlock match review — data extracted from the replay');
  push();
  push('You are reviewing a Deadlock match for the player marked **ME** below. Everything here was');
  push('parsed directly from the .dem replay file. Distances are expressed as a fraction of the');
  push('distance between the two team bases (0 = own base, 1 = enemy base), because raw world units');
  push('are not meaningful on their own.');
  push();
  push('Please give: (1) the three most costly mistakes I personally made, each tied to a timestamp,');
  push('(2) the single biggest team-level pattern that lost or nearly lost this game, and');
  push('(3) what specifically to do differently, phrased as decisions rather than platitudes.');
  push();

  /* ---- match ---- */
  push('## Match');
  push();
  push(`- File: ${meta.fileName}`);
  push(`- Duration: ${formatClock(meta.duration)}`);
  push(`- Winner: ${meta.winningTeam ? teamName(meta.winningTeam) : 'not recorded in replay'}`);
  if (focus) {
    push(`- ME: **${focus.name}**${focus.hero ? ` (${focus.hero})` : ''} on ${teamName(focus.team)}`);
    const result = meta.winningTeam ? (meta.winningTeam === focus.team ? 'WIN' : 'LOSS') : 'unknown';
    push(`- Result for me: ${result}`);
  }
  push();

  /* ---- scoreboard ---- */
  push('## Final scoreboard');
  push();
  push('| Player | Team | Hero | Souls | K | D | A | Hero dmg | Obj dmg | Healing |');
  push('|---|---|---|---|---|---|---|---|---|---|');
  const ordered = [...(teamRoster[FIRST] || []), ...(teamRoster[SECOND] || [])];
  for (const p of ordered) {
    const f = p.final || {};
    const marker = focus && p.ctrl === focus.ctrl ? ' **(ME)**' : '';
    push(
      `| ${p.name}${marker} | ${teamName(p.team)} | ${p.hero || '?'} | ${num(f.netWorth)} | ${num(f.kills, '0')} | ${num(f.deaths, '0')} | ${num(f.assists, '0')} | ${num(f.heroDamage, '0')} | ${num(f.objectiveDamage, '0')} | ${num(f.heroHealing, '0')} |`
    );
  }
  push();

  /* ---- farm ---- */
  push('## Net worth at milestones');
  push();
  const marks = farm.milestones.filter((m) => m <= meta.duration + 5);
  push(`| Player | ${marks.map((m) => formatClock(m)).join(' | ')} |`);
  push(`|---|${marks.map(() => '---').join('|')}|`);
  for (const row of farm.rows) {
    const marker = focus && row.ctrl === focus.ctrl ? ' (ME)' : '';
    push(`| ${row.name}${marker} | ${marks.map((m) => num(row.marks[m])).join(' | ')} |`);
  }
  push();
  if (farm.laneOpponent && focus) {
    push(`Closest early-game opponent (likely lane matchup): **${farm.laneOpponent.name}**.`);
    push();
  }

  /* ---- my deaths ---- */
  const myDeaths = deaths.filter((d) => d.isFocus);
  if (focus) {
    push(`## My deaths (${myDeaths.length})`);
    push();
    if (myDeaths.length === 0) {
      push('No deaths recorded.');
    } else {
      push('| Time | Killed by | Assists | Where (0=my base, 1=enemy base) | Allies alive nearby | Enemies nearby | Souls | Traded? | Flags |');
      push('|---|---|---|---|---|---|---|---|---|');
      for (const d of myDeaths) {
        push(
          `| ${formatClock(d.t)} | ${d.killerName} | ${d.assisters.length} | ${d.depth === null ? '?' : d.depth.toFixed(2)} (${d.zone}) | ${d.alliesNear} | ${d.enemiesNear} | ${num(d.netWorth)} | ${d.trade > 0 ? `yes (${d.trade})` : 'no'} | ${d.flags.join(', ') || '—'} |`
        );
      }
    }
    push();
  }

  /* ---- team deaths summary ---- */
  push('## Deaths by player');
  push();
  push('| Player | Team | Deaths | Solo deaths | Deep deaths | Untraded |');
  push('|---|---|---|---|---|---|');
  for (const p of ordered) {
    const own = deaths.filter((d) => d.ctrl === p.ctrl);
    if (own.length === 0) continue;
    push(
      `| ${p.name} | ${teamName(p.team)} | ${own.length} | ${own.filter((d) => d.flags.includes('solo')).length} | ${own.filter((d) => d.flags.includes('deep')).length} | ${own.filter((d) => d.flags.includes('no-trade')).length} |`
    );
  }
  push();

  /* ---- fights ---- */
  const realFights = fights.filter((f) => !f.isPick);
  push(`## Teamfights (${realFights.length} fights, ${fights.length - realFights.length} isolated picks)`);
  push();
  if (fights.length === 0) {
    push('No fights detected.');
  } else {
    push(`| # | Start | Type | Result | Where | Present (${teamName(FIRST)}) | Present (${teamName(SECOND)}) | Missing on my team |`);
    push('|---|---|---|---|---|---|---|---|');
    for (const f of fights.slice(0, 40)) {
      const depth = focus && f.depth ? f.depth[focus.team] : null;
      const firstIn = f.participation.filter((p) => p.team === FIRST && p.present).map((p) => p.name);
      const secondIn = f.participation.filter((p) => p.team === SECOND && p.present).map((p) => p.name);
      const missing = focus
        ? f.participation.filter((p) => p.team === focus.team && !p.present && p.alive !== false).map((p) => p.name)
        : [];
      push(
        `| ${f.id} | ${formatClock(f.start)} | ${f.isPick ? 'pick' : 'fight'} | ${teamName(FIRST)} ${f.score[FIRST]} – ${f.score[SECOND]} ${teamName(SECOND)} | ${depth === null || depth === undefined ? '?' : depth.toFixed(2)} | ${firstIn.join(', ') || '—'} | ${secondIn.join(', ') || '—'} | ${missing.join(', ') || '—'} |`
      );
    }
    if (fights.length > 40) push(`\n_(${fights.length - 40} further fights omitted to keep this pasteable.)_`);
  }
  push();

  /* ---- objectives ---- */
  push('## Objectives');
  push();
  const realObjectives = objectives.filter((o) => o.kind !== 'midboss_spawned');
  if (realObjectives.length === 0) {
    push('No objective events captured.');
  } else {
    for (const o of realObjectives) {
      push(
        `- ${formatClock(o.t)} — ${o.kind === 'midboss' ? 'Mid boss (Rejuvenator)' : 'Building destroyed'}${o.takenByTeam !== null ? `, taken by ${teamName(o.takenByTeam)}` : ''}${o.killerName ? ` (last hit: ${o.killerName})` : ''}`
      );
    }
  }
  push();

  /* ---- build ---- */
  if (focus) {
    const build = analysis.build;
    push(`## My build`);
    push();

    if (!build || !build.ok || build.purchases.length === 0) {
      const mine = items.filter((i) => i.ctrl === focus.ctrl);
      if (mine.length === 0) {
        push('No purchases resolved to me — see Diagnostics in the app.');
      } else {
        push(mine.map((i) => `- ${formatClock(i.t)} — ${i.item}${i.cost ? ` (${num(i.cost)})` : ''}`).join('\n'));
      }
      push();
    } else {
      push('| # | Time | Item | Slot | Cost | Spent so far | Usual purchase time | Win rate |');
      push('|---|---|---|---|---|---|---|---|');
      build.purchases.forEach((p, i) => {
        const b = p.benchmark;
        push(
          `| ${i + 1} | ${formatClock(p.t)} | ${p.name} | ${p.slotLabel}${p.tier ? ` T${p.tier}` : ''} | ${num(p.cost)} | ${num(p.committedAfter)} | ${b && Number.isFinite(b.avgBoughtAt) ? formatClock(b.avgBoughtAt) : '—'} | ${b && Number.isFinite(b.winRate) ? `${Math.round(b.winRate * 100)}%` : '—'} |`
        );
      });
      push();

      push(
        `Souls by category — weapon ${num(build.categorySouls.weapon)}, vitality ${num(build.categorySouls.vitality)}, spirit ${num(build.categorySouls.spirit)}.`
      );
      if (build.spend.worstBanking) {
        push(
          `Longest stretch sitting on unspent souls: ${formatClock(build.spend.worstBanking.from)} to ${formatClock(build.spend.worstBanking.to)}, peaking around ${num(build.spend.worstBanking.peak)} unspent.`
        );
      }
      push();

      /* what the damage actually was */
      const taken = build.damage?.taken;
      if (taken && taken.total > 0) {
        push('### Damage I took, by kind');
        push();
        push(`- Total: ${num(taken.total)}`);
        push(`- Weapon fire: ${num(taken.weapon)} (${Math.round((taken.weaponShare || 0) * 100)}%)`);
        push(`- Ability / spirit: ${num(taken.ability)} (${Math.round((taken.abilityShare || 0) * 100)}%)`);
        if (taken.mixed > 0) push(`- Unclassified: ${num(taken.mixed)}`);
        push();
        push('Classification is derived from whether each damage event carried an ability id, not from a hardcoded type table.');
        push();
      }

      if (build.threats.length > 0) {
        push('### Who dealt the damage to me');
        push();
        for (const t of build.threats) {
          push(`- ${t.name}${t.hero ? ` (${t.hero})` : ''} — ${num(t.dmg)}${t.share !== null ? ` (${Math.round(t.share * 100)}%)` : ''}`);
        }
        push();
      }

      if (build.enemyHealing > 0) {
        push(`Enemy team hero healing across the match: ${num(build.enemyHealing)}.`);
        push();
      }

      if (build.deathContext.length > 0) {
        push('### What I had, and what hit me, at each death');
        push();
        push('| Time | Killed by | Items owned | Unspent souls | Damage in the last 8s |');
        push('|---|---|---|---|---|');
        for (const d of build.deathContext) {
          const breakdown = d.breakdown.length
            ? d.breakdown.map((b) => `${b.name} ${num(b.dmg)} ${b.label}`).join('; ')
            : 'not captured';
          push(`| ${formatClock(d.t)} | ${d.killerName} | ${d.itemsOwned} | ${num(d.soulsBanked)} | ${breakdown} |`);
        }
        push();
      }

      /* benchmark */
      if (build.benchmark.available) {
        push('### Against real matches');
        push();
        push(
          `Reference data: ${build.benchmark.sampleMatches.toLocaleString()} recent matches ${
            build.benchmark.scope && build.benchmark.scope.startsWith('hero:')
              ? `on ${build.hero || 'this hero'}`
              : 'across all heroes'
          } (deadlock-api, last 30 days).`
        );
        push();
        if (build.benchmark.missed.length > 0) {
          push('Popular, high-win-rate items I never bought:');
          for (const m of build.benchmark.missed) {
            push(
              `- ${m.name} — ${Math.round(m.winRate * 100)}% win (${m.vsBaseline > 0 ? '+' : ''}${(m.vsBaseline * 100).toFixed(1)} vs the average item), popularity ${Math.round(m.popularity * 100)}% of the most-bought item${Number.isFinite(m.avgBoughtAt) ? `, usually by ${formatClock(m.avgBoughtAt)}` : ''}`
            );
          }
          push();
        }
        if (build.benchmark.late.length > 0) {
          push('Items I bought later than the average:');
          for (const l of build.benchmark.late) {
            push(`- ${l.name} — me ${formatClock(l.yours)} vs average ${formatClock(l.median)} (${Math.round(l.delta / 60)} min late)`);
          }
          push();
        }
        if (build.benchmark.lowValue.length > 0) {
          push('Items I bought that underperform in real matches:');
          for (const l of build.benchmark.lowValue) {
            push(`- ${l.name} — ${Math.round(l.winRate * 100)}% win over ${l.matches.toLocaleString()} matches`);
          }
          push();
        }
      } else {
        push('_Item win-rate data was unavailable, so nothing above is benchmarked against real matches._');
        push();
      }

      if (build.suggestions.length > 0) {
        push('### Build flags raised by the analyzer');
        push();
        for (const s of build.suggestions) {
          push(`- **[${s.priority}] ${s.title}** — ${s.reason}`);
          for (const e of s.evidence) push(`  - ${e}`);
          if (s.items.length) push(`  - Candidate items: ${s.items.map((i) => i.name).join(', ')}`);
        }
        push();
      }

      push('When you answer, please review this build specifically: whether the order and timing made');
      push('sense given the damage I was taking and who was dealing it, what I should have bought');
      push('instead of which purchase, and at roughly what minute each change should have happened.');
      push();
    }
  }

  /* ---- macro ---- */
  push('## Macro summary');
  push();
  const focusTeam = focus && teams.includes(focus.team) ? focus.team : FIRST;
  const enemyTeam = teams.other(focusTeam) ?? SECOND;
  const myConv = macro.conversionRate[focusTeam] || EMPTY_RATE;
  const theirConv = macro.conversionRate[enemyTeam] || EMPTY_RATE;
  push(`- Decisive fights won by my team: ${myConv.won}, converted into an objective within 75s: ${myConv.converted}`);
  push(`- Decisive fights won by the enemy: ${theirConv.won}, converted: ${theirConv.converted}`);
  push(`- Objectives taken — my team: ${macro.objectiveCount[focusTeam] ?? 0}, enemy: ${macro.objectiveCount[enemyTeam] ?? 0}`);
  const sign = focusTeam === FIRST ? 1 : -1;
  push(`- Peak soul lead for my team: ${num(macro.lead.peak.v * sign)} at ${formatClock(macro.lead.peak.t)}`);
  push(`- Soul lead at the end: ${num(macro.lead.finalLead * sign)}`);
  push(`- Deaths on my team while more than 3,000 souls ahead: ${macro.deathsWhileAhead[focusTeam] ?? 0}`);
  push();

  /* ---- findings ---- */
  push('## Automated findings (generated by the analyzer, verify against the data above)');
  push();
  if (findings.length === 0) {
    push('Nothing crossed the thresholds the analyzer checks.');
  } else {
    for (const f of findings) {
      push(`- **[${f.scope}/${f.severity}] ${f.title}** — ${f.detail}`);
      if (f.evidence) {
        for (const e of f.evidence) push(`  - ${e}`);
      }
    }
  }
  push();

  return lines.join('\n');
}

export function buildJsonBrief(analysis) {
  const { meta, teams, players, focus, deaths, fights, farm, items, objectives, macro, findings } = analysis;

  return JSON.stringify(
    {
      meta,
      teams: {
        ids: teams.ids,
        labels: Object.fromEntries(teams.ids.map((id) => [id, teams.label(id)]))
      },
      focus: focus ? { ctrl: focus.ctrl, name: focus.name, team: focus.team, hero: focus.hero } : null,
      players: players.map((p) => ({
        ctrl: p.ctrl,
        name: p.name,
        team: p.team,
        hero: p.hero,
        final: p.final
      })),
      farm: {
        milestones: farm.milestones,
        rows: farm.rows.map((r) => ({ ctrl: r.ctrl, name: r.name, team: r.team, marks: r.marks, final: r.final })),
        laneOpponent: farm.laneOpponent ? farm.laneOpponent.name : null,
        lead: farm.leadSeries.filter((_, i) => i % 10 === 0)
      },
      deaths: deaths.map((d) => ({
        t: Math.round(d.t),
        name: d.name,
        team: d.team,
        isMe: d.isFocus,
        killer: d.killerName,
        assists: d.assisters,
        depth: d.depth === null ? null : Number(d.depth.toFixed(3)),
        alliesNear: d.alliesNear,
        enemiesNear: d.enemiesNear,
        netWorth: d.netWorth,
        traded: d.trade,
        flags: d.flags
      })),
      fights: fights.map((f) => ({
        id: f.id,
        type: f.isPick ? 'pick' : 'fight',
        start: Math.round(f.start),
        end: Math.round(f.end),
        score: f.score,
        winner: f.winner,
        present: f.participation.filter((p) => p.present).map((p) => p.name),
        absent: f.participation.filter((p) => !p.present).map((p) => p.name)
      })),
      objectives: objectives.map((o) => ({ t: Math.round(o.t), kind: o.kind, takenBy: o.takenByTeam })),
      items: items.map((i) => ({ t: Math.round(i.t), player: i.name, item: i.item, cost: i.cost })),
      build: analysis.build && analysis.build.ok
        ? {
            hero: analysis.build.hero,
            purchases: analysis.build.purchases.map((p) => ({
              t: Math.round(p.t),
              name: p.name,
              slot: p.slot,
              tier: p.tier,
              cost: p.cost,
              spentSoFar: Math.round(p.committedAfter),
              usualTime: p.benchmark && Number.isFinite(p.benchmark.avgBoughtAt) ? Math.round(p.benchmark.avgBoughtAt) : null,
              winRate: p.benchmark?.winRate ?? null
            })),
            categorySouls: analysis.build.categorySouls,
            damageTaken: analysis.build.damage?.taken
              ? {
                  total: Math.round(analysis.build.damage.taken.total),
                  weapon: Math.round(analysis.build.damage.taken.weapon),
                  ability: Math.round(analysis.build.damage.taken.ability),
                  weaponShare: analysis.build.damage.taken.weaponShare,
                  abilityShare: analysis.build.damage.taken.abilityShare
                }
              : null,
            threats: analysis.build.threats,
            enemyHealing: analysis.build.enemyHealing,
            deathContext: analysis.build.deathContext,
            benchmark: analysis.build.benchmark,
            suggestions: analysis.build.suggestions
          }
        : null,
      macro: {
        conversionRate: macro.conversionRate,
        objectiveCount: macro.objectiveCount,
        deathsWhileAhead: macro.deathsWhileAhead,
        leadPeak: macro.lead.peak,
        leadFinal: macro.lead.finalLead
      },
      findings
    },
    null,
    2
  );
}
