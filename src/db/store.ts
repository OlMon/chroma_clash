import type { DatabaseSync } from 'node:sqlite';
import { config, type GuildId, type SeasonStart, type SkillId, type StatId } from '../config.ts';
import type { MapTile } from '../game/expansion.ts';
import { assignGuild } from '../game/guilds.ts';
import {
  addDevelopmentPoint,
  developTarget,
  fertility,
  homeTile,
  isCenter,
  levelAfterCapture,
  monumentIncome,
  rollMishaps,
  startingLand,
  tickPoints,
  type Mishap,
} from '../game/land.ts';
import { createRng, hashString, type Rng } from '../util/rng.ts';
import { THIRD_PARTY_SOURCES, type ThirdPartySource } from '../emotes/sources.ts';
import { scaleFor } from '../game/scaling.ts';
import { levelForXp, tickXp, windowStartOf } from '../game/ticks.ts';
import type { ChatMessageEvent } from '../irc/events.ts';
import { openDatabase } from './schema.ts';

export interface UserRow {
  user_id: string;
  login: string;
  display_name: string;
  color: string | null;
  /** The Twitch emote the chatter used most recently, or null. */
  emote_id: string | null;
  guild_id: GuildId;
  /** Unused since professions were removed; kept so old databases still load. */
  profession: string | null;
  xp: number;
  level: number;
  kills: number;
  deaths: number;
  battles: number;
  clash_wins: number;
  seasons_won: number;
  first_seen: number;
  last_seen: number;
}

export interface TileRow {
  tile_id: string;
  q: number;
  r: number;
  owner_guild_id: GuildId | null;
  is_city: number;
  scorched: number;
  /** Development: the tile's level and the points toward its next one. */
  level: number;
  points: number;
  /** Windows a fire has burned on the tile; 0: no fire. */
  burning: number;
}

/** A mishap as the pages show it: what happened, where, and a number to tell new ones from old. */
export interface MishapRecord extends Mishap {
  id: number;
  /** The start of the window it happened in; missing in records from before it was kept. */
  at?: number;
}

export interface BattleRecord {
  warId: number;
  position: number;
  kind: 'attack' | 'skirmish' | 'skipped';
  tileId: string | null;
  attacker: GuildId;
  defender: GuildId | null;
  winner: GuildId | null;
  captured: boolean;
  endedBy: string | null;
  durationMs: number | null;
  seed: number;
}

export interface BattleRow {
  battle_id: number;
  war_id: number;
  position: number;
  kind: string;
  tile_id: string | null;
  attacker_guild_id: GuildId;
  defender_guild_id: GuildId | null;
  winner_guild_id: GuildId | null;
  captured: number;
  ended_by: string | null;
  duration_ms: number | null;
  seed: number;
}

export interface ClaimRow {
  tile_id: string;
  guild_id: GuildId;
  progress: number;
}

export interface SessionRow {
  session_id: number;
  started_at: number;
  ended_at: number | null;
  champion_user_id: string | null;
  versus_used: number;
}

/** The god's wins and losses. Friendly fights, with nothing at stake, are counted apart. */
/** Where an overlay panel sits: its top-left corner in screen pixels, and whether it is shown. */
export interface PanelPlace {
  x: number;
  y: number;
  visible: boolean;
}

export interface GodRecord {
  seasonWins: number;
  seasonLosses: number;
  lifetimeWins: number;
  lifetimeLosses: number;
  friendlyWins: number;
  friendlyLosses: number;
}

export interface MessageResult {
  user: UserRow;
  /** True when this message earned the chatter a tick. */
  tickAwarded: boolean;
  /** True when this tick ended a guild's time on the center tile: the god took it back. */
  centerReclaimed?: boolean;
  /** Set when this tick completed a guild's Monument: the season just ended with that winner. */
  seasonWonBy?: GuildId;
}

/** A finished season, for the history. The god's score leaves friendly fights aside. */
/** A season's final picture, recorded when it ends, before levels and kills are reset. */
export interface SeasonSummary {
  /**
   * How the season ended: a guild finished its Monument, the god reached its
   * wins against chat, or the streamer ended it from the control panel.
   */
  endedBy: 'monument' | 'god' | 'streamer';
  /** The chatter with the highest level, the most kills, and the most Clash wins in the season. */
  topLevel: { displayName: string; level: number } | null;
  topKiller: { displayName: string; kills: number } | null;
  champion: { displayName: string; wins: number } | null;
  /** How many chatters played in the season. */
  players: number;
  /** Final standings per guild: Monument progress, the goal it was measured against, tiles and land level. */
  monumentGoal: number;
  guilds: Record<GuildId, { monument: number; tiles: number; development: number; members: number; design?: number }>;
}

/** How the overlay looks: the theme, and how fighters' emotes are shown. */
export interface DisplaySettings {
  /** The chosen theme's folder name, or null for the default. */
  theme: string | null;
  pixelateEmotes: boolean;
  animatedEmotes: boolean;
  /** Whether a chatter who never used an emote fights as a random one. */
  randomEmotes: boolean;
  emoteSources: Record<ThirdPartySource, boolean>;
}

export interface SeasonRecord {
  id: number;
  startedAt: number;
  endedAt: number;
  winner: SeasonWinner | null;
  wars: number;
  godWins: number;
  godLosses: number;
  /** Null for seasons that ended before summaries were recorded. */
  summary: SeasonSummary | null;
}

/**
 * The emote a message leaves its author with, as a source-qualified id: what
 * the caller worked out from all sources, else the last Twitch emote.
 */
function messageEmote(event: ChatMessageEvent): string | null {
  if (event.emote !== undefined) return event.emote;
  const twitch = event.emoteIds.at(-1);
  return twitch === undefined ? null : `twitch:${twitch}`;
}

/** Who can win a season: a guild, or the god. */
export type SeasonWinner = GuildId | 'god';

/** All database access for one channel. Time is always passed in, never read from the clock. */
export class Store {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(path: string): Store {
    return new Store(openDatabase(path));
  }

  close(): void {
    this.db.close();
  }

  /**
   * Writes a complete, consistent copy of the database to `file` (which must
   * not exist yet), while the game keeps running. For exports and backups.
   */
  copyTo(file: string): void {
    this.db.prepare('VACUUM INTO ?').run(file);
  }

  /** Runs `work` atomically. Joins the surrounding transaction if there is one. */
  transaction<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec('BEGIN');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // --- Seasons ---------------------------------------------------------------

