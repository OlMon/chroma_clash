/**
 * Balancing aid for the final pass: measures what the balance targets in
 * IMPROVEMENTS.md are about, through the real engines, without drawing.
 *
 *   node src/cli/balance.ts god [--runs 40] [--sizes 3,8,20] [--fit]
 *     A god with each single skill against chat: how often it wins, per chat
 *     size (chatters per guild). With --fit, searches each skill's
 *     `healthFactor` for half the fights won. With --mix, searches only
 *     `skills.mixFactor`, so a god with every skill wins half its fights.
 *     With --large (and --sizes 40, a big chat), searches only
 *     `god.largeChatExponent`, the god's health above 70 fighters.
 *   node src/cli/balance.ts classes [--runs 30] [--sizes 6,15,40]
 *     War battles: per class, how many survive, kills, damage and healing per
 *     fighter, against the average.
 *   node src/cli/balance.ts obstacles [--runs 30] [--sizes 6,15,40]
 *     War battles in each arena and without: how long they last, and the
 *     share of deaths by barrels and traps.
 *   node src/cli/balance.ts duel [--runs 200] [--fit]
 *     Duels by the class both start with (they switch later): how often the
 *     first wins (should be half), draws, and how long they last. With
 *     --fit, searches the duel's toughness (`pace.kinds.duel`) for a median
 *     of `duel.targetMs`.
 *   node src/cli/balance.ts pachinko [--runs 4000]
 *     Pachinko with the slot values in config and a few alternatives: how
 *     often a jackpot falls, how often it decides the game, and how often the
 *     leader at half-time wins.
 */
import { parseArgs } from 'node:util';
import { config, type ClassId, type SkillId } from '../config.ts';
import { Battle, type BattleResult } from '../game/battle.ts';
import { ARENAS, type ArenaId } from '../game/obstacles.ts';
import { playPachinko } from '../game/pachinko.ts';
import type { EventEngine } from '../server/event-runner.ts';
import { GodEngine } from '../server/god-engine.ts';
import { DuelEngine } from '../server/duel-engine.ts';
import { Store, type UserRow } from '../db/store.ts';
import { WarEngine } from '../server/war-engine.ts';
import { createRng } from '../util/rng.ts';
import { T0, asRunner, channel } from './sim-support.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    runs: { type: 'string' },
    sizes: { type: 'string' },
    fit: { type: 'boolean', default: false },
    mix: { type: 'boolean', default: false },
    large: { type: 'boolean', default: false },
  },
});
const mode = positionals[0] ?? 'god';
const pct = (share: number) => `${Math.round(share * 100)}%`.padStart(5);

/** Plays an event to its end; `onBattle` sees every battle once it is over. */
function play(engine: EventEngine, onBattle: (battle: Battle, result: BattleResult) => void, place?: ArenaId | 'none'): void {
  for (let step = engine.next(); step; step = engine.next()) {
    if (!step.setup) continue;
    const setup = asRunner(step.setup);
    if (place === 'none') delete setup.obstacles;
    else if (place) {
      setup.obstacles = 'fixed';
      setup.place = place;
    }
    const battle = new Battle(setup);
    const result = battle.run();
    onBattle(battle, result);
    engine.apply(step, result);
  }
  engine.finish();
}

// --- The god, skill by skill ----------------------------------------------------------

const CAST: SkillId[] = ['rampage', 'shockwave', 'leap', 'vortex', 'smite', 'shield', 'minions'];
const SKILLS: SkillId[] = [...CAST, 'enrage'];

/** How often a god with exactly these skills wins against chat of each size. */
function godWins(skills: SkillId[], sizes: number[], runs: number): number[] {
  return sizes.map((size) => {
    let wins = 0;
    for (let run = 1; run <= runs; run++) {
      const seed = size * 1000 + run;
      const store = channel(size, seed);
      store.setSetting('god_skills', JSON.stringify(skills));
      play(new GodEngine(store, () => T0, seed, 'friendly', 'streamer'), (_battle, result) => {
        if (result.winner === 'god') wins++;
      });
      store.close();
    }
    return wins / runs;
  });
}

