/** One parsed IRC line (IRCv3 message tags, optional prefix, command, params). */
export interface IrcMessage {
  raw: string;
  tags: Record<string, string>;
  /** Full source, e.g. `ronni!ronni@ronni.tmi.twitch.tv` or `tmi.twitch.tv`. */
  prefix: string | null;
  /** The part of the prefix before `!`, or null if the source is a server. */
  nick: string | null;
  command: string;
  params: string[];
}

const TAG_ESCAPES: Record<string, string> = {
  ':': ';',
  s: ' ',
  '\\': '\\',
  r: '\r',
  n: '\n',
};

/** Unescapes an IRCv3 tag value. An unknown escape yields the character itself. */
export function unescapeTagValue(value: string): string {
  if (!value.includes('\\')) return value;
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = value[i + 1];
    if (next === undefined) break; // a trailing lone backslash is dropped
    out += TAG_ESCAPES[next] ?? next;
    i++;
  }
  return out;
}

export function parseTags(section: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of section.split(';')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    if (eq === -1) {
      tags[part] = '';
    } else {
      tags[part.slice(0, eq)] = unescapeTagValue(part.slice(eq + 1));
    }
  }
  return tags;
}

/** Parses one IRC line without its line ending. Returns null for empty or malformed lines. */
export function parseLine(line: string): IrcMessage | null {
  const raw = line.replace(/[\r\n]+$/, '');
  let rest = raw;
  let tags: Record<string, string> = {};
  let prefix: string | null = null;

  if (rest.startsWith('@')) {
    const end = rest.indexOf(' ');
    if (end === -1) return null;
    tags = parseTags(rest.slice(1, end));
    rest = rest.slice(end + 1).trimStart();
  }

  if (rest.startsWith(':')) {
    const end = rest.indexOf(' ');
    if (end === -1) return null;
    prefix = rest.slice(1, end);
    rest = rest.slice(end + 1).trimStart();
  }

  const params: string[] = [];
  let command = '';
  while (rest.length > 0) {
    if (command !== '' && rest.startsWith(':')) {
      params.push(rest.slice(1));
      break;
    }
    const end = rest.indexOf(' ');
    const word = end === -1 ? rest : rest.slice(0, end);
    if (command === '') command = word.toUpperCase();
    else params.push(word);
    rest = end === -1 ? '' : rest.slice(end + 1).trimStart();
  }

  if (command === '') return null;

  let nick: string | null = null;
  if (prefix !== null) {
    const bang = prefix.indexOf('!');
    if (bang !== -1) nick = prefix.slice(0, bang);
  }

  return { raw, tags, prefix, nick, command, params };
}
