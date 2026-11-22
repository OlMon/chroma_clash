/**
 * Builds the packaged release for the platform this runs on, or for Windows
 * from Linux:
 *
 *   npm run release [-- --notes "What's new"] [-- --url <download page>] [-- --node <node binary>]
 *   npm run release -- --target win-x64      (a Windows build, made on Linux)
 *
 * Produces dist/chroma-clash-<version>-<platform>-<arch>/ with a single executable
 * (Node.js single executable application: the official Node binary plus the game
 * bundled into one script), the overlay/, control/ and lang/ folders it serves, and
 * START.txt; then an archive of that folder next to it (.tar.gz on Linux, .zip on
 * Windows and macOS). Also writes website/version.json for the update notice.
 *
 * The executable is built from the official nodejs.org binary of the running Node
 * version (downloaded once into dist/.cache and checked against SHASUMS256.txt),
 * because a distribution's own node (Arch, Homebrew, …) links system libraries
 * that other computers do not have. `--node <path>` uses that binary instead, which
 * must be the same Node version as the one running this script.
 *
 * Other platforms: run this script on that operating system and architecture
 * (Windows x64, macOS arm64, Linux x64, …), for example in a CI job per platform
 * with the same Node version. Building on the target system keeps it simple:
 * the right Node binary is fetched, the archive format fits, and macOS
 * executables get signed (ad hoc), which Apple silicon requires. Windows is
 * the exception: `--target win-x64` builds it from Linux with the official
 * node.exe (Node's single-executable builder writes Windows executables too),
 * zipped with `zip`. The executable is not code-signed: SmartScreen warns
 * once ("More info", "Run anyway").
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const { values: options } = parseArgs({
  options: {
    notes: { type: 'string' },
    url: { type: 'string' },
    node: { type: 'string' },
    /** Another platform to build for: only `win-x64` (from Linux or macOS). */
    target: { type: 'string' },
  },
});
if (options.target && options.target !== 'win-x64') throw new Error(`--target ${options.target}: only win-x64 can be built from here`);

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { version } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string };
/** Building for Windows: on Windows, or with --target win-x64 elsewhere. */
const isWindows = process.platform === 'win32' || options.target === 'win-x64';
const crossBuild = options.target === 'win-x64' && process.platform !== 'win32';
const isMac = !isWindows && process.platform === 'darwin';
const arch = crossBuild ? 'x64' : process.arch;
const platformName = isWindows ? 'windows' : isMac ? 'macos' : process.platform;
const name = `chroma-clash-${version}-${platformName}-${arch}`;
const dist = join(repo, 'dist');
const out = join(dist, name);
const work = join(dist, '.build');
const cache = join(dist, '.cache');
const exeName = isWindows ? 'chroma-clash.exe' : 'chroma-clash';