  /** The id of the running season; starts the first season if there is none. */
  currentSeasonId(now: number): number {
    const row = this.db
      .prepare('SELECT season_id FROM seasons WHERE ended_at IS NULL ORDER BY season_id DESC LIMIT 1')
      .get() as { season_id: number } | undefined;
    if (row) return row.season_id;
    const result = this.db.prepare('INSERT INTO seasons (started_at) VALUES (?)').run(now);
    return Number(result.lastInsertRowid);
  }

  /** The most recently finished season, or null in the first season. */
  lastSeason(): { season_id: number; winner_guild_id: SeasonWinner | null } | null {
    const row = this.db
      .prepare(
        'SELECT season_id, winner_guild_id FROM seasons WHERE ended_at IS NOT NULL ORDER BY season_id DESC LIMIT 1',
      )
      .get() as { season_id: number; winner_guild_id: SeasonWinner | null } | undefined;
    return row ? { ...row } : null;
  }

  /** Every finished season, newest first, with who won it and what happened in it. */
  seasonHistory(): SeasonRecord[] {
    const rows = this.db
      .prepare(
        `SELECT s.season_id AS id, s.started_at AS startedAt, s.ended_at AS endedAt, s.winner_guild_id AS winner,
           s.summary AS summary,
           (SELECT COUNT(*) FROM wars w WHERE w.season_id = s.season_id) AS wars,
           (SELECT COALESCE(SUM(g.god_won = 1), 0) FROM god_fights g
              WHERE g.season_id = s.season_id AND g.kind != 'friendly') AS godWins,
           (SELECT COALESCE(SUM(g.god_won = 0), 0) FROM god_fights g
              WHERE g.season_id = s.season_id AND g.kind != 'friendly') AS godLosses
         FROM seasons s WHERE s.ended_at IS NOT NULL ORDER BY s.season_id DESC`,
      )
      .all() as unknown as (Omit<SeasonRecord, 'summary'> & { summary: string | null })[];
    return rows.map((row) => {
      let summary: SeasonSummary | null = null;
      try {
        summary = row.summary ? (JSON.parse(row.summary) as SeasonSummary) : null;
      } catch {
        summary = null;
      }
      return { ...row, summary };
    });
  }

  /** The running season as it stands: what is recorded for the history when it ends. */
  seasonSummary(seasonId: number, endedBy: SeasonSummary['endedBy'] = 'streamer'): SeasonSummary {
    const started = this.seasonInfo(seasonId).startedAt;
    const champion = this.db
      .prepare(
        `SELECT u.display_name AS displayName, COUNT(*) AS wins FROM clashes c
         JOIN users u ON u.user_id = c.winner_user_id
         WHERE c.started_at >= ? GROUP BY u.user_id ORDER BY wins DESC, u.user_id LIMIT 1`,
      )
      .get(started) as { displayName: string; wins: number } | undefined;
    const monuments = this.monuments();
    const sizes = this.guildSizes();
    const designs = this.monumentDesigns();
    const guilds = {} as SeasonSummary['guilds'];
    for (const guild of config.guilds.list) {
      guilds[guild.id] = {
        monument: Math.round(monuments[guild.id]),
        tiles: this.ownedTiles(guild.id),
        development: this.development(guild.id),
        members: sizes[guild.id],
        design: designs[guild.id],
      };
    }
    return {
      endedBy,
      topLevel: this.seasonTopLevel(),
      topKiller: this.seasonTopKiller(),
      champion: champion ? { ...champion } : null,
      players: this.seasonPlayers(),
      monumentGoal: config.monument.goal,
      guilds,
    };
  }

  // --- Monument designs and display -----------------------------------------

  /**
   * Which of the three Monument designs each guild builds this season: a
   * different one each, dealt at random when a season begins.
   */
  monumentDesigns(): Record<GuildId, number> {
    try {
      const stored: unknown = JSON.parse(this.getSetting('monument_designs') ?? 'null');
      const values = stored && typeof stored === 'object' ? Object.values(stored) : [];
      if (values.length === 3 && new Set(values).size === 3 && values.every((v) => v === 0 || v === 1 || v === 2)) {
        return stored as Record<GuildId, number>;
      }
    } catch {
      // dealt below
    }
    // A database from before designs were dealt: deal them for the running season, from its id.
    const row = this.db.prepare('SELECT COALESCE(MAX(season_id), 0) AS id FROM seasons').get() as { id: number };
    const seasonId = row.id;
    return this.dealMonumentDesigns(createRng(hashString(`designs:${seasonId}`)));
  }

  /** Deals the three designs to the three guilds in a random order, and stores them. */
  dealMonumentDesigns(rng: Rng): Record<GuildId, number> {
    const order = [0, 1, 2];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    const designs = { red: order[0]!, green: order[1]!, blue: order[2]! };
    this.setSetting('monument_designs', JSON.stringify(designs));
    return designs;
  }

  /** How the overlay looks. Everything is on until the streamer switches it off. */
  displaySettings(): DisplaySettings {
    const flag = (key: string) => this.getSetting(key) !== '0';
    let sources: unknown = null;
    try {
      sources = JSON.parse(this.getSetting('display_emote_sources') ?? 'null');
    } catch {
      sources = null;
    }
    const emoteSources = { bttv: true, ffz: true, '7tv': true } as Record<ThirdPartySource, boolean>;
    for (const source of THIRD_PARTY_SOURCES) {
      const value = sources && typeof sources === 'object' ? (sources as Record<string, unknown>)[source] : undefined;
      if (typeof value === 'boolean') emoteSources[source] = value;
    }
    return {
      theme: this.getSetting('display_theme'),
      pixelateEmotes: flag('display_pixelate_emotes'),
      animatedEmotes: flag('display_animated_emotes'),
      randomEmotes: flag('display_random_emotes'),
      emoteSources,
    };
  }

  /** Changes any of the display settings; the others stay as they are. */
  setDisplay(change: Partial<Omit<DisplaySettings, 'emoteSources'>> & { emoteSources?: Partial<Record<ThirdPartySource, boolean>> }): void {
    this.transaction(() => {
      if (change.theme !== undefined) this.setSetting('display_theme', change.theme);
      const flags = [
        ['pixelateEmotes', 'display_pixelate_emotes'],
        ['animatedEmotes', 'display_animated_emotes'],
        ['randomEmotes', 'display_random_emotes'],
      ] as const;
      for (const [field, key] of flags) {
        const value = change[field];
        if (value !== undefined) this.setSetting(key, value ? '1' : '0');
      }
      if (change.emoteSources) {
        const sources = { ...this.displaySettings().emoteSources, ...change.emoteSources };
        this.setSetting('display_emote_sources', JSON.stringify(sources));
      }
    });
  }

