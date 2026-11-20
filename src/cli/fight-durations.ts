/**
 * Balancing aid: how long the fights last. Runs every kind of event through
 * its real engine, with chat of a few sizes, fights each battle without
 * drawing it (with obstacles and the map banner, as the live game does), and
 * prints the battle lengths per kind. The target is 60 to 90 seconds a fight.
 *
 *   node src/cli/fight-durations.ts [--runs 6] [--sizes 6,15,40]
 */
import { parseArgs } from 'node:util';
import { config } from '../config.ts';
import type { UserRow } from '../db/store.ts';
import { Battle } from '../game/battle.ts';
import { playPachinko } from '../game/pachinko.ts';
import { ClashEngine } from '../server/clash-engine.ts';
import { DraftEngine, drawFighters } from '../server/draft-engine.ts';
import type { EventEngine } from '../server/event-runner.ts';
import { GodEngine } from '../server/god-engine.ts';
import { WarEngine } from '../server/war-engine.ts';
import { createRng } from '../util/rng.ts';
import { T0, asRunner, channel } from './sim-support.ts';

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '6' },
    sizes: { type: 'string', default: '6,15,40' },
    /** Only these kinds: war, clash, draft, god, pachinko. */
    kinds: { type: 'string', default: 'war,clash,draft,god,pachinko' },
  },
});
const kinds = new Set(values.kinds.split(','));
const runs = Number(values.runs);
const sizes = values.sizes.split(',').map(Number);

const lengths = new Map<string, { ms: number[]; byTime: number; godWins: number }>();
function note(kind: string, ms: number, byTime: boolean, godWon = false): void {
  const entry = lengths.get(kind) ?? { ms: [], byTime: 0, godWins: 0 };
  entry.ms.push(ms);
  if (byTime) entry.byTime++;
  if (godWon) entry.godWins++;
  lengths.set(kind, entry);
}

/** Runs an event to its end, fighting each battle; `label` names the battle for the report. */
function play(engine: EventEngine, label: (step: { label: string; title: string }) => string): void {
  for (let step = engine.next(); step; step = engine.next()) {
    if (!step.setup) continue;
    const result = new Battle(asRunner(step.setup)).run();
    note(label(step), result.durationMs, result.endedBy === 'time', result.winner === 'god');
    engine.apply(step, result);
  }
  engine.finish();
}

for (const size of sizes) {
  for (let run = 1; run <= runs; run++) {
    const seed = size * 1000 + run;
    const now = () => T0;
    let store = channel(size, seed);
    if (kinds.has('war')) play(new WarEngine(store, now, seed), () => `War battle (${size}/guild)`);
    store.close();

    store = channel(size, seed);
    if (kinds.has('clash')) play(new ClashEngine(store, now, seed), (s) => `Hero Clash ${/final/i.test(s.title) ? 'final' : 'heat'} (${size}/guild)`);
    store.close();

    for (const mode of kinds.has('draft') ? (['guild', 'free'] as const) : []) {
      store = channel(size, seed);
      const picks = drawFighters(store.recentlyActive(0) as UserRow[], mode, createRng(seed));
      try {
        play(new DraftEngine(store, now, seed, mode, picks), () => `${mode === 'guild' ? 'Guild Clash' : 'Free-for-all'} (${size}/guild)`);
      } catch {
        // Too few for this draw.
      }
      store.close();
    }

    for (const kind of kinds.has('god') ? (['wrath', 'friendly'] as const) : []) {
      store = channel(size, seed);
      try {
        play(new GodEngine(store, now, seed, kind, 'streamer'), () => `${kind === 'wrath' ? "God's Wrath" : 'Streamer vs Chat'} (${size}/guild)`);
      } catch {
        // Not available in this state.
      }
      store.close();
    }

    if (!kinds.has('pachinko')) continue;
    const players = (n: number) => Array.from({ length: Math.min(n, config.draft.perGuild) }, (_, i) => i);
    const game = playPachinko(
      ['red', 'green', 'blue'].map((team) => ({ team, players: players(size) })),
      createRng(seed),
    );
    note(`Pachinko (${size}/guild)`, game.durationMs, false);
  }
}

const pad = (text: string, width: number) => text.padEnd(width);
const seconds = (ms: number) => `${(ms / 1000).toFixed(0)}s`;
console.log(`${pad('fight', 34)}${pad('count', 7)}${pad('median', 8)}${pad('min', 6)}${pad('max', 6)}${pad('by time', 9)}god won`);
for (const [kind, { ms, byTime, godWins }] of [...lengths].sort(([a], [b]) => a.localeCompare(b))) {
  const sorted = [...ms].sort((a, b) => a - b);
  console.log(
    `${pad(kind, 34)}${pad(String(ms.length), 7)}${pad(seconds(sorted[Math.floor(sorted.length / 2)]!), 8)}` +
      `${pad(seconds(sorted[0]!), 6)}${pad(seconds(sorted[sorted.length - 1]!), 6)}` +
      `${pad(`${Math.round((byTime / ms.length) * 100)}%`, 9)}${/God|Streamer/.test(kind) ? `${Math.round((godWins / ms.length) * 100)}%` : ''}`,
  );
}