function step(text: string): void {
  console.log(`\n> ${text}`);
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function download(url: string, file: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

/** The official Node binary of the running version for this platform, cached in dist/.cache. */
async function officialNode(): Promise<string> {
  const base = `https://nodejs.org/dist/${process.version}`;
  const nodeOs = isWindows ? 'win' : isMac ? 'darwin' : process.platform;
  const target = join(cache, `node-${process.version}-${nodeOs}-${arch}${isWindows ? '.exe' : ''}`);
  if (existsSync(target)) return target;
  mkdirSync(cache, { recursive: true });
  // Windows has a plain node.exe to download; elsewhere it is bin/node inside the tarball.
  const remote = isWindows ? `${nodeOs}-${arch}/node.exe` : `node-${process.version}-${nodeOs}-${arch}.tar.gz`;
  const downloaded = join(cache, remote.replace('/', '-'));
  console.log(`  downloading ${base}/${remote}`);
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = sums.split('\n').find((line) => line.trim().endsWith(`  ${remote}`))?.split(/\s+/)[0];
  if (!expected) throw new Error(`${remote} is not listed in ${base}/SHASUMS256.txt`);
  await download(`${base}/${remote}`, downloaded);
  if (sha256(downloaded) !== expected) throw new Error(`${remote}: checksum mismatch`);
  if (isWindows) {
    cpSync(downloaded, target);
  } else {
    const inner = `node-${process.version}-${nodeOs}-${arch}/bin/node`;
    const unpacked = join(cache, 'unpacked');
    rmSync(unpacked, { recursive: true, force: true });
    mkdirSync(unpacked);
    execFileSync('tar', ['-xzf', downloaded, '-C', unpacked, inner]);
    cpSync(join(unpacked, inner), target);
    chmodSync(target, 0o755);
    rmSync(unpacked, { recursive: true, force: true });
  }
  rmSync(downloaded, { force: true });
  return target;
}

/** Node.js's licence for the running version (it covers the Node runtime inside the executable), cached in dist/.cache. */
async function nodeLicense(): Promise<string> {
  const file = join(cache, `node-${process.version}-LICENSE`);
  if (!existsSync(file)) {
    mkdirSync(cache, { recursive: true });
    await download(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, file);
  }
  return readFileSync(file, 'utf8');
}

/**
 * The notices of what the download contains from others: Node.js inside the
 * executable, the ws package bundled into it, and the themes' fonts.
 */
async function thirdPartyNotices(): Promise<string> {
  const rule = '='.repeat(78);
  const section = (title: string, text: string) => `${rule}\n${title}\n${rule}\n\n${text.trim()}\n\n`;
  const ws = JSON.parse(readFileSync(join(repo, 'node_modules', 'ws', 'package.json'), 'utf8')) as { version: string };
  return (
    `Chroma Clash ${version} contains the following software and fonts by others,\n` +
    `each under its own licence. Chroma Clash itself is under the GNU General\n` +
    `Public License, version 3 or later: see LICENSE.\n\n` +
    section(`Node.js ${process.version} (the runtime inside ${exeName})`, await nodeLicense()) +
    section(`ws ${ws.version} (bundled into ${exeName})`, readFileSync(join(repo, 'node_modules', 'ws', 'LICENSE'), 'utf8')) +
    section('Jersey 10 font (overlay/themes/pixel/)', readFileSync(join(repo, 'overlay', 'themes', 'pixel', 'OFL.txt'), 'utf8')) +
    section('Pirata One font (overlay/themes/comic/)', readFileSync(join(repo, 'overlay', 'themes', 'comic', 'OFL.txt'), 'utf8'))
  );
}

function megabytes(file: string): string {
  return `${(statSync(file).size / 1024 / 1024).toFixed(1)} MB`;
}

/** How to start the game, for the platform this build is for; Windows with its warnings. */
function startSteps(): string {
  const keepOpen = `  Your browser opens the control panel. Keep the window open while you stream;
  closing it (or Ctrl+C) stops the game.
`;
  if (isWindows) {
    return `START
  Double-click ${exeName}.
${keepOpen}
WINDOWS WARNINGS
  Chroma Clash is new and not signed with a paid code-signing certificate, so
  Windows may make a fuss the first time:
  - SmartScreen: "Windows protected your PC". Click "More info", then
    "Run anyway". It asks only once.
  - Your antivirus (Defender or another) may hold the file back or move it to
    quarantine. Allow ${exeName} (in Defender: Windows Security >
    Virus & threat protection > Protection history > the entry > Allow), or
    unpack the download again.
  The game runs only on your computer. It talks to Twitch chat and the emote
  sites (BetterTTV, FrankerFaceZ, 7TV), and asks the website whether a new
  version is out; nothing else.
`;
  }
  if (isMac) {
    return `START
  Double-click ${exeName}; it opens in Terminal.
  If macOS refuses an unknown developer: right-click it, "Open", "Open";
  or in Terminal: xattr -d com.apple.quarantine ${exeName}
${keepOpen}`;
  }
  return `START
  In a terminal in this folder: ./${exeName}
${keepOpen}`;
}

/** The starter for the simulated chat, beside the executable: its file name and contents for this platform. */
const simStarter = isWindows
  ? {
      file: 'chroma-clash-simulated-chat.cmd',
      content: `@echo off
rem Starts Chroma Clash with a simulated chat of made-up chatters: try everything
rem offline, no Twitch needed. Your real channel and game are not touched; the
rem simulation keeps its own save (data\\sim-simchannel.sqlite).
cd /d "%~dp0"
"%~dp0${exeName}" --sim %*
`,
    }
  : {
      file: `chroma-clash-simulated-chat.${isMac ? 'command' : 'sh'}`,
      content: `#!/bin/sh
# Starts Chroma Clash with a simulated chat of made-up chatters: try everything
# offline, no Twitch needed. Your real channel and game are not touched; the
# simulation keeps its own save (data/sim-simchannel.sqlite).
cd "$(dirname "$0")" && exec ./${exeName} --sim "$@"
`,
    };

const START_TXT = `Chroma Clash ${version}
${'='.repeat(`Chroma Clash ${version}`.length)}

A game for your Twitch chat: every chatter joins a guild by their name color and
fights for the map on your stream overlay. Nothing to install.

${startSteps()}
FIRST TIME
  1. In the control panel, enter your Twitch channel name.
  2. In OBS add a "Browser" source:
       URL     http://localhost:4747/overlay/
       Size    1920 x 1080
     Keep OBS's browser sources on the graphics card, or battles stutter:
       Settings > Advanced > Sources > Enable Browser Source Hardware Acceleration
     (on by default; the control panel warns when it is off).
  3. That's it: once your channel is in, "Chat plays" is on, and it is on
     again every time you start the game. Chatting counts and the map shows
     on the overlay. Pause it in the control panel if a stream should not count.
     Control panel: http://localhost:4747/control/

TRY IT WITHOUT TWITCH
  ${isWindows || isMac ? 'Double-click' : 'In a terminal in this folder:'} ${isWindows || isMac ? '' : './'}${simStarter.file}
  It starts the game with a simulated chat instead: about 60 made-up chatters
  write, join guilds and fight, so you can try every button, the overlay and
  OBS before going live, even offline. It keeps its own save, so your real
  game is not touched. Run one at a time: close the game's window before
  starting the simulation, and the other way round.${
    isWindows ? '\n  Windows may ask whether to run it the first time; click "Run".' : ''
  }

YOUR DATA
  Everything the game remembers is in the data/ folder next to ${exeName}.
  To update, unpack the new version and copy your data/ folder into it
  (or unpack the new version over this folder).

LICENCE AND SOURCE CODE
  Chroma Clash is free software: you may use it on any stream, share it, and
  change it under the GNU General Public License, version 3 or later (see
  LICENSE.txt). It comes with no warranty. The source code, downloads and the
  place for bug reports and ideas: https://github.com/OlMon/chroma_clash
  What it contains from others (Node.js, ws, two fonts): THIRD-PARTY-NOTICES.txt

OPTIONS (from a terminal)
  --port 4747          another port, if 4747 is taken
  --data <folder>      keep the data somewhere else
  --channel <name>     read this channel
  --no-open            do not open the browser
`;

step(`Chroma Clash ${version} for ${platformName}-${arch} (Node ${process.version})${crossBuild ? ', built on ' + process.platform : ''}`);
rmSync(out, { recursive: true, force: true });
rmSync(work, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });

step('bundling src/main.ts and its packages into one script');
const bundle = join(work, 'main.mjs');
await build({
  entryPoints: [join(repo, 'src', 'main.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: `node${process.versions.node.split('.')[0]}`,
  // ws loads these native speed-ups if present and works without them.
  external: ['bufferutil', 'utf-8-validate'],
  // Packages written as CommonJS (ws) call require(); an ES module has none of its own.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  legalComments: 'inline',
  logLevel: 'warning',
});
console.log(`  ${megabytes(bundle)}`);

step('building the executable');
const baseNode = options.node ?? (await officialNode());
console.log(`  from ${baseNode}`);
const exe = join(out, exeName);
const seaConfig = join(work, 'sea-config.json');
writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: bundle,
      mainFormat: 'module',
      executable: baseNode,
      output: exe,
      disableExperimentalSEAWarning: true,
      // node:sqlite still prints an experimental warning on some Node versions.
      execArgv: ['--disable-warning=ExperimentalWarning'],
    },
    null,
    2,
  ),
);
execFileSync(process.execPath, ['--build-sea', seaConfig], { stdio: 'inherit' });
if (isMac) execFileSync('codesign', ['--sign', '-', '--force', exe], { stdio: 'inherit' });
console.log(`  ${exeName}: ${megabytes(exe)}`);

