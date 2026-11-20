import { config, type ClassId, type SkillId } from '../config.ts';
import { createRng, type Rng } from '../util/rng.ts';
import { Obstacles, type ArenaId, type ClearZone, type FrameObstacle, type ObstacleMode } from './obstacles.ts';

export interface FighterSpec {
  id: string;
  name: string;
  /** The chatter's name color, or null to use the side's color. */
  color: string | null;
  /** The emote the fighter is drawn as, or null for a plain circle. Looks only. */
  emote?: string | null;
  /** The address of a picture the fighter is drawn as, instead of an emote. Looks only. */
  image?: string | null;
  /** Draws a crown on the fighter: the session's Hero Clash champion. Looks only. */
  crown?: boolean;
  /** Drawn as one of the streamer's imps, in its side's color, without a name: a filler for an empty place. Looks only. */
  imp?: boolean;
  /**
   * Multiplies the fighter's health and damage: the streamer's imps that fill
   * a small fight are weaker, and the chatters who lead them a little stronger
   * (see `config.smallChat`).
   */
  strength?: number;
  /** A chatter fighting beside imps or doubles: the overlay flies a banner over their name. Looks only. */
  leader?: boolean;
  /**
   * A double the god made of the fighter with this id, in a small chat: it
   * starts beside it, never makes a highlight, and earns nothing.
   */
  doubleOf?: string;
  /**
   * The fighter's class for this fight: its stats and how it behaves. See
   * `config.classes`. Fighters with stat overrides, such as the god, have none.
   */
  class?: ClassId | null;
  /** The side the fighter belongs to: a guild id in a War, other ids in special events. */
  side: string;
  level: number;
  /**
   * Overrides for special fighters such as the god. A fighter with an
   * override gets exactly that value: no level, building, balance or fortune
   * multiplier is applied to it.
   */
  health?: number;
  damage?: number;
  radius?: number;
  speed?: number;
  /** If set, each hit also strikes every enemy within this distance of the target. */
  splashRadius?: number;
  /**
   * How hard the fighter is to push aside, relative to a normal fighter's 1.
   * When two fighters overlap, each gives way in proportion to the other's weight.
   */
  weight?: number;
  /** Skills the fighter casts during the battle. See `config.skills`. */
  skills?: SkillId[];
  /**
   * The fighter does not chase anyone: it holds the middle of the arena,
   * drifting a little, and strikes whoever comes within reach. Everyone else
   * starts in a ring around it. Used for the god, so it can be attacked from
   * all sides and never ends up against an edge.
   */
  holdsCenter?: boolean;
}

export interface SideSpec {
  id: string;
  /** Sides with the same team fight together. Defaults to the side's own id. */
  team?: string;
  /** From the Barracks, e.g. 0.06 for +6% damage. */
  damageBonus: number;
  /** From the Walls when defending, e.g. 0.09 for +9% health. */
  healthBonus: number;
}

/** A rectangle fighters stay out of. */
export interface ClearArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface BattleSetup {
  seed: number;
  sides: SideSpec[];
  fighters: FighterSpec[];
  durationMs?: number;
  /** Apply the size balance between sides. Default true. */
  sizeBalance?: boolean;
  /** Apply the fortune of battle. Default true. */
  fortune?: boolean;
  /** Apply the health bonus from chatter levels. Default true. */
  levelBonus?: boolean;
  /**
   * A team that wins if it is still standing at the time limit, whatever the
   * remaining health. Used for the god: chat must bring it down in time.
   */
  timeLimitWinner?: string;
  /**
   * Limits how many fighters are on the field at once; the others wait on a
   * bench and step in when someone falls. `perSide` limits each side, `total`
   * the whole field. A team is beaten only when its bench is empty too.
   */
  field?: { perSide?: number; total?: number };
  /**
   * The battle never ends: fallen fighters rejoin the bench after a while.
   * Only useful together with `field`.
   */
  endless?: boolean;
  /**
   * Rectangles of the arena fighters may not enter, in arena units.
   */
  keepClear?: ClearArea[];
  /**
   * Obstacles: `fixed`, a layout for the whole fight (only in some battles,
   * see `config.obstacles.chance`), or `changing`, obstacles that come and go.
   * Without it, none.
   */
  obstacles?: ObstacleMode;
  /** With `fixed` obstacles: this arena, always, instead of one by chance (for tests and previews). */
  place?: ArenaId;
  /**
   * Multiplies every fighter's health in this battle, the god's and its
   * minions' included, and healing and obstacle damage with it: a fight
   * lasts about this many times longer. Each kind of fight has its own (see
   * `config.pace`), so every kind lasts about as long.
   */
  toughness?: number;
  /**
   * The arena of this battle, when it is not `config.battle.arena`: shorter,
   * for example, when the map banner takes a strip of the screen.
   */
  arena?: Arena;
}

/** The field a battle is fought on, in arena units. See `config.battle.arena`. */
export interface Arena {
  width: number;
  height: number;
  /** Kept free for the scoreboard. */
  top: number;
  /** No fighter comes nearer than this to the left, right and bottom edge. */
  margin: number;
}

/** A skill being announced (`warn`) or carried out (`act`). */
interface ActiveSkill {
  skill: SkillId;
  phase: 'warn' | 'act';
  /** Battle time at which the phase ends. */
  until: number;
  /** Where the skill is aimed: the leap's landing point, otherwise the caster's position. */
  x: number;
  y: number;
  /** Rampage: direction of travel and wall bounces left. */
  vx: number;
  vy: number;
  bounces: number;
  /** Smite: the fighters that will be struck. */
  targets: Fighter[];
  /** Rampage: when each fighter was last run over. */
  lastHit: Map<Fighter, number>;
  /** Vortex: the fighters each whirlwind is about to catch. */
  groups: Fighter[][];
  /** Rampage: true on the last leg, back to the middle of the arena. */
  returning: boolean;
}

/** Burning ground: it hurts the enemies of the fighter that set it, at intervals, until it burns out. */
interface Fire {
  owner: Fighter;
  x: number;
  y: number;
  r: number;
  until: number;
  nextTickAt: number;
}

/** A whirlwind: it holds its fighters in a turning ring and wanders across the arena. */
interface Whirlwind {
  caster: Fighter;
  members: Fighter[];
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  orbit: number;
  until: number;
}

/** The god's move in progress between skills: a dash, or a run across the screen's edge. */
/**
 * A fighter thrown through the air (see `config.flight`): its direction, its
 * average speed in arena units per second, and when the throw began and ends.
 * It slows down along the way.
 */
interface Flight {
  vx: number;
  vy: number;
  speed: number;
  from: number;
  until: number;
  /** When it last bounced off a bumper, so one bumper sends it off only once. */
  bumpedAt?: number;
}

/** A fighter breaking out of a crowd: see `config.roam`. */
interface Roam {
  /** When it next checks whether it has been standing still, and where it stood at the last check. */
  checkAt: number;
  x: number;
  y: number;
  /** The far enemy it goes for, until `until`; null while it goes for the nearest as usual. */
  target: Fighter | null;
  until: number;
}

interface Maneuver {
  kind: 'dash' | 'wrap';
  vx: number;
  vy: number;
  /** Distance still to go; for a wrap, counted from when it came back in. */
  left: number;
  /** For a wrap: whether it has crossed the edge yet. */
  wrapped: boolean;
  /** Chatters already knocked aside by this move. */
  hit: Set<Fighter>;
}

interface SkillState {
  nextCastAt: number;
  /** When the god's next move between skills may start (see `config.god.moves`). */
  nextMoveAt: number;
  active: ActiveSkill | null;
  /** Minions that have not been summoned yet. */
  reserves: Fighter[];
}

export interface Fighter extends FighterSpec {
  team: string;
  x: number;
  y: number;
  radius: number;
  health: number;
  maxHealth: number;
  damage: number;
  speed: number;
  weight: number;
  cooldownMs: number;
  alive: boolean;
  kills: number;
  damageDealt: number;
  /** Health given back to allies (healers), in the same units as `damageDealt`: for the balancing tools. */
  healingDone: number;
  /** True if the fighter was hit in the most recent step. */
  hit: boolean;
  /** Class behavior: when the class's special move is next ready, and a thief's dart back. */
  nextSpecialAt: number;
  retreatUntil: number;
  retreatX: number;
  retreatY: number;
  /** Battle time until which a thief is hidden in the shadows: it cannot be targeted or hurt. */
  hiddenUntil: number;
  /** The god's move between skills, while it runs. */
  maneuver: Maneuver | null;
  /** Breaking out of a crowd (`config.roam`): where it stood at the last check, and the far enemy it goes for, if any. */
  roam: Roam | null;
  /** Battle time of the latest jump (a blink, or crossing the screen's edge): the overlay does not slide across it. */
  jumpedAt: number;
  /** Battle time until which the fighter moves slowly, or cannot be hurt. */
  slowUntil: number;
  shieldUntil: number;
  /** Battle time until which the fighter shows the marks of a lightning strike. Looks only. */
  scorchedUntil: number;
  /** Set while the fighter is hurled through the air: direction and the time it lands. */
  flight: Flight | null;
  /** True while a whirlwind carries the fighter. */
  spinning: boolean;
  /** Waiting on the bench: not on the field, but not beaten. `enterAt` is the earliest time to step in. */
  benched: boolean;
  enterAt: number;
  enraged: boolean;
  /** A summoned helper. `spawned` is false until it has been summoned. */
  minion: boolean;
  spawned: boolean;
  owner: Fighter | null;
  skillState: SkillState | null;
}

export interface BattleResult {
  /** The winning team, or null when nobody won: all fell at once, or a tie at the time limit. */
  winner: string | null;
  endedBy: 'elimination' | 'time' | 'walkover';
  durationMs: number;
  sides: { id: string; team: string; fighters: number; survivors: number; health: number; damageDealt: number }[];
  /** Minions are not listed. */
  fighters: { id: string; side: string; kills: number; alive: boolean; damageDealt: number }[];
}

/** Flags in a frame: hit this step, slowed, shielded, enraged, hurled through the air, scorched, caught in a whirlwind. */
export const FLAG = {
  hit: 1,
  slowed: 2,
  shielded: 4,
  enraged: 8,
  flying: 16,
  scorched: 32,
  spinning: 64,
  /** Set on a fighter that is off the field but waiting on the bench, not beaten. */
  benched: 128,
  /** A thief hidden in the shadows. */
  hidden: 256,
  /** The fighter jumped (the god's blink, or its run across the screen's edge): show it there at once. */
  jumped: 512,
} as const;

/** One fighter in a frame: x, y, health as a share from 0 to 1 (0 = dead or not summoned), flags. */
export type FrameFighter = [x: number, y: number, health: number, flags: number];

