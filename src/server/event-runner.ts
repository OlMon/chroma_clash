import { config } from '../config.ts';
import type { BattleRunner } from './battle-runner.ts';
import type { BattleResult, BattleSetup } from '../game/battle.ts';
import type { BattleMeta } from './battle-runner.ts';

/**
 * What the overlay shows on its large map during an event.
 * - `targets`: tiles under attack, and by whom (a guild id, or `god`).
 * - `changes`: tiles that changed owner; the overlay animates the change.
 * - `held`: tiles that were attacked and kept by their owner.
 */
export interface EventMap {
  targets?: { tile: string; by: string }[];
  changes?: { tile: string; from: string | null; to: string | null; scorched: boolean }[];
  held?: string[];
}

/** What a battle changed, shown on the map after the battle's result. */
export interface EventOutcome {
  title: string;
  subtitle: string;
  map: EventMap;
}

/** One step of an event: a battle to show, or a step that is only announced. */
export interface EventStep {
  /** `skipped` steps are announced and not fought. */
  kind: string;
  title: string;
  subtitle: string;
  /** What the control panel shows while this step runs. */
  label: string;
  /** If set, the announcement shows the large map with these marks. */
  map?: EventMap;
  /** If set, the announcement lists the fighters instead: see `Lineup` in draft-engine.ts. */
  lineup?: unknown;
  /** How long the announcement shows before the battle. Defaults to the War's announcement time. */
  holdMs?: number;
  setup?: BattleSetup;
  meta?: BattleMeta;
  /**
   * Instead of a battle: something the overlay plays by itself, such as
   * Pachinko. `message` goes to the pages after the announcement; the event
   * moves on after `durationMs`. Its outcome is known from the start.
   */
  show?: { message: object; durationMs: number };
}

/**
 * The rules of an event that consists of battles: a War, a Hero Clash, a god
 * event. It has no clock; the runner shows each battle and reports the result.
 */
export interface EventEngine<S extends EventStep = EventStep> {
  next(): S | null;
  /** Applies a battle's result. May return what to show on the map afterwards. */
  apply(step: S, result: BattleResult): { display?: EventOutcome } | void;
  /** Closes the event: rewards and records. Must be safe to call once only. */
  finish(): void;
  /** The banner shown when the event is over. */
  closing(): { title: string; subtitle: string; map?: EventMap };
}

export interface EventRunnerOptions {
  battles: BattleRunner;
  /** Sends a message to the overlay and the control panel. */
  send: (message: object) => void;
  /** Called whenever the game state changed and should be pushed to the pages. */
  onChange: () => void;
  /** Called with the closing summary when an event ran to its end (not when it was stopped). */
  onFinish?: (closing: { title: string; subtitle: string }) => void;
}

/**
 * Drives an event against the real clock: announce a battle, run it, show the
 * result, move on to the next, and close the event with a summary.
 */
export class EventRunner {
  private readonly options: EventRunnerOptions;
  private engine: EventEngine | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private label = '';
  /** The show on screen, such as Pachinko, and when it began: for pages that connect late. */
  private show: { message: object; startedAt: number } | null = null;

  constructor(options: EventRunnerOptions) {
    this.options = options;
  }

  get running(): boolean {
    return this.engine !== null;
  }

  /** What is going on, for the control panel; null when no event is running. */
  get title(): string | null {
    return this.engine ? this.label : null;
  }

  /** The running show's message for a page that connects now, with how far it has got; null without one. */
  showMessage(): object | null {
    return this.show ? { ...this.show.message, elapsedMs: Date.now() - this.show.startedAt } : null;
  }

  /** Starts an event. Throws if a battle or another event is already running. */
  start(engine: EventEngine, label: string): void {
    if (this.engine || this.options.battles.running) throw new Error('A battle is already running.');
    this.engine = engine;
    this.label = label;
    this.advance();
  }

  /** Stops the event after the battles fought so far. Their results stand. */
  stop(): void {
    if (!this.engine) return;
    const engine = this.engine;
    this.engine = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.options.battles.stop();
    engine.finish();
    this.show = null;
    this.options.send({ type: 'show-end' });
    this.options.send({ type: 'announce', title: null });
    this.options.onChange();
  }

  private wait(ms: number, then: () => void): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.engine) then();
    }, ms);
  }

  private advance(): void {
    const engine = this.engine;
    if (!engine) return;
    const { send, battles, onChange } = this.options;
    const step = engine.next();

    if (!step) {
      engine.finish();
      this.engine = null;
      const closing = engine.closing();
      send({ type: 'announce', ...closing, holdMs: config.war.summaryHoldMs });
      onChange();
      this.options.onFinish?.(closing);
      return;
    }

    this.label = step.label;
    onChange();
    send({
      type: 'announce',
      title: step.title,
      subtitle: step.subtitle,
      map: step.map,
      lineup: step.lineup,
      holdMs: step.holdMs ?? config.war.announceMs,
    });

    if (step.kind === 'skipped') {
      this.wait(config.war.announceMs, () => this.advance());
      return;
    }
    const show = step.show;
    if (show) {
      this.wait(step.holdMs ?? config.war.announceMs, () => {
        send(show.message);
        this.show = { message: show.message, startedAt: Date.now() };
        this.wait(show.durationMs, () => {
          this.show = null;
          send({ type: 'show-end' });
          this.advance();
        });
      });
      return;
    }
    this.wait(step.holdMs ?? config.war.announceMs, () => {
      battles.start(step.setup!, step.meta!, (result) => {
        // A null result means the battle was stopped; stop() handles the rest.
        if (!result || this.engine !== engine) return;
        const display = engine.apply(step, result)?.display;
        onChange();
        this.wait(config.war.resultHoldMs, () => {
          if (!display) {
            this.advance();
            return;
          }
          // Back to the map: show what the battle changed before moving on.
          send({ type: 'announce', ...display, holdMs: config.war.outcomeMs });
          this.wait(config.war.outcomeMs, () => this.advance());
        });
      });
    });
  }
}