function god(): void {
  const runs = Number(values.runs ?? 40);
  const sizes = (values.sizes ?? '3,8,20').split(',').map(Number);
  const mean = (list: number[]) => list.reduce((a, b) => a + b, 0) / list.length;
  console.log(`god wins against chat, ${runs} fights per size (${sizes.join(', ')} per guild)`);
  const report = (label: string, skills: SkillId[]) => {
    const rates = godWins(skills, sizes, runs);
    console.log(`${label.padEnd(10)}${rates.map(pct).join(' ')}   mean ${pct(mean(rates))}`);
    return mean(rates);
  };
  if (values.large) {
    // Only the god's health above `largeChat` fighters, with every skill on: Streamer vs Chat in a big chat.
    let low = 0;
    let high = 1.5;
    for (let i = 0; i < 6; i++) {
      const middle = (low + high) / 2;
      config.god.largeChatExponent = middle;
      const rate = mean(godWins(SKILLS, sizes, runs));
      console.log(`  largeChatExponent ${middle.toFixed(3)}: ${pct(rate)}`);
      if (rate > 0.5) high = middle;
      else low = middle;
    }
    console.log(`largeChatExponent → ${((low + high) / 2).toFixed(2)}`);
    return;
  }
  if (values.mix) {
    // Only the factor for skills together, with the single skills' factors as they are.
    let low = Math.log(0.2);
    let high = Math.log(2);
    for (let i = 0; i < 7; i++) {
      const middle = (low + high) / 2;
      config.skills.mixFactor = Math.exp(middle);
      const rate = mean(godWins(SKILLS, sizes, runs));
      console.log(`  mixFactor ${config.skills.mixFactor.toFixed(3)}: ${pct(rate)}`);
      if (rate > 0.5) high = middle;
      else low = middle;
    }
    console.log(`mixFactor → ${Math.exp((low + high) / 2).toFixed(2)}`);
    return;
  }
  report('all', SKILLS);
  const found: Partial<Record<SkillId, number>> = {};
  for (const skill of SKILLS) {
    report(skill, [skill]);
    if (!values.fit) continue;
    // A search in log space: more health, fewer wins. Enrage alone is always on, so it is fitted alone too.
    const settings = config.skills[skill] as { healthFactor: number };
    const saved = settings.healthFactor;
    let low = Math.log(0.3);
    let high = Math.log(3);
    for (let i = 0; i < 7; i++) {
      const middle = (low + high) / 2;
      settings.healthFactor = Math.exp(middle);
      const rate = mean(godWins([skill], sizes, runs));
      if (rate > 0.5) high = middle;
      else low = middle;
    }
    found[skill] = Math.exp((low + high) / 2);
    settings.healthFactor = saved;
    console.log(`  ${skill}: healthFactor ${saved} → ${found[skill]!.toFixed(2)}`);
  }
  if (values.fit) console.log('\nPut the factors into config.skills, then fit how skills combine with --mix.');
}

// --- Classes ------------------------------------------------------------------------

function classes(): void {
  const runs = Number(values.runs ?? 30);
  const sizes = (values.sizes ?? '6,15,40').split(',').map(Number);
  type Tally = { fighters: number; survived: number; kills: number; damage: number; healing: number };
  const tally = new Map<ClassId, Tally>();
  for (const size of sizes) {
    for (let run = 1; run <= runs; run++) {
      const seed = size * 1000 + run;
      const store = channel(size, seed);
      play(new WarEngine(store, () => T0, seed), (battle) => {
        for (const f of battle.fighters) {
          if (!f.class || f.minion) continue;
          const t = tally.get(f.class) ?? { fighters: 0, survived: 0, kills: 0, damage: 0, healing: 0 };
          t.fighters++;
          if (f.alive) t.survived++;
          t.kills += f.kills;
          t.damage += f.damageDealt;
          t.healing += f.healingDone;
          tally.set(f.class, t);
        }
      });
      store.close();
    }
  }
  const all = [...tally.values()].reduce(
    (sum, t) => ({ fighters: sum.fighters + t.fighters, survived: sum.survived + t.survived, kills: sum.kills + t.kills, damage: sum.damage + t.damage, healing: sum.healing + t.healing }),
    { fighters: 0, survived: 0, kills: 0, damage: 0, healing: 0 },
  );
  const per = (t: Tally, key: keyof Tally) => t[key] / t.fighters;
  const vs = (value: number, average: number) => `${value.toFixed(2).padStart(7)} (${pct(value / average)})`;
  console.log(`War battles, ${runs} Wars per size (${sizes.join(', ')} per guild); in brackets: against the average`);
  console.log(`${'class'.padEnd(9)}${'fighters'.padStart(9)}  ${'survive'.padEnd(16)}${'kills'.padEnd(16)}${'damage'.padEnd(16)}damage+healing`);
  for (const [cls, t] of [...tally].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(
      `${cls.padEnd(9)}${String(t.fighters).padStart(9)}  ${vs(per(t, 'survived'), per(all, 'survived'))}  ${vs(per(t, 'kills'), per(all, 'kills'))}  ` +
        `${vs(per(t, 'damage'), per(all, 'damage'))}  ${vs(per(t, 'damage') + per(t, 'healing'), per(all, 'damage') + per(all, 'healing'))}`,
    );
  }
}