/**
 * Something the overlay should show: a skill being announced (`warn`) or cast,
 * a fighter stepping in from the bench (`enter`, with no skill), or a class
 * effect (`fx`): a spin, an arrow, a mage's blast, a heal.
 * `i` is the caster's index in the roster, `t` the indices of targeted
 * fighters, `r` a radius, `ms` how long the warning or the effect lasts,
 * `dx`, `dy` a direction, `g` groups of fighter indices (one per whirlwind),
 * and `d` how long each group's effect lasts.
 */
/** What dealt a fighter's last blow: a class's attack, one of the god's skills, its fire, or an obstacle. */
export type DeathCause =
  | 'strike' | 'arrow' | 'spin' | 'blast'
  | 'rampage' | 'shockwave' | 'leap' | 'smite' | 'fire'
  | 'barrel' | 'trap';

/**
 * Why a death is worth a line in the overlay's highlights, most important
 * first: the god falls, the last fighter of a side, the crown holder, a
 * fighter on a streak of kills, a killer reaching a spree, a death by the
 * god's skills or an obstacle, the battle's first death, and an ordinary
 * kill after a quiet while (`config.highlights.quietMs`), so a large fight
 * where kills spread thin still gets a line now and then.
 */
export const HIGHLIGHTS = ['godFalls', 'last', 'crown', 'streak', 'spree', 'cause', 'firstBlood', 'kill'] as const;
export type Highlight = (typeof HIGHLIGHTS)[number];

/** Deaths whose cause alone makes them a highlight. */
const NOTABLE_CAUSES: ReadonlySet<DeathCause> = new Set(['rampage', 'shockwave', 'leap', 'smite', 'fire', 'barrel', 'trap']);

export interface BattleEvent {
  /**
   * `death`: a noteworthy death, for the highlights: `i` fell to `b` (-1: nobody) by `c`, worth a line for `h`.
   * `hit`: a big hit (see `config.battle.bigHit`) on `i`, by `c`: `v` its damage, `l` 1 when it was the killing blow.
   */
  k: 'warn' | 'cast' | 'enter' | 'fx' | 'death' | 'hit';
  s?: SkillId;
  /** For `fx`: a class effect, one of spin, arrow, blast-warn, blast, heal, shadow. */
  fx?: string;
  i: number;
  x: number;
  y: number;
  r?: number;
  ms?: number;
  t?: number[];
  dx?: number;
  dy?: number;
  g?: number[][];
  d?: number[];
  b?: number;
  c?: DeathCause;
  h?: Highlight;
  v?: number;
  l?: number;
}

export function levelHealthMultiplier(level: number): number {
  const { levelHealthBonus, maxLevelHealthBonus } = config.battle;
  return 1 + Math.min(maxLevelHealthBonus, levelHealthBonus * Math.max(0, level));
}

/** Multiplier on health and damage that softens uneven side sizes. */
export function sizeBalance(ownSize: number, sideSizes: readonly number[]): number {
  const { sizeBalanceMin, sizeBalanceMax } = config.battle;
  const average = sideSizes.reduce((sum, n) => sum + n, 0) / sideSizes.length;
  const exponent =
    sideSizes.length > 2
      ? config.battle.sizeBalanceExponentThreeWay
      : config.battle.sizeBalanceExponent;
  const factor = (average / ownSize) ** exponent;
  return Math.min(sizeBalanceMax, Math.max(sizeBalanceMin, factor));
}

/**
 * Draws the fighters of one side when more are eligible than fit on screen.
 * Heroes always get a place; the rest is drawn by lot.
 */
export function selectFighters<T extends { id: string }>(
  eligible: readonly T[],
  heroIds: ReadonlySet<string>,
  rng: Rng,
  cap = config.battle.maxFightersPerSide,
): T[] {
  if (eligible.length <= cap) return [...eligible];
  const heroes = eligible.filter((f) => heroIds.has(f.id)).slice(0, cap);
  const rest = eligible.filter((f) => !heroIds.has(f.id));
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [rest[i], rest[j]] = [rest[j]!, rest[i]!];
  }
  return [...heroes, ...rest.slice(0, cap - heroes.length)];
}

/** A fighter's radius for a battle with this many fighters: larger when there are few. */
export function radiusFor(fighterCount: number): number {
  const { fighterRadius, maxFighterRadius, radiusReferenceCount } = config.battle;
  const scaled = fighterRadius * Math.sqrt(radiusReferenceCount / Math.max(1, fighterCount));
  return Math.min(maxFighterRadius, Math.max(fighterRadius, scaled));
}

/**
 * Deals every fighter a class at random, by the shares in `config.classes`.
 * Fighters that already have one, and special fighters with their own stats
 * (the god), are left alone.
 */
export function assignClasses(fighters: FighterSpec[], rng: Rng): void {
  const shares = Object.entries(config.classes.shares) as [ClassId, number][];
  const total = shares.reduce((sum, [, share]) => sum + share, 0);
  for (const fighter of fighters) {
    if (fighter.class !== undefined || fighter.health !== undefined || fighter.holdsCenter) continue;
    let roll = rng() * total;
    fighter.class = shares[shares.length - 1]![0];
    for (const [id, share] of shares) {
      roll -= share;
      if (roll < 0) {
        fighter.class = id;
        break;
      }
    }
  }
}

/**
 * The god's health against this many fighters, before the per-fight variation
 * and the skill factor: the health at which a god without skills wins half its
 * fights against a chat without bonuses. See `config.god`.
 */
export function godHealth(opponents: number): number {
  const { healthBase, healthExponent, largeChat, largeChatExponent } = config.god;
  const n = Math.max(1, opponents);
  const health = healthBase * Math.min(n, largeChat) ** healthExponent;
  return n > largeChat ? health * (n / largeChat) ** largeChatExponent : health;
}

/**
 * How much health a fighter with these skills should have, relative to the
 * god's health curve, for an even fight. Only one skill is cast at a time, so
 * the cast skills share their effect: their factors are averaged
 * (geometrically). Enrage is always active when enabled, so its factor
 * multiplies on top. Several skills together are worth less than that says:
 * `mixFactor`, in full with every skill and by a share with fewer.
 */
export function skillHealthFactor(skills: readonly SkillId[]): number {
  const cast = skills.filter((skill) => skill !== 'enrage');
  let factor = 1;
  if (cast.length > 0) {
    const logSum = cast.reduce((sum, skill) => sum + Math.log(config.skills[skill].healthFactor), 0);
    factor = Math.exp(logSum / cast.length);
  }
  if (skills.includes('enrage')) factor *= config.skills.enrage.healthFactor;
  // Several skills together: the mix factor, in full with every skill, not at all with one.
  const all = Object.keys(config.skills.names).length;
  const share = all > 1 ? Math.max(0, skills.length - 1) / (all - 1) : 0;
  return factor * config.skills.mixFactor ** share;
}

/** Where each team gathers, as shares of the arena, by number of teams. */
const SPAWN_POINTS: Record<number, [number, number][]> = {
  1: [[0.5, 0.5]],
  2: [
    [0.22, 0.5],
    [0.78, 0.5],
  ],
  // An equilateral triangle, so no team starts nearer to the others.
  3: [
    [0.3, 0.34],
    [0.7, 0.34],
    [0.5, 0.956],
  ],
};

/**
 * An automatic battle. Pure and deterministic: the same setup gives the same
 * fight. It has no clock; the caller calls `step` at a fixed rate.
 */
export class Battle {
  readonly fighters: Fighter[];
  readonly sides: (SideSpec & { team: string })[];
  readonly durationMs: number;
  /** The field this battle is fought on. */
  readonly arena: Arena;
  /** See `BattleSetup.toughness`. */
  private readonly toughness: number;
  /** Each side's fortune of battle: its damage multiplier for this fight. */
  readonly fortunes: Record<string, number>;
  /** What happened in the most recent step that the overlay should show. */
  events: BattleEvent[] = [];
  /** Fighters killed by a barrel or a trap: for the balancing tools. */
  obstacleDeaths = 0;
  /** A normal fighter's radius in this battle; skill distances are multiples of it. */
  private readonly unit: number;
  private readonly teams: string[];
  private readonly rng: Rng;
  /** The god's moves have random numbers of their own, so the rest of a fight rolls as it did before them. */
  private readonly moveRng: Rng;
  /** For breaking out of crowds: separate, so these rolls leave every other roll of the battle as it was. */
  private readonly roamRng: Rng;
  /** Deaths so far, for first blood, and when the last highlight was. */
  private deaths = 0;
  private lastHighlightAt = 0;
  /** Varies each throw (see `config.flight`); its own, so the other draws of a battle stay as they were. */
  private readonly flightRng: Rng;
  private readonly timeLimitWinner: string | null;
  private readonly field: { perSide?: number; total?: number } | null;
  private readonly endless: boolean;
  private readonly keepClear: ClearArea[];
  /** Fighters waiting to step in, first in line first. */
  private bench: Fighter[] = [];
  /** Nobody steps in from the bench before this time. */
  private nextEntryAt = 0;
  private whirlwinds: Whirlwind[] = [];
  /** Mages' circles on the ground, each going off at its time. */
  private blasts: { x: number; y: number; r: number; at: number; owner: Fighter }[] = [];
  private fires: Fire[] = [];
  /** Walls, bumpers, barrels and traps, if this battle has any. */
  private readonly obstacles: Obstacles | null = null;
  private steps = 0;
  private outcome: { winner: string | null; endedBy: BattleResult['endedBy'] } | null = null;

