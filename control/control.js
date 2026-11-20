// The control panel shows the state from the server and sends the streamer's commands.
'use strict';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const HEX_SIZE = 26;
const SCREEN = { width: 1920, height: 1080 };

let state = null;
/** The server's language when the tuning rows and skill switches were built. */
let builtLanguage = null;
/** Reloads the status tab every few seconds while it is open. */
let statusTimer = null;

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}

async function post(path, body) {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    // The server's own messages arrive in the chosen language already.
    if (!response.ok) throw new Error(result.error || tr('control.error.request', { status: response.status }));
    showError('');
    render(result);
  } catch (error) {
    showError(error.message);
  }
}

function cell(row, text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  row.appendChild(td);
  return td;
}

function guildCell(row, guild) {
  const td = document.createElement('td');
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = guild.color;
  td.append(dot, guild.name);
  row.appendChild(td);
  return td;
}

function hexPoints(x, y, size) {
  const points = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 90);
    points.push(`${(x + size * Math.cos(angle)).toFixed(1)},${(y + size * Math.sin(angle)).toFixed(1)}`);
  }
  return points.join(' ');
}

function renderMap() {
  const svg = $('map');
  svg.replaceChildren();
  const colors = Object.fromEntries(state.guilds.map((g) => [g.id, g.color]));
  for (const tile of state.tiles) {
    const x = HEX_SIZE * Math.sqrt(3) * (tile.q + tile.r / 2);
    const y = HEX_SIZE * 1.5 * tile.r;
    const hex = document.createElementNS(SVG, 'polygon');
    hex.setAttribute('points', hexPoints(x, y, HEX_SIZE));
    if (tile.owner) {
      hex.setAttribute('fill', colors[tile.owner]);
      if (!tile.isCity) hex.setAttribute('fill-opacity', '0.75');
    } else {
      hex.setAttribute('class', 'neutral');
    }
    if (tile.burning) hex.classList.add('burning');
    svg.appendChild(hex);
    if (tile.level > 0 && !tile.isCity) {
      // The tile's development level.
      const label = document.createElementNS(SVG, 'text');
      label.setAttribute('x', x.toFixed(1));
      label.setAttribute('y', (y + 5).toFixed(1));
      label.setAttribute('class', 'tile-level');
      label.textContent = tile.level;
      svg.appendChild(label);
    }
    if (tile.isCity) {
      const mark = document.createElementNS(SVG, 'circle');
      mark.setAttribute('cx', x.toFixed(1));
      mark.setAttribute('cy', y.toFixed(1));
      mark.setAttribute('r', '6');
      mark.setAttribute('class', 'city-mark');
      svg.appendChild(mark);
    }
  }
}

/** The mishaps there are words for; each is a whole sentence, since languages put the tile in different places. */
const MISHAP_KINDS = ['lightning', 'fire', 'spread', 'burn', 'burntOut', 'doused', 'harvest'];

/** The latest mishaps, newest first, in words. */
function renderMishaps() {
  const list = $('mishaps');
  list.replaceChildren();
  const names = Object.fromEntries(state.guilds.map((g) => [g.id, g.name]));
  for (const mishap of [...(state.mishaps || [])].reverse()) {
    const item = document.createElement('li');
    const where = mishap.owner
      ? tr('control.mishap.ownedTile', { guild: names[mishap.owner], tile: mishap.tile })
      : tr('control.mishap.freeTile', { tile: mishap.tile });
    const change = mishap.to === mishap.from
      ? tr('control.mishap.kept', { level: mishap.to })
      : tr('control.mishap.changed', { from: mishap.from, to: mishap.to });
    item.textContent = MISHAP_KINDS.includes(mishap.kind)
      ? tr(`control.mishap.${mishap.kind}`, { where, change })
      : `${mishap.kind} ${where}: ${change}`;
    list.appendChild(item);
  }
  $('mishaps-empty').hidden = list.children.length > 0;
}

function renderGuilds() {
  const body = $('guilds').querySelector('tbody');
  body.replaceChildren();
  for (const guild of state.guilds) {
    const row = document.createElement('tr');
    const name = guildCell(row, guild);
    cell(row, guild.members, 'num');
    cell(row, guild.active, 'num');
    cell(row, guild.tiles, 'num');
    cell(row, guild.development, 'num');
    const monument = cell(row, `${Math.floor((guild.monument.progress / guild.monument.goal) * 100)}%`, 'num');
    const detail = document.createElement('div');
    detail.className = 'sub';
    detail.textContent = tr('control.map.monumentDetail', guild.monument);
    monument.appendChild(detail);
    name.title = `${guild.name}`;
    body.appendChild(row);
  }
}

/** How far the season is, in stream hours, and when it should end at the chat's pace. */
function paceText() {
  const pace = state.pace;
  const guild = state.guilds.find((g) => g.id === pace.leader);
  const values = {
    played: number(pace.played, 1),
    hours: number(pace.hours, 0),
    goal: pace.goal.toLocaleString(I18n.language),
    until: number(pace.adaptUntil, Number.isInteger(pace.adaptUntil) ? 0 : 1),
    guild: guild ? guild.name : '',
    remaining: pace.remaining === null ? '' : number(Math.max(1, Math.round(pace.remaining)), 0),
  };
  const parts = [tr('control.pace.played', values)];
  if (pace.adapting) parts.push(tr('control.pace.adapting', values));
  if (guild && pace.remaining !== null) {
    parts.push(tr(pace.remaining < 1.5 ? 'control.pace.soon' : 'control.pace.forecast', values));
  }
  return parts.join(' ');
}

function renderTop() {
  const body = $('top').querySelector('tbody');
  body.replaceChildren();
  const guilds = Object.fromEntries(state.guilds.map((g) => [g.id, g]));
  for (const chatter of state.topChatters) {
    const row = document.createElement('tr');
    cell(row, chatter.displayName);
    guildCell(row, guilds[chatter.guild]);
    cell(row, chatter.ticks, 'num');
    cell(row, chatter.level, 'num');
    body.appendChild(row);
  }
  $('top').hidden = state.topChatters.length === 0;
  $('top-empty').hidden = state.topChatters.length > 0;
}

