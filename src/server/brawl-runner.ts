import { config } from '../config.ts';
import { Brawl, type BrawlEvent, type BrawlFighter, type BrawlWho, type Role } from '../game/brawl.ts';

const B = config.brawl;

/** Bits of a frame's flags. */
export const BRAWL_FLAG = { grounded: 1, stunned: 2 } as const;

/** A fighter as the overlay needs to know it: who, how big, with what, and the bites so far. */
function describe(f: BrawlFighter): object {
  return {
    id: f.id,
    name: f.who.name,
    color: f.who.color,
    emote: f.who.emote ?? null,
    image: f.who.image ?? null,
    role: f.role,
    giant: f.giant,
    r: Math.round(f.r * 10) / 10,
    weapon: f.weapon,
    bites: f.bites,
    kills: f.kills,
  };
}

/**
 * Runs a brawl against the real clock and streams it to the overlay: a
 * `brawl-start` message with everyone on the field, a `brawl-frame` 30 times
 * a second, and `brawl-end` when it is switched off. It runs until stopped.
 */
export class BrawlRunner {
  private readonly send: (message: object) => void;
  private brawl: Brawl | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(send: (message: object) => void) {
    this.send = send;
  }

  get running(): boolean {
    return this.brawl !== null;
  }

  /** How the streamer is on the field right now: as a fighter, as the god, or not at all. */
  streamer(): Role | null {
    return this.brawl?.streamer() ?? null;
  }

  start(seed: number, size: number): void {
    this.begin(seed, size);
    const brawl = this.brawl!;
    const frameMs = 1000 / B.framesPerSecond;
    const startedAt = performance.now();
    let frames = 0;
    this.timer = setInterval(() => {
      if (this.brawl !== brawl) return;
      // Follows the clock: a late timer catches up a few frames, a long pause is skipped.
      const due = Math.floor((performance.now() - startedAt) / frameMs) - frames;
      const run = Math.min(Math.max(due, 1), 4);
      this.tick(run);
      frames += run;
      if (due > 4) frames = Math.floor((performance.now() - startedAt) / frameMs);
    }, frameMs);
  }

  /** Sets up a brawl and announces it, without a clock: `tick` moves it on (the preview pictures do so). */
  begin(seed: number, size: number): void {
    this.stop();
    this.brawl = new Brawl({ seed, size });
    this.send(this.startMessage()!);
  }

  /** Runs `frames` frames' worth of the brawl and sends one frame message. */
  tick(frames = 1): void {
    const brawl = this.brawl;
    if (!brawl) return;
    for (let i = 0; i < frames * B.stepsPerFrame; i++) brawl.step();
    this.sendFrame();
  }

  stop(): void {
    if (!this.brawl) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.brawl = null;
    this.send({ type: 'brawl-end' });
  }

  /** A chatter wrote in chat. */
  write(who: BrawlWho): void {
    this.brawl?.write(who);
  }

  /** The streamer joins as a fighter or as the god; false when that is not possible now. */
  join(who: BrawlWho, role: 'streamer' | 'god'): boolean {
    return this.brawl?.join(who, role) ?? false;
  }

  /** How many chatters fight at once; applies at once to a running brawl. */
  setSize(size: number): void {
    if (this.brawl) this.brawl.size = Math.max(B.minFighters, Math.min(B.maxFighters, Math.round(size)));
  }

  /** Everything a page that connects now needs to show the brawl. */
  startMessage(): object | null {
    const brawl = this.brawl;
    if (!brawl) return null;
    return {
      type: 'brawl-start',
      t: brawl.t,
      size: brawl.size,
      arena: B.arena,
      frameMs: 1000 / B.framesPerSecond,
      weapons: Object.fromEntries(Object.entries(B.weapons).map(([id, w]) => [id, { length: w.length, kind: w.kind, windup: w.windup, swing: w.swing }])),
      layout: brawl.layout,
      twist: brawl.twist,
      god: brawl.god,
      waiting: brawl.queue.length,
      fighters: brawl.alive.map(describe),
    };
  }

  private sendFrame(): void {
    const brawl = this.brawl!;
    const events = brawl.takeEvents().map((e) => this.expand(brawl, e));
    this.send({
      type: 'brawl-frame',
      t: Math.round(brawl.t * 1000),
      f: brawl.alive.map((f) => {
        const w = brawl.weaponOf(f);
        return [
          f.id,
          Math.round(f.x),
          Math.round(f.y),
          Math.round(f.rot * 100),
          f.face,
          Math.round(w.angle * 100),
          Math.round(w.out * 100),
          Math.ceil((f.hp / f.maxHp) * 100),
          (f.grounded ? BRAWL_FLAG.grounded : 0) | (f.stun > 0 ? BRAWL_FLAG.stunned : 0),
          Math.round(w.swing * 100),
        ];
      }),
      waiting: brawl.queue.length,
      size: brawl.size,
      ...(brawl.god ? { toll: brawl.god.toll } : {}),
      ...(events.length > 0 ? { e: events } : {}),
    });
  }

  /** Adds what the overlay cannot know by itself: who joined, the new layout, the names at a god's fall. */
  private expand(brawl: Brawl, e: BrawlEvent): object {
    const find = (id: number | null) => brawl.byId(id);
    if (e.k === 'join') return { ...e, f: describe(find(e.i)!) };
    if (e.k === 'layout') return { ...e, layout: brawl.layout };
    if (e.k === 'godfall') {
      const killer = find(e.by);
      return { ...e, name: find(e.i)?.who.name ?? '', killer: killer ? { name: killer.who.name, color: killer.who.color } : null };
    }
    return e;
  }
}
