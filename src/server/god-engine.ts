import { config, type GuildId } from '../config.ts';
import type { Store } from '../db/store.ts';
import { godHealth, radiusFor, skillHealthFactor, type BattleResult } from '../game/battle.ts';
import { farthestTile, tileCounts } from '../game/war.ts';
import { createRng, type Rng } from '../util/rng.ts';
import { prepareBattle, toughnessFor } from './battles.ts';
import type { EventEngine, EventMap, EventOutcome, EventStep } from './event-runner.ts';
import { guildName, languageOf, translator } from '../i18n.ts';

export type GodEventKind = 'wrath' | 'versus';
/** What the streamer can start: the two god events, or a friendly Streamer vs Chat. */
export type GodStartKind = GodEventKind | 'friendly';

export interface GodStep extends EventStep {
  kind: GodEventKind;
}

const GOD = 'god';
const CHAT = 'chat';
const guildOf = (id: GuildId) => config.guilds.list.find((g) => g.id === id)!;

/**
 * The streamer descends as a god, one large fighter.
 * - God's Wrath: against the guild whose Monument is furthest, for its tile
 *   farthest from its city. If the god wins, the tile becomes neutral.
 * - Streamer vs Chat: against all guilds together, over the map once per
 *   session: if the god wins, every guild loses its farthest tile and every
 *   Monument a share of its progress. A friendly one can run any time.
 * With enough wins against chat in a season, the god wins the season.
 * The god wins if it is still standing at the time limit.
 */
export class GodEngine implements EventEngine<GodStep> {
  readonly kind: GodEventKind;
  /** God's Wrath only: the guild under attack and the tile at stake. */
  readonly target: GuildId | null = null;
  readonly tileId: string | null = null;
  godWon: boolean | null = null;
  /** Set when this fight won the god the season: the number of wins it took. */
  seasonWins: number | null = null;
  /**
   * A friendly Streamer vs Chat: a fight to see who wins. It changes nothing
   * in the game and is counted apart from the score.
   */
  readonly friendly: boolean = false;
  private readonly store: Store;
  private readonly now: () => number;
  private readonly rng: Rng;
  private readonly seed: number;
  private readonly startedAt: number;
  private readonly god: { name: string; color: string; emote: string | null };
  private readonly participants = new Map<string, GuildId>();
  /** The tile each guild loses if the god wins, fixed when the event is announced. */
  private readonly stakes: { guild: GuildId; tile: string }[] = [];
  private started = false;
  private finished = false;
  private text = '';
  /** The texts of this fight, in the language chosen when it started. */
  private readonly lang: string;
  private readonly t: ReturnType<typeof translator>;

  /** Throws an Error with a message for the streamer if the event cannot start. */
  constructor(store: Store, now: () => number, seed: number, start: GodStartKind, channel: string) {
    this.lang = languageOf(store);
    this.t = translator(this.lang);
    // A friendly fight is a Streamer vs Chat with nothing at stake.
    const kind: GodEventKind = start === 'friendly' ? 'versus' : start;
    this.store = store;
    this.now = now;
    this.seed = seed;
    this.kind = kind;
    this.rng = createRng(seed);
    this.startedAt = now();
    this.god = store.godIdentity(channel);

    if (kind === 'wrath') {
      const tiles = store.mapTiles();
      // The god goes for whoever leads the race: the furthest Monument among the guilds that hold land.
      const counts = tileCounts(tiles);
      const monuments = store.monuments();
      const landed = config.guilds.list.filter((guild) => counts[guild.id] > 0);
      if (landed.length === 0) throw new Error(this.t('server.god.wrathNeedsLand'));
      const furthest = Math.max(...landed.map((guild) => monuments[guild.id]));
      const leaders = landed.filter((guild) => monuments[guild.id] === furthest);
      const leader = leaders[Math.floor(this.rng() * leaders.length)]!.id;
      this.target = leader;
      this.tileId = farthestTile(tiles, leader, this.rng)!.id;
      this.stakes.push({ guild: leader, tile: this.tileId });
    } else {
      const session = store.activeSession();
      if (!session) throw new Error(this.t('server.god.versusNeedsLayer'));
      // Fought over the map once per session; a friendly fight can run any time and changes nothing.
      if (start === 'versus' && session.versus_used === 1) {
        throw new Error(this.t('server.god.versusUsed'));
      }
      this.friendly = start === 'friendly';
      const tiles = store.mapTiles();
      for (const guild of this.friendly ? [] : config.guilds.list) {
        const tile = farthestTile(tiles, guild.id, this.rng);
        if (tile) this.stakes.push({ guild: guild.id, tile: tile.id });
      }
    }
  }

