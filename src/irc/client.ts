import { config } from '../config.ts';
import { toChatEvent, type ChatMessageEvent } from './events.ts';
import { parseLine } from './parser.ts';

/** The part of a WebSocket the client uses; lets tests supply a fake. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type IrcStatus =
  | { type: 'connecting' }
  | { type: 'connected'; nick: string }
  | { type: 'joined'; channel: string }
  | { type: 'disconnected'; retryInMs: number | null }
  | { type: 'notice'; text: string };

export interface IrcClientOptions {
  channel: string;
  onChat: (event: ChatMessageEvent) => void;
  onStatus?: (status: IrcStatus) => void;
  url?: string;
  createSocket?: (url: string) => SocketLike;
  /** Schedules a callback and returns a function that cancels it. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
  now?: () => number;
  random?: () => number;
}

/**
 * Twitch chat connection with PING handling and reconnect with backoff. It logs
 * in anonymously and only reads; it never writes in chat.
 */
export class IrcClient {
  private readonly channel: string;
  private readonly options: IrcClientOptions;
  private readonly url: string;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly schedule: (callback: () => void, delayMs: number) => () => void;
  private readonly now: () => number;
  private readonly random: () => number;

  private socket: SocketLike | null = null;
  private nick = '';
  private attempt = 0;
  private stopped = true;
  private joined = false;
  private cancelRetry: (() => void) | null = null;

  constructor(options: IrcClientOptions) {
    this.options = options;
    this.channel = options.channel.replace(/^#/, '').toLowerCase();
    this.url = options.url ?? config.irc.url;
    this.createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.schedule =
      options.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      });
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.socket?.close();
  }

  private status(status: IrcStatus): void {
    this.options.onStatus?.(status);
  }

  private open(): void {
    this.status({ type: 'connecting' });
    this.joined = false;
    const socket = this.createSocket(this.url);
    this.socket = socket;

    socket.onopen = () => {
      this.nick = `${config.irc.anonymousNickPrefix}${10_000 + Math.floor(this.random() * 90_000)}`;
      socket.send(`CAP REQ :${config.irc.capabilities.join(' ')}`);
      socket.send(`NICK ${this.nick}`);
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      for (const line of event.data.split('\r\n')) {
        if (line !== '') this.handleLine(socket, line);
      }
    };

    socket.onerror = () => {
      // A close event follows; reconnecting is handled there.
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      const delay = this.stopped ? null : this.nextDelay();
      this.status({ type: 'disconnected', retryInMs: delay });
      if (delay !== null) {
        this.cancelRetry = this.schedule(() => {
          this.cancelRetry = null;
          if (!this.stopped) this.open();
        }, delay);
      }
    };
  }

  private nextDelay(): number {
    const { baseDelayMs, maxDelayMs, jitterMs } = config.irc.reconnect;
    const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** this.attempt);
    this.attempt++;
    return Math.round(delay + this.random() * jitterMs);
  }

  private handleLine(socket: SocketLike, line: string): void {
    const message = parseLine(line);
    if (!message) return;

    switch (message.command) {
      case 'PING':
        socket.send(`PONG :${message.params[0] ?? 'tmi.twitch.tv'}`);
        break;
      case '001':
        this.attempt = 0;
        this.status({ type: 'connected', nick: this.nick });
        socket.send(`JOIN #${this.channel}`);
        break;
      case 'ROOMSTATE':
        if (!this.joined) {
          this.joined = true;
          this.status({ type: 'joined', channel: this.channel });
        }
        break;
      case 'RECONNECT':
        socket.close();
        break;
      case 'NOTICE': {
        this.status({ type: 'notice', text: message.params[message.params.length - 1] ?? '' });
        break;
      }
      case 'PRIVMSG': {
        const event = toChatEvent(message, this.now());
        if (event) this.options.onChat(event);
        break;
      }
    }
  }
}