  constructor(setup: BattleSetup) {
    const { baseHealth, baseDamage, hitIntervalMs, moveSpeed, speedVariation } = config.battle;
    const arena = (this.arena = setup.arena ?? config.battle.arena);
    // Fighters are sized for how many are on the field at once, not for how many wait on the bench.
    const sideCount = new Set(setup.fighters.map((fighter) => fighter.side)).size;
    const onField = Math.min(
      setup.fighters.length,
      setup.field?.total ?? Infinity,
      setup.field?.perSide === undefined ? Infinity : setup.field.perSide * sideCount,
    );
    const fighterRadius = radiusFor(onField);
    const rng = createRng(setup.seed);
    this.moveRng = createRng((setup.seed ^ 0x27d4eb2f) >>> 0);
    this.roamRng = createRng((setup.seed ^ 0x6a09e667) >>> 0);
    this.flightRng = createRng((setup.seed ^ 0x3c6ef372) >>> 0);
    this.rng = rng;
    this.unit = fighterRadius;
    this.timeLimitWinner = setup.timeLimitWinner ?? null;
    this.field = setup.field ?? null;
    this.endless = setup.endless === true;
    this.keepClear = setup.keepClear ?? [];
    this.durationMs = setup.durationMs ?? config.battle.durationMs;
    this.toughness = setup.toughness ?? 1;

    const counts = new Map<string, number>();
    for (const fighter of setup.fighters) counts.set(fighter.side, (counts.get(fighter.side) ?? 0) + 1);
    this.sides = setup.sides
      .filter((side) => (counts.get(side.id) ?? 0) > 0)
      .map((side) => ({ ...side, team: side.team ?? side.id }));
    this.teams = [...new Set(this.sides.map((side) => side.team))];
    const sizes = this.sides.map((side) => counts.get(side.id)!);
    const spawns = SPAWN_POINTS[this.teams.length] ?? [];
    const teamSizes = new Map<string, number>();
    this.sides.forEach((side, index) => {
      teamSizes.set(side.team, (teamSizes.get(side.team) ?? 0) + sizes[index]!);
    });

    this.fighters = [];
    this.fortunes = {};
    this.sides.forEach((side, index) => {
      const balance = setup.sizeBalance === false ? 1 : sizeBalance(sizes[index]!, sizes);
      // The roll is always made, so switching fortune off does not shift the other rolls.
      const roll = 1 + config.battle.fortune * (2 * rng() - 1);
      const fortune = setup.fortune === false ? 1 : roll;
      this.fortunes[side.id] = fortune;
      const [sx, sy] = spawns[this.teams.indexOf(side.team)] ?? [0.5, 0.5];
      const spread = fighterRadius * (1 + 1.4 * Math.sqrt(teamSizes.get(side.team)!));
      for (const spec of setup.fighters) {
        if (spec.side !== side.id) continue;
        const radius = spec.radius ?? fighterRadius;
        const angle = rng() * Math.PI * 2;
        const distance = spread * Math.sqrt(rng());
        const levelBonus = setup.levelBonus === false ? 1 : levelHealthMultiplier(spec.level);
        const maxHealth = (spec.health ?? baseHealth * levelBonus * (1 + side.healthBonus) * balance) * this.toughness;
        const speedRoll = 1 - speedVariation + 2 * speedVariation * rng();
        this.fighters.push({
          ...spec,
          team: side.team,
          x: clamp(sx * arena.width + Math.cos(angle) * distance, radius, arena.width - radius),
          y: clamp(sy * arena.height + Math.sin(angle) * distance, arena.top + radius, arena.height - radius),
          radius,
          health: maxHealth,
          maxHealth,
          damage: spec.damage ?? baseDamage * (1 + side.damageBonus) * balance * fortune,
          speed: spec.speed ?? moveSpeed * speedRoll,
          weight: spec.weight ?? 1,
          cooldownMs: rng() * hitIntervalMs,
          alive: true,
          kills: 0,
          damageDealt: 0,
          healingDone: 0,
          hit: false,
          slowUntil: 0,
          shieldUntil: 0,
          scorchedUntil: 0,
          flight: null,
          spinning: false,
          benched: false,
          enterAt: 0,
          enraged: false,
          minion: false,
          spawned: true,
          owner: null,
          // Staggered by place in the roster, without the rng, so not everyone acts at once.
          nextSpecialAt: 1_200 + ((this.fighters.length * 137) % 3_000),
          retreatUntil: 0,
          retreatX: 0,
          retreatY: 0,
          hiddenUntil: 0,
          maneuver: null,
          jumpedAt: -Infinity,
          skillState: null,
          roam: null,
        });
      }
    });

    // Around a fighter that holds the middle, everyone else starts in a ring: surrounded from the first moment.
    // A class changes the base stats.
    for (const fighter of this.fighters) {
      if (fighter.class) {
        const stats = config.classes[fighter.class];
        fighter.maxHealth *= stats.health;
        fighter.damage *= stats.damage;
        fighter.speed *= stats.speed;
      }
      if (fighter.strength !== undefined) {
        fighter.maxHealth *= fighter.strength;
        fighter.damage *= fighter.strength;
      }
      fighter.health = fighter.maxHealth;
    }

    // The god's doubles start right beside the chatter they copy, and step apart from there.
    for (const double of this.fighters.filter((f) => f.doubleOf)) {
      const original = this.fighters.find((f) => f.id === double.doubleOf);
      if (!original) continue;
      const angle = rng() * Math.PI * 2;
      double.x = original.x + Math.cos(angle) * original.radius * 1.2;
      double.y = original.y + Math.sin(angle) * original.radius * 1.2;
    }

    const holder = this.fighters.find((fighter) => fighter.holdsCenter);
    if (holder) {
      const middle = this.middle();
      const playable = arena.height - arena.margin - arena.top;
      holder.x = middle.x;
      holder.y = middle.y;
      for (const fighter of this.fighters) {
        if (fighter === holder) continue;
        const angle = rng() * Math.PI * 2;
        fighter.x = middle.x + Math.cos(angle) * arena.width * 0.4;
        fighter.y = middle.y + Math.sin(angle) * playable * 0.4;
      }
    }

    // Fighters with skills get their cast timer, and their minions wait off the field.
    // The roster must not change during a battle, so minions exist from the start.
    // The god gets one even with every skill switched off: its moves between skills run on it.
    for (const caster of [...this.fighters]) {
      if ((!caster.skills || caster.skills.length === 0) && !caster.holdsCenter) continue;
      const state: SkillState = {
        nextCastAt: between(rng, config.skills.firstCastMs),
        nextMoveAt: config.god.moves.everyMs[0],
        active: null,
        reserves: [],
      };
      caster.skillState = state;
      if (caster.skills?.includes('minions')) {
        const minions = config.skills.minions;
        for (let i = 0; i < minions.count * minions.casts; i++) {
          const minion: Fighter = {
            id: `${caster.id}#${i}`,
            name: '',
            color: caster.color,
            emote: caster.emote,
            image: caster.image,
            side: caster.side,
            team: caster.team,
            level: 0,
            x: caster.x,
            y: caster.y,
            radius: fighterRadius * minions.radiusFactor,
            health: 0,
            maxHealth: minions.health * this.toughness,
            damage: minions.damage,
            speed: moveSpeed,
            weight: 1,
            cooldownMs: 0,
            alive: false,
            kills: 0,
            damageDealt: 0,
            healingDone: 0,
            hit: false,
            slowUntil: 0,
            shieldUntil: 0,
            scorchedUntil: 0,
            flight: null,
            spinning: false,
            benched: false,
            enterAt: 0,
            enraged: false,
            minion: true,
            spawned: false,
            owner: caster,
            nextSpecialAt: 0,
            retreatUntil: 0,
            retreatX: 0,
            retreatY: 0,
            hiddenUntil: 0,
            maneuver: null,
            jumpedAt: -Infinity,
            skillState: null,
            roam: null,
          };
          state.reserves.push(minion);
          this.fighters.push(minion);
        }
      }
    }

    // With more than three teams there are no corners to gather in: everyone starts somewhere at random.
    if (this.teams.length > 3) {
      for (const fighter of this.fighters) {
        const limits = this.limits(fighter);
        fighter.x = limits.minX + rng() * (limits.maxX - limits.minX);
        fighter.y = limits.minY + rng() * (limits.maxY - limits.minY);
        this.keepInArena(fighter);
      }
    }

    // A limited field: only the first fighters start on it, the others wait on the bench.
    if (this.field) {
      const onField = new Map<string, number>();
      let total = 0;
      for (const fighter of this.fighters) {
        if (fighter.minion) continue;
        const own = onField.get(fighter.side) ?? 0;
        const room =
          (this.field.perSide === undefined || own < this.field.perSide) &&
          (this.field.total === undefined || total < this.field.total);
        if (room) {
          onField.set(fighter.side, own + 1);
          total++;
        } else {
          fighter.alive = false;
          fighter.benched = true;
          this.bench.push(fighter);
        }
      }
    }

    // Obstacles, away from where the teams gather and from a fighter that holds the middle.
    // They have their own random numbers, so a battle without them plays exactly as before.
    if (setup.obstacles) {
      const zones: ClearZone[] = [];
      if (this.teams.length <= 3) {
        this.teams.forEach((team, index) => {
          const [sx, sy] = spawns[index] ?? [0.5, 0.5];
          const spread = fighterRadius * (1 + 1.4 * Math.sqrt(teamSizes.get(team) ?? 1));
          zones.push({ x: sx * arena.width, y: sy * arena.height, r: spread + 2 * fighterRadius, soft: true });
        });
      }
      if (holder) {
        const middle = this.middle();
        zones.push({ x: middle.x, y: middle.y, r: holder.radius + 4 * fighterRadius });
      }
      const bounds = { left: arena.margin, top: arena.top, right: arena.width - arena.margin, bottom: arena.height - arena.margin };
      this.obstacles = Obstacles.create(setup.obstacles, createRng((setup.seed ^ 0x5bd1e995) >>> 0), fighterRadius, bounds, zones, setup.place);
    }

    // Wherever a fighter was placed above, it starts inside the arena's limits.
    for (const fighter of this.fighters) this.keepInArena(fighter);

    if (this.teams.length <= 1 && !this.endless) {
      this.outcome = { winner: this.teams[0] ?? null, endedBy: 'walkover' };
    }
  }

  /**
   * How far a fighter's center may go: its whole circle stays on screen, clear
   * of the scoreboard at the top and of a margin at the other three edges.
   */
  private limits(fighter: { radius: number }): { minX: number; maxX: number; minY: number; maxY: number } {
    const arena = this.arena;
    return {
      minX: fighter.radius + arena.margin,
      maxX: arena.width - fighter.radius - arena.margin,
      minY: arena.top + fighter.radius,
      maxY: arena.height - fighter.radius - arena.margin,
    };
  }

  /** The middle of the area fighters can stand in. */
  private middle(): { x: number; y: number } {
    const arena = this.arena;
    return { x: arena.width / 2, y: (arena.top + arena.height - arena.margin) / 2 };
  }

