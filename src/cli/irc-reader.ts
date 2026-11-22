/**
 * Milestone 1 demo: connect to a channel and print typed chat events.
 *
 *   node src/cli/irc-reader.ts <channel>
 *
 * Logs in anonymously and only reads.
 */
import { IrcClient } from '../irc/client.ts';

const channel = process.argv[2];
if (!channel) {
  console.error('Usage: node src/cli/irc-reader.ts <channel>');
  process.exit(1);
}

const client = new IrcClient({
  channel,
  onStatus: (status) => console.error(`[irc] ${JSON.stringify(status)}`),
  onChat: (event) => console.log(JSON.stringify(event)),
});

process.on('SIGINT', () => {
  client.stop();
  process.exit(0);
});
process.on('SIGTERM', () => {
  client.stop();
  process.exit(0);
});

client.start();
