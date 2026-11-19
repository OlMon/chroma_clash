import { config, type GuildId } from '../config.ts';
import type { UserRow } from '../db/store.ts';
import type { BattleResult } from '../game/battle.ts';
import { playPachinko, type PachinkoGame } from '../game/pachinko.ts';
import { createRng } from '../util/rng.ts';
import type { Lineup } from './draft-engine.ts';
import { bannerStrip, type BannerPlace } from './battle-runner.ts';
import type { EventEngine, EventStep } from './event-runner.ts';
import { DEFAULT_LANGUAGE, guildName, translator } from '../i18n.ts';

const guildOf = (id: GuildId) => config.guilds.list.find((g) => g.id === id)!;

/** How a player's ball looks on the overlay: its name, color and emote. */
export type BallLook = (user: UserRow) => { emote: unknown };

/**
 * Pachinko, an Arena game for fun: the chatters drawn like for a Guild Clash
 * drop down one board per guild, and the guild with the most points wins.
 * The whole game is played when it starts; the overlay shows it ball by ball.
 * It changes nothing in the game.
 */
export class PachinkoEngine implements EventEngine {
  readonly picks: UserRow[];
  readonly game: PachinkoGame<UserRow>;
  private readonly look: BallLook;
  private started = false;
  /** The texts of this game, in the language chosen when it started. */
  private readonly lang: string;
  private readonly t: ReturnType<typeof translator>;

  /** Where the map banner is during the game, as in a battle; null for none. */
  private readonly banner: BannerPlace;

  constructor(seed: number, picks: UserRow[], look: BallLook, lang = DEFAULT_LANGUAGE, banner: BannerPlace = null) {
    this.banner = banner;
    this.picks = picks;
    this.look = look;
    this.lang = lang;
    this.t = translator(lang);
    const teams = config.guilds.list.map((guild) => ({
      team: guild.id,
      players: picks.filter((user) => user.guild_id === guild.id),
    }));
    this.game = playPachinko(teams, createRng(seed));
  }

  lineup(): Lineup {
    const balls = Math.max(0, ...this.game.boards.map((board) => board.drops.length));
    return {
      teams: config.guilds.list
        .map((guild) => ({
          name: guildName(this.lang, guild.id),
          color: guild.color,
          members: this.picks
            .filter((user) => user.guild_id === guild.id)
            .map((user) => ({ name: user.display_name, detail: '', id: user.user_id })),
        }))
        .filter((team) => team.members.length > 0),
      note: this.t('server.pachinko.note', { count: balls }),
    };
  }

  next(): EventStep | null {
    if (this.started) return null;
    this.started = true;
    const { rows, slots, hopMs } = config.pachinko;
    return {
      kind: 'pachinko',
      title: this.t('server.lineupTitle', { mode: this.t('mode.pachinko') }),
      subtitle: this.lineup().note,
      label: this.t('mode.pachinko'),
      holdMs: config.draft.lineupMs,
      lineup: this.lineup(),
      show: {
        durationMs: this.game.durationMs + config.pachinko.holdMs,
        message: {
          type: 'pachinko',
          title: this.t('mode.pachinko'),
          // The map banner's strip, as for a battle.
          banner: bannerStrip(this.banner),
          rows,
          slots,
          hopMs,
          durationMs: this.game.durationMs,
          winner: this.game.winner,
          boards: this.game.boards.map((board) => {
            const guild = guildOf(board.team as GuildId);
            return {
              team: board.team,
              name: guildName(this.lang, guild.id),
              color: guild.color,
              total: board.total,
              drops: board.drops.map((drop) => ({
                name: drop.player.display_name,
                color: drop.player.color,
                emote: this.look(drop.player).emote,
                path: drop.path,
                slot: drop.slot,
                points: drop.points,
                at: drop.at,
              })),
            };
          }),
        },
      },
    };
  }

  apply(_step: EventStep, _result: BattleResult): void {
    // Nothing is fought: the game was played when it started.
  }

  finish(): void {
    // Pachinko changes nothing in the game.
  }

  closing(): { title: string; subtitle: string } {
    const winner = this.game.winner;
    if (!winner) return { title: this.t('mode.pachinko'), subtitle: this.t('server.noWinner') };
    const scores = this.game.boards.map((board) => `${guildName(this.lang, board.team)} ${board.total}`).join(' · ');
    return { title: this.t('server.pachinko.wins', { guild: guildName(this.lang, winner) }), subtitle: scores };
  }
}
