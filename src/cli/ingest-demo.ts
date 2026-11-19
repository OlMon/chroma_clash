/**
 * Demo: feed simulated chat into a database with the background layer on,
 * then print the guilds with their land and Monuments, and the most active chatters.
 *
 *   node src/cli/ingest-demo.ts [--minutes 180] [--chatters 60] [--seed 1] [--db :memory:]
 */
import { parseArgs } from 'node:util';
import { config } from '../config.ts';
import { Store } from '../db/store.ts';
import { SimulatedChat } from '../sim/chat.ts';

const { values } = parseArgs({
  options: {
    seed: { type: 'string', default: '1' },
    chatters: { type: 'string', default: String(config.sim.chatterCount) },
    minutes: { type: 'string', default: '180' },
    db: { type: 'string', default: ':memory:' },
  },
});

const startAt = Date.now();
const chat = new SimulatedChat({
  seed: Number(values.seed),
  chatterCount: Number(values.chatters),
  channel: 'simchannel',
  startAt,
});
const store = Store.open(values.db);
const session = store.startSession(startAt);
const events = chat.advanceTo(startAt + Number(values.minutes) * 60_000);

let ticks = 0;
store.transaction(() => {
  for (const event of events) {
    if (store.recordMessage(event)?.tickAwarded) ticks++;
  }
});

console.log(`${events.length} messages in ${values.minutes} minutes earned ${ticks} ticks`);
console.log(
  `channel size: ${store.measuredChatters()?.toFixed(1)} active chatters per window, ` +
    `cost scale ${store.channelScale().toFixed(2)}\n`,
);
const sizes = store.guildSizes();
const monuments = store.monuments();
for (const guild of config.guilds.list) {
  const share = ((monuments[guild.id] / config.monument.goal) * 100).toFixed(1);
  console.log(
    `${guild.name.padEnd(6)} ${String(sizes[guild.id]).padStart(3)} members, ${store.ownedTiles(guild.id)} tiles, ` +
      `development ${store.development(guild.id)}, Monument ${Math.round(monuments[guild.id])} of ${config.monument.goal} (${share}%)`,
  );
}

console.log('\nMost active this session:');
for (const user of store.topTickers(session.session_id, 5)) {
  console.log(
    `  ${user.display_name.padEnd(16)} ${user.guild_id.padEnd(6)} ` +
      `${String(user.ticks).padStart(3)} ticks  ${user.xp} XP  level ${user.level}`,
  );
}
store.close();