function renderExcluded() {
  const list = $('excluded');
  list.replaceChildren();
  for (const login of state.excluded) {
    const item = document.createElement('li');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = tr('control.excluded.remove');
    remove.setAttribute('aria-label', tr('control.excluded.removeLabel', { login }));
    remove.addEventListener('click', () => post('/api/exclusions', { login, excluded: false }));
    item.append(login, remove);
    list.appendChild(item);
  }
}

/** Builds the tuning rows once, then only updates values the streamer is not editing. */
/** The tuning values: the everyday ones openly, the rest folded away under "Advanced". */
function renderTuning() {
  for (const item of state.tuning) {
    const box = $(item.everyday ? 'tuning' : 'tuning-advanced');
    let input = box.querySelector(`[data-key="${item.key}"]`);
    if (!input) {
      // Each section starts with its heading, added when its first value is built.
      if (!box.querySelector(`[data-group="${item.group}"]`)) {
        const heading = document.createElement('h3');
        heading.textContent = item.group;
        heading.dataset.group = item.group;
        box.appendChild(heading);
      }
      const label = document.createElement('label');
      label.textContent = item.label;
      input = document.createElement('input');
      input.type = 'number';
      input.step = 'any';
      input.min = item.min;
      input.max = item.max;
      input.dataset.key = item.key;
      label.htmlFor = input.id = `tuning-${item.key}`;
      input.addEventListener('change', () => {
        const value = input.value.trim() === '' ? null : Number(input.value);
        post('/api/tuning', { key: item.key, value });
      });
      const note = document.createElement('span');
      note.className = 'default';
      note.textContent = tr('control.tuning.default', { value: item.default });
      box.append(label, input, note);
    }
    if (document.activeElement !== input) input.value = item.value;
  }
}

/** The panel being dragged in the layout preview, with where the pointer took hold of it. */
let drag = null;

/** Places the preview's panels as the overlay has them, and updates the switches under it. */
function renderLayout() {
  for (const panel of ['map', 'stats']) {
    const box = state.overlay[panel];
    const element = $(`stage-${panel}`);
    // A panel that is being dragged follows the pointer, not the server.
    if (!drag || drag.panel !== panel) placeOnStage(element, box, box.x, box.y);
    element.classList.toggle('off', !box.visible);
    $(`show-${panel}`).checked = box.visible;
  }

  const lines = $('stat-lines');
  for (const row of state.seasonStats) {
    let input = lines.querySelector(`[data-line="${row.id}"]`);
    if (!input) {
      const label = document.createElement('label');
      input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.line = row.id;
      input.addEventListener('change', () => {
        post('/api/overlay', { line: { id: row.id, enabled: input.checked } });
      });
      const name = document.createElement('span');
      name.dataset.role = 'name';
      const value = document.createElement('span');
      value.className = 'sub';
      value.dataset.role = 'value';
      label.append(input, name, value);
      lines.appendChild(label);
    }
    input.checked = row.enabled;
    input.parentElement.querySelector('[data-role="name"]').textContent = row.label;
    input.parentElement.querySelector('[data-role="value"]').textContent = tr('control.layout.now', { value: row.value });
  }
}

/** Sizes and places a preview panel from screen pixels, as shares of the preview. */
function placeOnStage(element, box, x, y) {
  element.style.left = `${(x / SCREEN.width) * 100}%`;
  element.style.top = `${(y / SCREEN.height) * 100}%`;
  element.style.width = `${(box.width / SCREEN.width) * 100}%`;
  element.style.height = `${(box.height / SCREEN.height) * 100}%`;
}

/** The Look card: the theme, and how emotes are shown. Built once, then only kept in step. */
function renderDisplay() {
  const display = state.display;
  const select = $('theme-select');
  const ids = display.themes.map((theme) => theme.id).join(',');
  if (select.dataset.ids !== ids) {
    select.replaceChildren(...display.themes.map((theme) => new Option(theme.name, theme.id)));
    select.dataset.ids = ids;
  }
  if (document.activeElement !== select) select.value = display.theme;
  const current = display.themes.find((theme) => theme.id === display.theme);
  $('theme-description').textContent = current ? current.description : '';
  $('display-pixelate').checked = display.pixelateEmotes;
  $('display-animated').checked = display.animatedEmotes;
  $('display-random').checked = display.randomEmotes;
  $('display-names').checked = display.names;
  $('display-highlights').checked = display.highlights;
  for (const input of document.querySelectorAll('[data-source]')) {
    input.checked = display.emoteSources[input.dataset.source];
  }
}

/** The channel card: which chat is read, and a field to enter another. */
function renderChannel(source) {
  const card = $('channel-card');
  card.classList.toggle('attention', source.kind === 'none');
  const input = $('channel-input');
  const simulated = source.kind === 'sim';
  input.disabled = simulated;
  $('channel-connect').disabled = simulated;
  $('channel-connect').textContent = tr(source.kind === 'none' ? 'control.channel.connect' : 'control.channel.switch');
  if (document.activeElement !== input && !input.value) input.placeholder = source.channel || tr('control.channel.placeholder');
  $('channel-status').textContent = simulated
    ? tr('control.channel.simulated')
    : source.kind === 'none'
      ? tr('control.channel.none')
      : tr('control.channel.reading', { channel: source.channel, status: sourceStatus(source.status) });
}

/**
 * The chat connection's state comes from the server as a short English id;
 * the known ones are put into words here, anything else is shown as it is.
 */
function sourceStatus(status) {
  const simulating = /^simulating (\d+) chatters at x(.+)$/.exec(status);
  if (simulating) return tr('control.sourceStatus.simulating', { count: Number(simulating[1]), speed: simulating[2] });
  const known = {
    'waiting for the channel name': 'waiting',
    starting: 'starting',
    connecting: 'connecting',
    connected: 'connected',
    joined: 'joined',
    disconnected: 'disconnected',
    'auth-failed': 'authFailed',
  };
  return known[status] ? tr(`control.sourceStatus.${known[status]}`) : status;
}

