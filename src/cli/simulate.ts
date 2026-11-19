/**
 * Milestone 2 demo: a fake chat that prints the same typed events as the IRC reader.
 *
 *   node src/cli/simulate.ts                       realtime
 *   node src/cli/simulate.ts --speed 60            one simulated minute per second
 *   node src/cli/simulate.ts --minutes 180         print three hours at once and exit
 *   node src/cli/simulate.ts --chatters 200 --seed 7
 */
import { parseArgs } from 'node:util';
import { config } from '../config.ts';
import { SimulatedChat, SimulatedChatSource } from '../sim/chat.ts';

const { values } = parseArgs({
  options: {
    seed: { type: 'string', default: '1' },
    chatters: { type: 'string', default: String(config.sim.chatterCount) },
    speed: { type: 'string', default: '1' },
    minutes: { type: 'string' },
    channel: { type: 'string', default: 'simchannel' },
  },
});

const seed = Number(values.seed);
const chatterCount = Number(values.chatters);
const speed = Number(values.speed);
if (![seed, chatterCount, speed].every(Number.isFinite)) {
  console.error('--seed, --chatters and --speed must be numbers.');
  process.exit(1);
}

if (values.minutes !== undefined) {
  const minutes = Number(values.minutes);
  const startAt = Date.now();
  const chat = new SimulatedChat({ seed, chatterCount, channel: values.channel, startAt });
  const events = chat.advanceTo(startAt + minutes * 60_000);
  for (const event of events) console.log(JSON.stringify(event));
  console.error(`[sim] ${chat.chatters.length} chatters, ${events.length} messages in ${minutes} minutes`);
} else {
  const source = new SimulatedChatSource({
    seed,
    chatterCount,
    channel: values.channel,
    speed,
    onChat: (event) => console.log(JSON.stringify(event)),
  });
  console.error(`[sim] ${source.chat.chatters.length} chatters, speed x${speed}; Ctrl+C to stop`);
  process.on('SIGINT', () => {
    source.stop();
    process.exit(0);
  });
  source.start();
}