  /** How the tiles are handed out when the next season starts. */
  seasonStart(): SeasonStart {
    return this.getSetting('season_start') === 'random' ? 'random' : 'equal';
  }

  setSeasonStart(mode: SeasonStart): void {
    this.setSetting('season_start', mode);
  }

  /**
   * Ends the running season and starts the next one.
   * - The winner is `winner` if given (a guild that finished its Monument, or
   *   the god). Otherwise it is the guild whose Monument is furthest, then the
   *   one with the most tiles, then `tieBreak` (a number from 0 to 1).
   * - A winning guild's members get a season win in their lifetime statistics.
   * - The land is dealt out again and its development, the Monuments, XP and
   *   levels are reset. Guilds are cleared, so every chatter is assigned again
   *   when they next write.
   * - Lifetime statistics, sessions and battle records are kept.
   */
  endSeason(now: number, tieBreak: number, winner?: SeasonWinner): { seasonId: number; winner: SeasonWinner } {
    return this.transaction(() => {
      const seasonId = this.currentSeasonId(now);
      // A given winner means the season decided itself; without one, the streamer ended it.
      const endedBy = winner === undefined ? 'streamer' : winner === 'god' ? 'god' : 'monument';
      let decided = winner;
      if (!decided) {
        const monuments = this.monuments();
        const standings = config.guilds.list.map((guild) => ({
          id: guild.id,
          monument: monuments[guild.id],
          tiles: this.ownedTiles(guild.id),
        }));
        standings.sort((a, b) => b.monument - a.monument || b.tiles - a.tiles);
        const tied = standings.filter(
          (s) => s.monument === standings[0]!.monument && s.tiles === standings[0]!.tiles,
        );
        decided = tied[Math.min(tied.length - 1, Math.floor(tieBreak * tied.length))]!.id;
      }

      // Recorded before anything is reset: the history shows who stood where at the end.
      this.db
        .prepare('UPDATE seasons SET ended_at = ?, winner_guild_id = ?, summary = ? WHERE season_id = ?')
        .run(now, decided, JSON.stringify(this.seasonSummary(seasonId, endedBy)), seasonId);
      if (decided !== 'god') {
        this.db.prepare('UPDATE users SET seasons_won = seasons_won + 1 WHERE guild_id = ?').run(decided);
      }

      this.db.exec(`
        UPDATE tiles SET owner_guild_id = NULL, scorched = 0, level = 0, points = 0, burning = 0 WHERE is_city = 0;
        DELETE FROM settings WHERE key = 'mishaps';
        DELETE FROM guild_windows;
        UPDATE guilds SET monument = 0, xp_boost_until = NULL;
        UPDATE users SET xp = 0, level = 0, season_kills = 0, guild_id = NULL;
      `);
      this.resetCenter();
      const give = this.db.prepare('UPDATE tiles SET owner_guild_id = ? WHERE tile_id = ?');
      const rng = createRng(Math.floor(tieBreak * 2 ** 31) + seasonId);
      const land = startingLand(this.seasonStart(), rng);
      for (const [id, guild] of Object.entries(land)) give.run(guild, id);
      this.dealMonumentDesigns(rng);
      this.db.prepare('INSERT INTO seasons (started_at) VALUES (?)').run(now);
      return { seasonId, winner: decided };
    });
  }

  // --- Sessions --------------------------------------------------------------

  /** The running session (background layer on), or null. */
  activeSession(): SessionRow | null {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY session_id DESC LIMIT 1')
      .get();
    return (row as unknown as SessionRow | undefined) ?? null;
  }

  /** Turns the background layer on. Returns the running session if there already is one. */
  startSession(now: number): SessionRow {
    const active = this.activeSession();
    if (active) return active;
    this.db.prepare('INSERT INTO sessions (started_at) VALUES (?)').run(now);
    this.refreshChannelSize(now);
    return this.activeSession()!;
  }

  /** Turns the background layer off. */
  endSession(now: number): void {
    this.db.prepare('UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL').run(now);
  }