/** A number in the panel's language, such as 1.5 or 1,5. */
function number(value, digits) {
  return value.toLocaleString(I18n.language, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function render(next) {
  state = next;
  I18n.follow(state.display.language);
  const { source, session, channelSize } = state;

  $('source').textContent = source.kind === 'none'
    ? tr('control.source.none')
    : tr('control.source.line', {
        kind: tr(source.kind === 'sim' ? 'control.source.sim' : 'control.source.twitch'),
        channel: source.channel,
        status: sourceStatus(source.status),
        season: state.seasonId,
      });
  renderChannel(source);

  const toggle = $('layer-toggle');
  // Without a channel there is no chat to play with.
  toggle.disabled = source.kind === 'none';
  toggle.textContent = tr(session.active ? 'control.turnOff' : 'control.turnOn');
  toggle.classList.toggle('primary', !session.active);
  $('layer-status').textContent = session.active
    ? tr('control.layer.on', { time: new Date(session.startedAt).toLocaleTimeString(I18n.language) })
    : tr('control.layer.off');

  const running = state.battle !== null;
  // One status and one Stop for whatever is on the overlay, shown above every tab.
  $('running-status').textContent = running
    ? tr('control.running.title', { title: state.battle.title })
    : state.endless.active
      ? tr('control.running.endless')
      : tr('control.running.nothing');
  $('running-bar').classList.toggle('active', running || state.endless.active);
  $('stop-all').disabled = !running && !state.endless.active;
  for (const button of document.querySelectorAll('[data-battle]')) button.disabled = running;
  $('war-start').disabled = running;
  const guildName = Object.fromEntries(state.guilds.map((g) => [g.id, g.name]));
  $('clash-start').disabled = running || !session.active;
  $('clash-status').textContent = state.champion
    ? tr('control.clash.champion', { name: state.champion.displayName, guild: guildName[state.champion.guild] })
    : tr('control.clash.text');

  $('draft-guild').disabled = running;
  $('draft-free').disabled = running;
  $('draft-pachinko').disabled = running;

  const endless = state.endless;
  $('endless-toggle').disabled = running && !endless.active;
  $('endless-toggle').textContent = tr(endless.active ? 'control.turnOff' : 'control.turnOn');
  $('endless-toggle').classList.toggle('primary', !endless.active);
  $('endless-status').textContent = endless.active
    ? tr('control.endless.on', { count: endless.concurrent })
    : tr('control.endless.off');
  const concurrent = $('endless-concurrent');
  if (document.activeElement !== concurrent) concurrent.value = endless.concurrent;

  const god = state.god;
  $('god-wrath').disabled = running || !state.guilds.some((g) => g.tiles > 0);
  $('god-versus').disabled = running || !god.versusAvailable;
  $('god-status').textContent = tr('control.god.status', {
    name: god.name,
    seasonWins: god.seasonWins,
    seasonLosses: god.seasonLosses,
    lifetimeWins: god.lifetimeWins,
    lifetimeLosses: god.lifetimeLosses,
    winsToWin: state.godWinsToWin,
  });
  // Streamer vs Chat over the map runs once per session; say why the button is off when it is.
  $('god-versus-note').textContent = tr(
    god.versusUsed ? 'control.god.versusUsed' : !session.active ? 'control.god.versusNeedsLayer' : 'control.god.versusOnce',
  );
  $('god-friendly').disabled = running || !god.friendlyAvailable;
  $('god-friendly-status').textContent = [
    tr('control.friendly.text'),
    god.friendlyWins + god.friendlyLosses > 0
      ? tr('control.friendly.tally', { wins: god.friendlyWins, losses: god.friendlyLosses })
      : tr('control.friendly.apart'),
    session.active ? '' : tr('control.friendly.needsLayer'),
  ].filter(Boolean).join(' ');
  // Rows built once from the server's words are built anew when the server writes in another language.
  if (builtLanguage !== state.display.language) {
    builtLanguage = state.display.language;
    $('tuning').replaceChildren();
    $('god-skills').replaceChildren();
  }
  // Skill switches are built once; afterwards only their state is updated.
  const skillBox = $('god-skills');
  for (const skill of god.skills) {
    let input = skillBox.querySelector(`[data-skill="${skill.id}"]`);
    if (!input) {
      const label = document.createElement('label');
      input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.skill = skill.id;
      input.addEventListener('change', () => {
        post('/api/god/skills', { skill: skill.id, enabled: input.checked });
      });
      const name = document.createElement('span');
      name.textContent = skill.name;
      const description = document.createElement('span');
      description.className = 'sub';
      description.textContent = skill.description;
      label.append(input, name, description);
      skillBox.appendChild(label);
    }
    input.checked = skill.enabled;
  }

  renderLayout();
  renderDisplay();
  renderLanguage();

  const picture = $('god-picture');
  if (god.picture && picture.getAttribute('src') !== god.picture) picture.src = god.picture;
  picture.hidden = !god.picture;
  $('god-picture-empty').hidden = Boolean(god.picture);
  $('god-picture-remove').disabled = !god.picture;
  picture.alt = tr('control.picture.alt');
  $('god-picture-status').textContent = tr(god.picture ? 'control.picture.has' : 'control.picture.none');
  $('war-command').disabled = false;
  $('war-command').checked = state.warCommand;
  $('obstacles').disabled = false;
  $('obstacles').checked = state.obstacles;
  if (document.activeElement !== $('map-banner')) $('map-banner').value = state.mapBanner;

  const measured =
    channelSize.measured === null
      ? tr('control.size.notMeasured')
      : tr('control.size.measured', { value: number(channelSize.measured, 1) });
  const mode =
    channelSize.manual === null ? tr('control.size.usingMeasurement') : tr('control.size.manual', { value: channelSize.manual });
  $('size-status').textContent = `${measured} ${mode} ${tr('control.size.cost', { scale: number(channelSize.scale, 2) })}`;
  $('size-auto').disabled = channelSize.manual === null;

  const guildNames = Object.fromEntries(state.guilds.map((g) => [g.id, g.name]));
  const last = state.lastSeason
    ? tr('control.season.lastWinner', {
        season: state.lastSeason.id,
        winner: state.lastSeason.winner === 'god' ? state.god.name : guildNames[state.lastSeason.winner] || tr('control.nobody'),
      })
    : '';
  $('season-pace').textContent = paceText();
  $('season-status').textContent = [tr('control.season.running', { season: state.seasonId }), paceText(), last, tr('control.season.rules')]
    .filter(Boolean)
    .join(' ');
  const start = $('season-start');
  if (document.activeElement !== start) start.value = state.seasonStart;
  $('season-end').disabled = running;

  renderGuide();
  renderDock();
  renderExtras();
  renderRuntimes();

  renderMap();
  renderMishaps();
  renderGuilds();
  renderTop();
  renderExcluded();
  renderTuning();
  renderHistory();
  // A season that just ended belongs in the history at once.
  const lastSeasonId = state.lastSeason ? state.lastSeason.id : 0;
  if (lastSeasonId !== historyUpTo) loadHistory();
}

// --- History -----------------------------------------------------------------

/** The finished seasons as last loaded, newest first; null before the first load. */
let seasons = null;
/** The newest finished season the loaded history covers, to notice when another one ends. */
let historyUpTo = -1;

async function loadHistory() {
  if (!state) return;
  const upTo = state.lastSeason ? state.lastSeason.id : 0;
  historyUpTo = upTo;
  try {
    const response = await fetch('/api/history');
    if (!response.ok) throw new Error(tr('control.error.history', { status: response.status }));
    seasons = (await response.json()).seasons;
    renderHistory();
  } catch (error) {
    // Try again with the next state update.
    historyUpTo = -1;
    showError(error.message);
  }
}

function renderHistory() {
  if (!state) return;
  const date = (ms) => new Date(ms).toLocaleDateString(I18n.language);
  $('history-current').textContent = tr('control.history.current', {
    season: state.seasonId,
    date: date(state.season.startedAt),
    day: state.season.day,
  });
  $('history-god-heading').textContent = tr('control.history.godHeading', { name: state.god.name });
  if (seasons === null) return;

  const guilds = Object.fromEntries(state.guilds.map((g) => [g.id, g]));
  const body = $('history').querySelector('tbody');
  body.replaceChildren();
  for (const season of seasons) {
    const row = document.createElement('tr');
    cell(row, season.id, 'num');
    cell(row, date(season.startedAt));
    cell(row, date(season.endedAt));
    cell(row, Math.max(1, Math.ceil((season.endedAt - season.startedAt) / 86_400_000)), 'num');
    if (guilds[season.winner]) {
      guildCell(row, guilds[season.winner]);
    } else if (season.winner === 'god') {
      // The god has no guild color: its dot takes the streamer's name color.
      guildCell(row, { name: state.god.name, color: state.god.color });
    } else {
      cell(row, tr('control.nobody'));
    }
    cell(row, season.wars, 'num');
    cell(row, `${season.godWins} : ${season.godLosses}`, 'num');
    body.appendChild(row);

    // Under each season, what it looked like when it ended.
    const details = document.createElement('tr');
    details.className = 'history-details';
    const box = document.createElement('td');
    box.colSpan = row.children.length;
    const summary = season.summary;
    if (!summary) {
      box.textContent = tr('control.history.noDetails');
    } else {
      const facts = document.createElement('dl');
      const fact = (label, value) => {
        const term = document.createElement('dt');
        term.textContent = label;
        const text = document.createElement('dd');
        text.textContent = value;
        facts.append(term, text);
      };
      const nobody = tr('control.nobody');
      // Seasons recorded before the ending was kept have none to show.
      if (['monument', 'god', 'streamer'].includes(summary.endedBy)) {
        fact(tr('control.history.endedBecause'), tr(`control.history.ending.${summary.endedBy}`, { name: state.god.name }));
      }
      fact(
        tr('control.history.highestLevel'),
        summary.topLevel ? tr('control.history.levelOf', { name: summary.topLevel.displayName, level: summary.topLevel.level }) : nobody,
      );
      fact(
        tr('control.history.mostKills'),
        summary.topKiller ? tr('control.history.kills', { name: summary.topKiller.displayName, count: summary.topKiller.kills }) : nobody,
      );
      fact(
        tr('control.history.mostClashWins'),
        summary.champion
          ? tr('control.history.wins', { name: summary.champion.displayName, count: summary.champion.wins })
          : tr('control.history.noClash'),
      );
      // Seasons from before the best Pachinko run was kept have none.
      if (summary.pachinko !== undefined) {
        fact(
          tr('control.history.pachinko'),
          summary.pachinko ? tr('control.history.points', { name: summary.pachinko.displayName, count: summary.pachinko.points }) : nobody,
        );
      }
      fact(tr('control.history.players'), String(summary.players));
      for (const guild of state.guilds) {
        const final = summary.guilds[guild.id];
        if (!final) continue;
        const share = Math.min(100, Math.floor((final.monument / summary.monumentGoal) * 100));
        fact(
          guild.name,
          tr('control.history.guild', {
            share,
            tiles: tr('control.history.tiles', { count: final.tiles }),
            development: final.development,
            members: tr('control.history.members', { count: final.members }),
          }),
        );
      }
      box.appendChild(facts);
    }
    details.appendChild(box);
    body.appendChild(details);
  }
  $('history').hidden = seasons.length === 0;
  $('history-empty').hidden = seasons.length > 0;
}

// --- Tabs --------------------------------------------------------------------

const tabs = [...document.querySelectorAll('[role="tab"]')];

/** Shows one tab's panel and hides the others. The choice is kept in the address, so it survives a reload. */
function selectTab(tab, { focus = false, remember = true } = {}) {
  for (const other of tabs) {
    const selected = other === tab;
    other.setAttribute('aria-selected', String(selected));
    // Only the selected tab is in the Tab order; the arrow keys reach the others.
    other.tabIndex = selected ? 0 : -1;
    $(other.getAttribute('aria-controls')).hidden = !selected;
  }
  if (focus) tab.focus();
  const name = tab.id.replace('tab-', '');
  if (remember && location.hash !== `#${name}`) rememberTab(name);
  if (name === 'history') loadHistory();
  watchStatus();
}

/** Puts the tab's name into the address without adding a step to the browser's Back button. */
function rememberTab(name) {
  window.history.replaceState(null, '', `#${name}`);
}

function tabFromAddress() {
  return $(`tab-${location.hash.slice(1)}`) || tabs[0];
}

for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    const index = tabs.indexOf(tab);
    const target = {
      ArrowRight: tabs[(index + 1) % tabs.length],
      ArrowLeft: tabs[(index - 1 + tabs.length) % tabs.length],
      Home: tabs[0],
      End: tabs[tabs.length - 1],
    }[event.key];
    if (!target) return;
    event.preventDefault();
    selectTab(target, { focus: true });
  });
}
window.addEventListener('hashchange', () => selectTab(tabFromAddress(), { remember: false }));
selectTab(tabFromAddress(), { remember: false });

