import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IrcClient, type IrcStatus, type SocketLike } from '../../src/irc/client.ts';
import type { ChatMessageEvent } from '../../src/irc/events.ts';

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
  receive(...lines: string[]): void {
    this.onmessage?.({ data: lines.join('\r\n') + '\r\n' });
  }
}

function setup(options: { token?: string; login?: string } = {}) {
  const sockets: FakeSocket[] = [];
  const scheduled: { callback: () => void; delayMs: number }[] = [];
  const statuses: IrcStatus[] = [];
  const chats: ChatMessageEvent[] = [];
  const client = new IrcClient({
    channel: '#SomeChannel',
    ...options,
    onChat: (event) => chats.push(event),
    onStatus: (status) => statuses.push(status),
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    schedule: (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
      return () => {};
    },
    now: () => 1000,
    random: () => 0,
  });
  return { client, sockets, scheduled, statuses, chats };
}

test('logs in anonymously, joins after the welcome, and reports status', () => {
  const { client, sockets, statuses } = setup();
  client.start();
  const socket = sockets[0]!;
  socket.onopen?.();
  assert.deepEqual(socket.sent, [
    'CAP REQ :twitch.tv/tags twitch.tv/commands',
    'NICK justinfan10000',
  ]);

  socket.receive(':tmi.twitch.tv 001 justinfan10000 :Welcome, GLHF!');
  assert.equal(socket.sent.at(-1), 'JOIN #somechannel');

  socket.receive('@room-id=1 :tmi.twitch.tv ROOMSTATE #somechannel');
  assert.deepEqual(statuses, [
    { type: 'connecting' },
    { type: 'connected', nick: 'justinfan10000' },
    { type: 'joined', channel: 'somechannel' },
  ]);
});

test('sends PASS before NICK when a token is given', () => {
  const { client, sockets } = setup({ token: 'oauth:abc', login: 'MyBot' });
  client.start();
  sockets[0]!.onopen?.();
  assert.deepEqual(sockets[0]!.sent, [
    'CAP REQ :twitch.tv/tags twitch.tv/commands',
    'PASS oauth:abc',
    'NICK mybot',
  ]);
});

test('answers PING and emits chat events, also for several lines in one frame', () => {
  const { client, sockets, chats } = setup();
  client.start();
  const socket = sockets[0]!;
  socket.onopen?.();
  socket.receive(
    'PING :tmi.twitch.tv',
    '@color=#FF0000;display-name=A;user-id=1 :a!a@a.tmi.twitch.tv PRIVMSG #somechannel :hi',
  );
  assert.equal(socket.sent.at(-1), 'PONG :tmi.twitch.tv');
  assert.equal(chats.length, 1);
  assert.equal(chats[0]!.text, 'hi');
  assert.equal(chats[0]!.sentAt, 1000);
});

test('reconnects on RECONNECT and backs off on repeated connection loss', () => {
  const { client, sockets, scheduled } = setup();
  client.start();
  sockets[0]!.onopen?.();
  sockets[0]!.receive(':tmi.twitch.tv RECONNECT');
  assert.equal(sockets[0]!.closed, true);
  assert.equal(scheduled[0]!.delayMs, 1000);

  scheduled[0]!.callback();
  assert.equal(sockets.length, 2);
  sockets[1]!.close();
  assert.equal(scheduled[1]!.delayMs, 2000);

  scheduled[1]!.callback();
  sockets[2]!.onopen?.();
  sockets[2]!.receive(':tmi.twitch.tv 001 justinfan10000 :Welcome, GLHF!');
  sockets[2]!.close();
  assert.equal(scheduled[2]!.delayMs, 1000, 'backoff resets after a successful login');
});

test('does not reconnect after an authentication failure or after stop()', () => {
  const failed = setup({ token: 'bad', login: 'bot' });
  failed.client.start();
  failed.sockets[0]!.onopen?.();
  failed.sockets[0]!.receive(':tmi.twitch.tv NOTICE * :Login authentication failed');
  failed.sockets[0]!.close();
  assert.equal(failed.scheduled.length, 0);
  assert.deepEqual(failed.statuses.at(-1), { type: 'disconnected', retryInMs: null });

  const stopped = setup();
  stopped.client.start();
  stopped.client.stop();
  assert.equal(stopped.sockets[0]!.closed, true);
  assert.equal(stopped.scheduled.length, 0);
});