  /** Lets waiting fighters step onto the field where there is room for them. */
  private enterFromBench(now: number): void {
    if (!this.field || this.bench.length === 0 || now < this.nextEntryAt) return;
    const { hitIntervalMs } = config.battle;
    const arena = this.arena;
    const onField = new Map<string, number>();
    let total = 0;
    for (const fighter of this.fighters) {
      if (!fighter.alive || fighter.minion) continue;
      onField.set(fighter.side, (onField.get(fighter.side) ?? 0) + 1);
      total++;
    }
    const waiting: Fighter[] = [];
    for (const fighter of this.bench) {
      const own = onField.get(fighter.side) ?? 0;
      const room =
        (this.field.perSide === undefined || own < this.field.perSide) &&
        (this.field.total === undefined || total < this.field.total);
      if (!room || fighter.enterAt > now) {
        waiting.push(fighter);
        continue;
      }
      // Teams step in where they gathered at the start; in a free-for-all, from a random edge.
      const spawn = (SPAWN_POINTS[this.teams.length] ?? [])[this.teams.indexOf(fighter.team)];
      if (spawn) {
        fighter.x = spawn[0] * arena.width + (this.rng() - 0.5) * 4 * fighter.radius;
        fighter.y = spawn[1] * arena.height + (this.rng() - 0.5) * 4 * fighter.radius;
      } else {
        const along = this.rng();
        const edge = Math.floor(this.rng() * 4);
        fighter.x = edge === 0 ? 0 : edge === 1 ? arena.width : along * arena.width;
        fighter.y = edge === 2 ? arena.top : edge === 3 ? arena.height : arena.top + along * (arena.height - arena.top);
      }
      this.keepInArena(fighter);
      fighter.alive = true;
      fighter.benched = false;
      fighter.health = fighter.maxHealth;
      fighter.cooldownMs = this.rng() * hitIntervalMs;
      fighter.slowUntil = 0;
      fighter.scorchedUntil = 0;
      onField.set(fighter.side, own + 1);
      total++;
      this.events.push({ k: 'enter', i: this.fighters.indexOf(fighter), x: Math.round(fighter.x), y: Math.round(fighter.y) });
    }
    this.bench = waiting;
  }

  get finished(): boolean {
    return this.outcome !== null;
  }

  get timeMs(): number {
    return (this.steps * 1000) / config.battle.stepsPerSecond;
  }