  // --- Settings and channel size ---------------------------------------------

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    } else {
      this.db
        .prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        )
        .run(key, value);
    }
  }

  /**
   * Measures the channel: the average number of chatters who earned a tick per
   * window, over the completed windows of the most recent sessions. Windows in
   * which nobody wrote are not counted. Stores the result; returns null when
   * there is nothing to measure yet.
   */
  refreshChannelSize(now: number): number | null {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS ticks, COUNT(DISTINCT window_start) AS windows FROM ticks
         WHERE window_start < ?
           AND session_id IN (
             SELECT DISTINCT session_id FROM ticks ORDER BY session_id DESC LIMIT ?
           )`,
      )
      .get(windowStartOf(now), config.scaling.historySessions) as { ticks: number; windows: number };
    if (row.windows === 0) return null;
    const average = row.ticks / row.windows;
    this.setSetting('measured_chatters', String(average));
    this.setSetting('measured_windows', String(row.windows));
    return average;
  }

  private measuredWindows(): number {
    return Number(this.getSetting('measured_windows') ?? 0);
  }

  /** The measured number of active chatters per window, or null before the first measurement. */
  measuredChatters(): number | null {
    const value = this.getSetting('measured_chatters');
    return value === null ? null : Number(value);
  }

  /** The streamer's manual channel size, or null when the size is measured automatically. */
  manualChatters(): number | null {
    const value = this.getSetting('manual_chatters');
    return value === null ? null : Number(value);
  }

  setManualChatters(chatters: number | null): void {
    this.setSetting('manual_chatters', chatters === null ? null : String(chatters));
  }

  /** The cost multiplier in effect: manual size if set, else measured, else 1. */
  channelScale(): number {
    const chatters = this.manualChatters() ?? this.measuredChatters();
    return chatters === null ? 1 : scaleFor(chatters);
  }

  // --- Users -----------------------------------------------------------------

  /** Whether a message's author takes part in the game at all. */
  isPlayer(event: ChatMessageEvent): boolean {
    if (event.isBroadcaster || config.botNames.includes(event.login)) return false;
    return !this.excludedLogins().includes(event.login);
  }

  // --- Exclusions ------------------------------------------------------------

  private excludedCache: string[] | null = null;

  /** Logins the streamer shut out of the game, in alphabetical order. */
  excludedLogins(): string[] {
    if (!this.excludedCache) {
      const rows = this.db.prepare('SELECT login FROM excluded ORDER BY login').all() as unknown as {
        login: string;
      }[];
      this.excludedCache = rows.map((row) => row.login);
    }
    return this.excludedCache;
  }

  /** Shuts a login out of the game, or lets it back in. An excluded chatter earns nothing and does not fight. */
  setExcluded(login: string, excluded: boolean): void {
    const name = login.trim().replace(/^@/, '').toLowerCase();
    if (name === '') return;
    if (excluded) this.db.prepare('INSERT OR IGNORE INTO excluded (login) VALUES (?)').run(name);
    else this.db.prepare('DELETE FROM excluded WHERE login = ?').run(name);
    this.excludedCache = null;
  }

  /**
   * Records the author of a chat message and returns their row, or null for the
   * broadcaster and bots. Name and color follow the latest message. The guild
   * is set only when missing, which is the season lock: a later color change
   * does not move the chatter.
   */
  upsertUser(event: ChatMessageEvent): UserRow | null {
    if (!this.isPlayer(event)) return null;
    this.currentSeasonId(event.sentAt); // starts the first season if there is none
    const existing = this.getUser(event.userId);
    const guildId =
      existing?.guild_id ?? assignGuild(event.color, event.userId, this.guildSizes());

    this.db
      .prepare(
        `INSERT INTO users (user_id, login, display_name, color, emote_id, guild_id, first_seen, last_seen)
         VALUES (:userId, :login, :displayName, :color, :emoteId, :guildId, :sentAt, :sentAt)
         ON CONFLICT (user_id) DO UPDATE SET
           login = excluded.login,
           display_name = excluded.display_name,
           color = excluded.color,
           emote_id = COALESCE(excluded.emote_id, emote_id),
           guild_id = excluded.guild_id,
           last_seen = MAX(last_seen, excluded.last_seen)`,
      )
      .run({
        userId: event.userId,
        login: event.login,
        displayName: event.displayName,
        color: event.color,
        emoteId: messageEmote(event),
        guildId,
        sentAt: event.sentAt,
      });
    return this.getUser(event.userId)!;
  }

  getUser(userId: string): UserRow | null {
    const row = this.db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
    return (row as unknown as UserRow | undefined) ?? null;
  }

  /** Member count per guild, including guilds with no members. */
  guildSizes(): Record<GuildId, number> {
    const rows = this.db
      .prepare(
        `SELECT g.guild_id AS guildId, COUNT(u.user_id) AS members
         FROM guilds g LEFT JOIN users u ON u.guild_id = g.guild_id
         GROUP BY g.guild_id`,
      )
      .all() as unknown as { guildId: GuildId; members: number }[];
    const sizes = { red: 0, green: 0, blue: 0 };
    for (const row of rows) sizes[row.guildId] = row.members;
    return sizes;
  }

  // --- Map -------------------------------------------------------------------

  tiles(): TileRow[] {
    return this.db.prepare('SELECT * FROM tiles ORDER BY r, q').all() as unknown as TileRow[];
  }

  /**
   * Per guild, how many members earned a tick in a window starting from
   * `since` up to `until` (the game passes now).
   */
  activeByGuild(since: number, until = Number.MAX_SAFE_INTEGER): Record<GuildId, number> {
    // The upper limit keeps the scan short whatever else the table holds, such
    // as ticks the simulator dated ahead: this runs with every state update,
    // and a slow scan here once made battles stutter every second.
    const rows = this.db
      .prepare(
        `SELECT u.guild_id AS guildId, COUNT(DISTINCT u.user_id) AS members
         FROM ticks t JOIN users u ON u.user_id = t.user_id
         WHERE t.window_start >= ? AND t.window_start <= ? AND u.guild_id IS NOT NULL
           AND u.login NOT IN (SELECT login FROM excluded)
         GROUP BY u.guild_id`,
      )
      .all(since, until) as unknown as { guildId: GuildId; members: number }[];
    const active = { red: 0, green: 0, blue: 0 };
    for (const row of rows) active[row.guildId] = row.members;
    return active;
  }

  /** Tiles a guild owns besides its city. */
  ownedTiles(guildId: GuildId): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS tiles FROM tiles WHERE owner_guild_id = ? AND is_city = 0')
      .get(guildId) as { tiles: number };
    return row.tiles;
  }

  /** The map in the form the game rules use. */
  mapTiles(): MapTile[] {
    return this.tiles().map((t) => ({
      id: t.tile_id,
      q: t.q,
      r: t.r,
      owner: t.owner_guild_id,
      isCity: t.is_city === 1,
      level: t.level,
    }));
  }

  /**
   * Gives a tile to a guild, or makes it neutral with `null`. `scorched` marks
   * a tile the god turned neutral. With `capture`, the tile loses part of its
   * development, as land does when it is taken by force.
   */
  setTileOwner(tileIdValue: string, guildId: GuildId | null, scorched = false, capture = false): void {
    this.transaction(() => {
      if (isCenter(tileIdValue)) {
        // The god's tile keeps its fixed level and is never scorched. A new holder's time starts now.
        this.db.prepare('UPDATE tiles SET owner_guild_id = ?, scorched = 0 WHERE tile_id = ?').run(guildId, tileIdValue);
        this.setSetting('center_windows_left', guildId === null ? null : String(config.land.center.holdWindows));
        return;
      }
      if (capture) {
        const tile = this.db.prepare('SELECT level FROM tiles WHERE tile_id = ?').get(tileIdValue) as
          | { level: number }
          | undefined;
        this.db
          .prepare('UPDATE tiles SET level = ?, points = 0 WHERE tile_id = ? AND is_city = 0')
          .run(levelAfterCapture(tile?.level ?? 0), tileIdValue);
      }
      this.db
        .prepare('UPDATE tiles SET owner_guild_id = ?, scorched = ? WHERE tile_id = ? AND is_city = 0')
        .run(guildId, scorched ? 1 : 0, tileIdValue);
    });
  }

  /** The neutral tile nearest a guild's city, or null if no tile is neutral. Ties go to the lowest id. */
  nearestNeutralTile(guildId: GuildId): string | null {
    const city = config.map.cities[guildId];
    const distance = (t: TileRow): number =>
      (Math.abs(t.q - city.q) + Math.abs(t.r - city.r) + Math.abs(t.q + t.r - city.q - city.r)) / 2;
    const neutral = this.tiles()
      .filter((t) => t.owner_guild_id === null && t.is_city === 0)
      .sort((a, b) => distance(a) - distance(b) || (a.tile_id < b.tile_id ? -1 : 1));
    return neutral[0]?.tile_id ?? null;
  }

  // --- The center: the god's tile --------------------------------------------

  /** Puts the center tile in its starting state: free, at its fixed level. */
  resetCenter(): void {
    const { id, level } = config.land.center;
    this.db
      .prepare('UPDATE tiles SET owner_guild_id = NULL, scorched = 0, level = ?, points = 0 WHERE tile_id = ?')
      .run(level, id);
    this.setSetting('center_windows_left', null);
  }

  /** Who holds the center tile, and for how many more windows of stream time. */
  center(): { id: string; owner: GuildId | null; windowsLeft: number } {
    const { id } = config.land.center;
    const row = this.db.prepare('SELECT owner_guild_id FROM tiles WHERE tile_id = ?').get(id) as
      | { owner_guild_id: GuildId | null }
      | undefined;
    const owner = row?.owner_guild_id ?? null;
    return { id, owner, windowsLeft: owner ? Number(this.getSetting('center_windows_left') ?? 0) : 0 };
  }

  /**
   * Counts one window of stream time against the center's holder, once per
   * window however many chatters are active. When the time is up the god takes
   * the tile back. Returns true when that just happened.
   */
  private countCenterWindow(windowStart: number): boolean {
    if (Number(this.getSetting('center_window') ?? 0) >= windowStart) return false;
    this.setSetting('center_window', String(windowStart));
    const center = this.center();
    if (!center.owner) return false;
    if (center.windowsLeft > 1) {
      this.setSetting('center_windows_left', String(center.windowsLeft - 1));
      return false;
    }
    this.setTileOwner(center.id, null);
    return true;
  }

  // --- Land and Monument -----------------------------------------------------

  /**
   * Development from a chatter's tick. With a chatter, it builds their home
   * tile, by as many points as the tile's fertility gives (`roll`, from 0 to
   * 1, decides a fraction); without one, one point for the guild's least
   * developed tile. A guild with no tile left to develop puts the point
   * straight into its Monument.
   */
  develop(guildId: GuildId, userId?: string, roll = 0.5, seasonId = 0): void {
    const own = this.tiles()
      .filter((t) => t.owner_guild_id === guildId && t.is_city === 0 && !isCenter(t.tile_id))
      .map((t) => ({ id: t.tile_id, level: t.level, points: t.points }));
    const target = userId === undefined ? developTarget(own) : homeTile(userId, own);
    if (!target) {
      this.addMonument(guildId, 1);
      return;
    }
    const amount = userId === undefined ? 1 : tickPoints(fertility(seasonId, target.id), roll);
    if (amount <= 0) return;
    const next = addDevelopmentPoint(target, this.channelScale(), amount);
    this.db.prepare('UPDATE tiles SET level = ?, points = ? WHERE tile_id = ?').run(next.level, next.points, target.id);
  }

  /**
   * Rolls the mishaps of a window: lightning, fires and harvests (see
   * `rollMishaps`). Runs once per window, on its first tick; the window
   * before tells who was there to put out fires. Returns what happened.
   */
  private windowMishaps(windowStart: number, seasonId: number): Mishap[] {
    if (Number(this.getSetting('mishap_window') ?? 0) >= windowStart) return [];
    this.setSetting('mishap_window', String(windowStart));
    const before = windowStart - config.ticks.windowMs;
    const rows = this.db
      .prepare(
        `SELECT u.guild_id AS guild, COUNT(DISTINCT t.user_id) AS active FROM ticks t
         JOIN users u ON u.user_id = t.user_id
         WHERE t.window_start = ? AND u.guild_id IS NOT NULL GROUP BY u.guild_id`,
      )
      .all(before) as { guild: GuildId; active: number }[];
    const activeBefore = Object.fromEntries(rows.map((row) => [row.guild, row.active]));
    const tiles = this.tiles().map((t) => ({
      id: t.tile_id,
      q: t.q,
      r: t.r,
      owner: t.owner_guild_id,
      level: t.level,
      burning: t.burning,
      developable: t.is_city === 0 && !isCenter(t.tile_id),
    }));
    const rng = createRng(hashString(`mishaps:${seasonId}:${windowStart}`));
    const { changed, events } = rollMishaps(tiles, activeBefore, rng);
    const update = this.db.prepare('UPDATE tiles SET level = ?, burning = ?, points = 0 WHERE tile_id = ?');
    for (const [id, tile] of changed) update.run(tile.level, tile.burning, id);
    if (events.length > 0) {
      let next = Number(this.getSetting('mishap_seq') ?? 0);
      const added = events.map((event) => ({ ...event, id: ++next, at: windowStart }));
      this.setSetting('mishap_seq', String(next));
      this.setSetting('mishaps', JSON.stringify([...this.recentMishaps(), ...added].slice(-config.mishaps.remember)));
    }
    return events;
  }

  /**
   * The marks mishaps left on tiles, by tile: a scorch mark from lightning,
   * ash from a fire that burnt out or was put out, for `mishaps.markWindows`
   * windows. `age` runs from 0 (this window) toward 1 (about to fade). The
   * newest mark of a tile wins. Counted in the windows the mishaps are rolled
   * in, so a sped-up simulation keeps up.
   */
  tileMarks(): Map<string, { kind: 'lightning' | 'fire'; age: number }> {
    const marks = new Map<string, { kind: 'lightning' | 'fire'; age: number }>();
    const latest = Number(this.getSetting('mishap_window') ?? 0);
    const { markWindows } = config.mishaps;
    for (const mishap of this.recentMishaps()) {
      const kind = mishap.kind === 'lightning' ? 'lightning' : mishap.kind === 'burntOut' || mishap.kind === 'doused' ? 'fire' : null;
      if (!kind || mishap.at === undefined) continue;
      const windows = Math.round((latest - mishap.at) / config.ticks.windowMs);
      if (windows < 0 || windows >= markWindows) continue;
      marks.set(mishap.tile, { kind, age: windows / markWindows });
    }
    return marks;
  }

  /** The latest mishaps of the season, oldest first. */
  recentMishaps(): MishapRecord[] {
    try {
      const list = JSON.parse(this.getSetting('mishaps') ?? '[]') as unknown;
      return Array.isArray(list) ? (list as MishapRecord[]) : [];
    } catch {
      return [];
    }
  }

  /** Sets a tile's level directly. For rewards and tests. The center keeps its fixed level. */
  setTileLevel(tileIdValue: string, level: number): void {
    if (isCenter(tileIdValue)) return;
    const capped = Math.min(config.land.maxLevel, Math.max(0, Math.round(level)));
    this.db.prepare('UPDATE tiles SET level = ?, points = 0 WHERE tile_id = ? AND is_city = 0').run(capped, tileIdValue);
  }

  /** Raises a guild's least developed tile by one level: a reward. Returns the tile, or null if none can grow. */
  addFreeTileLevel(guildId: GuildId): string | null {
    const own = this.tiles()
      .filter((t) => t.owner_guild_id === guildId && t.is_city === 0 && !isCenter(t.tile_id))
      .map((t) => ({ id: t.tile_id, level: t.level, points: t.points }));
    const target = developTarget(own);
    if (!target) return null;
    this.db.prepare('UPDATE tiles SET level = level + 1 WHERE tile_id = ?').run(target.id);
    return target.id;
  }

  /** Each guild's Monument progress. */
  monuments(): Record<GuildId, number> {
    const rows = this.db.prepare('SELECT guild_id AS guildId, monument FROM guilds').all() as unknown as {
      guildId: GuildId;
      monument: number;
    }[];
    const progress = { red: 0, green: 0, blue: 0 };
    for (const row of rows) progress[row.guildId] = row.monument;
    return progress;
  }

  addMonument(guildId: GuildId, amount: number): void {
    this.db.prepare('UPDATE guilds SET monument = MAX(0, monument + ?) WHERE guild_id = ?').run(amount, guildId);
  }

  /** Every Monument loses a share of its progress: the god's blow after winning Streamer vs Chat. */
  setBackMonuments(share: number): void {
    this.db.prepare('UPDATE guilds SET monument = monument * ?').run(1 - share);
  }

  /** The sum of the levels of a guild's tiles: how developed its land is. */
  development(guildId: GuildId): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(level), 0) AS total FROM tiles WHERE owner_guild_id = ? AND is_city = 0')
      .get(guildId) as { total: number };
    return row.total;
  }

  // --- Wars ------------------------------------------------------------------

  createWar(now: number, seed: number): number {
    const result = this.db
      .prepare('INSERT INTO wars (season_id, started_at, seed) VALUES (?, ?, ?)')
      .run(this.currentSeasonId(now), now, seed);
    return Number(result.lastInsertRowid);
  }

  endWar(warId: number, now: number): void {
    this.db.prepare('UPDATE wars SET ended_at = ? WHERE war_id = ?').run(now, warId);
  }

  insertBattle(battle: BattleRecord): void {
    this.db
      .prepare(
        `INSERT INTO battles (war_id, position, kind, tile_id, attacker_guild_id, defender_guild_id,
           winner_guild_id, captured, ended_by, duration_ms, seed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        battle.warId,
        battle.position,
        battle.kind,
        battle.tileId,
        battle.attacker,
        battle.defender,
        battle.winner,
        battle.captured ? 1 : 0,
        battle.endedBy,
        battle.durationMs,
        battle.seed,
      );
  }

  battles(warId: number): BattleRow[] {
    const rows = this.db
      .prepare('SELECT * FROM battles WHERE war_id = ? ORDER BY position')
      .all(warId) as unknown as BattleRow[];
    return rows.map((row) => ({ ...row }));
  }

  /** Adds a battle's kills, deaths and participation to the fighters' lifetime statistics. */
  addFightStats(fighters: readonly { id: string; kills: number; alive: boolean }[]): void {
    this.transaction(() => {
      const update = this.db.prepare(
        `UPDATE users SET kills = kills + ?, season_kills = season_kills + ?, deaths = deaths + ?,
           battles = battles + 1 WHERE user_id = ?`,
      );
      for (const fighter of fighters) update.run(fighter.kills, fighter.kills, fighter.alive ? 0 : 1, fighter.id);
    });
  }

  /** Adds XP to a chatter and updates their level. Unknown ids are ignored. */
  addXp(userId: string, amount: number): void {
    const user = this.getUser(userId);
    if (!user) return;
    const xp = user.xp + amount;
    this.db.prepare('UPDATE users SET xp = ?, level = ? WHERE user_id = ?').run(xp, levelForXp(xp), userId);
  }

  // --- Hero Clash ------------------------------------------------------------

  /** Whether a guild's tick XP is boosted at the given time. */
  guildBoostActive(guildId: GuildId, at: number): boolean {
    const row = this.db.prepare('SELECT xp_boost_until FROM guilds WHERE guild_id = ?').get(guildId) as
      | { xp_boost_until: number | null }
      | undefined;
    return row?.xp_boost_until != null && row.xp_boost_until > at;
  }

  setGuildBoost(guildId: GuildId, until: number): void {
    this.db.prepare('UPDATE guilds SET xp_boost_until = ? WHERE guild_id = ?').run(until, guildId);
  }

  /** The running session's Hero Clash champion, who wears the crown; null if there is none. */
  champion(): UserRow | null {
    const session = this.activeSession();
    return session?.champion_user_id ? this.getUser(session.champion_user_id) : null;
  }

  /** Records a finished Hero Clash. With a champion, also the crown and the lifetime win. */
  insertClash(sessionId: number, startedAt: number, seed: number, champion: UserRow | null): void {
    this.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO clashes (session_id, started_at, winner_user_id, winner_guild_id, seed) VALUES (?, ?, ?, ?, ?)',
        )
        .run(sessionId, startedAt, champion?.user_id ?? null, champion?.guild_id ?? null, seed);
      if (champion) {
        this.db
          .prepare('UPDATE sessions SET champion_user_id = ? WHERE session_id = ?')
          .run(champion.user_id, sessionId);
        this.db.prepare('UPDATE users SET clash_wins = clash_wins + 1 WHERE user_id = ?').run(champion.user_id);
      }
    });
  }

  // --- God -------------------------------------------------------------------

  /** Remembers how the broadcaster looks in chat; the god is drawn that way. */
  private rememberBroadcaster(event: ChatMessageEvent): void {
    const emote = messageEmote(event) ?? this.getSetting('god_emote');
    const next = JSON.stringify([event.displayName, event.color, emote]);
    if (next === this.broadcasterCache) return;
    this.broadcasterCache = next;
    this.setSetting('god_name', event.displayName);
    this.setSetting('god_color', event.color);
    this.setSetting('god_emote', emote);
  }

  private broadcasterCache = '';

  /** The god's name, color and emote: the broadcaster's, once they have written in chat. */
  godIdentity(fallbackName: string): { name: string; color: string; emote: string | null } {
    return {
      name: this.getSetting('god_name') ?? fallbackName,
      color: this.getSetting('god_color') ?? config.god.fallbackColor,
      emote: this.getSetting('god_emote'),
    };
  }

  /**
   * Stores the picture the god wears, or removes it with `null`. `data` is the
   * image file's bytes. The version changes with every upload, so pages reload it.
   */
  setGodPicture(picture: { mime: string; data: Buffer } | null): void {
    this.transaction(() => {
      this.setSetting('god_picture', picture ? picture.data.toString('base64') : null);
      this.setSetting('god_picture_mime', picture ? picture.mime : null);
      const version = Number(this.getSetting('god_picture_version') ?? 0) + 1;
      this.setSetting('god_picture_version', String(version));
    });
  }

  godPicture(): { mime: string; data: Buffer } | null {
    const data = this.getSetting('god_picture');
    const mime = this.getSetting('god_picture_mime');
    return data && mime ? { mime, data: Buffer.from(data, 'base64') } : null;
  }

  /** The address the pages load the god's picture from, or null if none was uploaded. */
  godPictureUrl(): string | null {
    if (this.getSetting('god_picture') === null) return null;
    return `/api/god/picture?v=${this.getSetting('god_picture_version') ?? 0}`;
  }

  /** The skills the god may use, in a fixed order. All are enabled until the streamer changes it. */
  godSkills(): SkillId[] {
    const all = Object.keys(config.skills.names) as SkillId[];
    const stored = this.getSetting('god_skills');
    if (stored === null) return all;
    try {
      const enabled: unknown = JSON.parse(stored);
      return Array.isArray(enabled) ? all.filter((skill) => enabled.includes(skill)) : all;
    } catch {
      return all;
    }
  }

  setGodSkill(skill: SkillId, enabled: boolean): void {
    const skills = new Set(this.godSkills());
    if (enabled) skills.add(skill);
    else skills.delete(skill);
    this.setSetting('god_skills', JSON.stringify([...skills]));
  }

  /**
   * Where the overlay's two panels sit, as the top-left corner in screen
   * pixels, and whether each is shown. Until the streamer moves them: the map
   * in the lower right corner, the statistics in the upper left.
   */
  overlayLayout(): Record<'map' | 'stats', PanelPlace> {
    const { width, height, margin, mapPanel } = config.overlay;
    const defaults = {
      map: { x: width - margin - mapPanel.width, y: height - margin - mapPanel.height },
      stats: { x: margin, y: margin },
    };
    const read = (panel: 'map' | 'stats'): PanelPlace => {
      const x = Number(this.getSetting(`overlay_${panel}_x`) ?? NaN);
      const y = Number(this.getSetting(`overlay_${panel}_y`) ?? NaN);
      return {
        x: Number.isFinite(x) ? x : defaults[panel].x,
        y: Number.isFinite(y) ? y : defaults[panel].y,
        visible: this.getSetting(`overlay_${panel}_visible`) !== '0',
      };
    };
    return { map: read('map'), stats: read('stats') };
  }

  /** Moves a panel, shows or hides it. `null` for the place puts it back where it was at first. */
  setOverlayPanel(panel: 'map' | 'stats', change: { x?: number; y?: number; visible?: boolean; reset?: boolean }): void {
    this.transaction(() => {
      if (change.reset) {
        this.setSetting(`overlay_${panel}_x`, null);
        this.setSetting(`overlay_${panel}_y`, null);
      }
      if (change.x !== undefined) this.setSetting(`overlay_${panel}_x`, String(Math.round(change.x)));
      if (change.y !== undefined) this.setSetting(`overlay_${panel}_y`, String(Math.round(change.y)));
      if (change.visible !== undefined) this.setSetting(`overlay_${panel}_visible`, change.visible ? '1' : '0');
    });
  }

  /** The statistics lines that are switched on, in display order. */
  statLines(): StatId[] {
    const all = config.overlay.statLines;
    const stored = this.getSetting('overlay_stat_lines');
    if (stored === null) return [...all];
    try {
      const enabled: unknown = JSON.parse(stored);
      return Array.isArray(enabled) ? all.filter((id) => enabled.includes(id)) : [...all];
    } catch {
      return [...all];
    }
  }

  setStatLine(id: StatId, enabled: boolean): void {
    const lines = new Set(this.statLines());
    if (enabled) lines.add(id);
    else lines.delete(id);
    this.setSetting('overlay_stat_lines', JSON.stringify([...lines]));
  }

  /** The chatter with the most kills in the running season, or null if nobody has one. */
  seasonTopKiller(): { displayName: string; kills: number } | null {
    const row = this.db
      .prepare(
        `SELECT display_name AS displayName, season_kills AS kills FROM users
         WHERE season_kills > 0 AND guild_id IS NOT NULL ORDER BY season_kills DESC, user_id LIMIT 1`,
      )
      .get() as { displayName: string; kills: number } | undefined;
    return row ? { ...row } : null;
  }

  /** The chatter with the highest level in the running season, or null before anyone has gained one. */
  seasonTopLevel(): { displayName: string; level: number } | null {
    const row = this.db
      .prepare(
        `SELECT display_name AS displayName, level FROM users
         WHERE level > 0 AND guild_id IS NOT NULL ORDER BY xp DESC, user_id LIMIT 1`,
      )
      .get() as { displayName: string; level: number } | undefined;
    return row ? { ...row } : null;
  }

  /** How many chatters have a guild this season, that is, have played in it. */
  seasonPlayers(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS players FROM users WHERE guild_id IS NOT NULL').get() as {
      players: number;
    };
    return row.players;
  }

  /** When the season began and how many Wars it has seen. */
  seasonInfo(seasonId: number): { startedAt: number; wars: number } {
    const season = this.db.prepare('SELECT started_at FROM seasons WHERE season_id = ?').get(seasonId) as
      | { started_at: number }
      | undefined;
    const wars = this.db.prepare('SELECT COUNT(*) AS wars FROM wars WHERE season_id = ?').get(seasonId) as {
      wars: number;
    };
    return { startedAt: season?.started_at ?? 0, wars: wars.wars };
  }

  /** How many fighters the endless mode keeps on the field at once. */
  endlessConcurrent(): number {
    const { concurrent, minConcurrent, maxConcurrent } = config.endless;
    const stored = Number(this.getSetting('endless_concurrent') ?? concurrent);
    return Number.isFinite(stored) ? Math.min(maxConcurrent, Math.max(minConcurrent, Math.round(stored))) : concurrent;
  }

  setEndlessConcurrent(value: number): void {
    this.setSetting('endless_concurrent', String(Math.round(value)));
  }

  markVersusUsed(sessionId: number): void {
    this.db.prepare('UPDATE sessions SET versus_used = 1 WHERE session_id = ?').run(sessionId);
  }

  insertGodFight(fight: {
    kind: 'wrath' | 'versus' | 'friendly';
    tileId: string | null;
    targetGuild: GuildId | null;
    godWon: boolean;
    topDamageGuild: GuildId | null;
    startedAt: number;
    seed: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO god_fights (season_id, kind, tile_id, target_guild_id, god_won, top_damage_guild_id, started_at, seed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.currentSeasonId(fight.startedAt),
        fight.kind,
        fight.tileId,
        fight.targetGuild,
        fight.godWon ? 1 : 0,
        fight.topDamageGuild,
        fight.startedAt,
        fight.seed,
      );
  }

  /** The god's wins and losses, this season and over all seasons. */
  godRecord(seasonId: number): GodRecord {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(god_won = 1 AND season_id = :season AND kind != 'friendly'), 0) AS seasonWins,
           COALESCE(SUM(god_won = 0 AND season_id = :season AND kind != 'friendly'), 0) AS seasonLosses,
           COALESCE(SUM(god_won = 1 AND kind != 'friendly'), 0) AS lifetimeWins,
           COALESCE(SUM(god_won = 0 AND kind != 'friendly'), 0) AS lifetimeLosses,
           COALESCE(SUM(god_won = 1 AND season_id = :season AND kind = 'friendly'), 0) AS friendlyWins,
           COALESCE(SUM(god_won = 0 AND season_id = :season AND kind = 'friendly'), 0) AS friendlyLosses
         FROM god_fights`,
      )
      .get({ season: seasonId }) as unknown as GodRecord;
    return { ...row };
  }

  // --- Ticks -----------------------------------------------------------------

  /**
   * Handles one chat message: records the author and, while a session is
   * running, awards at most one tick per chatter per window. A tick gives the
   * chatter XP and develops their guild's land by one point. A guild's first
   * tick in a window also grows its Monument; reaching the goal wins the season.
   * Returns null for the broadcaster and bots.
   */
  recordMessage(event: ChatMessageEvent): MessageResult | null {
    if (event.isBroadcaster) this.rememberBroadcaster(event);
    return this.transaction(() => {
      const user = this.upsertUser(event);
      if (!user) return null;

      const session = this.activeSession();
      if (!session || event.sentAt < session.started_at) return { user, tickAwarded: false };

      const inserted = this.db
        .prepare('INSERT OR IGNORE INTO ticks (user_id, window_start, session_id) VALUES (?, ?, ?)')
        .run(user.user_id, windowStartOf(event.sentAt), session.session_id);
      if (Number(inserted.changes) === 0) return { user, tickAwarded: false };
      this.db
        .prepare(
          `INSERT INTO session_ticks (session_id, user_id, ticks) VALUES (?, ?, 1)
           ON CONFLICT (session_id, user_id) DO UPDATE SET ticks = ticks + 1`,
        )
        .run(session.session_id, user.user_id);

      const boosted = this.guildBoostActive(user.guild_id, event.sentAt);
      const xp = user.xp + tickXp(this.ownedTiles(user.guild_id), boosted);
      this.db
        .prepare('UPDATE users SET xp = ?, level = ? WHERE user_id = ?')
        .run(xp, levelForXp(xp), user.user_id);
      if (this.measuredWindows() < config.scaling.warmupWindows) this.refreshChannelSize(event.sentAt);
      const seasonId = this.currentSeasonId(event.sentAt);
      this.windowMishaps(windowStartOf(event.sentAt), seasonId);
      this.develop(user.guild_id, user.user_id, hashString(`tick:${user.user_id}:${event.sentAt}`) / 0x1_0000_0000, seasonId);
      const centerReclaimed = this.countCenterWindow(windowStartOf(event.sentAt));

      // The guild's first tick in a window grows its Monument by what its land yields.
      const firstInWindow = this.db
        .prepare('INSERT OR IGNORE INTO guild_windows (guild_id, window_start) VALUES (?, ?)')
        .run(user.guild_id, windowStartOf(event.sentAt));
      if (Number(firstInWindow.changes) === 1) {
        const levels = this.tiles()
          .filter((t) => t.owner_guild_id === user.guild_id && t.is_city === 0)
          .map((t) => t.level);
        this.addMonument(user.guild_id, monumentIncome(levels));
      }

      // A finished Monument wins the season at once; the chatter is then assigned anew.
      if (this.monuments()[user.guild_id] >= config.monument.goal) {
        const winner = user.guild_id;
        this.endSeason(event.sentAt, (event.sentAt % 1000) / 1000, winner);
        return { user: this.upsertUser(event)!, tickAwarded: true, seasonWonBy: winner };
      }

      return { user: this.getUser(user.user_id)!, tickAwarded: true, ...(centerReclaimed ? { centerReclaimed } : {}) };
    });
  }

  /** Ticks a chatter earned in a session. */
  tickCount(userId: string, sessionId: number): number {
    const row = this.db
      .prepare('SELECT ticks FROM session_ticks WHERE user_id = ? AND session_id = ?')
      .get(userId, sessionId) as { ticks: number } | undefined;
    return row?.ticks ?? 0;
  }

  /** The end of the latest window anyone earned a tick in; null for a game nobody has played yet. */
  latestActivity(): number | null {
    const row = this.db.prepare('SELECT MAX(window_start) AS latest FROM ticks').get() as { latest: number | null };
    return row.latest === null ? null : row.latest + config.ticks.windowMs;
  }

  /** Chatters who earned a tick in a window starting at or after `since` (see `activeByGuild`). */
  recentlyActive(since: number, until = Number.MAX_SAFE_INTEGER): UserRow[] {
    return this.db
      .prepare(
        `SELECT u.* FROM users u
         WHERE EXISTS (SELECT 1 FROM ticks t WHERE t.user_id = u.user_id AND t.window_start >= ? AND t.window_start <= ?)
           AND u.guild_id IS NOT NULL
           AND u.login NOT IN (SELECT login FROM excluded)
         ORDER BY u.user_id`,
      )
      .all(since, until) as unknown as UserRow[];
  }

  /** The ids of a guild's most active chatters of a session: its heroes. */
  heroIds(sessionId: number, guildId: GuildId, limit: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT u.user_id AS userId FROM session_ticks s JOIN users u ON u.user_id = s.user_id
         WHERE s.session_id = ? AND u.guild_id = ?
           AND u.login NOT IN (SELECT login FROM excluded)
         ORDER BY s.ticks DESC, u.user_id LIMIT ?`,
      )
      .all(sessionId, guildId, limit) as unknown as { userId: string }[];
    return rows.map((row) => row.userId);
  }

  /** The most active chatters of a session, most ticks first. */
  topTickers(sessionId: number, limit: number): (UserRow & { ticks: number })[] {
    return this.db
      .prepare(
        `SELECT u.*, s.ticks AS ticks FROM session_ticks s JOIN users u ON u.user_id = s.user_id
         WHERE s.session_id = ? AND u.guild_id IS NOT NULL
           AND u.login NOT IN (SELECT login FROM excluded)
         ORDER BY s.ticks DESC, u.user_id LIMIT ?`,
      )
      .all(sessionId, limit) as unknown as (UserRow & { ticks: number })[];
  }
}