$('layer-toggle').addEventListener('click', () => {
  if (state) post('/api/session', { active: !state.session.active });
});

for (const button of document.querySelectorAll('[data-battle]')) {
  button.addEventListener('click', () => {
    const sides = button.dataset.battle.split(',');
    post('/api/test-battle', { sides });
  });
}

// Stops whatever is on the overlay: a War, a god event, a countdown, a test battle, or endless mode.
$('stop-all').addEventListener('click', () => post('/api/battle/stop', {}));
/** Shrinks a picture to a centered square of at most 256 pixels and returns it as a data address. */
function shrinkPicture(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      const size = Math.min(256, side);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas
        .getContext('2d')
        .drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      // WebP is small and keeps transparency; browsers that cannot write it fall back to PNG.
      const webp = canvas.toDataURL('image/webp', 0.9);
      resolve(webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png'));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(tr('control.error.picture')));
    };
    image.src = url;
  });
}

/** Uploads the god's picture from a file input, on the God tab or in the setup guide. */
async function uploadPicture(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    await post('/api/god/picture', { image: await shrinkPicture(file) });
  } catch (error) {
    showError(error.message);
  }
}
$('god-picture-file').addEventListener('change', uploadPicture);
$('guide-picture-file').addEventListener('change', uploadPicture);

