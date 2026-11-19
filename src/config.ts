/**
 * Every tuning number lives here. Game logic must not contain magic numbers.
 */
export type GuildId = 'red' | 'green' | 'blue';
/** How the tiles are handed out when a season starts. */
export type SeasonStart = 'equal' | 'random';
export type ClassId = 'fighter' | 'tank' | 'thief' | 'archer' | 'mage' | 'healer';
/** A line of the overlay's season statistics panel. */
export type StatId =
  | 'leading'
  | 'champion'
  | 'godSeason'
  | 'godAllTime'
  | 'wars'
  | 'mostKills'
  | 'highestLevel'
  | 'players'
  | 'started';
export type SkillId =
  | 'rampage'
  | 'shockwave'
  | 'leap'
  | 'vortex'
  | 'smite'
  | 'shield'
  | 'minions'
  | 'enrage';

export interface GuildDefinition {
  id: GuildId;
  name: string;
  /** Display color on the overlay and in the control panel. */
  color: string;
  fromHue: number;
  toHue: number;
}

export const config = {
  irc: {
    url: 'wss://irc-ws.chat.twitch.tv:443',
    /** Twitch requires the commands capability whenever tags are requested. */
    capabilities: ['twitch.tv/tags', 'twitch.tv/commands'],
    /** Nickname prefix for anonymous read-only login; random digits are appended. */
    anonymousNickPrefix: 'justinfan',
    reconnect: {
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      jitterMs: 500,
    },
  },
  emotes: {
    /** How often the BetterTTV, FrankerFaceZ and 7TV emote sets are loaded again. */
    refreshMs: 30 * 60_000,
    /** How long the game server waits for an emote service or image before giving up. */
    fetchTimeoutMs: 10_000,
  },
  guilds: {
    /**
     * Hue ranges in degrees, half-open: `fromHue` belongs to the range, `toHue`
     * does not. A range may wrap around 360.
     */
    list: [
      { id: 'red', name: 'Red', color: '#E5484D', fromHue: 300, toHue: 60 },
      { id: 'green', name: 'Green', color: '#46A758', fromHue: 60, toHue: 180 },
      { id: 'blue', name: 'Blue', color: '#3E8BFF', fromHue: 180, toHue: 300 },
    ] as GuildDefinition[],
    /**
     * While fewer chatters than this are known in the season, a new chatter
     * joins one of the smallest guilds, so that no guild stays empty.
     */
    balanceBelowChatters: 15,
    /** Outside these limits a color has no usable hue and the user-id hash decides. */
    minSaturation: 0.15,
    minLightness: 0.1,
    maxLightness: 0.9,
  },
  map: {
    /** A hexagon of hex tiles with this radius: 19 tiles at radius 2. */
    radius: 2,
    /** City positions in axial coordinates, on alternating corners. */
    cities: {
      red: { q: 2, r: -2 },
      green: { q: 0, r: 2 },
      blue: { q: -2, r: 0 },
    } as Record<GuildId, { q: number; r: number }>,
  },
  /**
   * Land: every tile but the cities and the center belongs to a guild from the
   * start of a season. Chatting develops a guild's tiles; developed land feeds
   * the guild's Monument and is harder to take.
   */
  land: {
    /**
     * The five tiles the Red guild starts with, in axial coordinates. The other
     * guilds get the same shape turned by a third of a circle, so all three
     * have the same position; the center tile stays neutral.
     */
    redSector: [
      { q: 1, r: -2 },
      { q: 1, r: -1 },
      { q: 2, r: -1 },
      { q: 1, r: 0 },
      { q: 2, r: 0 },
    ],
    maxLevel: 10,
    /** Developing a tile to level n costs `costPerLevel * n` points, times the channel scale. */
    costPerLevel: 12,
    /** In a War the defender's fighters have this much more health per level of the attacked tile. */
    defensePerLevel: 0.03,
    /** A captured or scorched tile keeps this share of its level, rounded down. */
    keepOnCapture: 0.5,
    /**
     * The center tile is the god's. A guild can win it (the next Clash's prize,
     * or a raid in a War) but only holds it for `holdWindows` windows of stream
     * time; then the god takes it back. It cannot be developed: while held it
     * counts as a tile of this fixed `level`.
     */
    center: { id: '0,0', holdWindows: 6, level: 5 },
    /**
     * Land does not grow evenly. Every chatter has a home tile in their guild
     * (stable while the guild keeps it), and their ticks build it, so tiles
     * with many regulars rise fast. Each season every tile also gets a
     * fertility between `fertility.min` and `fertility.max`: the development
     * points one tick gives it.
     */
    fertility: { min: 0.6, max: 1.6 },
  },
  /**
   * Mishaps, rolled once per window of stream time while the background layer
   * is on, so the land never just climbs:
   * - Lightning seeks tall structures: it strikes with `chance` per window,
   *   a tile picked by its level squared, which loses `levels` levels (one
   *   more with `extraChance`).
   * - A fire starts with `chance` on a developed tile, picked by level. Each
   *   window it burns a level, unless at least `douse` members of the owning
   *   guild were active in the window before: they put it out. A fire may
   *   spread to a neighbouring tile (`spreadChance`), whoever owns it, and
   *   burns out by itself after `maxWindows`.
   * - A harvest raises a random tile by one level with `chance`.
   */
  mishaps: {
    /**
     * Lightning and fire start rare and grow with the season, so a young
     * season's land is not taken back as fast as it grows: their chances are
     * multiplied by `startStrength` at the start, rising to full strength
     * after `fullAfterHours` of the season's stream time. (By stream time,
     * not by Monument progress: then the land settles at the same time in a
     * short season as in a long one, before the goal stops adapting.)
     */
    ramp: { startStrength: 0.3, fullAfterHours: 2 },
    lightning: { chance: 0.14, levels: 1, extraChance: 0.35 },
    fire: { chance: 0.1, douse: 2, spreadChance: 0.3, maxWindows: 3 },
    harvest: { chance: 0.07 },
    /** How many recent mishaps the overlay and the control panel are told about. */
    remember: 12,
    /**
     * Lightning leaves a scorch mark on its tile, a fire that burnt out or was
     * put out leaves ash, for this many windows (the one it happened in included).
     */
    markWindows: 3,
  },
  /**
   * The Monument: the season's finish line. In every window in which a guild
   * is active, its Monument grows by `baseIncome`, plus `perTile` for each
   * tile it holds (its city aside), plus `perLevel` for each level of those
   * tiles: an owned tile always yields something, even at level 0. A
   * development point with no tile left to go to adds `perPoint`. The first
   * guild to reach the season's goal (see `season`) wins the season. The
   * numbers are in tens so that a window's gain splits into many small pops
   * on the overlay.
   */
  monument: {
    baseIncome: 10,
    perTile: 10,
    perLevel: 10,
    perPoint: 10,
    /** When the god wins the first Streamer vs Chat of a session, every Monument loses this share. */
    setback: 0.15,
  },
  /**
   * How long a season lasts: the streamer's one balance setting. The
   * Monument goal is worked out from `hours` of stream time (time with the
   * background layer on and chat writing; time between streams does not
   * count):
   * - Before anything is measured, the goal is `expectedPerHour * hours`:
   *   what the leading Monument grows in an hour of stream, measured with
   *   `node src/cli/season-pace.ts` (about the same for 12 or 200 chatters,
   *   as costs follow the channel size).
   * - For the first `adaptShare` of the season (at most `adaptHours`), the
   *   goal moves toward what the chat's own pace projects, measured over the
   *   last `paceWindows` windows; then it stays put, so a Monument's share
   *   never jumps back later.
   */
  season: {
    hours: 10,
    expectedPerHour: 2_000,
    adaptShare: 0.3,
    adaptHours: 6,
    paceWindows: 12,
    /** Goals are rounded to this, and never set below `minGoal`. */
    roundTo: 100,
    minGoal: 500,
  },
  /**
   * How long fights last. Every kind of fight should take 60 to 90 seconds:
   * long enough to follow, short enough to stay exciting. Each number
   * multiplies every fighter's health (healing and obstacle damage with it)
   * in that kind of fight, scaled by `(30 / fighters) ^ exponent` for its
   * size: a crowded arena ends a fight sooner per fighter (a small exponent
   * evens that out), and a fight with a bench lasts as long as it takes to
   * get through everyone drawn (exponent 1). Measured with
   * `node src/cli/fight-durations.ts`.
   */
  pace: {
    /**
     * The shortest a fight usually lasts, for the runtimes the control panel
     * shows (the longest is the time limit). The measured medians are 60 to 80 s.
     */
    shortestFightMs: 60_000,
    reference: 30,
    kinds: {
      war: { toughness: 4.3, exponent: 0.1 },
      heroClash: { toughness: 6, exponent: 0 },
      guildClash: { toughness: 1.25, exponent: 1 },
      freeForAll: { toughness: 1.5, exponent: 1 },
      god: { toughness: 5, exponent: 0.2 },
    },
  },
  battle: {
    /** A test battle with too few active chatters fills each empty guild with this many stand-ins. */
    standIns: 8,
    stepsPerSecond: 20,
    /** The time limit of a battle; most end before it (see `pace`). */
    durationMs: 90_000,
    baseHealth: 100,
    baseDamage: 10,
    hitIntervalMs: 1_000,
    /** Health bonus per chatter level, and its cap. */
    levelHealthBonus: 0.02,
    maxLevelHealthBonus: 0.3,
    /** Each hit deals the fighter's damage varied by this share up or down. */
    damageVariation: 0.25,
    /**
     * Fortune of battle: each side's damage is multiplied once per battle by a
     * random factor between `1 - fortune` and `1 + fortune`. Without it, a
     * large battle is so predictable that a 10% bonus wins nine times in ten.
     */
    fortune: 0.25,
    /**
     * Size balance: health and damage are multiplied by
     * `(average side / own side) ^ sizeBalanceExponent`, clamped. The exponent
     * was tuned with `src/cli/battle-stats.ts`: at 0.5 the smaller side loses
     * most fights, at 0.75 it wins most.
     */
    sizeBalanceExponent: 0.6,
    /** With three sides the small side needs less help: the two larger ones wear each other down. */
    sizeBalanceExponentThreeWay: 0.3,
    sizeBalanceMin: 0.6,
    sizeBalanceMax: 1.8,
    /** A screen cannot show thousands of fighters; larger sides are drawn by lot. */
    maxFightersPerSide: 40,
    /** The session's most active chatters of a guild always get a place. */
    heroesPerGuild: 3,
    /**
     * The arena in simulation units; the overlay stretches it over the whole
     * 1920 x 1080 screen (1.875 pixels a unit). Fighters, skills and speeds are
     * in these units, so a smaller arena shows everything larger.
     */
    arena: {
      width: 1024,
      height: 576,
      /** Kept free for the scoreboard (about 135 screen pixels). */
      top: 72,
      /** No fighter comes nearer than this to the left, right and bottom edge: nothing is ever off screen. */
      margin: 16,
    },
    /**
     * The map banner across the top or the bottom of the screen during battles
     * (a setting in the control panel): this many arena units of the height
     * (about 112 screen pixels) are taken from the arena, so no fighter, skill
     * or caption ever reaches it.
     */
    bannerHeight: 60,
    /**
     * A fighter's personal space. Small battles get larger fighters so they
     * fill the screen: `fighterRadius * sqrt(radiusReferenceCount / fighters)`,
     * between `fighterRadius` and `maxFighterRadius`.
     */
    fighterRadius: 20,
    maxFighterRadius: 40,
    radiusReferenceCount: 60,
    /** The overlay draws the circle smaller than the personal space, leaving gaps for names. */
    drawnRadiusShare: 0.8,
    /** How often per step overlapping fighters are pushed apart. More passes mean less crowding. */
    separationPasses: 6,
    /** Movement in arena units per second, varied by `speedVariation` per fighter. */
    moveSpeed: 140,
    speedVariation: 0.1,
    /** How long the overlay shows the result. */
    resultHoldMs: 7_000,
  },
  /**
   * Obstacles in battles, when switched on in the control panel. Sizes are
   * multiples of a fighter's radius in that battle (the unit).
   * - A team battle gets a layout with `chance`; it stays for the whole fight,
   *   so each battle of a War can look different.
   * - A free-for-all or the endless mode has obstacles appear now and then
   *   (`changing.everyMs`) and disappear again after `changing.lifeMs`.
   * Walls stand in the way; bumpers fling whoever touches them away like a
   * pinball; barrels roll across, knock fighters aside and hurt them; spike
   * traps strike everyone on them every `periodMs`, after a warning.
   */
  /**
   * Fighters thrown through the air: hurled by Shockwave, flung by a bumper or
   * a barrel, pushed aside by the god. A throw starts at `start` times its
   * average speed and slows down evenly to `2 - start` times it at the end, so
   * it covers the same distance as at an even speed but lands softly. The
   * god's pushes (dash, Rampage, Leap) take `pushMs` for their distance.
   * So that a crowd hurled by one blast does not fly in lockstep, each throw
   * by the god varies its starting speed by up to `speedVariation` and its
   * duration by up to `durationVariation`, up or down.
   */
  flight: {
    start: 1.8,
    pushMs: 280,
    speedVariation: 0.25,
    durationVariation: 0.3,
  },
  obstacles: {
    chance: 0.4,
    wall: { count: [2, 3] as [number, number], length: [4, 7] as [number, number], thickness: 0.8 },
    bumper: { count: [3, 5] as [number, number], radius: 1.3, flingMs: 220 },
    barrel: { radius: 0.9, speed: 300, everyMs: [2_200, 4_500] as [number, number], damage: 8, knock: 2.5 },
    trap: { count: [2, 4] as [number, number], radius: 1.4, periodMs: 3_200, warnMs: 800, strikeMs: 300, damage: 16 },
    changing: { everyMs: [9_000, 18_000] as [number, number], lifeMs: [10_000, 18_000] as [number, number], max: 4 },
    /** How long an obstacle takes to appear and to fade away, in the overlay and before it blocks. */
    fadeMs: 600,
  },
  war: {
    /** The chat command for the broadcaster and moderators. Off unless enabled in the panel. */
    command: '!war',
    /** How long the overlay shows the map with the attack before a battle begins. */
    announceMs: 5_000,
    /** How long a battle's result stays on screen during an event, before the map returns. */
    resultHoldMs: 4_500,
    /** How long the map shows what a battle changed: the tile changing hands, or holding. */
    outcomeMs: 4_500,
    /** How long the overlay shows the War's summary. */
    summaryHoldMs: 9_000,
    /** Bonus XP for everyone eligible to fight in a War. */
    participationXp: 20,
    /** Extra XP per battle the chatter's guild won. */
    winXp: 10,
  },
  /**
   * Classes: every chatter is dealt one at random for each fight. A class
   * changes a fighter's stats a little and its behavior a lot, so fights keep
   * moving. `health`, `damage` and `speed` multiply the base values. Distances
   * given as a "factor" are multiples of a normal fighter's radius in that battle.
   * All numbers are first guesses, to be balanced in the final pass.
   */
  classes: {
    /** How often each class is dealt, as shares that need not add up to 1. */
    shares: { fighter: 0.3, archer: 0.2, tank: 0.15, thief: 0.15, mage: 0.1, healer: 0.1 } as Record<ClassId, number>,
    names: {
      fighter: 'Fighter',
      tank: 'Tank',
      thief: 'Thief',
      archer: 'Archer',
      mage: 'Mage',
      healer: 'Healer',
    } as Record<ClassId, string>,
    /** Walks to the nearest enemy; now and then a spin that hits everyone around it for part of its damage. */
    fighter: { health: 1, damage: 1, speed: 1, spinEveryMs: 4_000, spinRadiusFactor: 2.8, spinDamage: 0.6 },
    /**
     * Slow and tough. Enemies within `tauntRadiusFactor` prefer to attack it.
     * Now and then, with an enemy close, it cannot be hurt for `shieldMs`.
     */
    tank: { health: 1.5, damage: 0.9, speed: 0.7, tauntRadiusFactor: 6, shieldEveryMs: 7_000, shieldMs: 1_800 },
    /**
     * Fast and weak. Goes for archers, mages and healers first; after each
     * strike it darts back for `retreatMs`. Every `shadowEveryMs` it slips
     * into the shadows for up to `shadowMs`: nobody can target or hurt it, and
     * it moves `shadowSpeed` times as fast. Its own strike brings it back out.
     */
    thief: {
      health: 0.85, damage: 0.7, speed: 1.55, retreatMs: 800,
      shadowEveryMs: 6_000, shadowMs: 2_500, shadowSpeed: 1.6,
    },
    /** Shoots from `rangeFactor` away and backs off from enemies closer than `retreatFactor`. */
    archer: { health: 0.7, damage: 0.8, speed: 0.95, rangeFactor: 11, retreatFactor: 5 },
    /**
     * Keeps its distance like an archer. Every `castEveryMs` it marks a circle on
     * the ground at its target, which blasts everyone in it `warnMs` later.
     */
    mage: {
      health: 0.7, damage: 1, speed: 0.8, rangeFactor: 10, retreatFactor: 5,
      castEveryMs: 4_000, warnMs: 900, blastRadiusFactor: 3.2, blastDamage: 18,
    },
    /**
     * Follows the ally with the least health and heals it from `rangeFactor`
     * away. It heals neither itself nor other healers. A healer left without
     * such allies fights for itself, weakly (`damage`), so a fight can always end.
     */
    healer: { health: 0.75, damage: 0.5, speed: 1.05, rangeFactor: 3.5, healPerSecond: 7, tickMs: 500 },
  },
  /**
   * Skills of special fighters, today only the god. A fighter casts one of its
   * enabled skills at random intervals; each cast is announced `warnMs` ahead.
   * Distances given as a "factor" are multiples of a normal fighter's radius in
   * that battle, so skills keep their proportions in small and large fights.
   * `healthFactor` is the god health, relative to a god without skills, at
   * which a god with only that skill wins half its fights; measured by a search
   * over chat sizes 8, 25 and 60. A value below 1 means the skill makes the god
   * stronger. Vortex is above 1: pulling chat in lets more fighters reach the
   * god. Enrage is slightly above 1 too: the god's growth lets more fighters
   * reach it, which outweighs its speed and damage.
   * See `skillHealthFactor` for how the factors of several skills combine.
   */
  skills: {
    /** Time before the first cast, and between the end of one skill and the next cast. */
    firstCastMs: [2_000, 3_500] as [number, number],
    intervalMs: [2_500, 4_500] as [number, number],
    warnMs: 1_000,
    names: {
      rampage: 'Rampage',
      shockwave: 'Shockwave',
      leap: 'Leap',
      vortex: 'Vortex',
      smite: 'Smite',
      shield: 'Divine Shield',
      minions: 'Minions',
      enrage: 'Enrage',
    } as Record<SkillId, string>,
    descriptions: {
      rampage: 'Bounces very fast from edge to edge, knocking aside everyone in the way, then returns to the middle.',
      shockwave: 'A blast that hurls the five nearest fighters across the arena and pushes back and slows the rest.',
      leap: 'Jumps onto the thickest group of fighters and damages everyone where it lands.',
      vortex: 'Several whirlwinds each catch a handful of fighters, spin them and carry them off for a few seconds.',
      smite: 'Lightning strikes the three chatters who dealt the most damage and leaves burning ground.',
      shield: 'Cannot be hurt for a few seconds.',
      minions: 'Summons small copies of itself that fight on its side.',
      enrage: 'Below 30% health it grows, moves faster and hits harder. Always active, not cast.',
    } as Record<SkillId, string>,
    rampage: { speed: 1_400, bounces: 3, /** Long enough for the bounces and the way back to the middle. */ maxMs: 5_000, damage: 25, knockbackFactor: 5, rehitMs: 500, healthFactor: 0.74 },
    shockwave: {
      radiusFactor: 7, pushFactor: 9, slow: 0.45, slowMs: 3_000, damage: 10,
      /** The nearest fighters are hurled across the arena and bounce off its walls. */
      launchCount: 5, launchSpeed: 1_300, launchMs: 1_500,
      healthFactor: 0.81 },
    leap: { radiusFactor: 5, damage: 45, knockbackFactor: 3, healthFactor: 0.79 },
    vortex: {
      /** One whirlwind per this many enemies, at least one and at most `maxWhirlwinds`. */
      enemiesPerWhirlwind: 6,
      maxWhirlwinds: 4,
      /** How many fighters one whirlwind catches, and how long it lasts; both are rolled per whirlwind. */
      size: [4, 6] as [number, number],
      durationMs: [1_800, 4_500] as [number, number],
      /** How fast a whirlwind wanders, in arena units per second, and how fast it turns, in radians per second. */
      driftSpeed: 90,
      spin: 5,
      healthFactor: 1.26,
    },
    smite: {
      targets: 3, damage: 60, /** How long a struck fighter stays visibly scorched. */ scorchMs: 4_000,
      /** Each strike leaves burning ground: its size, how long it burns, and what it does to enemies standing in it. */
      fireRadiusFactor: 2.2, fireMs: 5_000, fireDamage: 6, fireTickMs: 500,
      healthFactor: 0.92 },
    shield: { durationMs: 3_000, healthFactor: 0.69 },
    minions: { count: 4, casts: 2, health: 50, damage: 5, radiusFactor: 0.8, healthFactor: 0.73 },
    enrage: { below: 0.3, speed: 1.5, damage: 1.5, /** The enraged fighter grows by this factor. */ grow: 1.3, healthFactor: 1.04 },
  },
  /**
   * Countdown fights: the streamer starts a countdown, chatters who write
   * during it are drawn, the line-up is shown, and they fight with equal stats.
   */
  draft: {
    countdownMs: 30_000,
    /** How long the line-up stays on screen before the fight; time to place bets in chat. */
    lineupMs: 15_000,
    /** Guild mode: fighters drawn per guild, and how many of them are on the field at once. */
    perGuild: 10,
    onFieldPerGuild: 3,
    /** Free-for-all: fighters drawn in total, and how many are on the field at once. */
    freeForAllFighters: 30,
    freeForAllOnField: 10,
    /** Time limit of the fight, bench included. */
    durationMs: 100_000,
  },
  /**
   * Pachinko, in the Arena: chatters are drawn like for a Guild Clash, then
   * each guild gets a board. Every drawn chatter drops once; a guild with
   * fewer drops some again, so all guilds drop as many balls. A ball bounces
   * down `rows` rows of pins, left or right at each, into one of `rows + 1`
   * slots worth `slots` points. The highest sum wins. It changes nothing in
   * the game: it is for fun, and for betting in chat.
   */
  pachinko: {
    rows: 8,
    slots: [100, 25, 10, 5, 2, 5, 10, 25, 100],
    /**
     * One ball drops at a time, the boards taking turns, spaced so the game
     * lasts about `targetMs` (like a fight: 60 to 90 seconds), but never
     * closer than `minGapMs` or further apart than `maxGapMs`. Every board
     * drops at least `minBalls`: with few chatters, they drop again in turn.
     * A ball takes `hopMs` per row of pins.
     */
    targetMs: 75_000,
    minGapMs: 1_500,
    maxGapMs: 3_500,
    minBalls: 8,
    hopMs: 360,
    /** How long the boards stay after the last ball landed: the winner's celebration. */
    holdMs: 7_000,
  },
  /** Endless mode: a free-for-all that runs until switched off and changes nothing in the game. */
  endless: {
    /** Default number of fighters on the field at once; the streamer can change it. */
    concurrent: 12,
    minConcurrent: 2,
    maxConcurrent: 60,
    /** At most this many chatters take turns. */
    roster: 80,
    /** The fight restarts with the chatters active at that moment this often. */
    refreshMs: 300_000,
  },
  /**
   * Breaking up crowds: fighters go for the nearest enemy, so one stuck in a
   * crowd can push into it for a long time. Every `checkMs` a fighter that has
   * moved less than `still` (in fighter radii) since the last check, with at
   * least `crowd` others within `crowdRadius` radii, goes with a chance of
   * `chance` for a straggler instead: one of the `pick` least crowded enemies
   * among the farther `farShare` of them, for `roamMs` or until it reaches it.
   * Random on purpose: it happens now and then, not every time. Not the god,
   * which holds the middle, and not healers, which follow their allies.
   */
  roam: {
    checkMs: 2_000,
    still: 0.6,
    crowd: 4,
    crowdRadius: 3,
    chance: 0.35,
    farShare: 0.5,
    pick: 3,
    roamMs: [3_000, 5_000] as [number, number],
  },
  bench: {
    /** How long after a death the next fighter steps in from the bench. */
    entryDelayMs: 700,
    /** Endless fights: how long a fallen fighter waits before rejoining the queue. */
    respawnMs: 3_000,
  },
  clash: {
    heroesPerGuild: 3,
    /** Time limit of one heat or the final. */
    matchMs: 90_000,
    /** The champion's guild earns `ticks.boostMultiplier` times the tick XP for this long. */
    boostMs: 30 * 60_000,
  },
  god: {
    /** Shown when the broadcaster has not written in chat yet. */
    fallbackColor: '#FFD54A',
    /** Largest accepted picture for the god, after the control panel shrank it. */
    maxPictureBytes: 400_000,
    /**
     * The god's health is `healthBase * fighters ^ healthExponent`, varied by
     * `healthVariation` up or down per fight. Found with a search over chat
     * sizes from 3 to 120 (`node src/cli/fight-durations.ts --kinds god`): at
     * these values the god wins about half its fights (33 to 67% per size in
     * 30 fights each), with fights of 60 to 90 seconds (see `pace`).
     */
    healthBase: 17.5,
    healthExponent: 1.3,
    /**
     * Above this many fighters the health grows more slowly, with
     * `largeChatExponent`: such fights run close to the time limit, which the
     * god wins, so it needs less health than the curve for smaller chats says.
     */
    largeChat: 70,
    largeChatExponent: 0.4,
    healthVariation: 0.3,
    damage: 30,
    /** The god's size and the reach of its sweeping blow, as multiples of a fighter's radius. */
    radiusFactor: 2.4,
    splashFactor: 2.5,
    speed: 120,
    /** How hard the god is to push aside; a normal fighter weighs 1. */
    weight: 40,
    /** The god holds the middle of the arena and drifts around it by at most this many units. */
    wander: 70,
    /**
     * Between skills the god never stands still. These moves are always on,
     * not skills: a dash that knocks chatters aside, a blink to another spot,
     * or a run off one side of the screen and back in at the other (chatters
     * cannot do that). One starts every `everyMs`, never this close before
     * the next skill (`clearOfSkillMs`), picked by `shares`.
     */
    moves: {
      everyMs: [1_300, 2_400] as [number, number],
      clearOfSkillMs: 600,
      shares: { dash: 0.45, blink: 0.3, wrap: 0.25 },
      dash: { speed: 1_000, distance: [180, 320] as [number, number], knockbackFactor: 2.5 },
      blink: { distance: [180, 340] as [number, number] },
      /** How far past the edge it comes back in, beyond its own size. */
      wrap: { speed: 1_100, beyond: [140, 260] as [number, number] },
    },
    /** XP for everyone on the winning side when chat beats the god. */
    winXp: 30,
    /** With this many wins against chat in a season (friendly fights aside), the god wins the season. */
    winsToWinSeason: 5,
  },
  /**
   * The overlay's two panels, in screen pixels of the 1920 x 1080 overlay. The
   * server sends each panel's place and size to the overlay and uses the same
   * numbers to keep endless-mode fighters from walking over the panels.
   */
  overlay: {
    width: 1920,
    height: 1080,
    margin: 28,
    mapPanel: { width: 820, height: 360 },
    /** The statistics panel is as tall as its lines: a header, then one row per enabled line. */
    statsPanel: { width: 440, headerHeight: 60, rowHeight: 32, footerHeight: 16 },
    /** The statistics lines, in the order shown. All are on until the streamer switches some off. */
    statLines: [
      'leading',
      'champion',
      'godSeason',
      'godAllTime',
      'wars',
      'mostKills',
      'highestLevel',
      'players',
      'started',
    ] as StatId[],
  },
  server: {
    port: 4747,
    /** Local only: the overlay and panel are opened on the streamer's own machine. */
    host: '127.0.0.1',
    /** How often the server checks whether the state changed and pushes it. */
    broadcastIntervalMs: 1_000,
    /** A chatter counts as active for fights if they earned a tick this recently. */
    activeWindowMs: 30 * 60_000,
    topChatters: 8,
  },
  /**
   * The "new version available" notice in the control panel. `url` is the
   * website's version.json (written by `npm run release`), e.g.
   * 'https://<group>.gitlab.io/<project>/version.json'. Empty: never checks.
   */
  updates: {
    url: '' as string,
    everyMs: 6 * 60 * 60_000,
    /** How long a check waits for the website before giving up quietly. */
    timeoutMs: 5_000,
  },
  ticks: {
    /** Length of one activity window. One tick per chatter per window. */
    windowMs: 5 * 60_000,
    xpPerTick: 10,
    /** Extra XP per tick for each tile the guild owns besides its city. */
    xpPerOwnedTile: 1,
    maxOwnedTileXp: 6,
    /** Multiplier on tick XP while a Hero Clash boost is active. */
    boostMultiplier: 1.5,
    /** Level n needs `levelXpFactor * n^2` total XP. */
    levelXpFactor: 50,
  },
  /**
   * Channel size. All point costs are tuned for `referenceChatters` chatters
   * earning a tick per window (about 60 people who chat at all during a stream)
   * and are multiplied by `activeChatters / referenceChatters`.
   */
  scaling: {
    referenceChatters: 25,
    minScale: 0.02,
    maxScale: 200,
    /** The measurement averages over the most recent sessions. */
    historySessions: 5,
    /**
     * Until this many windows have been measured, the scale is re-measured in
     * every window; after that only when a session starts.
     */
    warmupWindows: 6,
  },
  /** Logins (lower case) that never take part: no guild, no ticks. */
  botNames: ['nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot', 'wizebot'],
  /** Defaults for the chat simulator used during development. */
  sim: {
    chatterCount: 60,
    moderatorCount: 2,
    botNames: ['nightbot'],
    /** Share of chatters who never set a name color (empty `color` tag). */
    noColorShare: 0.3,
    /** Of those with a color, the share using one of Twitch's default colors. */
    defaultColorShare: 0.6,
    /**
     * Messages per minute of a chatter: `min + spread * u^skew` with u uniform
     * in [0, 1). A high skew gives a few very active chatters and many quiet ones.
     */
    rate: { minPerMinute: 0.02, spreadPerMinute: 1.5, skew: 4 },
    /** Share of simulated messages that contain an emote. */
    emoteShare: 0.4,
    /** Share of simulated chatters who never use emotes. */
    noEmoteShare: 0.2,
    /** How often the realtime driver emits pending events. */
    driverIntervalMs: 250,
  },
};

export type Config = typeof config;
