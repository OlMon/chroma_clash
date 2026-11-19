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
  | { type: 'auth-failed'; reason: string }
  | { type: 'notice'; text: string };

export interface IrcClientOptions {
  channel: string;
  /** OAuth token with `chat:read`. Without it the client logs in anonymously. */
  token?: string;
  /** Login name belonging to the token. Required when a token is given. */
  login?: string;
  onChat: (event: ChatMessageEvent) => void;
  onStatus?: (status: IrcStatus) => void;
  url?: string;
  createSocket?: (url: string) => SocketLike;
  /** Schedules a callback and returns a function that cancels it. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
  now?: () => number;
  random?: () => number;
}

const AUTH_FAILURES = ['Login authentication failed', 'Improperly formatted auth'];

/**
 * Twitch chat connection with PING handling and reconnect with backoff. It
 * reads; with a token it can also write a line (see `say`).
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
  private authFailed = false;
  private joined = false;
  private cancelRetry: (() => void) | null = null;

  constructor(options: IrcClientOptions) {
    if (options.token && !options.login) {
      throw new Error('A login name is required when a token is given.');
    }
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
    this.authFailed = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.socket?.close();
  }

  /** Whether the client is logged in with a token, and so may write in chat. */
  get canSay(): boolean {
    return Boolean(this.options.token);
  }

  /**
   * Writes one line in the channel's chat. Only with a token (it needs the
   * `chat:edit` scope) and while joined; returns whether the line was sent.
   */
  say(text: string): boolean {
    if (!this.options.token || !this.joined || !this.socket) return false;
    const line = text.replace(/[\r\n]+/g, ' ').trim().slice(0, 450);
    if (line === '') return false;
    this.socket.send(`PRIVMSG #${this.channel} :${line}`);
    return true;
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
      const { token, login } = this.options;
      this.nick = token
        ? login!.toLowerCase()
        : `${config.irc.anonymousNickPrefix}${10_000 + Math.floor(this.random() * 90_000)}`;
      socket.send(`CAP REQ :${config.irc.capabilities.join(' ')}`);
      if (token) socket.send(`PASS oauth:${token.replace(/^oauth:/, '')}`);
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
      const retry = !this.stopped && !this.authFailed;
      const delay = retry ? this.nextDelay() : null;
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
        const text = message.params[message.params.length - 1] ?? '';
        if (AUTH_FAILURES.some((failure) => text.includes(failure))) {
          this.authFailed = true;
          this.status({ type: 'auth-failed', reason: text });
        } else {
          this.status({ type: 'notice', text });
        }
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