$('god-picture-remove').addEventListener('click', () => post('/api/god/picture', { image: null }));

// Dragging a panel in the layout preview: it follows the pointer and is saved when let go.
for (const element of document.querySelectorAll('.stage-panel')) {
  const panel = element.dataset.panel;
  const clampTo = (value, max) => Math.min(Math.max(0, value), max);

  element.addEventListener('pointerdown', (event) => {
    if (!state) return;
    const stage = $('layout-stage').getBoundingClientRect();
    const box = state.overlay[panel];
    const scale = SCREEN.width / stage.width; // screen pixels per preview pixel
    drag = {
      panel,
      scale,
      // Where inside the panel the pointer took hold, in screen pixels.
      grabX: (event.clientX - stage.left) * scale - box.x,
      grabY: (event.clientY - stage.top) * scale - box.y,
      x: box.x,
      y: box.y,
      moved: false,
    };
    element.setPointerCapture(event.pointerId);
    element.classList.add('dragging');
  });

  element.addEventListener('pointermove', (event) => {
    if (!drag || drag.panel !== panel) return;
    const stage = $('layout-stage').getBoundingClientRect();
    const box = state.overlay[panel];
    drag.x = clampTo((event.clientX - stage.left) * drag.scale - drag.grabX, SCREEN.width - box.width);
    drag.y = clampTo((event.clientY - stage.top) * drag.scale - drag.grabY, SCREEN.height - box.height);
    drag.moved = true;
    placeOnStage(element, box, drag.x, drag.y);
  });

  const drop = () => {
    if (!drag || drag.panel !== panel) return;
    const { x, y, moved } = drag;
    drag = null;
    element.classList.remove('dragging');
    if (moved) post('/api/overlay', { [panel]: { x: Math.round(x), y: Math.round(y) } });
  };
  element.addEventListener('pointerup', drop);
  element.addEventListener('pointercancel', drop);

  // Arrow keys move the selected panel: 10 pixels a press, 50 with Shift held.
  element.addEventListener('keydown', (event) => {
    const steps = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!steps || !state) return;
    event.preventDefault();
    const box = state.overlay[panel];
    const size = event.shiftKey ? 50 : 10;
    post('/api/overlay', {
      [panel]: {
        x: clampTo(box.x + steps[0] * size, SCREEN.width - box.width),
        y: clampTo(box.y + steps[1] * size, SCREEN.height - box.height),
      },
    });
  });
}

for (const panel of ['map', 'stats']) {
  $(`show-${panel}`).addEventListener('change', (event) => {
    post('/api/overlay', { [panel]: { visible: event.target.checked } });
  });
}
$('layout-reset').addEventListener('click', () => {
  post('/api/overlay', { map: { reset: true }, stats: { reset: true } });
});

$('clash-start').addEventListener('click', () => post('/api/clash/start', {}));
$('draft-guild').addEventListener('click', () => post('/api/draft/start', { mode: 'guild' }));
$('draft-free').addEventListener('click', () => post('/api/draft/start', { mode: 'free' }));
$('draft-pachinko').addEventListener('click', () => post('/api/draft/start', { mode: 'pachinko' }));
$('endless-toggle').addEventListener('click', () => {
  if (state) post('/api/endless', { active: !state.endless.active });
});
$('endless-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = Number($('endless-concurrent').value);
  if (!Number.isFinite(value)) return;
  post('/api/endless', { concurrent: value });
});
$('god-wrath').addEventListener('click', () => post('/api/god/start', { kind: 'wrath' }));
$('god-versus').addEventListener('click', () => post('/api/god/start', { kind: 'versus' }));
$('god-friendly').addEventListener('click', () => post('/api/god/start', { kind: 'friendly' }));
$('war-start').addEventListener('click', () => post('/api/war/start', {}));
$('war-command').addEventListener('change', (event) => {
  post('/api/settings', { warCommand: event.target.checked });
});
$('map-banner').addEventListener('change', (event) => post('/api/map-banner', { place: event.target.value }));
$('obstacles').addEventListener('change', (event) => {
  post('/api/settings', { obstacles: event.target.checked });
});

$('season-start').addEventListener('change', (event) => {
  post('/api/season/start', { mode: event.target.value });
});

$('exclude-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const login = $('exclude-input').value.trim();
  if (login === '') return;
  post('/api/exclusions', { login, excluded: true });
  $('exclude-input').value = '';
});

// Ending a season cannot be undone, so the button must be pressed twice.
let seasonArmed = null;
$('season-end').addEventListener('click', () => {
  const button = $('season-end');
  if (seasonArmed) {
    clearTimeout(seasonArmed);
    seasonArmed = null;
    button.textContent = tr('control.season.end');
    post('/api/season/end', { confirm: true });
    return;
  }
  button.textContent = tr('control.season.confirm');
  seasonArmed = setTimeout(() => {
    seasonArmed = null;
    button.textContent = tr('control.season.end');
  }, 5000);
});