  next(): GodStep | null {
    if (this.started) return null;
    this.started = true;
    const guilds: GuildId[] = this.target ? [this.target] : config.guilds.list.map((g) => g.id);
    const god = this.god.name;
    const title =
      this.kind === 'wrath'
        ? this.t('mode.godsWrath')
        : this.t(this.friendly ? 'server.god.friendlyTitle' : 'server.god.versusTitle', { god });
    const { setup, meta } = prepareBattle(this.store, {
      title,
      sides: guilds,
      defender: this.target ?? undefined,
      tileId: this.tileId ?? undefined,
      seed: Math.floor(this.rng() * 2 ** 31),
      now: this.now(),
    });
    for (const fighter of setup.fighters) if (!fighter.imp) this.participants.set(fighter.id, fighter.side as GuildId);
    // Chatters who were not drawn into the fight share in the reward.
    for (const user of this.store.recentlyActive(this.now() - config.server.activeWindowMs, this.now())) {
      if (guilds.includes(user.guild_id)) this.participants.set(user.user_id, user.guild_id);
    }

    // The streamer's imps that fill a small chat count by their strength.
    const imps = setup.fighters.filter((fighter) => fighter.imp).length;
    const opponents = setup.fighters.length - imps + imps * config.smallChat.impStrength;
    const { healthVariation, damage, radiusFactor, splashFactor, speed, weight } = config.god;
    const radius = radiusFor(setup.fighters.length + 1);
    // Skills make the god stronger; its health is lowered to keep the fight even.
    const skills = this.store.godSkills();
    const health =
      godHealth(opponents) * (1 + healthVariation * (2 * this.rng() - 1)) * skillHealthFactor(skills);

    setup.sizeBalance = false;
    setup.toughness = toughnessFor('god', setup.fighters.length);
    setup.timeLimitWinner = GOD;
    for (const side of setup.sides) side.team = CHAT;
    setup.sides.unshift({ id: GOD, damageBonus: 0, healthBonus: 0 });
    setup.fighters.unshift({
      id: GOD,
      name: this.god.name,
      color: this.god.color,
      emote: this.god.emote,
      image: this.store.godPictureUrl(),
      side: GOD,
      level: 0,
      health,
      damage,
      radius: radius * radiusFactor,
      splashRadius: radius * splashFactor,
      speed,
      weight,
      skills,
      holdsCenter: true,
    });

    const chatTeam = this.target
      ? { name: guildName(this.lang, this.target), color: guildOf(this.target).color }
      : { name: this.t('common.chat'), color: '#FFFFFF' };
    const subtitle = this.target
      ? this.t('server.god.wrathSubtitle', { god, guild: guildName(this.lang, this.target) })
      : this.t(this.friendly ? 'server.god.friendlySubtitle' : 'server.god.versusSubtitle', { god });
    return {
      kind: this.kind,
      title,
      subtitle,
      label: title,
      map: { targets: this.stakes.map((stake) => ({ tile: stake.tile, by: GOD })) },
      setup,
      meta: {
        title,
        sides: [{ id: GOD, name: this.god.name, color: this.god.color }, ...meta.sides],
        teams: { [GOD]: { name: this.god.name, color: this.god.color }, [CHAT]: chatTeam },
      },
    };
  }

