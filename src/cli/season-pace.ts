/**
 * How fast a season moves: feeds a simulated chat into a fresh game, stream
 * by stream, and prints each guild's Monument, the land level and the
 * mishaps hour by hour. Fights are left out (no Wars, no god's setback), so
 * this measures the land and the Monuments alone.
 *
 *   node src/cli/season-pace.ts                         60 chatters, 12 hours
 *   node src/cli/season-pace.ts --chatters 12 --hours 20 --stream 3 --seed 2
 *   node src/cli/season-pace.ts --season 20 --hours 30   a season set to 20 stream hours
 */
import { parseArgs } from 'node:util';
import { config } from '../config.ts';
import { Store } from '../db/store.ts';
import { SimulatedChat } from '../sim/chat.ts';
const GUILD_IDS = ['red', 'green', 'blue'] as const;

const { values } = parseArgs({
  options: {
    chatters: { type: 'string', default: '60' },
    hours: { type: 'string', default: '12' },
    stream: { type: 'string', default: '3' },
    seed: { type: 'string', default: '1' },
    season: { type: 'string' },
  },
});
const chatters = Number(values.chatters);
const hours = Number(values.hours);
const streamHours = Number(values.stream);
const seed = Number(values.seed);
if (values.season !== undefined) config.season.hours = Number(values.season);

const HOUR = 60 * 60_000;
const start = Date.UTC(2026, 0, 5, 18);
const store = Store.open(':memory:');
const chat = new SimulatedChat({ seed, chatterCount: chatters, channel: 'sim', startAt: start });

let streamed = 0;
let day = 0;
let mishaps = 0;
let seen = 0;
console.log(`${chatters} chatters, streams of ${streamHours} h, a season set to ${config.season.hours} h`);
console.log('hour  leader  monuments (r/g/b)        avg level  mishaps  scale');
while (streamed < hours) {
  const from = start + day * 24 * HOUR;
  const length = Math.min(streamHours, hours - streamed);
  // Chat goes on between streams too; only the stream counts.
  chat.advanceTo(from);
  store.startSession(from);
  for (let h = 1; h <= length; h++) {
    for (const event of chat.advanceTo(from + h * HOUR)) {
      const result = store.recordMessage(event);
      if (result?.seasonWonBy) console.log(`  season won by ${result.seasonWonBy} at hour ${streamed + h}`);
    }
    const recent = store.recentMishaps();
    const fresh = recent.filter((m) => m.id > seen && m.kind !== 'burn' && m.kind !== 'doused' && m.kind !== 'burntOut' && m.kind !== 'harvest');
    mishaps += fresh.length;
    seen = Math.max(seen, ...recent.map((m) => m.id));
    const monuments = store.monuments();
    const land = store.tiles().filter((t) => t.is_city === 0 && t.owner_guild_id !== null && t.tile_id !== '0,0');
    const avg = land.reduce((s, t) => s + t.level, 0) / Math.max(1, land.length);
    const lead = Math.max(...Object.values(monuments));
    console.log(
      `${String(streamed + h).padStart(4)}  ${String(Math.round((lead / store.monumentGoal()) * 1000) / 10).padStart(5)}%  ` +
        `${GUILD_IDS.map((g) => String(Math.round(monuments[g])).padStart(6)).join(' ')}   ` +
        `${avg.toFixed(2).padStart(9)}  ${String(mishaps).padStart(7)}  ${store.channelScale().toFixed(2)}`,
    );
  }
  store.endSession(from + length * HOUR);
  streamed += length;
  day += 2;
}