$('size-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = Number($('size-input').value);
  if (!Number.isFinite(value) || value <= 0) {
    showError(tr('control.error.size'));
    return;
  }
  post('/api/channel-size', { chatters: value });
  $('size-input').value = '';
});

$('channel-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('channel-input').value.trim();
  if (!name) return;
  if (state && state.source.kind !== 'none' && !confirm(tr('control.channel.confirmSwitch', { channel: name.replace(/^#/, '') }))) return;
  $('channel-connect').disabled = true;
  $('channel-status').textContent = tr('control.channel.connecting', { channel: name.replace(/^#/, '').toLowerCase() });
  await post('/api/channel', { channel: name });
  $('channel-input').value = '';
});

$('size-auto').addEventListener('click', () => post('/api/channel-size', { chatters: null }));

for (const code of document.querySelectorAll('.overlay-url')) code.textContent = `${location.origin}/overlay/`;
$('dock-url').textContent = `${location.origin}/control/?dock`;

function connect() {
  const socket = new WebSocket(`ws://${location.host}/ws?page=control`);
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'state') {
      showError('');
      render(message.state);
    }
  };
  socket.onclose = () => {
    showError(tr('control.error.connection'));
    setTimeout(connect, 2000);
  };
}

$('theme-select').addEventListener('change', (event) => post('/api/display', { theme: event.target.value }));
$('language-select').addEventListener('change', (event) => post('/api/display', { language: event.target.value }));
$('display-pixelate').addEventListener('change', (event) => post('/api/display', { pixelateEmotes: event.target.checked }));
$('display-animated').addEventListener('change', (event) => post('/api/display', { animatedEmotes: event.target.checked }));
$('display-random').addEventListener('change', (event) => post('/api/display', { randomEmotes: event.target.checked }));
$('display-names').addEventListener('change', (event) => post('/api/display', { names: event.target.checked }));
$('display-highlights').addEventListener('change', (event) => post('/api/display', { highlights: event.target.checked }));
for (const input of document.querySelectorAll('[data-source]')) {
  input.addEventListener('change', () => {
    post('/api/display', { emoteSources: { [input.dataset.source]: input.checked } });
  });
}

// --- Setup guide, compact dock, status, links, data ---------------------------

/** Remembered in this browser only; a blocked storage just means the default. */
function stored(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // private window or blocked storage
  }
  return null;
}

/** Copies a text, and says so on the button for a moment. */
async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Without clipboard access (some docks): select the text so Ctrl+C works.
    window.prompt(tr('control.copyPrompt'), text);
    return;
  }
  const label = button.textContent;
  button.textContent = tr('control.copied');
  setTimeout(() => (button.textContent = label), 1500);
}

for (const button of document.querySelectorAll('[data-copy-overlay]')) {
  button.addEventListener('click', () => copyText(`${location.origin}/overlay/`, button));
}
$('copy-dock').addEventListener('click', (event) => copyText(`${location.origin}/control/?dock`, event.target));

/** The four setup steps, each ticked off when the game sees it done. */
function renderGuide() {
  const done = {
    channel: state.source.kind !== 'none',
    obs: state.guide.overlays > 0,
    layer: state.session.active,
    picture: Boolean(state.god.picture),
    test: state.guide.testBattleRun,
  };
  for (const [step, finished] of Object.entries(done)) $(`step-${step}`).classList.toggle('done', finished);
  const overlays = state.guide.overlays;
  $('step-obs-check').textContent = overlays > 0
    ? tr('control.guide.overlaysOpen', { count: overlays })
    : tr('control.guide.waiting');
  const all = Object.values(done).every(Boolean);
  $('guide-title').textContent = tr(all ? 'control.guide.allSet' : 'control.guide.title');
  $('guide-done').hidden = !all;
  $('guide').hidden = stored('guide-hidden') === '1';
  $('guide-layer').disabled = !done.channel || done.layer;
  $('guide-layer').hidden = done.layer;
  $('guide-test').disabled = !done.channel || state.battle !== null || state.endless.active;
  $('guide-test').hidden = done.test;
  const picture = $('guide-picture');
  if (state.god.picture && picture.getAttribute('src') !== state.god.picture) picture.src = state.god.picture;
  picture.hidden = !state.god.picture;
  picture.alt = tr('control.picture.alt');
  // Once there is a picture, the button is for changing it; the God tab can remove it.
  $('guide-picture-label').querySelector('span').textContent = tr(state.god.picture ? 'control.guide.pictureChange' : 'control.picture.choose');
}

$('guide-hide').addEventListener('click', () => {
  stored('guide-hidden', '1');
  $('guide').hidden = true;
});
$('guide-show').addEventListener('click', () => {
  stored('guide-hidden', null);
  if (state) renderGuide();
  selectTab($('tab-overview'));
});
$('guide-layer').addEventListener('click', () => post('/api/session', { active: true }));
$('guide-test').addEventListener('click', () => post('/api/test-battle', { sides: ['red', 'blue'] }));

// The compact layout: in a narrow OBS dock (or with ?dock in the address) only the main buttons show.
const QUICK = {
  layer: 'layer-toggle',
  war: 'war-start',
  'guild-clash': 'draft-guild',
  'hero-clash': 'clash-start',
  'free-for-all': 'draft-free',
  pachinko: 'draft-pachinko',
  'gods-wrath': 'god-wrath',
  'streamer-vs-chat': 'god-versus',
  'friendly-fight': 'god-friendly',
  endless: 'endless-toggle',
};
const params = new URLSearchParams(location.search);
const narrow = window.matchMedia('(max-width: 560px)');

function applyLayout() {
  const choice = stored('panel-layout');
  const compact = params.has('full') ? false : choice ? choice === 'compact' : params.has('dock') || narrow.matches;
  document.body.classList.toggle('compact', compact);
  $('dock').hidden = !compact;
  $('dock-back').hidden = compact || !(params.has('dock') || narrow.matches);
}
narrow.addEventListener('change', applyLayout);
$('dock-full').addEventListener('click', () => {
  stored('panel-layout', 'full');
  applyLayout();
});
$('dock-compact').addEventListener('click', () => {
  stored('panel-layout', null);
  applyLayout();
});
applyLayout();

/** The dock's buttons press the full panel's buttons, and are on or off with them. */
function renderDock() {
  for (const button of document.querySelectorAll('[data-quick]')) {
    const main = $(QUICK[button.dataset.quick]);
    button.disabled = main.disabled;
  }
  const layer = document.querySelector('[data-quick="layer"]');
  layer.querySelector('span').textContent = tr('control.dock.layer', { state: tr(state.session.active ? 'control.on' : 'control.off') });
  layer.classList.toggle('on', state.session.active);
  const endless = document.querySelector('[data-quick="endless"]');
  endless.querySelector('span').textContent = tr('control.dock.endless', { state: tr(state.endless.active ? 'control.on' : 'control.off') });
  endless.classList.toggle('on', state.endless.active);
}
for (const button of document.querySelectorAll('[data-quick]')) {
  button.addEventListener('click', () => $(QUICK[button.dataset.quick]).click());
}

/** The dock's buttons, by the runtime they show as a tooltip. */
const QUICK_RUNTIME = {
  war: 'war', 'guild-clash': 'guildClash', 'hero-clash': 'heroClash', 'free-for-all': 'freeForAll',
  pachinko: 'pachinko', 'gods-wrath': 'godsWrath', 'streamer-vs-chat': 'streamerVsChat', 'friendly-fight': 'friendly',
};

/** A runtime range in minutes, to the half minute: "about 4–5.5 min", or "about 2.5 min" when both ends meet. */
function runtimeText([shortest, longest]) {
  const minutes = (ms) => Math.max(0.5, Math.round(ms / 30_000) / 2);
  const number = new Intl.NumberFormat(document.documentElement.lang || 'en', { maximumFractionDigits: 1 });
  const low = minutes(shortest);
  const high = minutes(longest);
  const time = low === high ? number.format(low) : `${number.format(low)}–${number.format(high)}`;
  return tr('control.runtime', { time });
}

/** The expected runtime under each event, from the click until the overlay is free again. */
function renderRuntimes() {
  for (const line of document.querySelectorAll('[data-runtime]')) {
    const runtime = state.runtimes?.[line.dataset.runtime];
    line.textContent = runtime ? runtimeText(runtime) : '';
  }
  for (const button of document.querySelectorAll('[data-quick]')) {
    const runtime = state.runtimes?.[QUICK_RUNTIME[button.dataset.quick]];
    if (runtime) button.title = runtimeText(runtime);
  }
}

/** The update notice, chat announcements and the saved-game card. */
function renderExtras() {
  const version = state.version;
  const update = $('update');
  update.hidden = !version.latest;
  if (version.latest) {
    update.replaceChildren(`${tr('control.update.available', { version: version.latest.version, current: version.current })} `);
    const link = document.createElement('a');
    link.href = version.latest.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = tr('control.update.download');
    update.append(link);
    if (version.latest.notes) update.append(` · ${version.latest.notes}`);
  }

  // An overlay drawing without the graphics card stutters: say how to fix it, on every tab.
  $('no-gpu').hidden = !(state.guide.withoutGpu > 0);

  const announce = state.chatAnnounce;
  $('chat-announce').disabled = !announce.available;
  $('chat-announce').checked = announce.enabled;
  $('chat-announce-status').textContent = tr(announce.available ? 'control.announce.available' : 'control.announce.unavailable');

  const resettable = state.data.resettable;
  $('data-import').disabled = !resettable;
  $('data-import-label').classList.toggle('disabled', !resettable);
  $('reset-confirm').disabled = !resettable;
  $('reset-game').disabled = !resettable || $('reset-confirm').value.trim().toLowerCase() !== state.source.channel;
  $('data-status').textContent = resettable
    ? tr('control.data.kept', { channel: state.source.channel })
    : tr('control.data.none');
}

$('chat-announce').addEventListener('change', (event) => post('/api/settings', { chatAnnounce: event.target.checked }));

$('reset-confirm').addEventListener('input', () => {
  if (state) renderExtras();
});
$('reset-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state) return;
  const confirmText = $('reset-confirm').value.trim().toLowerCase();
  $('reset-game').disabled = true;
  await post('/api/database/reset', { confirm: confirmText });
  $('reset-confirm').value = '';
});

$('data-import').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || !state) return;
  const ok = confirm(tr('control.data.confirmImport', { channel: state.source.channel, file: file.name }));
  if (!ok) return;
  try {
    const response = await fetch('/api/database/import', { method: 'POST', body: file });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || tr('control.error.import', { status: response.status }));
    showError('');
  } catch (error) {
    showError(error.message);
  }
});

