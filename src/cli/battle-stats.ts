/**
 * Tuning aid: runs many battles without drawing them and prints win rates and
 * durations for a few typical match-ups.
 *
 *   node src/cli/battle-stats.ts [--runs 300]
 */
import { parseArgs } from 'node:util';
import type { GuildId } from '../config.ts';
import { Battle, type FighterSpec, type SideSpec } from '../game/battle.ts';

const { values } = parseArgs({ options: { runs: { type: 'string', default: '300' } } });
const runs = Number(values.runs);

function squad(side: GuildId, count: number, level: number): FighterSpec[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${side}${i}`, name: '', color: null, side, level }));
}

interface Team {
  id: GuildId;
  size: number;
  level?: number;
  damageBonus?: number;
  healthBonus?: number;
}

function report(label: string, teams: Team[]): void {
  const wins = new Map<string, number>();
  let totalMs = 0;
  let byTime = 0;
  for (let seed = 1; seed <= runs; seed++) {
    const sides: SideSpec[] = teams.map((t) => ({
      id: t.id,
      damageBonus: t.damageBonus ?? 0,
      healthBonus: t.healthBonus ?? 0,
    }));
    const fighters = teams.flatMap((t) => squad(t.id, t.size, t.level ?? 0));
    const result = new Battle({ seed, sides, fighters }).run();
    wins.set(result.winner ?? 'nobody', (wins.get(result.winner ?? 'nobody') ?? 0) + 1);
    totalMs += result.durationMs;
    if (result.endedBy === 'time') byTime++;
  }
  const rates = [...teams.map((t) => t.id as string), 'nobody']
    .filter((id) => wins.has(id) || id !== 'nobody')
    .map((id) => `${id} ${Math.round(((wins.get(id) ?? 0) / runs) * 100)}%`)
    .join(', ');
  console.log(
    `${label.padEnd(44)} ${rates.padEnd(40)} avg ${(totalMs / runs / 1000).toFixed(1)}s, ` +
      `${Math.round((byTime / runs) * 100)}% by time limit`,
  );
}

console.log(`${runs} battles per row\n`);
report('5 vs 5, equal', [{ id: 'red', size: 5 }, { id: 'blue', size: 5 }]);
report('20 vs 20, equal', [{ id: 'red', size: 20 }, { id: 'blue', size: 20 }]);
report('40 vs 40, equal', [{ id: 'red', size: 40 }, { id: 'blue', size: 40 }]);
report('10 vs 30 (size balance)', [{ id: 'red', size: 10 }, { id: 'blue', size: 30 }]);
report('10 vs 20 (size balance)', [{ id: 'red', size: 10 }, { id: 'blue', size: 20 }]);
report('30 vs 40 (size balance)', [{ id: 'red', size: 30 }, { id: 'blue', size: 40 }]);
report('15 vs 20 (size balance)', [{ id: 'red', size: 15 }, { id: 'blue', size: 20 }]);
report('3 vs 40 (size balance, clamped)', [{ id: 'red', size: 3 }, { id: 'blue', size: 40 }]);
report('20 vs 20, red Barracks 5 (+10% damage)', [{ id: 'red', size: 20, damageBonus: 0.1 }, { id: 'blue', size: 20 }]);
report('20 vs 20, red Barracks 10 (+20% damage)', [{ id: 'red', size: 20, damageBonus: 0.2 }, { id: 'blue', size: 20 }]);
report('20 vs 20, blue Walls +30% health', [{ id: 'red', size: 20 }, { id: 'blue', size: 20, healthBonus: 0.3 }]);
report('20 vs 20, red all level 15 (+30% health)', [{ id: 'red', size: 20, level: 15 }, { id: 'blue', size: 20 }]);
report('20 vs 20 vs 20', [{ id: 'red', size: 20 }, { id: 'green', size: 20 }, { id: 'blue', size: 20 }]);
report('15 vs 20 vs 25', [{ id: 'red', size: 15 }, { id: 'green', size: 20 }, { id: 'blue', size: 25 }]);
report('10 vs 20 vs 30', [{ id: 'red', size: 10 }, { id: 'green', size: 20 }, { id: 'blue', size: 30 }]);
