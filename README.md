# Paseo Control

A Stream Deck + plugin for macOS that shows the agents of a local
[Paseo](https://paseo.sh) installation on the device's keys and dials, and
opens the agent shown on a key in Paseo with one press.

> **Early test release.** This is a small personal project, not an Elgato
> Marketplace plugin. It has been used on one Mac with one Stream Deck +.
> See [Limitations](#limitations).

Paseo Control only reads agent state. It never sends messages to agents,
never stops them and never approves permissions.

## Requirements

- macOS 12 or later and the Stream Deck app 7.1 or later (from the plugin
  manifest); the plugin runs on the Node.js 24 runtime of the Stream Deck app.
- A Stream Deck + (eight keys and four dials with a touch strip).
- Paseo with its daemon running on the same Mac, **without a password**.
  The plugin is built with the Paseo client libraries 0.15.4; the version of
  the Paseo daemon it was used with has not been recorded, so which daemon
  versions work is not known.

## Install

1. Download `local.paseocontrol.e1spike.streamDeckPlugin` and `SHA256SUMS`
   from the release.
2. Check the download: `shasum -a 256 -c SHA256SUMS`.
3. Double-click the `.streamDeckPlugin` file; the Stream Deck app installs it.

Installing over an earlier version without removing it first has not been
verified.

## Set up

Place the actions of the **Paseo Control** category:

| Where          | Action              |
| -------------- | ------------------- |
| all eight keys | `Paseo agent`       |
| a dial         | `Paseo project`     |
| a dial         | `Paseo agent pages` |
| a dial         | `Paseo usage`       |
| a dial         | `Paseo attention`   |

- **Connection:** the address of the Paseo daemon is set once, in the
  "Paseo connection" section of any action's Property Inspector (Save); it
  applies to all actions. Only a local address is accepted. The plugin uses,
  in this order: an address saved this way; otherwise the address in a
  configuration file left by earlier test builds, if one exists; otherwise
  the default `ws://127.0.0.1:6767/ws`. The default is used only when the
  plugin's settings could be read and no address is set anywhere. If the
  settings cannot be read, or nothing is saved and that file cannot be read
  or is invalid, the keys show the problem instead of falling back.
- **Project dial:** turn to preview a project, press to show the agents of
  all its workspaces on the keys. This choice is temporary.
- **Start in:** the project a Project dial starts with is chosen in its
  Property Inspector; it is kept after a restart.
- **Agent pages:** turn to page through the keys, eight agents per page;
  press for page 1.
- **Usage:** account usage reported by Paseo (quota windows and balances).
- **Attention:** agents that wait for an answer, an approval or have an
  error; press to open the shown agent.
- **Keys:** each key shows an agent's status, title and project; a press
  opens exactly the agent drawn on that key.

## Limitations

- Only the first 200 agents of the daemon are seen.
- Only a local daemon without a password is supported.
- The interface is in English only.
- Tested on one Mac and one Stream Deck +; other macOS, Stream Deck app and
  Paseo versions are untested.
- Advanced connection cases (switching to another daemon, a daemon that
  stops answering, reconnects) are covered by automated tests with simulated
  components, not on a device.

## Privacy

The plugin communicates with the Stream Deck app (through the Stream Deck
SDK's local connection) and with the local Paseo daemon at the configured
address. Opening an agent hands a `paseo://` link to macOS (`/usr/bin/open`),
which opens it in the Paseo app. The plugin sends no telemetry. The plugin's
own log entries are fixed codes and states (for example `link: connected`),
plus the Node.js version and platform at start; they contain no agent names,
titles, messages or paths. The Paseo client library's own logging is reduced
to log levels. What the Stream Deck app itself logs is outside the plugin's
control.

## Build from source

Requires Node.js 24 (see `.nvmrc`) and npm.

```sh
npm ci
npm run check   # typecheck, lint, format, tests and the .streamDeckPlugin in release/
```

To assemble a release the same way the published one is made:

```sh
npm run release:assemble -- [ref] [out]
```

It exports the committed `ref` (default `HEAD`; uncommitted changes are not
included) into `out/source`, scans it, runs `npm ci` and `npm run check` on a
copy in a temporary folder, and writes only the plugin and `SHA256SUMS` to
`out/publish` (default `out`: `release/assembly-<commit>`). The source files
and the packaged files are listed with their SHA-256 in
`out/source-contents.txt` and `out/package-contents.txt`. The
`.streamDeckPlugin` archive is not reproducible bit for bit, because its ZIP
metadata differs between runs; compare `package-contents.txt` instead.
`npm run release:stage -- [ref] [target]` only exports and scans the source.

`npm run deps:audit` checks dependencies (needs network). The optional
secret-scanning hook (`npm run hooks:install`) downloads a pinned Gitleaks
binary and verifies its checksum.

## Third-party software

The plugin bundles third-party npm packages; their notices are in
[`THIRD_PARTY_NOTICES.txt`](THIRD_PARTY_NOTICES.txt).

## Not affiliated

Paseo Control is an independent project. It is not made, endorsed or
supported by Elgato or Corsair or by the makers of Paseo. Stream Deck is a
trademark of Corsair Memory Inc.

## License

MIT, see [`LICENSE`](LICENSE). Copyright (c) 2026 Nikola Micic. The bundled
third-party packages keep their own licenses; see
[`THIRD_PARTY_NOTICES.txt`](THIRD_PARTY_NOTICES.txt).

## Support

Questions and bug reports: please open an issue in this repository's
[issue tracker](https://github.com/nikolaamicic/paseo-streamdeck/issues).
This is a personal project; there is no guaranteed response time.