  apply(step: GodStep, result: BattleResult): { display: EventOutcome } {
    const godWon = result.winner === GOD;
    this.godWon = godWon;
    const { store } = this;
    let topDamageGuild: GuildId | null = null;
    const map: EventMap = {};
    // Only tiles their guild still owns are at stake.
    const owners = new Map(store.mapTiles().map((tile) => [tile.id, tile.owner]));
    const stakes = this.stakes.filter((stake) => owners.get(stake.tile) === stake.guild);
    if (godWon) {
      map.changes = stakes.map((stake) => ({ tile: stake.tile, from: stake.guild, to: null, scorched: true }));
    } else {
      map.held = stakes.map((stake) => stake.tile);
    }

    if (this.friendly) {
      // Nothing changes: no tiles, no ruins, no XP, no statistics. Only the friendly tally.
      this.text = this.t('server.god.friendlyResult');
      store.insertGodFight({
        kind: 'friendly',
        tileId: null,
        targetGuild: null,
        godWon,
        topDamageGuild: null,
        startedAt: this.startedAt,
        seed: this.seed,
      });
      return {
        display: {
          title: this.t(godWon ? 'server.god.prevails' : 'server.god.defeated', { god: this.god.name }),
          subtitle: this.text,
          map: {},
        },
      };
    }

    store.transaction(() => {
      store.addFightStats(result.fighters.filter((fighter) => fighter.id !== GOD));

      if (this.kind === 'wrath') {
        const guild = guildName(this.lang, this.target!);
        if (godWon) {
          for (const stake of stakes) store.setTileOwner(stake.tile, null, true, true);
          this.text = this.t('server.god.tileLost', { guild });
        } else {
          for (const userId of this.participants.keys()) store.addXp(userId, config.god.winXp);
          this.text = this.t('server.god.landKept', { guild });
        }
      } else if (godWon) {
        for (const stake of stakes) store.setTileOwner(stake.tile, null, true, true);
        store.setBackMonuments(config.monument.setback);
        const lost = Math.round(config.monument.setback * 100);
        this.text = this.t('server.god.allLost', { percent: lost });
      } else {
        for (const userId of this.participants.keys()) store.addXp(userId, config.god.winXp);
        // The guild whose fighters dealt the most damage each sees one of its tiles grow a level.
        let best = -1;
        for (const side of result.sides) {
          if (side.team !== CHAT || side.fighters === 0) continue;
          const perFighter = side.damageDealt / side.fighters;
          if (perFighter > best) {
            best = perFighter;
            topDamageGuild = side.id as GuildId;
          }
        }
        if (topDamageGuild) {
          store.addFreeTileLevel(topDamageGuild);
          this.text = this.t('server.god.struckHardest', { guild: guildName(this.lang, topDamageGuild) });
        } else {
          this.text = this.t('server.god.chatWon');
        }
      }

      const session = store.activeSession();
      if (this.kind === 'versus' && session) store.markVersusUsed(session.session_id);
      store.insertGodFight({
        kind: this.kind,
        tileId: this.tileId,
        targetGuild: this.target,
        godWon,
        topDamageGuild,
        startedAt: this.startedAt,
        seed: this.seed,
      });
    });

    // Enough wins against chat, and the season is the god's.
    const wins = store.godRecord(store.currentSeasonId(this.now())).seasonWins;
    if (godWon && wins >= config.god.winsToWinSeason) {
      this.seasonWins = wins;
      store.endSeason(this.now(), this.rng(), 'god');
    }

    return {
      display: {
        title: this.t(godWon ? 'server.god.prevails' : 'server.god.defeated', { god: this.god.name }),
        subtitle: this.text,
        map,
      },
    };
  }

  finish(): void {
    this.finished = true;
  }

  closing(): { title: string; subtitle: string; map: EventMap } {
    if (this.godWon === null) {
      return {
        title: this.t(this.kind === 'wrath' ? 'mode.godsWrath' : 'mode.streamerVsChat'),
        subtitle: this.t('server.god.calledOff'),
        map: {},
      };
    }
    if (this.seasonWins !== null) {
      return {
        title: this.t('server.god.winsSeason', { god: this.god.name }),
        subtitle: this.t('server.god.winsSeasonSubtitle', { wins: this.seasonWins }),
        map: {},
      };
    }
    // The map already showed the outcome; the closing banner shows the god's season score.
    const record = this.store.godRecord(this.store.currentSeasonId(this.now()));
    if (this.friendly) {
      return {
        title: this.t('server.god.score', { god: this.god.name, wins: record.friendlyWins, losses: record.friendlyLosses }),
        subtitle: this.t('server.god.friendlyScore'),
        map: {},
      };
    }
    return {
      title: this.t('server.god.score', { god: this.god.name, wins: record.seasonWins, losses: record.seasonLosses }),
      subtitle: this.t('server.god.seasonScore'),
      map: {},
    };
  }
}