  /** Advances the battle by one fixed step. Does nothing once it is finished. */
  step(): void {
    if (this.outcome) return;
    const { stepsPerSecond, hitIntervalMs, separationPasses } = config.battle;
    const arena = this.arena;
    const dt = 1 / stepsPerSecond;
    const now = this.timeMs;
    this.events = [];
    for (const fighter of this.fighters) fighter.hit = false;
    this.enterFromBench(now);

    // Skills come first: they may move fighters, summon minions, or hurt.
    for (const caster of this.fighters) {
      if (caster.alive && caster.skillState) this.updateSkills(caster, now, dt);
    }

    const alive = this.fighters.filter((f) => f.alive);
    /** Attacker, target, and optionally a factor on the attacker's damage. */
    const attacks: [Fighter, Fighter, number?, DeathCause?][] = [];

    // Fighters hurled through the air fly in a straight line, slowing down, and bounce off the walls.
    for (const fighter of alive) {
      const flight = fighter.flight;
      if (!flight) continue;
      const length = Math.max(1, flight.until - flight.from);
      const { start } = config.flight;
      /** How far along the throw is, from 0 to 1, at a time. */
      const along = (time: number): number => clamp((time - flight.from) / length, 0, 1);
      /** The distance covered between two points of the throw, in multiples of its whole length at even speed. */
      const covered = (p1: number, p2: number): number => start * (p2 - p1) - (start - 1) * (p2 * p2 - p1 * p1);
      // Two half-steps, so the bounce happens at the wall and not beyond it.
      for (let half = 0; half < 2; half++) {
        const t1 = now + (half * dt * 1000) / 2;
        const distance = covered(along(t1), along(t1 + (dt * 1000) / 2)) * flight.speed * (length / 1000);
        fighter.x += flight.vx * distance;
        fighter.y += flight.vy * distance;
        const limits = this.limits(fighter);
        if (fighter.x < limits.minX || fighter.x > limits.maxX) flight.vx = -flight.vx;
        if (fighter.y < limits.minY || fighter.y > limits.maxY) flight.vy = -flight.vy;
        // Into a bumper or a wall: it bounces off, and a bumper sends it off again at full speed, like a pinball.
        const bounce = this.obstacles?.deflect(fighter.x, fighter.y, fighter.radius, flight.vx, flight.vy, now);
        if (bounce) {
          flight.vx = bounce.vx;
          flight.vy = bounce.vy;
          if (bounce.bumper && now - (flight.bumpedAt ?? -Infinity) > 150) {
            flight.bumpedAt = now;
            flight.from = now;
            flight.until = Math.max(flight.until, now + config.obstacles.bumper.flingMs * 2);
          }
        }
        this.keepInArena(fighter);
      }
      if (now + dt * 1000 >= flight.until) fighter.flight = null;
    }

    // Whirlwinds wander, turn, and carry their fighters along in a ring.
    for (const whirlwind of this.whirlwinds) {
      const { driftSpeed, spin } = config.skills.vortex;
      for (const member of whirlwind.members) if (!member.alive) member.spinning = false;
      whirlwind.members = whirlwind.members.filter((member) => member.alive);
      // The whole ring of carried fighters stays inside the arena's limits.
      const limits = this.limits({ radius: whirlwind.orbit + this.unit });
      whirlwind.x += whirlwind.vx * driftSpeed * dt;
      whirlwind.y += whirlwind.vy * driftSpeed * dt;
      if (whirlwind.x < limits.minX || whirlwind.x > limits.maxX) whirlwind.vx = -whirlwind.vx;
      if (whirlwind.y < limits.minY || whirlwind.y > limits.maxY) whirlwind.vy = -whirlwind.vy;
      whirlwind.x = clamp(whirlwind.x, limits.minX, Math.max(limits.minX, limits.maxX));
      whirlwind.y = clamp(whirlwind.y, limits.minY, Math.max(limits.minY, limits.maxY));
      whirlwind.angle += spin * dt;
      whirlwind.members.forEach((member, index) => {
        const angle = whirlwind.angle + (Math.PI * 2 * index) / whirlwind.members.length;
        member.x = whirlwind.x + Math.cos(angle) * whirlwind.orbit;
        member.y = whirlwind.y + Math.sin(angle) * whirlwind.orbit;
        this.keepInArena(member);
      });
      // It blows itself out at its time, when it is empty, or when its caster falls.
      if (now + dt * 1000 >= whirlwind.until || whirlwind.members.length === 0 || !whirlwind.caster.alive) {
        for (const member of whirlwind.members) member.spinning = false;
        whirlwind.members = [];
      }
    }
    this.whirlwinds = this.whirlwinds.filter((whirlwind) => whirlwind.members.length > 0);

    // Obstacles: barrels roll, bumpers fling, traps strike, and some come and go.
    this.obstacles?.update(now, dt, alive, {
      hurt: (fighter, amount, kind) => this.hurt(null, fighter, amount * this.toughness, now, kind),
      fling: (fighter, vx, vy, ms) => {
        fighter.flight = { vx, vy, speed: config.skills.shockwave.launchSpeed, from: now, until: now + ms };
      },
      settle: (fighter) => this.keepInArena(fighter),
    });

    // Burning ground hurts the enemies of whoever set it, a little at a time.
    for (const fire of this.fires) {
      if (now < fire.nextTickAt) continue;
      fire.nextTickAt += config.skills.smite.fireTickMs;
      for (const fighter of alive) {
        if (!fighter.alive || fighter.team === fire.owner.team) continue;
        if ((fighter.x - fire.x) ** 2 + (fighter.y - fire.y) ** 2 > fire.r * fire.r) continue;
        this.hurt(fire.owner, fighter, config.skills.smite.fireDamage, now, 'fire');
      }
    }
    this.fires = this.fires.filter((fire) => fire.until > now);

    // Mages' blasts go off where their circles were drawn.
    for (const blast of this.blasts) {
      if (blast.at > now) continue;
      for (const fighter of alive) {
        if (fighter.team === blast.owner.team) continue;
        const reach = blast.r + fighter.radius * 0.5;
        if ((fighter.x - blast.x) ** 2 + (fighter.y - blast.y) ** 2 > reach * reach) continue;
        this.hurt(blast.owner, fighter, config.classes.mage.blastDamage, now, 'blast');
      }
      this.fx('blast', blast.owner, { x: blast.x, y: blast.y, r: blast.r, ms: 350 });
    }
    this.blasts = this.blasts.filter((blast) => blast.at > now);

    // Every fighter decides from the positions at the start of the step, so
    // the order in which fighters are processed gives no side an advantage.
    const classes = config.classes;
    const tauntRange = (this.unit * classes.tank.tauntRadiusFactor) ** 2;
    const plans = alive.map((fighter) => {
      const distanceTo = (other: Fighter): number => Math.hypot(other.x - fighter.x, other.y - fighter.y);
      const planFor = (target: Fighter, heal: boolean) => ({
        target,
        tx: target.x,
        ty: target.y,
        distance: distanceTo(target),
        heal,
      });

      // A healer goes to the ally with the least health; healers and minions are not its patients.
      if (fighter.class === 'healer') {
        let patient: Fighter | null = null;
        let nearest: Fighter | null = null;
        let lowest = 1;
        let closest = Infinity;
        for (const other of alive) {
          if (other.team !== fighter.team || other === fighter || other.class === 'healer' || other.minion) continue;
          const share = other.health / other.maxHealth;
          if (share < lowest) {
            lowest = share;
            patient = other;
          }
          const d = distanceTo(other);
          if (d < closest) {
            closest = d;
            nearest = other;
          }
        }
        // Everyone healthy: stay with the nearest ally. Nobody left to heal: fight, below.
        if (patient ?? nearest) return planFor((patient ?? nearest)!, true);
      }

      // Stuck in a crowd for a while: now and then it goes for an enemy further away instead.
      const far = this.roamTarget(fighter, alive, now);
      if (far) return planFor(far, false);

      let target: Fighter | null = null;
      let best = Infinity;
      // A thief looks for those who stand back; everyone else is drawn to a tank that is close.
      let prey: Fighter | null = null;
      let preyBest = Infinity;
      let tank: Fighter | null = null;
      let tankBest = Infinity;
      for (const other of alive) {
        if (other.team === fighter.team) continue;
        // Nobody can go for a thief that is hidden in the shadows.
        if (other.hiddenUntil > now) continue;
        const d = (other.x - fighter.x) ** 2 + (other.y - fighter.y) ** 2;
        if (d < best) {
          best = d;
          target = other;
        }
        const standsBack = other.class === 'archer' || other.class === 'mage' || other.class === 'healer';
        if (fighter.class === 'thief' && standsBack && d < preyBest) {
          preyBest = d;
          prey = other;
        }
        if (other.class === 'tank' && d <= tauntRange && d < tankBest) {
          tankBest = d;
          tank = other;
        }
      }
      // The god strikes whoever is in reach; a tank does not draw it away from them.
      const chosen = fighter.class === 'thief' ? (prey ?? target) : fighter.holdsCenter ? target : (tank ?? target);
      return chosen ? planFor(chosen, false) : null;
    });
    const startPositions = alive.map((f) => ({ x: f.x, y: f.y }));

    /** A blow against the planned target and, for a sweeping blow, everyone near it. */
    const strike = (fighter: Fighter, plan: { target: Fighter; tx: number; ty: number }): void => {
      attacks.push([fighter, plan.target]);
      if (fighter.splashRadius) {
        alive.forEach((other, otherIndex) => {
          if (other === plan.target || other.team === fighter.team) return;
          const at = startPositions[otherIndex]!;
          const reachSplash = fighter.splashRadius! + other.radius;
          if ((at.x - plan.tx) ** 2 + (at.y - plan.ty) ** 2 <= reachSplash * reachSplash) {
            attacks.push([fighter, other]);
          }
        });
      }
      fighter.cooldownMs = hitIntervalMs;
    };

    // Each fighter walks toward the nearest enemy and strikes on contact.
    alive.forEach((fighter, index) => {
      fighter.cooldownMs = Math.max(0, fighter.cooldownMs - dt * 1000);
      const plan = plans[index];
      if (isBusy(fighter)) return;
      if (fighter.holdsCenter) {
        // It does not chase: it drifts around the middle and strikes whoever is within reach.
        const middle = this.middle();
        const tx = middle.x + Math.cos(now / 2_600) * config.god.wander;
        const ty = middle.y + Math.sin(now / 1_900) * config.god.wander * 0.6;
        const away = Math.hypot(tx - fighter.x, ty - fighter.y);
        if (away > 0.5) {
          let speed = fighter.speed;
          if (fighter.enraged) speed *= config.skills.enrage.speed;
          const move = Math.min(speed * dt, away);
          fighter.x += ((tx - fighter.x) / away) * move;
          fighter.y += ((ty - fighter.y) / away) * move;
        }
        if (plan && fighter.cooldownMs <= 0 && plan.distance <= fighter.radius + plan.target.radius + 2.5) {
          strike(fighter, plan);
        }
        return;
      }
      if (!plan) return;
      let speed = fighter.speed;
      if (fighter.slowUntil > now) speed *= config.skills.shockwave.slow;
      if (fighter.enraged) speed *= config.skills.enrage.speed;
      /** Walks toward the planned target by a distance; a negative distance backs away. */
      const walk = (amount: number): void => {
        if (plan.distance < 1e-6) return;
        fighter.x += ((plan.tx - fighter.x) / plan.distance) * amount;
        fighter.y += ((plan.ty - fighter.y) / plan.distance) * amount;
      };
      // A healer with nobody to heal fights like anyone else, only weaker.
      const cls = fighter.class === 'healer' && !plan.heal ? null : (fighter.class ?? null);

      if (cls === 'healer') {
        const range = this.unit * classes.healer.rangeFactor + plan.target.radius;
        if (plan.distance > range) {
          walk(Math.min(speed * dt, plan.distance - range));
        } else if (now >= fighter.nextSpecialAt && plan.target.health < plan.target.maxHealth) {
          const { healPerSecond, tickMs } = classes.healer;
          const before = plan.target.health;
          plan.target.health = Math.min(
            plan.target.maxHealth,
            plan.target.health + (healPerSecond * this.toughness * tickMs) / 1000,
          );
          // Damage is not scaled by toughness, so neither is the healing counted here.
          fighter.healingDone += (plan.target.health - before) / this.toughness;
          fighter.nextSpecialAt = now + tickMs;
          this.fx('heal', fighter, { t: [this.fighters.indexOf(plan.target)], ms: tickMs });
        }
        return;
      }

      if (cls === 'archer' || cls === 'mage') {
        const range = this.unit * classes[cls].rangeFactor;
        // Too close: back away. Too far: come within range. In between: stand and work.
        if (plan.distance < this.unit * classes[cls].retreatFactor) walk(-speed * dt);
        else if (plan.distance > range) walk(Math.min(speed * dt, plan.distance - range * 0.9));
        if (plan.distance > range) return;
        if (cls === 'archer' && fighter.cooldownMs <= 0) {
          attacks.push([fighter, plan.target, 1, 'arrow']);
          fighter.cooldownMs = hitIntervalMs;
          this.fx('arrow', fighter, { t: [this.fighters.indexOf(plan.target)], ms: 180 });
        }
        if (cls === 'mage' && now >= fighter.nextSpecialAt) {
          const { castEveryMs, warnMs, blastRadiusFactor } = classes.mage;
          const r = this.unit * blastRadiusFactor;
          this.blasts.push({ x: plan.tx, y: plan.ty, r, at: now + warnMs, owner: fighter });
          fighter.nextSpecialAt = now + castEveryMs;
          this.fx('blast-warn', fighter, { x: plan.tx, y: plan.ty, r, ms: warnMs });
        }
        return;
      }

      // A thief slips into the shadows now and then: unseen and unhurt, it closes in faster.
      if (cls === 'thief') {
        if (fighter.hiddenUntil <= now && now >= fighter.nextSpecialAt) {
          fighter.hiddenUntil = now + classes.thief.shadowMs;
          fighter.nextSpecialAt = now + classes.thief.shadowEveryMs;
          fighter.retreatUntil = 0;
          this.fx('shadow', fighter, { ms: 400 });
        }
        if (fighter.hiddenUntil > now) speed *= classes.thief.shadowSpeed;
      }

      // A thief that has just struck darts back before it comes in again.
      if (cls === 'thief' && fighter.retreatUntil > now) {
        fighter.x += fighter.retreatX * speed * dt;
        fighter.y += fighter.retreatY * speed * dt;
        return;
      }

      const reach = fighter.radius + plan.target.radius + 2;
      // A little slack: a fighter that stops a hair short of its reach must still be able
      // to strike, or two fighters can freeze just out of range of each other for good.
      if (plan.distance > reach + 0.5) {
        walk(Math.min(speed * dt, plan.distance - reach));
      } else if (fighter.cooldownMs <= 0) {
        strike(fighter, plan);
        // Striking gives a hidden thief away.
        if (fighter.hiddenUntil > now) {
          fighter.hiddenUntil = now;
          this.fx('shadow', fighter, { ms: 400 });
        }
        if (cls === 'thief' && plan.distance > 1e-6) {
          fighter.retreatUntil = now + classes.thief.retreatMs;
          fighter.retreatX = (fighter.x - plan.tx) / plan.distance;
          fighter.retreatY = (fighter.y - plan.ty) / plan.distance;
        }
      }

      // A fighter's spin: with two or more enemies around it, it hits them all.
      if (cls === 'fighter' && now >= fighter.nextSpecialAt) {
        const radius = this.unit * classes.fighter.spinRadiusFactor;
        const around = alive.filter((other, otherIndex) => {
          if (other.team === fighter.team) return false;
          const at = startPositions[otherIndex]!;
          const within = radius + other.radius * 0.5;
          return (at.x - fighter.x) ** 2 + (at.y - fighter.y) ** 2 <= within * within;
        });
        if (around.length >= 2) {
          for (const other of around) attacks.push([fighter, other, classes.fighter.spinDamage, 'spin']);
          fighter.nextSpecialAt = now + classes.fighter.spinEveryMs;
          this.fx('spin', fighter, { r: radius, ms: 350 });
        }
      }

      // A tank's shield: raised when an enemy is upon it.
      if (cls === 'tank' && now >= fighter.nextSpecialAt && plan.distance <= reach * 1.5) {
        fighter.shieldUntil = now + classes.tank.shieldMs;
        fighter.nextSpecialAt = now + classes.tank.shieldEveryMs;
      }
    });

    // Fighters do not overlap: push each overlapping pair apart. One pass is
    // not enough in a crowd, where pushing one pair apart overlaps the next.
    for (let pass = 0; pass < separationPasses; pass++) {
      for (let i = 0; i < alive.length; i++) {
        for (let j = i + 1; j < alive.length; j++) {
          const a = alive[i]!;
          const b = alive[j]!;
          // A fighter in the air, hurled or carried by a whirlwind, passes over the others.
          if (a.flight || b.flight || a.spinning || b.spinning) continue;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          const min = a.radius + b.radius;
          const d2 = dx * dx + dy * dy;
          if (d2 >= min * min) continue;
          let d = Math.sqrt(d2);
          if (d < 1e-6) {
            // Exactly on top of each other: separate along a fixed direction.
            dx = 1;
            dy = 0;
            d = 1;
          }
          // Each gives way in proportion to the other's weight: a heavy fighter barely moves.
          const total = a.weight + b.weight;
          const overlap = min - d;
          const pushA = overlap * (b.weight / total);
          const pushB = overlap * (a.weight / total);
          a.x -= (dx / d) * pushA;
          a.y -= (dy / d) * pushA;
          b.x += (dx / d) * pushB;
          b.y += (dy / d) * pushB;
        }
      }
    }
    for (const fighter of alive) this.keepInArena(fighter);

    // All strikes of a step land together, so the order of fighters gives no advantage.
    const { damageVariation } = config.battle;
    for (const [attacker, target, factor, cause] of attacks) {
      let dealt = attacker.damage * (factor ?? 1) * (1 - damageVariation + 2 * damageVariation * this.rng());
      if (attacker.enraged) dealt *= config.skills.enrage.damage;
      this.hurt(attacker, target, dealt, now, cause ?? 'strike');
    }

    // Enrage: a wounded fighter with this skill turns faster and stronger, once.
    for (const fighter of alive) {
      if (!fighter.alive || fighter.enraged || !fighter.skills?.includes('enrage')) continue;
      if (fighter.health / fighter.maxHealth <= config.skills.enrage.below) {
        fighter.enraged = true;
        fighter.radius *= config.skills.enrage.grow;
        this.keepInArena(fighter);
        this.emit('cast', 'enrage', fighter, { ms: 1_500 });
      }
    }

    this.steps++;
    if (this.endless) return;
    // A team is standing while it has a fighter on the field or on the bench.
    const standing = this.teams.filter((team) =>
      this.fighters.some((f) => (f.alive || f.benched) && f.team === team),
    );
    if (standing.length <= 1) {
      this.outcome = { winner: standing[0] ?? null, endedBy: 'elimination' };
    } else if (this.timeMs >= this.durationMs && this.timeLimitWinner && standing.includes(this.timeLimitWinner)) {
      this.outcome = { winner: this.timeLimitWinner, endedBy: 'time' };
    } else if (this.timeMs >= this.durationMs) {
      const health = standing.map((team) => ({ team, health: this.teamHealth(team) }));
      health.sort((a, b) => b.health - a.health);
      const tie = Math.abs(health[0]!.health - health[1]!.health) < 1e-9;
      this.outcome = { winner: tie ? null : health[0]!.team, endedBy: 'time' };
    }
  }

  // --- Skills ----------------------------------------------------------------

  /** Reports a class effect for the overlay to draw. */
  private fx(name: string, fighter: Fighter, extra: Partial<BattleEvent> = {}): void {
    this.events.push({
      k: 'fx',
      fx: name,
      i: this.fighters.indexOf(fighter),
      x: Math.round(extra.x ?? fighter.x),
      y: Math.round(extra.y ?? fighter.y),
      ...(extra.r === undefined ? {} : { r: Math.round(extra.r) }),
      ...(extra.ms === undefined ? {} : { ms: extra.ms }),
      ...(extra.t === undefined ? {} : { t: extra.t }),
    });
  }