// --- Obstacles ----------------------------------------------------------------------

function obstacles(): void {
  const runs = Number(values.runs ?? 30);
  const sizes = (values.sizes ?? '6,15,40').split(',').map(Number);
  console.log(`War battles, ${runs} Wars per size (${sizes.join(', ')} per guild)`);
  console.log(`${'arena'.padEnd(10)}${'median'.padStart(7)}${'by time'.padStart(9)}  deaths by barrels and traps`);
  for (const place of ['none', ...ARENAS] as const) {
    const lengths: number[] = [];
    let byTime = 0;
    let deaths = 0;
    let byObstacle = 0;
    for (const size of sizes) {
      for (let run = 1; run <= runs; run++) {
        const seed = size * 1000 + run;
        const store = channel(size, seed);
        play(
          new WarEngine(store, () => T0, seed),
          (battle, result) => {
            lengths.push(result.durationMs);
            if (result.endedBy === 'time') byTime++;
            deaths += battle.fighters.filter((f) => !f.alive && !f.minion && !f.benched).length;
            byObstacle += battle.obstacleDeaths;
          },
          place,
        );
        store.close();
      }
    }
    lengths.sort((a, b) => a - b);
    console.log(
      `${place.padEnd(10)}${`${Math.round(lengths[Math.floor(lengths.length / 2)]! / 1000)}s`.padStart(7)}${pct(byTime / lengths.length).padStart(9)}  ${pct(byObstacle / Math.max(1, deaths))}`,
    );
  }
}

// --- Pachinko -----------------------------------------------------------------------

function pachinko(): void {
  const runs = Number(values.runs ?? 4000);
  const sets: [string, number[]][] = [
    ['config', config.pachinko.slots],
    ['flatter', [60, 25, 10, 5, 2, 5, 10, 25, 60]],
    ['steeper middle', [100, 30, 12, 4, 1, 4, 12, 30, 100]],
    ['jackpot 50', [50, 20, 10, 5, 2, 5, 10, 20, 50]],
  ];
  console.log(`Pachinko, ${runs} games of three boards of 10 balls`);
  console.log(`${'slots'.padEnd(16)}${'jackpot'.padStart(9)}${'decides'.padStart(9)}${'half-time leader wins'.padStart(23)}`);
  for (const [label, slots] of sets) {
    const saved = config.pachinko.slots;
    config.pachinko.slots = slots;
    const best = Math.max(...slots);
    let withJackpot = 0;
    let decided = 0;
    let leaderWins = 0;
    for (let seed = 1; seed <= runs; seed++) {
      const players = (n: number) => Array.from({ length: n }, (_, i) => i);
      const game = playPachinko(['red', 'green', 'blue'].map((team) => ({ team, players: players(10) })), createRng(seed));
      const jackpots = game.boards.filter((board) => board.drops.some((d) => d.points === best));
      if (jackpots.length > 0) withJackpot++;
      // Decided by a jackpot: the winner had one, and would not have won without it.
      const winner = game.boards.find((board) => board.team === game.winner)!;
      const jackpotPoints = winner.drops.filter((d) => d.points === best).reduce((sum, d) => sum + d.points, 0);
      if (jackpotPoints > 0 && game.boards.some((board) => board !== winner && board.total > winner.total - jackpotPoints)) decided++;
      // The leader once half the balls have landed.
      const half = game.durationMs / 2;
      const atHalf = game.boards.map((board) => ({ team: board.team, points: board.drops.filter((d) => d.at <= half).reduce((sum, d) => sum + d.points, 0) }));
      atHalf.sort((a, b) => b.points - a.points);
      if (atHalf[0]!.team === game.winner) leaderWins++;
    }
    config.pachinko.slots = saved;
    console.log(`${label.padEnd(16)}${pct(withJackpot / runs).padStart(9)}${pct(decided / runs).padStart(9)}${pct(leaderWins / runs).padStart(23)}`);
  }
}

