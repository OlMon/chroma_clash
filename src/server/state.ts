import { config, type GuildId, type SeasonStart, type SkillId, type StatId } from '../config.ts';
import type { GodRecord, MishapRecord, SeasonWinner, Store } from '../db/store.ts';
import { monumentIncome } from '../game/land.ts';
import { windowStartOf } from '../game/ticks.ts';
import type { SeasonForecast } from '../game/season.ts';
import { activeTheme, type ThemeInfo } from './themes.ts';
import { guildName, languageList, languageOf, translator } from '../i18n.ts';
import { tuningValues, type TuningValue } from './tuning.ts';

/** Where chat comes from, shown in the control panel. `none`: no channel entered yet. */
export interface SourceInfo {
  kind: 'irc' | 'sim' | 'none';
  channel: string;
  status: string;
}

/**
 * Everything the overlay and the control panel draw. The pages decide nothing;
 * they render this object. Keep it free of values that change every second, so
 * an unchanged game produces an identical snapshot.
 */
/** How the overlay looks, as the overlay and the control panel need it. */
export interface DisplayState {
  /** The theme in use: a folder name in overlay/themes. */
  theme: string;
  themes: ThemeInfo[];
  pixelateEmotes: boolean;
  animatedEmotes: boolean;
  randomEmotes: boolean;
  /** Fighters' names in battles, and the highlights beside the scoreboard. */
  names: boolean;
  highlights: boolean;
  emoteSources: { bttv: boolean; ffz: boolean; '7tv': boolean };
  /** The language of the overlay, the control panel and the texts the server writes, such as `en` or `de`. */
  language: string;
  /** Every language there is a file for, with its name in its own language. */
  languages: { id: string; name: string }[];
}

export interface GameSnapshot {
  display: DisplayState;
  source: SourceInfo;
  seasonId: number;
  /** The running season: when it began, which day of it this is, and how many Wars it has seen. */
  season: { startedAt: number; day: number; wars: number };
  /**
   * The center tile, the god's: who holds it now, and for how many more
   * minutes of stream time before the god takes it back.
   */
  center: { id: string; owner: GuildId | null; minutesLeft: number };
  /** Where the overlay shows its two panels, and how large each is. */
  overlay: Record<'map' | 'stats', PanelBox>;
  /**
   * The lines of the season statistics panel, in display order. The overlay
   * shows the enabled ones; the control panel lists all with their switches.
   */
  seasonStats: { id: StatId; label: string; value: string; color: string | null; enabled: boolean }[];
  /** The previous season's winner, or null in the first season. */
  /** The previous season and who won it: a guild, or `god`. */
  lastSeason: { id: number; winner: SeasonWinner | null } | null;
  /** How the land is dealt when the next season starts. */
  seasonStart: SeasonStart;
  /** How many wins against chat the god needs to win the season. */
  godWinsToWin: number;
  /** Logins shut out of the game. */
  excluded: string[];
  tuning: TuningValue[];
  session: { active: boolean; startedAt: number | null };
  /** The battle or War being shown on the overlay, if any. */
  battle: { title: string } | null;
  /** Endless mode: a free-for-all for show that runs until it is switched off. */
  endless: { active: boolean; concurrent: number };
  /** Whether the broadcaster and moderators may start a War with `!war` in chat. */
  warCommand: boolean;
  /** Battles get walls, bumpers, barrels and traps now and then. */
  obstacles: boolean;
  channelSize: { measured: number | null; manual: number | null; scale: number };
  /** The season's length, its goal and when it should end at the measured pace. */
  pace: SeasonForecast;
  /** The running session's Hero Clash champion. */
  champion: { displayName: string; guild: GuildId } | null;
  god: GodRecord & {
    name: string;
    color: string;
    /** The god's skills and whether each is switched on. */
    skills: { id: SkillId; name: string; description: string; enabled: boolean }[];
    /** Where to load the uploaded picture the god wears, or null if there is none. */
    picture: string | null;
    /** Streamer vs Chat over the map can start: a session runs and it was not fought yet in it. */
    versusAvailable: boolean;
    /** The session's Streamer vs Chat over the map has been fought. */
    versusUsed: boolean;
    /** A friendly Streamer vs Chat can start: a session runs. */
    friendlyAvailable: boolean;
  };
  guilds: {
    id: GuildId;
    name: string;
    color: string;
    /** Whether the guild's tick XP is boosted by a Hero Clash win. */
    xpBoost: boolean;
    members: number;
    /** Members who would take part if a fight started now. */
    active: number;
    /** Tiles owned besides the city. */
    tiles: number;
    /** The sum of the levels of the guild's tiles. */
    development: number;
    /** Ticks the guild's chatters earned since the server started: a "+1" pops on the overlay for each new one. */
    ticks: number;
    /**
     * While the guild's land burns: how many of its tiles, how many of its
     * members wrote in the current window, and how many it takes to put the
     * fires out when the window ends. Null while nothing of it burns.
     */
    fire: { tiles: number; writers: number; needed: number } | null;
    /** Progress toward the Monument that wins the season, and what one window adds to it now. */
    monument: {
      progress: number;
      goal: number;
      income: number;
      /** Which of the three Monument designs the guild builds this season. */
      design: number;
    };
  }[];
  tiles: {
    id: string;
    q: number;
    r: number;
    owner: GuildId | null;
    isCity: boolean;
    scorched: boolean;
    /** How far the tile is developed, from 0 to the maximum level. */
    level: number;
    /** A fire burns on the tile. */
    burning: boolean;
    /** What a recent mishap left on the tile: a scorch mark or ash, and how old (0 new, toward 1 fading); null for none. */
    mark: { kind: 'lightning' | 'fire'; age: number } | null;
  }[];
  /** The latest lightning strikes, fires and harvests, oldest first; `id` tells new ones from old. */
  mishaps: MishapRecord[];
  topChatters: {
    displayName: string;
    color: string | null;
    guild: GuildId;
    ticks: number;
    level: number;
  }[];
}