  private emit(k: BattleEvent['k'], s: SkillId, caster: Fighter, extra: Partial<BattleEvent> = {}): void {
    this.events.push({
      k,
      s,
      i: this.fighters.indexOf(caster),
      x: Math.round(extra.x ?? caster.x),
      y: Math.round(extra.y ?? caster.y),
      ...(extra.r === undefined ? {} : { r: Math.round(extra.r) }),
      ...(extra.ms === undefined ? {} : { ms: extra.ms }),
      ...(extra.t === undefined ? {} : { t: extra.t }),
      ...(extra.dx === undefined ? {} : { dx: Math.round(extra.dx * 100) / 100, dy: Math.round(extra.dy! * 100) / 100 }),
      ...(extra.g === undefined ? {} : { g: extra.g }),
      ...(extra.d === undefined ? {} : { d: extra.d }),
    });
  }

  /**
   * The far enemy a fighter stuck in a crowd goes for, or null to go for the
   * nearest as usual. See `config.roam`.
   */
  private roamTarget(fighter: Fighter, alive: Fighter[], now: number): Fighter | null {
    if (fighter.holdsCenter || fighter.class === 'healer') return null;
    const { checkMs, still, crowd, crowdRadius, chance, farShare, pick, roamMs } = config.roam;
    const roam = (fighter.roam ??= { checkAt: now + checkMs, x: fighter.x, y: fighter.y, target: null, until: 0 });
    const usable = (other: Fighter | null): other is Fighter =>
      other !== null && other.alive && !other.benched && other.hiddenUntil <= now && other.team !== fighter.team;

    if (roam.target) {
      const reach = fighter.radius + roam.target.radius + 2;
      const there = Math.hypot(roam.target.x - fighter.x, roam.target.y - fighter.y) <= reach + 0.5;
      if (!usable(roam.target) || now >= roam.until || there) roam.target = null;
    }
    if (now >= roam.checkAt) {
      const moved = Math.hypot(fighter.x - roam.x, fighter.y - roam.y);
      roam.checkAt = now + checkMs;
      roam.x = fighter.x;
      roam.y = fighter.y;
      /** How many others stand within the crowd radius of a fighter. */
      const crowding = (of: Fighter): number => {
        const r = crowdRadius * this.unit;
        return alive.filter((other) => other !== of && (other.x - of.x) ** 2 + (other.y - of.y) ** 2 < r * r).length;
      };
      if (!roam.target && moved < still * this.unit && crowding(fighter) >= crowd && this.roamRng() < chance) {
        const enemies = alive
          .filter(usable)
          .map((other) => ({ other, d: Math.hypot(other.x - fighter.x, other.y - fighter.y) }))
          .sort((a, b) => a.d - b.d);
        // From the farther part of the enemies, the ones standing most on their own: a walk
        // from one crowd into the next would not help. With only one enemy there is nobody else.
        const stragglers = enemies
          .slice(Math.floor(enemies.length * (1 - farShare)))
          .map((e) => ({ other: e.other, crowd: crowding(e.other) }))
          .sort((a, b) => a.crowd - b.crowd)
          .slice(0, pick);
        if (enemies.length > 1 && stragglers.length > 0) {
          roam.target = stragglers[Math.floor(this.roamRng() * stragglers.length)]!.other;
          roam.until = now + between(this.roamRng, roamMs);
        }
      }
    }
    return roam.target;
  }

  /**
   * Applies damage, unless the target is shielded. Counts the damage and the
   * kill for the source; an obstacle's damage (no source) counts for nobody.
   */
  private hurt(source: Fighter | null, target: Fighter, amount: number, now: number, cause: DeathCause = 'strike'): void {
    if (!target.alive || target.shieldUntil > now || target.hiddenUntil > now) return;
    if (source) source.damageDealt += Math.min(amount, Math.max(0, target.health));
    target.health -= amount;
    target.hit = true;
    // A big hit shows its number on the overlay, in base units: the same in every kind of fight
    // (only obstacle damage grows with the fight's toughness; fighters' damage does not).
    const shown = cause === 'barrel' || cause === 'trap' ? amount / this.toughness : amount;
    if (shown >= config.battle.bigHit) {
      this.events.push({
        k: 'hit',
        i: this.fighters.indexOf(target),
        x: Math.round(target.x),
        y: Math.round(target.y),
        v: Math.round(shown),
        c: cause,
        ...(target.health <= 0 ? { l: 1 } : {}),
      });
    }
    if (target.health <= 0) {
      target.alive = false;
      target.health = 0;
      if (source) source.kills++;
      if ((cause === 'barrel' || cause === 'trap') && !target.minion) this.obstacleDeaths++;
      this.noteDeath(target, source, cause);
      if (this.field && !target.minion) {
        // The next fighter steps in after a moment, not in the same instant.
        // A death while someone is already about to step in does not delay them further.
        if (this.nextEntryAt <= now) this.nextEntryAt = now + config.bench.entryDelayMs;
        if (this.endless) {
          // In an endless fight nobody is out for good: back to the end of the queue.
          target.benched = true;
          target.enterAt = now + config.bench.respawnMs;
          this.bench.push(target);
        }
      }
      // Minions fall with the fighter that summoned them.
      for (const other of this.fighters) {
        if (other.owner === target && other.alive) {
          other.alive = false;
          other.health = 0;
        }
      }
    }
  }

  /**
   * Adds a `death` event when a death is worth a highlight (see `HIGHLIGHTS`);
   * minions and the streamer's imps are not. `deaths` counts the others, so
   * the first of them is first blood.
   */
  private noteDeath(victim: Fighter, killer: Fighter | null, cause: DeathCause): void {
    if (victim.minion || victim.imp || victim.doubleOf) return;
    this.deaths++;
    const sideSize = this.fighters.filter((f) => f.side === victim.side && !f.minion).length;
    const standing = this.fighters.some((f) => f !== victim && f.side === victim.side && !f.minion && (f.alive || f.benched));
    const { streakKills, spreeKills, quietMs } = config.highlights;
    const reason: Highlight | null = victim.holdsCenter
      ? 'godFalls'
      : sideSize > 1 && !standing && !this.endless
        ? 'last'
        : victim.crown
          ? 'crown'
          : victim.kills >= streakKills
            ? 'streak'
            : killer && !killer.minion && spreeKills.includes(killer.kills)
              ? 'spree'
              : NOTABLE_CAUSES.has(cause)
                ? 'cause'
                : this.deaths === 1
                  ? 'firstBlood'
                  : killer && this.timeMs - this.lastHighlightAt >= quietMs
                    ? 'kill'
                    : null;
    if (!reason) return;
    this.lastHighlightAt = this.timeMs;
    this.events.push({
      k: 'death',
      i: this.fighters.indexOf(victim),
      x: Math.round(victim.x),
      y: Math.round(victim.y),
      b: killer ? this.fighters.indexOf(killer) : -1,
      c: cause,
      h: reason,
    });
  }

  private keepInArena(fighter: Fighter): void {
    const limits = this.limits(fighter);
    // The god running across the screen's edge is the one thing allowed past it.
    if (fighter.maneuver?.kind === 'wrap') {
      fighter.y = clamp(fighter.y, limits.minY, limits.maxY);
      return;
    }
    fighter.x = clamp(fighter.x, limits.minX, limits.maxX);
    fighter.y = clamp(fighter.y, limits.minY, limits.maxY);
    // Out of any area that must stay clear, by the shortest way that stays inside the arena.
    const r = fighter.radius;
    for (const area of this.keepClear) {
      const inside =
        fighter.x > area.left - r && fighter.x < area.right + r && fighter.y > area.top - r && fighter.y < area.bottom + r;
      if (!inside) continue;
      const exits = [
        { x: area.left - r, y: fighter.y },
        { x: area.right + r, y: fighter.y },
        { x: fighter.x, y: area.top - r },
        { x: fighter.x, y: area.bottom + r },
      ]
        .filter((exit) => exit.x >= limits.minX && exit.x <= limits.maxX && exit.y >= limits.minY && exit.y <= limits.maxY)
        .sort(
          (a, b) =>
            Math.abs(a.x - fighter.x) + Math.abs(a.y - fighter.y) - (Math.abs(b.x - fighter.x) + Math.abs(b.y - fighter.y)),
        );
      if (exits[0]) {
        fighter.x = exits[0].x;
        fighter.y = exits[0].y;
      }
    }
    if (!this.obstacles) return;
    // Walls: out by the shortest way, and a little toward the wall's nearer end,
    // so a fighter whose enemy stands behind a wall walks around it instead of pressing on.
    for (const wall of this.obstacles.walls(this.timeMs)) {
      const inside = fighter.x > wall.left - r && fighter.x < wall.right + r && fighter.y > wall.top - r && fighter.y < wall.bottom + r;
      if (!inside) continue;
      const centerX = (wall.left + wall.right) / 2;
      const centerY = (wall.top + wall.bottom) / 2;
      const exits = [
        { x: wall.left - r, y: fighter.y, side: 'x' },
        { x: wall.right + r, y: fighter.y, side: 'x' },
        { x: fighter.x, y: wall.top - r, side: 'y' },
        { x: fighter.x, y: wall.bottom + r, side: 'y' },
      ].sort((a, b) => Math.abs(a.x - fighter.x) + Math.abs(a.y - fighter.y) - (Math.abs(b.x - fighter.x) + Math.abs(b.y - fighter.y)));
      const exit = exits[0]!;
      fighter.x = exit.x;
      fighter.y = exit.y;
      const slide = this.unit * 0.12;
      if (exit.side === 'x') fighter.y += fighter.y < centerY ? -slide : slide;
      else fighter.x += fighter.x < centerX ? -slide : slide;
    }
    // Bumpers are solid posts.
    for (const post of this.obstacles.posts(this.timeMs)) {
      const dx = fighter.x - post.x;
      const dy = fighter.y - post.y;
      const d = Math.hypot(dx, dy);
      const min = post.r + r;
      if (d >= min) continue;
      const [ux, uy] = d < 1e-6 ? [1, 0] : [dx / d, dy / d];
      fighter.x = post.x + ux * min;
      fighter.y = post.y + uy * min;
    }
    fighter.x = clamp(fighter.x, limits.minX, limits.maxX);
    fighter.y = clamp(fighter.y, limits.minY, limits.maxY);
  }

  /** The arena the battle is fought in, or null for none (no obstacles, or ones that come and go). */
  get place(): ArenaId | null {
    return this.obstacles?.arena ?? null;
  }