step('copying overlay/, control/, lang/, START.txt, the simulated-chat starter, LICENSE and THIRD-PARTY-NOTICES.txt');
for (const folder of ['overlay', 'control', 'lang']) cpSync(join(repo, folder), join(out, folder), { recursive: true });
const text = (content: string) => (isWindows ? content.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n') : content);
writeFileSync(join(out, 'START.txt'), text(START_TXT));
writeFileSync(join(out, simStarter.file), text(simStarter.content));
if (!isWindows) chmodSync(join(out, simStarter.file), 0o755);
writeFileSync(join(out, 'LICENSE.txt'), text(readFileSync(join(repo, 'LICENSE'), 'utf8')));
writeFileSync(join(out, 'THIRD-PARTY-NOTICES.txt'), text(await thirdPartyNotices()));
rmSync(work, { recursive: true, force: true });

step('packing');
let archive: string | null = join(dist, `${name}${isWindows || isMac ? '.zip' : '.tar.gz'}`);
rmSync(archive, { force: true });
try {
  if (isMac) execFileSync('ditto', ['-c', '-k', '--keepParent', out, archive]);
  // Built elsewhere for Windows: zip, from inside dist/ so the folder is the archive's top level.
  else if (crossBuild) execFileSync('zip', ['-r', '-q', '-X', archive, name], { cwd: dist });
  // Windows 10 and newer ship bsdtar, which writes zip files with -a.
  else if (isWindows) execFileSync('tar', ['-a', '-c', '-f', archive, '-C', dist, name]);
  else execFileSync('tar', ['-czf', archive, '-C', dist, name]);
  console.log(`  ${archive}: ${megabytes(archive)}`);
} catch (error) {
  console.warn(`  no archive (${(error as Error).message.split('\n')[0]}); the folder is ready to zip by hand`);
  archive = null;
}

step('website/version.json');
const versionFile = join(repo, 'website', 'version.json');
let previous: { version?: string; url?: string; notes?: string } = {};
try {
  previous = JSON.parse(readFileSync(versionFile, 'utf8'));
} catch {
  // First release: no file yet.
}
const info: { version: string; url: string; notes?: string } = {
  version,
  // Relative to version.json: the website's getting-started section.
  url: options.url ?? previous.url ?? './#start',
};
const notes = options.notes ?? (previous.version === version ? previous.notes : undefined);
if (notes) info.notes = notes;
writeFileSync(versionFile, `${JSON.stringify(info, null, 2)}\n`);
console.log(`  ${JSON.stringify(info)}`);

console.log(`\nDone: ${out}${archive ? `\n      ${archive}` : ''}`);