/** An overlay panel's place and size in screen pixels. */
export interface PanelBox {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

/**
 * The two overlay panels as they are shown: the stored places, kept inside the
 * screen, with their sizes. The statistics panel is as tall as its enabled lines.
 */
export function overlayPanels(store: Store): Record<'map' | 'stats', PanelBox> {
  const { width, height, mapPanel, statsPanel } = config.overlay;
  const layout = store.overlayLayout();
  const statsHeight = statsPanel.headerHeight + statsPanel.rowHeight * store.statLines().length + statsPanel.footerHeight;
  const box = (place: { x: number; y: number; visible: boolean }, w: number, h: number): PanelBox => ({
    x: Math.min(Math.max(0, place.x), width - w),
    y: Math.min(Math.max(0, place.y), height - h),
    width: w,
    height: h,
    visible: place.visible,
  });
  return {
    map: box(layout.map, mapPanel.width, mapPanel.height),
    stats: box(layout.stats, statsPanel.width, statsHeight),
  };
}

export function buildSnapshot(
  store: Store,
  source: SourceInfo,
  now: number,
  battleTitle: string | null = null,
  endlessActive = false,
  themes: ThemeInfo[] = [],
): GameSnapshot {
  const display = store.displaySettings();
  // The texts here are written in the streamer's language; the pages show them as they come.
  const lang = languageOf(store);
  const t = translator(lang);
  const designs = store.monumentDesigns();
  const session = store.activeSession();
  const sizes = store.guildSizes();
  const active = store.activeByGuild(now - config.server.activeWindowMs, now);
  // Who wrote in this window: enough of a guild put out the fires on its land when it ends.
  const thisWindow = windowStartOf(now);
  const writers = store.activeByGuild(thisWindow, thisWindow);
  const tiles = store.tiles();
  const marks = store.tileMarks();
  const ticks = store.ticksSinceOpen();
  const scale = store.channelScale();
  const lastSeason = store.lastSeason();
  const seasonId = store.currentSeasonId(now);
  const seasonInfo = store.seasonInfo(seasonId);
  const champion = store.champion();
  const god = store.godIdentity(source.channel);
  const enabledSkills = store.godSkills();
  const enabledLines = store.statLines();
  const center = store.center();

  // The season statistics, one entry per line the overlay can show.
  const record = store.godRecord(seasonId);
  // The guild whose Monument is furthest leads the season.
  const monuments = store.monuments();
  const race = config.guilds.list
    .map((guild) => ({ guild, progress: monuments[guild.id] }))
    .sort((a, b) => b.progress - a.progress);
  const leader = race[0]!;
  const leadTied = race.filter((entry) => entry.progress === leader.progress).length > 1;
  const goal = store.monumentGoal();
  const percent = (progress: number): number => Math.min(100, Math.floor((progress / goal) * 100));
  const topKiller = store.seasonTopKiller();
  const topLevel = store.seasonTopLevel();
  const line = (label: string, value: string, color: string | null = null) => ({ label, value, color });
  /** When the season should end at the chat's pace, in stream hours, in the color of the guild set to finish first; measured once a few windows have passed. */
  const seasonEndLine = () => {
    const forecast = store.seasonForecast();
    const guild = config.guilds.list.find((g) => g.id === forecast.leader);
    if (!guild || forecast.remaining === null) return line(t('server.stats.seasonEnd'), t('server.stats.seasonEndMeasuring'));
    const count = Math.max(1, Math.round(forecast.remaining));
    return line(t('server.stats.seasonEnd'), t('server.stats.seasonEndIn', { count }), guild.color);
  };
  const [year, month, day] = new Date(seasonInfo.startedAt).toISOString().slice(0, 10).split('-');
  const statLine: Record<StatId, { label: string; value: string; color: string | null }> = {
    leading:
      leader.progress === 0
        ? line(t('server.stats.leading'), t('server.stats.nobodyYet'))
        : leadTied
          ? line(t('server.stats.leading'), t('server.stats.tied'))
          : line(
              t('server.stats.leading'),
              t('server.stats.leader', { guild: guildName(lang, leader.guild.id), percent: percent(leader.progress) }),
              leader.guild.color,
            ),
    champion: champion?.guild_id
      ? line(t('server.stats.champion'), champion.display_name, '#FFD54A')
      : line(t('server.stats.champion'), t('server.stats.noneYet')),
    godSeason: line(
      t('server.stats.godSeason', { god: god.name }),
      `${record.seasonWins} : ${record.seasonLosses}` +
        (record.friendlyWins + record.friendlyLosses > 0
          ? t('server.stats.godFriendly', { wins: record.friendlyWins, losses: record.friendlyLosses })
          : ''),
    ),
    godAllTime: line(t('server.stats.godAllTime', { god: god.name }), `${record.lifetimeWins} : ${record.lifetimeLosses}`),
    wars: line(t('server.stats.wars'), String(seasonInfo.wars)),
    mostKills: topKiller
      ? line(t('server.stats.mostKills'), `${topKiller.displayName} · ${t('server.stats.kills', { count: topKiller.kills })}`)
      : line(t('server.stats.mostKills'), t('server.stats.nobodyYet')),
    highestLevel: topLevel
      ? line(t('server.stats.highestLevel'), t('server.stats.level', { name: topLevel.displayName, level: topLevel.level }))
      : line(t('server.stats.highestLevel'), t('server.stats.nobodyYet')),
    seasonEnd: seasonEndLine(),
    players: line(t('server.stats.players'), String(store.seasonPlayers())),
    started: line(t('server.stats.started'), t('server.date', { year: year!, month: month!, day: day! })),
  };

  return {
    display: {
      theme: activeTheme(display.theme, themes),
      themes,
      pixelateEmotes: display.pixelateEmotes,
      animatedEmotes: display.animatedEmotes,
      randomEmotes: display.randomEmotes,
      names: display.names,
      highlights: display.highlights,
      emoteSources: display.emoteSources,
      language: languageOf(store),
      languages: languageList(),
    },
    source,
    seasonId,
    season: {
      startedAt: seasonInfo.startedAt,
      day: Math.max(1, Math.floor((now - seasonInfo.startedAt) / 86_400_000) + 1),
      wars: seasonInfo.wars,
    },
    center: {
      id: center.id,
      owner: center.owner,
      minutesLeft: Math.round((center.windowsLeft * config.ticks.windowMs) / 60_000),
    },
    overlay: overlayPanels(store),
    seasonStats: config.overlay.statLines.map((id) => ({ id, ...statLine[id], enabled: enabledLines.includes(id) })),
    champion: champion?.guild_id
      ? { displayName: champion.display_name, guild: champion.guild_id }
      : null,
    god: {
      ...store.godRecord(seasonId),
      name: god.name,
      color: god.color,
      picture: store.godPictureUrl(),
      skills: (Object.keys(config.skills.names) as SkillId[]).map((id) => ({
        id,
        name: t(`skill.${id}.name`),
        description: t(`skill.${id}.description`),
        enabled: enabledSkills.includes(id),
      })),
      versusAvailable: session !== null && session.versus_used !== 1,
      versusUsed: session !== null && session.versus_used === 1,
      friendlyAvailable: session !== null,
    },
    lastSeason: lastSeason ? { id: lastSeason.season_id, winner: lastSeason.winner_guild_id } : null,
    seasonStart: store.seasonStart(),
    godWinsToWin: config.god.winsToWinSeason,
    excluded: store.excludedLogins(),
    tuning: tuningValues(lang),
    session: { active: session !== null, startedAt: session?.started_at ?? null },
    battle: battleTitle === null ? null : { title: battleTitle },
    endless: { active: endlessActive, concurrent: store.endlessConcurrent() },
    warCommand: store.getSetting('war_command') === '1',
    obstacles: store.getSetting('obstacles') !== '0',
    channelSize: { measured: store.measuredChatters(), manual: store.manualChatters(), scale },
    pace: store.seasonForecast(),
    guilds: config.guilds.list.map((guild) => {
      const own = tiles.filter((t) => t.owner_guild_id === guild.id && !t.is_city);
      return {
        id: guild.id,
        name: guildName(lang, guild.id),
        color: guild.color,
        xpBoost: store.guildBoostActive(guild.id, now),
        members: sizes[guild.id],
        active: active[guild.id],
        tiles: own.length,
        development: own.reduce((sum, t) => sum + t.level, 0),
        ticks: ticks[guild.id],
        fire: own.some((t) => t.burning > 0)
          ? { tiles: own.filter((t) => t.burning > 0).length, writers: writers[guild.id], needed: config.mishaps.fire.douse }
          : null,
        monument: {
          progress: Math.round(monuments[guild.id]),
          goal,
          income: monumentIncome(own.map((t) => t.level)),
          design: designs[guild.id],
        },
      };
    }),
    tiles: tiles.map((t) => ({
      id: t.tile_id,
      q: t.q,
      r: t.r,
      owner: t.owner_guild_id,
      isCity: t.is_city === 1,
      scorched: t.scorched === 1,
      level: t.level,
      burning: t.burning > 0,
      mark: marks.get(t.tile_id) ?? null,
    })),
    mishaps: store.recentMishaps(),
    topChatters: session
      ? store.topTickers(session.session_id, config.server.topChatters).map((u) => ({
          displayName: u.display_name,
          color: u.color,
          guild: u.guild_id,
          ticks: u.ticks,
          level: u.level,
        }))
      : [],
  };
}