// --- Action links ----------------------------------------------------------------

/** The action links as last loaded, kept to redraw the table in another language. */
let actionLinks = null;

async function loadActions() {
  try {
    const response = await fetch('/api/actions');
    actionLinks = await response.json();
    renderActions();
  } catch {
    // Tried again on the next reload.
  }
}

/** One row per action link: what it does, its address, and a button to copy it. */
function renderActions() {
  if (!actionLinks) return;
  const { key, actions } = actionLinks;
  const body = $('actions').querySelector('tbody');
  body.replaceChildren();
  if (!key) return;
  for (const name of actions) {
    const link = `${location.origin}/api/action/${name}?key=${key}`;
    const row = document.createElement('tr');
    // Names the server added after this page was written have no words yet: show the name.
    const label = tr(`control.action.${name}`);
    cell(row, label === `control.action.${name}` ? name : label);
    const code = document.createElement('code');
    code.textContent = `/api/action/${name}`;
    const where = document.createElement('td');
    where.appendChild(code);
    row.appendChild(where);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = tr('control.actions.copyLink');
    copy.addEventListener('click', () => copyText(link, copy));
    const last = document.createElement('td');
    last.appendChild(copy);
    row.appendChild(last);
    body.appendChild(row);
  }
}

// --- Status tab ------------------------------------------------------------------

function facts(list, entries) {
  list.replaceChildren();
  for (const [label, value, warn] of entries) {
    const term = document.createElement('dt');
    term.textContent = label;
    const text = document.createElement('dd');
    text.textContent = value;
    if (warn) text.className = 'warn';
    list.append(term, text);
  }
}

