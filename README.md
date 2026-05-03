# Hayase (nickEatsBread fork)

Personal fork of [hayase-app](https://github.com/hayase-app), consolidated into a single pnpm workspace, with a few additions on top of upstream:

- **Debrid streaming** — Real-Debrid, AllDebrid, Premiumize and TorBox. Configure in **Settings → Client → Debrid** (the section is injected into hayase.app's existing settings page on the fly). When a provider is set, every torrent is resolved via the debrid CDN through a localhost HTTP proxy — no peer-to-peer activity, no upload, no torrenting at all.
- **Discord RPC master toggle** — full enable/disable switch in **Settings → Interface → Rich Presence Settings**, restoring a feature upstream removed (the old "Show Details" sub-toggle is still there and gets greyed out when the master is off).
- **Bundled DTS-enabled ffmpeg.dll** — `electron/resources/proprietary-ffmpeg-win32-x64.dll` (4.5 MB) ships H.264, H.265, AAC, AC-3, E-AC-3, MP3, Opus, FLAC, Vorbis, TrueHD **and DTS / DTS-HD** support, so Blu-ray rips with DTS audio actually play. The afterPack hook automatically swaps it into every packaged build.
- **Patched Electron with proprietary codecs in the Chromium media stack** — stock Electron has `proprietary_codecs=false` baked in, which excludes AC3/EAC3/HEVC from Chromium's HTML5 audio/video allowlist (`media/filters/ffmpeg_glue.cc::kAllowedDecoders`, `media/base/supported_types.cc::IsAudioCodecProprietary()`). Replacement ffmpeg.dlls don't help because the allowlist is checked **before** ffmpeg ever sees the codec. Building Chromium from source with the right GN args takes 4-8 hours and 500 GB. Instead, `pnpm electron:patch` extracts the already-patched Electron binary that upstream Hayase ships in their installer (built from [ThaUnknown/electron-chromium-codecs](https://github.com/ThaUnknown/electron-chromium-codecs)) and swaps it into `node_modules/electron/dist/`. The build pipeline then packages this patched Electron via `electronDist` in `electron-builder.yml`. Result: EAC3/AC3/DTS audio plays natively in `<video>` elements — no more relying on the experimental mediabunny WASM fallback.
- **Speed-only player stats bar in debrid mode** — peer count and upload speed are hidden via injected CSS while debrid is streaming, since they're meaningless when the bytes come from a CDN.

The main UI itself is loaded from `https://hayase.app/` (matching upstream) so animetosho, MAL linking, YouTube hover trailers and everything else continue to work as upstream intends. The fork's settings panels are injected into the live page via `webContents.executeJavaScript` from the main process — no separate UI is bundled.

## Layout

```
hayase/
├── electron/                  Electron desktop wrapper
│   ├── src/main/
│   │   ├── app.ts             BrowserWindow setup + injected settings + tray
│   │   ├── extras-window.ts   Standalone "Hayase+ Extras" window (fallback UI)
│   │   ├── ipc.ts             RPC + extras IPC methods
│   │   ├── store.ts           electron-store with `extras` field for our settings
│   │   └── ...
│   ├── src/preload/
│   │   ├── index.ts           Main preload — exposes our IPC on window.native
│   │   └── extras.ts          Preload for the extras window
│   ├── scripts/after-pack.mjs electron-builder hook (swaps ffmpeg.dll)
│   ├── resources/
│   │   └── proprietary-ffmpeg-win32-x64.dll   DTS-enabled, ~4.5 MB
│   ├── electron-builder.yml   Publishes releases to nickEatsBread/hayase
│   └── dev-app-update.yml     Same — autoupdater hits this fork's releases
├── interface/                 SvelteKit UI (used in dev only — production
│                              loads https://hayase.app/ directly)
├── torrent-client/            WebTorrent + debrid module
│   ├── debrid/
│   │   ├── providers/         Real-Debrid / AllDebrid / Premiumize / TorBox
│   │   ├── types.ts
│   │   └── index.ts           checkAuth, createProvider, resolveDebrid
│   ├── attachments.ts         MKV parser — extended with debrid registration
│   └── index.ts               TorrentClient — _playDebrid + localhost proxy
├── native/                    Shared IPC type schema
├── wiki/                      Upstream documentation (untouched)
├── capacitor/, free-torrents/ Other upstream packages
├── scripts/
│   ├── install-codecs.mjs     Download + swap proprietary ffmpeg into
│   │                          node_modules/electron/dist (for dev)
│   ├── install-patched-electron.mjs
│   │                          Download upstream Hayase installer + extract
│   │                          patched electron.exe (proprietary_codecs=true
│   │                          Chromium media stack — enables AC3/EAC3/HEVC
│   │                          natively) into node_modules/electron/dist
│   ├── setup-remotes.sh       Register hayase-app upstreams as remotes
│   └── sync-upstream.sh       Pull updates from a single upstream
├── pnpm-workspace.yaml
└── .npmrc                     shamefully-hoist=true (upstream requirement)
```

## How the debrid integration works

1. User picks a provider + pastes API key in **Settings → Client → Debrid**. The injected JS calls `window.native.setExtras(...)` which persists into electron-store and immediately pushes the new debrid config to the torrent process.
2. On torrent playback, `TorrentClient.playTorrent` short-circuits to `_playDebrid` whenever a provider is configured. `_playDebrid`:
   - Submits the magnet/hash to the debrid provider's API
   - Polls until the torrent is "ready" on their side
   - Spins up a localhost HTTP proxy (lazily, on first use)
   - Returns `http://localhost:<port>/<base64url-encoded-cdn-url>/<filename>` URLs to the player
3. The localhost proxy forwards range requests to the debrid CDN with a clean Chrome User-Agent and rewrites the response:
   - `Content-Type: application/force-download` → real `video/x-matroska` (etc.)
   - Adds `Access-Control-Allow-Origin: *` + full CORS headers + preflight handling
   - Strips `Content-Disposition: attachment`
   - Passes through `Content-Range`, `Content-Length`, `Accept-Ranges`
4. The proxy also tees the initial sequential stream through `matroska-metadata.parseStream`, so the player's audio track / subtitle track / chapter / font (attachment) UI works exactly the same as it does for WebTorrent playback.
5. Bytes flowing through the proxy are counted — the player stats bar shows actual debrid throughput in real time.

This pattern (localhost proxy with rewritten headers) is what Stremio's Real-Debrid plugin uses too. We need it because Hayase's player is mediabunny-based and uses `fetch(mode: 'cors')` + MediaSource Extensions — direct fetches against debrid CDNs always fail with `ERR_FAILED` due to missing CORS headers, regardless of any webRequest header rewrites.

## Setup

Requires Node 20+ and pnpm.

```bash
git clone https://github.com/nickEatsBread/hayase.git
cd hayase
pnpm install

# install proprietary codecs into node_modules/electron/dist for `pnpm dev`
# (auto-prefers electron/resources/proprietary-ffmpeg-win32-x64.dll, which
# includes DTS — falls back to the official Electron release otherwise)
pnpm codecs:install

# REQUIRED for native EAC3/AC3 playback: extract upstream Hayase's
# patched Electron (with proprietary_codecs=true Chromium media stack)
# and substitute it into node_modules/electron/dist. Downloads the
# upstream installer (~90 MB) and replaces electron.exe + ffmpeg.dll +
# friends. Re-run after every `pnpm install` since pnpm's electron
# postinstall re-downloads stock binaries.
pnpm electron:patch

# register hayase-app upstream remotes for syncing
bash scripts/setup-remotes.sh
```

## Run from source

Two-terminal workflow for development against your local interface:

```bash
# terminal 1 — interface dev server on :7344
pnpm dev:interface

# terminal 2 — electron, points at localhost:7344 in dev mode
pnpm dev:electron
```

`pnpm dev:electron` runs against `https://hayase.app/` if the `interface` dev server isn't up — the override goes via the `is.dev` check in `electron/src/main/app.ts`. You can also force a specific URL with the `HAYASE_BASE_URL` env var.

## Build a Windows installer

```bash
pnpm --filter hayase build:win
```

The chain: `electron-vite build` → `electron-builder --win` (uses the patched Electron from `node_modules/electron/dist/` via the `electronDist` config — make sure `pnpm electron:patch` has been run!) → afterPack hook (swaps in the DTS-enabled ffmpeg from `electron/resources/` as belt-and-suspenders, even though the patched Electron already has it) → NSIS package. Output lands in `electron/dist/`:

| File | Size | What it is |
|---|---|---|
| `win-hayase-X.Y.Z-installer.exe` | ~90 MB | NSIS installer |
| `win-hayase-X.Y.Z-installer.exe.blockmap` | — | autoupdater delta map |
| `latest.yml` | — | autoupdater manifest (sha512 + version) |
| `win-unpacked/` | ~290 MB | runnable app bundle (`Hayase.exe` + `resources/`) |

## Publish a release

The autoupdater is wired to `nickEatsBread/hayase`. To ship a new version:

1. Bump `electron/package.json` version
2. `pnpm --filter hayase build:win`
3. `gh release create vX.Y.Z --repo nickEatsBread/hayase dist/win-hayase-X.Y.Z-installer.exe dist/win-hayase-X.Y.Z-installer.exe.blockmap dist/latest.yml --title ... --notes ...`

Existing v6.4.62+ installs will see the new version on next autoupdater poll.

## Pull updates from upstream

```bash
# pull updates for one package
bash scripts/sync-upstream.sh electron

# or all of them at once
bash scripts/sync-upstream.sh all
```

`sync-upstream.sh` uses `git merge --squash -X subtree=<package>` to remap upstream changes onto the corresponding subdirectory. If a sync conflicts with our local additions (debrid module, RPC toggle, settings injection, etc.) git halts with conflict markers — resolve, `git add`, `git commit`.

## License

Each subdirectory inherits its upstream license:

- `interface/` — BUSL-1.1 (Business Source License)
- everything else — see the `LICENSE` file inside each subdirectory

The workspace glue (root files + `scripts/`) is MIT. The bundled `electron/resources/proprietary-ffmpeg-win32-x64.dll` is the same `ffmpeg.dll` upstream Hayase distributes in their public installer. `pnpm electron:patch` extracts the patched `electron.exe` from upstream Hayase's signed installer at build time — that binary is the result of compiling Electron with [ThaUnknown/electron-chromium-codecs](https://github.com/ThaUnknown/electron-chromium-codecs) patches applied to Chromium's media stack. We only redistribute it via this fork's installer; rebuilding from source ourselves takes 4-8 hours per release and isn't worthwhile while upstream Hayase keeps publishing freshly-patched binaries.