// --- Duels -------------------------------------------------------------------------

/** Duels of one class: how often the first duelist wins, how often neither does, and how long they last. */
function duelsOf(cls: ClassId, runs: number): { first: number; draws: number; durations: number[]; timeLimit: number } {
  const store = Store.open(':memory:');
  const user = (id: string, guild: 'red' | 'blue'): UserRow =>
    ({ user_id: id, login: id, display_name: id, color: null, emote_id: null, guild_id: guild }) as unknown as UserRow;
  const durations: number[] = [];
  let first = 0;
  let draws = 0;
  let timeLimit = 0;
  for (let run = 0; run < runs; run++) {
    const engine = new DuelEngine(store, () => T0, 1000 + run * 7919, user('a', 'red'), user('b', 'blue'));
    engine.cls = cls;
    play(engine, (_battle, result) => {
      durations.push(result.durationMs);
      if (result.endedBy === 'time') timeLimit++;
      if (result.winner === 'a') first++;
      if (result.winner === null) draws++;
    });
  }
  store.close();
  durations.sort((x, y) => x - y);
  return { first: first / runs, draws: draws / runs, durations, timeLimit: timeLimit / runs };
}

function duel(): void {
  const runs = Number(values.runs ?? 200);
  const classIds = Object.keys(config.classes.shares) as ClassId[];
  const kind = config.pace.kinds.duel;
  const median = (d: number[]) => d[Math.floor((d.length - 1) / 2)]!;
  if (values.fit) {
    // A duel's length follows its toughness closely: a few rounds of scaling settle it.
    for (let round = 1; round <= 4; round++) {
      const all = classIds.flatMap((c) => duelsOf(c, Math.max(30, Math.round(runs / 3))).durations).sort((x, y) => x - y);
      kind.toughness = Math.round(kind.toughness * (config.duel.targetMs / median(all)) * 100) / 100;
      console.log(`round ${round}: median ${Math.round(median(all) / 1000)} s → toughness ${kind.toughness}`);
    }
    console.log(`\npace.kinds.duel.toughness: ${kind.toughness}\n`);
  }
  console.log(`Duels, ${runs} per starting class (both start with it, then switch): the first duelist's wins, draws, and how long they last`);
  console.log(`${'class'.padEnd(9)}${'first'.padStart(7)}${'draws'.padStart(7)}${'10%'.padStart(7)}${'median'.padStart(8)}${'90%'.padStart(7)}  time limit`);
  const all: number[] = [];
  for (const c of classIds) {
    const { first, draws, durations, timeLimit } = duelsOf(c, runs);
    all.push(...durations);
    const at = (q: number) => `${Math.round(durations[Math.floor(q * (durations.length - 1))]! / 1000)} s`;
    console.log(`${c.padEnd(9)}${pct(first).padStart(7)}${pct(draws).padStart(7)}${at(0.1).padStart(7)}${at(0.5).padStart(8)}${at(0.9).padStart(7)}${pct(timeLimit).padStart(12)}`);
  }
  all.sort((x, y) => x - y);
  console.log(`\nAll: shortest tenth ${Math.round(all[Math.floor(0.1 * (all.length - 1))]! / 1000)} s, median ${Math.round(median(all) / 1000)} s, slowest tenth ${Math.round(all[Math.floor(0.9 * (all.length - 1))]! / 1000)} s`);
}

const modes: Record<string, () => void> = { god, classes, obstacles, pachinko, duel };
if (!modes[mode]) {
  console.log('Usage: node src/cli/balance.ts god|classes|obstacles|pachinko|duel [--runs N] [--sizes a,b,c] [--fit]');
  process.exit(1);
}
modes[mode]!();