const ago = (ms) => {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return tr('control.time.secondsAgo', { count: seconds });
  if (seconds < 3600) return tr('control.time.minutesAgo', { count: Math.round(seconds / 60) });
  return tr('control.time.hoursAgo', { count: Math.round(seconds / 3600) });
};
const bytes = (n) => (n >= 1024 * 1024 ? `${number(n / 1024 / 1024, 1)} MB` : `${Math.ceil(n / 1024)} KB`);
const duration = (ms) => {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 60
    ? tr('control.time.minutes', { minutes })
    : tr('control.time.hours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
};

/** The status as last loaded, kept to redraw the tab in another language. */
let lastStatus = null;

async function loadStatus() {
  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error(tr('control.error.status', { status: response.status }));
    lastStatus = await response.json();
    renderStatus(lastStatus);
  } catch (error) {
    showError(error.message);
  }
}

function renderStatus(status) {
  const chat = status.chat;
  const kinds = { irc: 'control.source.twitch', sim: 'control.status.simulator', none: 'control.status.noChannel' };
  const connected = chat.kind !== 'irc' || chat.status === 'joined';
  facts($('status-chat'), [
    [tr('control.status.source'), kinds[chat.kind] ? tr(kinds[chat.kind]) : chat.kind],
    ...(chat.channel ? [[tr('control.status.channel'), `#${chat.channel}`]] : []),
    [tr('control.status.connection'), sourceStatus(chat.status), !connected],
    [
      tr('control.status.messages'),
      chat.lastMessageAt
        ? tr('control.status.messagesLast', { count: chat.messages, ago: ago(chat.lastMessageAt) })
        : String(chat.messages),
    ],
    [
      tr('control.status.writing'),
      tr(chat.canSay ? (chat.announce ? 'control.status.writingOn' : 'control.status.writingOff') : 'control.status.writingNone'),
    ],
  ]);

  const overlays = status.overlays;
  $('status-overlays').hidden = overlays.length === 0;
  $('status-overlays-empty').hidden = overlays.length > 0;
  const body = $('status-overlays').querySelector('tbody');
  body.replaceChildren();
  for (const overlay of overlays) {
    const row = document.createElement('tr');
    cell(row, ago(overlay.connectedAt));
    if (overlay.reportedAt === null) {
      const waiting = cell(row, tr('control.status.waitingReport'));
      waiting.colSpan = 6;
    } else {
      const wrongSize = overlay.width !== 1920 || overlay.height !== 1080;
      const size = cell(row, tr(wrongSize ? 'control.status.wrongSize' : 'control.status.sizeValue', overlay));
      if (wrongSize) size.className = 'warn';
      cell(row, overlay.theme);
      const frame = cell(row, `${number(overlay.frameMs, 1)} ms`, 'num');
      if (overlay.frameMs > 16) frame.className = 'num warn';
      cell(row, `${overlay.slowMs.toFixed(0)} ms`, 'num');
      cell(row, overlay.fps.toFixed(0), 'num');
      const gpu = cell(row, tr(overlay.gpu === false ? 'control.status.gpuOff' : overlay.gpu ? 'control.yes' : 'control.status.gpuUnknown'));
      if (overlay.gpu === false) gpu.className = 'warn';
    }
    body.appendChild(row);
  }

  const emotes = $('status-emotes').querySelector('tbody');
  emotes.replaceChildren();
  const names = { bttv: 'BetterTTV', ffz: 'FrankerFaceZ', '7tv': '7TV' };
  for (const source of status.emotes) {
    const row = document.createElement('tr');
    cell(row, names[source.source] || source.source);
    const reach = cell(
      row,
      tr(source.reachable === null ? 'control.status.notTried' : source.reachable ? 'control.yes' : 'control.no'),
    );
    if (source.reachable === false) reach.className = 'warn';
    cell(row, source.global, 'num');
    cell(row, source.channel, 'num');
    emotes.appendChild(row);
  }

  const db = status.database;
  facts($('status-program'), [
    [tr('control.status.version'), status.version.current || tr('control.status.unknown')],
    ...(status.version.latest ? [[tr('control.status.newer'), status.version.latest.version, true]] : []),
    ['Node.js', status.node],
    [tr('control.status.uptime'), duration(status.uptimeMs)],
    [tr('control.status.panels'), String(status.controlPanels)],
    [tr('control.status.running'), status.running || tr('control.status.nothing')],
    // Over 50 ms the server misses a battle step: that shows on the overlay as a stutter.
    [tr('control.status.serverPause'), tr('control.status.serverPauseValue', { ms: Math.round(status.serverPauseMs) }), status.serverPauseMs > 50],
    [tr('control.status.database'), db ? `${bytes(db.bytes + db.walBytes)} · ${db.path}` : tr('control.status.inMemory')],
  ]);
}

function watchStatus() {
  const open = !$('panel-status').hidden;
  if (open && !statusTimer) {
    loadStatus();
    statusTimer = setInterval(loadStatus, 3000);
  } else if (!open && statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
}

// --- Language ----------------------------------------------------------------------

/** The language choice in the Settings tab: every language there is a file for. */
function renderLanguage() {
  const select = $('language-select');
  const { languages, language } = state.display;
  const ids = languages.map((entry) => entry.id).join(',');
  if (select.dataset.ids !== ids) {
    select.replaceChildren(...languages.map((entry) => new Option(entry.name, entry.id)));
    select.dataset.ids = ids;
  }
  if (document.activeElement !== select) select.value = language;
  const pinned = I18n.pinned && languages.find((entry) => entry.id === I18n.pinned);
  $('language-note').textContent = pinned
    ? tr('control.language.pinned', { language: pinned.name })
    : tr('control.language.note');
}

/**
 * Another language arrived: put the page's fixed text into it, and rebuild what
 * was built once from the server's words (tuning, skills), which the server now
 * writes in the new language too.
 */
I18n.onChange(() => {
  document.title = tr('control.title');
  I18n.translatePage();
  renderActions();
  if (state) render(state);
  if (lastStatus) renderStatus(lastStatus);
});

// The first text waits for the language file, so the panel does not start in English and then switch.
I18n.ready.then(() => {
  document.title = tr('control.title');
  I18n.translatePage();
  loadActions();
  connect();
});
