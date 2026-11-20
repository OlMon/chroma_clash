# Chroma Clash

A free Twitch chat overlay game. Chatters join one of three guilds by their
**name colour**, and just by chatting they grow their guild's land on a hex map
and build its Monument. When the streamer wants action, a battle starts and the
chatters' fighters clash on screen, fully automatic. The streamer takes part as
the god of the map. Nobody types a command.

**Website:** https://olmon.gitlab.io/chroma_clash/

## Download and play

Get the latest version from the [Releases](https://github.com/OlMon/chroma_clash/releases)
page, unpack it, and start `chroma-clash.exe` (Windows) or `./chroma-clash`
(Linux). Your browser opens the control panel with a short setup guide;
`START.txt` in the download explains the rest, including what to do when
Windows SmartScreen warns about the unsigned file.

The game runs entirely on your computer. It reads your chat anonymously and
needs no account, no bot and no server.

## Feedback and bugs

Please open an [issue](https://github.com/OlMon/chroma_clash/issues): what
happened, what you expected, and if you can a screenshot of the overlay or the
console window. Ideas are welcome too.

## Development

Needs Node.js 26 or newer.

```sh
npm install
npm start -- --sim          # the game with a simulated chat
npm start -- --channel name # the game reading a real Twitch chat
npm test                    # the tests
npm run typecheck           # TypeScript checks
npm run preview             # pictures of every overlay scene in every theme
npm run release             # the packaged build for this platform
npm run release -- --target win-x64   # the Windows build, made on Linux
```

How the game works is described in [SPEC.md](SPEC.md); what comes next in
[IMPROVEMENTS.md](IMPROVEMENTS.md). Balancing aids live in `src/cli/`
(`balance.ts`, `fight-durations.ts`, `season-pace.ts`).

### Releases

Pushing a version tag (`git tag v0.1.0 && git push origin v0.1.0`) builds the
Windows and Linux downloads on GitHub and attaches them to a release (see
`.github/workflows/release.yml`). Raise `version` in `package.json` first.

## Thanks

Chroma Clash was inspired by [Intro Fighters](https://lexone.itch.io/introfighters)
by [Lexone](https://lexone.itch.io/): chat's emotes tumbling across a "be right
back" screen is what started this project. Thank you.

## Licence

Copyright (C) 2026 OlMon.

Chroma Clash is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. It is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.

You may use it on any stream, monetized or not. The downloads also contain
software and fonts by others under their own licences (Node.js and ws under
MIT, Jersey 10 and Pirata One under the SIL Open Font License); see
`THIRD-PARTY-NOTICES.txt` in each download.