  /** The obstacles for the overlay, or null when the battle has none. */
  obstacleFrame(): FrameObstacle[] | null {
    if (!this.obstacles || this.obstacles.empty) return null;
    return this.obstacles.frame(this.timeMs);
  }

  /** Moves a fighter directly away from a point by a distance. */
  private pushAway(fighter: Fighter, fromX: number, fromY: number, distance: number): void {
    let dx = fighter.x - fromX;
    let dy = fighter.y - fromY;
    let d = Math.hypot(dx, dy);
    if (d < 1e-6) {
      dx = 1;
      dy = 0;
      d = 1;
    }
    // A short throw, not a jump: it flies the distance and slows down, like a bumper's fling.
    const { pushMs } = config.flight;
    this.toss(fighter, dx / d, dy / d, (distance * 1000) / pushMs, pushMs);
  }

  /**
   * Throws a fighter in a direction (a unit vector) at an average speed for a
   * time, both varied a little at random so that no two throws are alike.
   */
  private toss(fighter: Fighter, vx: number, vy: number, speed: number, ms: number): void {
    const { speedVariation, durationVariation } = config.flight;
    const vary = (share: number) => 1 + share * (this.flightRng() * 2 - 1);
    const now = this.timeMs;
    fighter.flight = { vx, vy, speed: speed * vary(speedVariation), from: now, until: now + Math.round(ms * vary(durationVariation)) };
  }

  /**
   * The god's moves between skills (see `config.god.moves`). Runs the move
   * under way, or starts a new one when it is time. Returns whether a move is
   * under way, which holds back the next skill.
   */
  private updateMoves(god: Fighter, state: SkillState, enemies: Fighter[], now: number, dt: number): boolean {
    const moves = config.god.moves;
    if (god.maneuver) {
      this.stepManeuver(god, god.maneuver, enemies, now, dt);
      return god.maneuver !== null;
    }
    if (enemies.length === 0 || god.flight || now < state.nextMoveAt || state.nextCastAt - now < moves.clearOfSkillMs) {
      return false;
    }
    const rng = this.moveRng;
    state.nextMoveAt = now + between(rng, moves.everyMs);
    const roll = rng() * (moves.shares.dash + moves.shares.blink + moves.shares.wrap);
    const arena = this.arena;
    const limits = this.limits(god);

    if (roll < moves.shares.dash + moves.shares.blink && roll >= moves.shares.dash) {
      // A blink: gone in a puff, and there, a few steps away, in the same moment.
      const distance = between(rng, moves.blink.distance);
      let angle = rng() * Math.PI * 2;
      let x = 0;
      let y = 0;
      for (let attempt = 0; attempt < 6; attempt++, angle += Math.PI / 3) {
        x = clamp(god.x + Math.cos(angle) * distance, limits.minX, limits.maxX);
        y = clamp(god.y + Math.sin(angle) * distance * 0.6, limits.minY, limits.maxY);
        if (Math.hypot(x - god.x, y - god.y) > distance * 0.6) break;
      }
      this.fx('blink', god, { t: [Math.round(x), Math.round(y)] });
      god.x = x;
      god.y = y;
      god.jumpedAt = now;
      return false;
    }

    // A dash goes sideways, toward the side with more chatters; a wrap runs for the nearer edge.
    const wrap = roll >= moves.shares.dash + moves.shares.blink;
    const right = enemies.filter((e) => e.x > god.x).length;
    const direction = wrap ? (god.x < arena.width / 2 ? -1 : 1) : right * 2 >= enemies.length ? 1 : -1;
    const vy = (rng() - 0.5) * 0.7;
    const length = Math.hypot(1, vy);
    god.maneuver = {
      kind: wrap ? 'wrap' : 'dash',
      vx: direction / length,
      vy: vy / length,
      left: wrap ? Infinity : between(rng, moves.dash.distance),
      wrapped: false,
      hit: new Set(),
    };
    this.fx(wrap ? 'wrap' : 'dash', god, { ms: 600 });
    return true;
  }

  /** One step of a dash or a wrap: move fast, knock chatters aside, cross the edge. */
  private stepManeuver(god: Fighter, move: Maneuver, enemies: Fighter[], now: number, dt: number): void {
    const moves = config.god.moves;
    const arena = this.arena;
    const limits = this.limits(god);
    const speed = move.kind === 'wrap' ? moves.wrap.speed : moves.dash.speed;
    const step = Math.min(speed * dt, move.left);
    god.x += move.vx * step;
    god.y = clamp(god.y + move.vy * step, limits.minY, limits.maxY);
    if (move.wrapped || move.kind === 'dash') move.left -= step;

    for (const enemy of enemies) {
      if (move.hit.has(enemy) || enemy.flight) continue;
      if (Math.hypot(enemy.x - god.x, enemy.y - god.y) < god.radius + enemy.radius + 2) {
        move.hit.add(enemy);
        this.pushAway(enemy, god.x, god.y, this.unit * moves.dash.knockbackFactor);
      }
    }

    if (move.kind === 'dash') {
      // A dash stops at the arena's edge.
      if (god.x <= limits.minX || god.x >= limits.maxX) {
        god.x = clamp(god.x, limits.minX, limits.maxX);
        god.maneuver = null;
      } else if (move.left <= 0) {
        god.maneuver = null;
      }
      return;
    }
    if (!move.wrapped && (god.x < -god.radius || god.x > arena.width + god.radius)) {
      // Fully off one side: it comes back in at the other.
      god.x += move.vx < 0 ? arena.width + 2 * god.radius : -(arena.width + 2 * god.radius);
      god.jumpedAt = now;
      move.wrapped = true;
      move.left = god.radius + arena.margin + between(this.moveRng, moves.wrap.beyond);
    } else if (move.wrapped && move.left <= 0) {
      god.maneuver = null;
      god.x = clamp(god.x, limits.minX, limits.maxX);
    }
  }

  private updateSkills(caster: Fighter, now: number, dt: number): void {
    const state = caster.skillState!;
    const skills = config.skills;
    const enemies = this.fighters.filter((f) => f.alive && f.team !== caster.team);
    const active = state.active;

    if (!active) {
      // Between skills the god keeps moving; a move under way finishes before the next skill.
      if (caster.holdsCenter && this.updateMoves(caster, state, enemies, now, dt)) return;
      if (now < state.nextCastAt || enemies.length === 0) return;
      const castable = (caster.skills ?? []).filter(
        (skill) => skill !== 'enrage' && (skill !== 'minions' || state.reserves.length > 0),
      );
      if (castable.length === 0) {
        // Nothing to cast (every skill off, or no minions left): look again later, and let the moves go on.
        state.nextCastAt = now + between(this.rng, skills.intervalMs);
        return;
      }
      this.announce(caster, castable[Math.floor(this.rng() * castable.length)]!, enemies, now);
      return;
    }

    const finish = (): void => {
      state.active = null;
      state.nextCastAt = now + between(this.rng, skills.intervalMs);
    };

    if (active.phase === 'warn') {
      if (now >= active.until) this.cast(caster, active, enemies, now, finish);
      return;
    }

    if (active.skill === 'rampage') {
      const middle = this.middle();
      let arrived = false;
      // Two half-steps, so a fast god does not jump over fighters in its way.
      for (let half = 0; half < 2 && !arrived; half++) {
        const move = (skills.rampage.speed * dt) / 2;
        if (active.returning) {
          // The last leg: straight back to the middle, where the skill ends.
          const dx = middle.x - caster.x;
          const dy = middle.y - caster.y;
          const d = Math.hypot(dx, dy);
          if (d <= move) {
            caster.x = middle.x;
            caster.y = middle.y;
            arrived = true;
          } else {
            caster.x += (dx / d) * move;
            caster.y += (dy / d) * move;
          }
        } else {
          const limits = this.limits(caster);
          caster.x += active.vx * move;
          caster.y += active.vy * move;
          if (caster.x < limits.minX || caster.x > limits.maxX) {
            active.vx = -active.vx;
            active.bounces--;
          }
          if (caster.y < limits.minY || caster.y > limits.maxY) {
            active.vy = -active.vy;
            active.bounces--;
          }
          if (active.bounces <= 0) active.returning = true;
        }
        // Walls in its way break.
        if (this.obstacles && this.obstacles.smash(caster.x, caster.y, caster.radius, now) > 0) this.fx('smash', caster);
        this.keepInArena(caster);
        for (const enemy of enemies) {
          if (!enemy.alive) continue;
          const reach = caster.radius + enemy.radius + 4;
          if ((enemy.x - caster.x) ** 2 + (enemy.y - caster.y) ** 2 > reach * reach) continue;
          if (now - (active.lastHit.get(enemy) ?? -Infinity) < skills.rampage.rehitMs) continue;
          active.lastHit.set(enemy, now);
          this.hurt(caster, enemy, skills.rampage.damage, now, 'rampage');
          this.pushAway(enemy, caster.x, caster.y, this.unit * skills.rampage.knockbackFactor);
        }
      }
      if (arrived || now >= active.until) finish();
    } else if (now >= active.until) {
      finish();
    }
  }

