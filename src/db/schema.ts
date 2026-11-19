import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';
import { mapTiles, tileId } from '../game/hex.ts';
import { startingLand } from '../game/land.ts';

/**
 * Migrations run in order, once each. The index of the last applied migration
 * is kept in SQLite's `user_version`. Never edit a released migration; add one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE seasons (
    season_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    winner_guild_id TEXT
  );

  CREATE TABLE guilds (
    guild_id TEXT PRIMARY KEY,
    name     TEXT NOT NULL
  );

  CREATE TABLE users (
    user_id      TEXT PRIMARY KEY,
    login        TEXT NOT NULL,
    display_name TEXT NOT NULL,
    color        TEXT,
    guild_id     TEXT REFERENCES guilds (guild_id),
    profession   TEXT,
    xp           INTEGER NOT NULL DEFAULT 0,
    level        INTEGER NOT NULL DEFAULT 0,
    kills        INTEGER NOT NULL DEFAULT 0,
    deaths       INTEGER NOT NULL DEFAULT 0,
    battles      INTEGER NOT NULL DEFAULT 0,
    clash_wins   INTEGER NOT NULL DEFAULT 0,
    seasons_won  INTEGER NOT NULL DEFAULT 0,
    first_seen   INTEGER NOT NULL,
    last_seen    INTEGER NOT NULL
  );

  CREATE INDEX users_guild ON users (guild_id);
  `,
  `
  CREATE TABLE sessions (
    session_id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER
  );

  CREATE TABLE ticks (
    user_id      TEXT NOT NULL REFERENCES users (user_id),
    window_start INTEGER NOT NULL,
    session_id   INTEGER NOT NULL REFERENCES sessions (session_id),
    PRIMARY KEY (user_id, window_start)
  );

  CREATE INDEX ticks_session ON ticks (session_id, user_id);
  CREATE INDEX ticks_window ON ticks (window_start);

  CREATE TABLE buildings (
    guild_id TEXT NOT NULL REFERENCES guilds (guild_id),
    building TEXT NOT NULL,
    level    INTEGER NOT NULL DEFAULT 0,
    points   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, building)
  );

  ALTER TABLE guilds ADD COLUMN repair_cost INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE guilds ADD COLUMN repair_points INTEGER NOT NULL DEFAULT 0;
  `,
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE tiles (
    tile_id        TEXT PRIMARY KEY,
    q              INTEGER NOT NULL,
    r              INTEGER NOT NULL,
    owner_guild_id TEXT REFERENCES guilds (guild_id),
    is_city        INTEGER NOT NULL DEFAULT 0,
    scorched       INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  CREATE TABLE claims (
    tile_id  TEXT NOT NULL REFERENCES tiles (tile_id),
    guild_id TEXT NOT NULL REFERENCES guilds (guild_id),
    progress REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (tile_id, guild_id)
  );

  -- One row per guild and window in which a member earned a tick.
  CREATE TABLE guild_windows (
    guild_id     TEXT NOT NULL REFERENCES guilds (guild_id),
    window_start INTEGER NOT NULL,
    PRIMARY KEY (guild_id, window_start)
  );
  `,
  `
  -- The Twitch emote the chatter used most recently; their fighter wears it.
  ALTER TABLE users ADD COLUMN emote_id TEXT;
  `,
  `
  CREATE TABLE wars (
    war_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id  INTEGER NOT NULL REFERENCES seasons (season_id),
    started_at INTEGER NOT NULL,
    ended_at   INTEGER,
    seed       INTEGER NOT NULL
  );

  CREATE TABLE battles (
    battle_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    war_id            INTEGER NOT NULL REFERENCES wars (war_id),
    position          INTEGER NOT NULL,
    -- attack, skirmish, or skipped
    kind              TEXT NOT NULL,
    tile_id           TEXT REFERENCES tiles (tile_id),
    attacker_guild_id TEXT NOT NULL REFERENCES guilds (guild_id),
    defender_guild_id TEXT REFERENCES guilds (guild_id),
    winner_guild_id   TEXT REFERENCES guilds (guild_id),
    captured          INTEGER NOT NULL DEFAULT 0,
    ended_by          TEXT,
    duration_ms       INTEGER,
    seed              INTEGER NOT NULL
  );
  `,
  `
  -- Logins (lower case) the streamer shut out of the game.
  CREATE TABLE excluded (
    login TEXT PRIMARY KEY
  );
  `,
  `
  -- Hero Clash: the champion's guild earns boosted XP until this time.
  ALTER TABLE guilds ADD COLUMN xp_boost_until INTEGER;
  ALTER TABLE sessions ADD COLUMN champion_user_id TEXT;
  -- Streamer vs Chat may run once per session.
  ALTER TABLE sessions ADD COLUMN versus_used INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE clashes (
    clash_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      INTEGER NOT NULL REFERENCES sessions (session_id),
    started_at      INTEGER NOT NULL,
    winner_user_id  TEXT,
    winner_guild_id TEXT,
    seed            INTEGER NOT NULL
  );

  -- Never cleared at season end: the god's lifetime record is counted from it.
  CREATE TABLE god_fights (
    god_fight_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id           INTEGER NOT NULL REFERENCES seasons (season_id),
    -- wrath or versus
    kind                TEXT NOT NULL,
    tile_id             TEXT,
    target_guild_id     TEXT,
    god_won             INTEGER NOT NULL,
    top_damage_guild_id TEXT,
    started_at          INTEGER NOT NULL,
    seed                INTEGER NOT NULL
  );
  `,
  `
  -- Kills in the running season; the kills column keeps the lifetime count.
  ALTER TABLE users ADD COLUMN season_kills INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Land development and the Monument replace buildings, claims and ruins.
  -- The old tables and columns stay, unused, so no data is dropped.
  ALTER TABLE tiles ADD COLUMN level INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tiles ADD COLUMN points INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE guilds ADD COLUMN monument REAL NOT NULL DEFAULT 0;
  `,
  `
  -- What a season looked like when it ended, as JSON: its best chatters and
  -- the final standings. Levels and kills are reset then, so it is kept here.
  ALTER TABLE seasons ADD COLUMN summary TEXT;
  `,
  `
  -- Emotes are stored with their source since BetterTTV, FrankerFaceZ and 7TV
  -- joined Twitch: a plain id from before is a Twitch emote.
  UPDATE users SET emote_id = 'twitch:' || emote_id WHERE emote_id IS NOT NULL AND instr(emote_id, ':') = 0;
  UPDATE settings SET value = 'twitch:' || value WHERE key = 'god_emote' AND instr(value, ':') = 0;
  `,
  `
  -- Mishaps: how many windows a fire has burned on a tile; 0 means no fire.
  ALTER TABLE tiles ADD COLUMN burning INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Each chatter's ticks per session, kept as they come in. Counting them in
  -- the ticks table took long enough on a long session to make battles stutter.
  CREATE TABLE session_ticks (
    session_id INTEGER NOT NULL,
    user_id    TEXT NOT NULL,
    ticks      INTEGER NOT NULL,
    PRIMARY KEY (session_id, user_id)
  );
  CREATE INDEX session_ticks_rank ON session_ticks (session_id, ticks DESC, user_id);
  INSERT INTO session_ticks (session_id, user_id, ticks)
    SELECT session_id, user_id, COUNT(*) FROM ticks GROUP BY session_id, user_id;
  `,
];

/** Opens (and if needed creates and migrates) a channel database. Use `:memory:` in tests. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // synchronous = NORMAL: with the write-ahead log, a commit no longer waits for
  // the disk. Waiting made every chat message block the whole server on slow
  // disks. The database stays consistent after a crash; at worst the last
  // moments before a power cut are lost.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');

  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const insertGuild = db.prepare(
    'INSERT INTO guilds (guild_id, name) VALUES (?, ?) ON CONFLICT (guild_id) DO UPDATE SET name = excluded.name',
  );
  for (const guild of config.guilds.list) insertGuild.run(guild.id, guild.name);

  // A database that has no tiles yet is new: its first season starts with the land dealt out.
  const isNew = (db.prepare('SELECT COUNT(*) AS tiles FROM tiles').get() as { tiles: number }).tiles === 0;
  const insertTile = db.prepare(
    'INSERT OR IGNORE INTO tiles (tile_id, q, r, owner_guild_id, is_city) VALUES (?, ?, ?, ?, ?)',
  );
  for (const tile of mapTiles()) {
    const city = config.guilds.list.find((guild) => {
      const at = config.map.cities[guild.id];
      return at.q === tile.q && at.r === tile.r;
    });
    insertTile.run(tileId(tile), tile.q, tile.r, city?.id ?? null, city ? 1 : 0);
  }
  if (isNew) {
    const give = db.prepare('UPDATE tiles SET owner_guild_id = ? WHERE tile_id = ?');
    for (const [id, guild] of Object.entries(startingLand('equal', () => 0))) give.run(guild, id);
  }
  // The center is the god's tile: it has a fixed level and is never developed.
  db.prepare('UPDATE tiles SET level = ?, points = 0 WHERE tile_id = ?').run(
    config.land.center.level,
    config.land.center.id,
  );

  return db;
}

/** Why a file cannot be opened as the game's database; the language files hold the message for each. */
export type DatabaseProblem = 'notSqlite' | 'notGame' | 'newerVersion';

const PROBLEM_TEXT: Record<DatabaseProblem, string> = {
  notSqlite: 'That file is not an SQLite database.',
  notGame: 'That file is not a Chroma Clash database.',
  newerVersion: 'That database comes from a newer version of Chroma Clash. Update the game first.',
};

/**
 * Checks that a file is a Chroma Clash database this version can open: an
 * SQLite file with the game's tables, from this version or an older one.
 * Returns what is wrong when it is not; null when it is fine.
 */
export function databaseProblem(path: string): DatabaseProblem | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name),
    );
    if (!['users', 'tiles', 'seasons', 'guilds', 'settings'].every((name) => tables.has(name))) return 'notGame';
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version > MIGRATIONS.length) return 'newerVersion';
    return null;
  } catch {
    return 'notSqlite';
  } finally {
    db?.close();
  }
}

/** Like `databaseProblem`, with the reason in English. */
export function checkDatabaseFile(path: string): string | null {
  const problem = databaseProblem(path);
  return problem ? PROBLEM_TEXT[problem] : null;
}