  /** Begins a skill with a warning the overlay can show. */
  private announce(caster: Fighter, skill: SkillId, enemies: Fighter[], now: number): void {
    const skills = config.skills;
    const active: ActiveSkill = {
      skill,
      phase: 'warn',
      until: now + skills.warnMs,
      x: caster.x,
      y: caster.y,
      vx: 0,
      vy: 0,
      bounces: 0,
      targets: [],
      lastHit: new Map(),
      groups: [],
      returning: false,
    };
    caster.skillState!.active = active;
    const extra: Partial<BattleEvent> = { ms: skills.warnMs };

    if (skill === 'rampage') {
      // Toward the middle of the enemies; the walls do the rest.
      const cx = enemies.reduce((sum, f) => sum + f.x, 0) / enemies.length - caster.x;
      const cy = enemies.reduce((sum, f) => sum + f.y, 0) / enemies.length - caster.y;
      const length = Math.hypot(cx, cy);
      const angle = length < 1 ? this.rng() * Math.PI * 2 : Math.atan2(cy, cx) + (this.rng() - 0.5) * 0.5;
      active.vx = Math.cos(angle);
      active.vy = Math.sin(angle);
      extra.dx = active.vx;
      extra.dy = active.vy;
    } else if (skill === 'shockwave') {
      extra.r = this.unit * skills.shockwave.radiusFactor;
    } else if (skill === 'leap') {
      // Onto the enemy with the most company around it.
      const radius = this.unit * skills.leap.radiusFactor;
      let best = enemies[0]!;
      let bestCount = -1;
      for (const candidate of enemies) {
        let count = 0;
        for (const other of enemies) {
          if ((other.x - candidate.x) ** 2 + (other.y - candidate.y) ** 2 <= radius * radius) count++;
        }
        if (count > bestCount) {
          bestCount = count;
          best = candidate;
        }
      }
      // It lands in the middle part of the arena, as near to that group as that allows,
      // so the god is never left standing against an edge.
      const arena = this.arena;
      const playable = arena.height - arena.margin - arena.top;
      active.x = clamp(best.x, arena.width * 0.22, arena.width * 0.78);
      active.y = clamp(best.y, arena.top + playable * 0.25, arena.top + playable * 0.75);
      extra.x = active.x;
      extra.y = active.y;
      extra.r = radius;
    } else if (skill === 'vortex') {
      // Each whirlwind forms around one fighter and takes those standing nearest to it.
      const vortex = skills.vortex;
      const free = enemies.filter((f) => !f.flight && !f.spinning);
      const count = clamp(Math.floor(free.length / vortex.enemiesPerWhirlwind), 1, vortex.maxWhirlwinds);
      for (let n = 0; n < count && free.length > 0; n++) {
        const center = free.splice(Math.floor(this.rng() * free.length), 1)[0]!;
        const size = Math.round(between(this.rng, vortex.size));
        free.sort(
          (a, b) =>
            (a.x - center.x) ** 2 + (a.y - center.y) ** 2 - ((b.x - center.x) ** 2 + (b.y - center.y) ** 2),
        );
        active.groups.push([center, ...free.splice(0, size - 1)]);
      }
      extra.g = active.groups.map((group) => group.map((f) => this.fighters.indexOf(f)));
    } else if (skill === 'smite') {
      // The enemies who dealt the most damage so far; minions are beneath notice.
      active.targets = enemies
        .filter((f) => !f.minion)
        .sort((a, b) => b.damageDealt - a.damageDealt)
        .slice(0, skills.smite.targets);
      extra.t = active.targets.map((f) => this.fighters.indexOf(f));
    }
    this.emit('warn', skill, caster, extra);
  }

  /** Carries out a skill when its warning ends. Lasting skills move to their `act` phase. */
  private cast(caster: Fighter, active: ActiveSkill, enemies: Fighter[], now: number, finish: () => void): void {
    const skills = config.skills;
    switch (active.skill) {
      case 'rampage':
        active.phase = 'act';
        active.until = now + skills.rampage.maxMs;
        active.bounces = skills.rampage.bounces;
        this.emit('cast', 'rampage', caster, { ms: skills.rampage.maxMs });
        return;
      case 'vortex': {
        const groups: number[][] = [];
        const durations: number[] = [];
        for (const group of active.groups) {
          const members = group.filter((f) => f.alive && !f.flight && !f.spinning);
          if (members.length === 0) continue;
          // Each whirlwind lasts a time of its own, so some fighters are let go sooner than others.
          const duration = Math.round(between(this.rng, skills.vortex.durationMs));
          const direction = this.rng() * Math.PI * 2;
          for (const member of members) member.spinning = true;
          this.whirlwinds.push({
            caster,
            members,
            x: members.reduce((sum, f) => sum + f.x, 0) / members.length,
            y: members.reduce((sum, f) => sum + f.y, 0) / members.length,
            vx: Math.cos(direction),
            vy: Math.sin(direction),
            angle: this.rng() * Math.PI * 2,
            // Wide enough that the fighters ride side by side around the ring.
            orbit: this.unit * (0.9 + 0.22 * members.length),
            until: now + duration,
          });
          groups.push(members.map((f) => this.fighters.indexOf(f)));
          durations.push(duration);
        }
        this.emit('cast', 'vortex', caster, { g: groups, d: durations, ms: Math.max(0, ...durations) });
        break;
      }
      case 'shield':
        active.phase = 'act';
        active.until = now + skills.shield.durationMs;
        caster.shieldUntil = active.until;
        this.emit('cast', 'shield', caster, { ms: skills.shield.durationMs });
        return;
      case 'shockwave': {
        const radius = this.unit * skills.shockwave.radiusFactor;
        const caught = enemies
          .map((enemy) => ({ enemy, d: Math.hypot(enemy.x - caster.x, enemy.y - caster.y) - caster.radius }))
          .filter((entry) => entry.d <= radius)
          .sort((a, b) => a.d - b.d);
        const launched: Fighter[] = [];
        caught.forEach(({ enemy, d }, index) => {
          enemy.slowUntil = now + skills.shockwave.slowMs;
          this.hurt(caster, enemy, skills.shockwave.damage, now, 'shockwave');
          if (!enemy.alive) return;
          if (index < skills.shockwave.launchCount) {
            // The nearest are hurled straight away from the caster, across the arena.
            let dx = enemy.x - caster.x;
            let dy = enemy.y - caster.y;
            let length = Math.hypot(dx, dy);
            if (length < 1e-6) {
              const angle = this.rng() * Math.PI * 2;
              dx = Math.cos(angle);
              dy = Math.sin(angle);
              length = 1;
            }
            this.toss(enemy, dx / length, dy / length, skills.shockwave.launchSpeed, skills.shockwave.launchMs);
            launched.push(enemy);
          } else {
            // The rest are pushed back; those nearer the caster farther.
            this.pushAway(enemy, caster.x, caster.y, this.unit * skills.shockwave.pushFactor * (1 - (0.6 * Math.max(0, d)) / radius));
          }
        });
        this.emit('cast', 'shockwave', caster, {
          r: radius + caster.radius,
          ms: 500,
          t: launched.map((f) => this.fighters.indexOf(f)),
        });
        break;
      }
      case 'leap': {
        const radius = this.unit * skills.leap.radiusFactor;
        caster.x = active.x;
        caster.y = active.y;
        this.keepInArena(caster);
        for (const enemy of enemies) {
          const d = Math.hypot(enemy.x - caster.x, enemy.y - caster.y);
          if (d > radius + enemy.radius) continue;
          this.hurt(caster, enemy, skills.leap.damage, now, 'leap');
          this.pushAway(enemy, caster.x, caster.y, this.unit * skills.leap.knockbackFactor);
        }
        this.emit('cast', 'leap', caster, { r: radius, ms: 500 });
        break;
      }
      case 'smite': {
        const struck = active.targets.filter((f) => f.alive);
        const fireRadius = this.unit * skills.smite.fireRadiusFactor;
        for (const target of struck) {
          this.hurt(caster, target, skills.smite.damage, now, 'smite');
          target.scorchedUntil = now + skills.smite.scorchMs;
          // The ground keeps burning where the lightning struck.
          this.fires.push({
            owner: caster,
            x: target.x,
            y: target.y,
            r: fireRadius,
            until: now + skills.smite.fireMs,
            nextTickAt: now + skills.smite.fireTickMs,
          });
        }
        this.emit('cast', 'smite', caster, {
          t: struck.map((f) => this.fighters.indexOf(f)),
          ms: 450,
          r: fireRadius,
          d: struck.map(() => skills.smite.fireMs),
        });
        break;
      }
      case 'minions': {
        const summoned = caster.skillState!.reserves.splice(0, skills.minions.count);
        summoned.forEach((minion, index) => {
          const angle = (Math.PI * 2 * index) / summoned.length + this.rng() * 0.6;
          const distance = caster.radius + minion.radius + 12;
          minion.x = caster.x + Math.cos(angle) * distance;
          minion.y = caster.y + Math.sin(angle) * distance;
          this.keepInArena(minion);
          minion.alive = true;
          minion.spawned = true;
          minion.health = minion.maxHealth;
          minion.cooldownMs = this.rng() * config.battle.hitIntervalMs;
        });
        this.emit('cast', 'minions', caster, { t: summoned.map((f) => this.fighters.indexOf(f)), ms: 600 });
        break;
      }
      case 'enrage':
        break;
    }
    finish();
  }

  // --- Results ---------------------------------------------------------------

  /** Runs the battle to its end and returns the result. */
  run(): BattleResult {
    while (!this.outcome) this.step();
    return this.result()!;
  }

  private teamHealth(team: string): number {
    let total = 0;
    for (const f of this.fighters) {
      if (f.team !== team) continue;
      // A fresh fighter on the bench counts with its full health.
      if (f.alive) total += f.health;
      else if (f.benched) total += f.maxHealth;
    }
    return total;
  }

  /** Positions, health and flags of all fighters, in roster order, for the overlay. */
  frame(): FrameFighter[] {
    const now = this.timeMs;
    return this.fighters.map((f) => [
      Math.round(f.x),
      Math.round(f.y),
      f.alive ? Math.max(0.01, Math.round((f.health / f.maxHealth) * 100) / 100) : 0,
      (f.hit ? FLAG.hit : 0) |
        (f.alive && f.slowUntil > now ? FLAG.slowed : 0) |
        (f.alive && f.shieldUntil > now ? FLAG.shielded : 0) |
        (f.alive && f.enraged ? FLAG.enraged : 0) |
        (f.alive && f.flight ? FLAG.flying : 0) |
        (f.alive && f.scorchedUntil > now ? FLAG.scorched : 0) |
        (f.alive && f.spinning ? FLAG.spinning : 0) |
        (f.benched ? FLAG.benched : 0) |
        (f.alive && f.hiddenUntil > now ? FLAG.hidden : 0) |
        // Long enough to be in a frame even when the server sends one for several steps.
        (f.alive && now - f.jumpedAt < 300 ? FLAG.jumped : 0),
    ]);
  }

  /** The result, or null while the battle is running. */
  result(): BattleResult | null {
    if (!this.outcome) return null;
    return {
      winner: this.outcome.winner,
      endedBy: this.outcome.endedBy,
      durationMs: this.timeMs,
      sides: this.sides.map((side) => {
        // Minions that were never summoned did not take part.
        const own = this.fighters.filter((f) => f.side === side.id && f.spawned);
        const living = own.filter((f) => f.alive || f.benched);
        return {
          id: side.id,
          team: side.team,
          fighters: own.length,
          survivors: living.length,
          health: living.reduce((sum, f) => sum + (f.alive ? f.health : f.maxHealth), 0),
          damageDealt: own.reduce((sum, f) => sum + f.damageDealt, 0),
        };
      }),
      fighters: this.fighters
        .filter((f) => !f.minion)
        .map((f) => ({
          id: f.id,
          side: f.side,
          kills: f.kills,
          alive: f.alive || f.benched,
          damageDealt: f.damageDealt,
        })),
    };
  }
}

/** A fighter that cannot walk or strike right now: in the air, or in a skill that takes over its movement. */
function isBusy(fighter: Fighter): boolean {
  if (fighter.flight || fighter.spinning || fighter.maneuver) return true;
  const skill = fighter.skillState?.active?.skill;
  return skill === 'rampage' || skill === 'leap';
}

function between(rng: Rng, range: [number, number]): number {
  return range[0] + (range[1] - range[0]) * rng();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
