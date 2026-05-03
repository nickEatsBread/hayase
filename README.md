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

## Build for Linux

```bash
pnpm --filter hayase build:linux
```

`pnpm electron:patch` works on Linux too — it grabs the upstream `linux-hayase-VERSION-linux.deb` from `api.hayase.watch`, `dpkg-deb -x` extracts it, and swaps the patched `hayase` binary + `libffmpeg.so` + V8 snapshots into `node_modules/electron/dist/`. Same proprietary-codec coverage as the Windows path.

Outputs in `electron/dist/`:
- `linux-hayase-X.Y.Z-linux.AppImage`
- `linux-hayase-X.Y.Z-linux.deb`
- `latest-linux.yml`

## Build via GitHub Actions

`.github/workflows/build.yml` runs the Windows + Linux builds in parallel on push of any `v*` tag:

```bash
git tag v6.4.82
git push origin v6.4.82
# Both jobs run on the matching tag, then a release job aggregates the
# artifacts and creates a GitHub release.
```

You can also trigger a test build via the Actions tab (workflow_dispatch). Setting `release: true` on dispatch creates a release using the tag input.

Android isn't covered yet — `capacitor/` depends on nodejs-mobile native modules built via Docker (multi-hour from scratch). A future `android.yml` will pre-build those once and cache the artifacts.

## Publish a release

The autoupdater is wired to `nickEatsBread/hayase`. To ship a new version:

1. Bump `electron/package.json` version
2. `git tag vX.Y.Z && git push origin vX.Y.Z` — `.github/workflows/build.yml` builds Windows + Linux installers in parallel and creates the release automatically

Existing v6.4.62+ installs will see the new version on the next autoupdater poll (Windows hits `latest.yml`, Linux hits `latest-linux.yml`).

## Pull updates from upstream

```bash
# pull updates for one package
bash scripts/sync-upstream.sh electron

# or all of them at once
bash scripts/sync-upstream.sh all
```

`sync-upstream.sh` uses `git merge --squash -X subtree=<package>` to remap upstream changes onto the corresponding subdirectory. If a sync conflicts with our local additions (debrid module, RPC toggle, settings injection, etc.) git halts with conflict markers — resolve, `git add`, `git commit`.

### Auto-sync via GitHub Actions

`.github/workflows/upstream-sync.yml` runs every Monday at 08:00 UTC (and on workflow_dispatch). It tries the same subtree merge for each upstream and opens a PR per package with the changes.

When conflicts happen, the workflow can auto-resolve them via an LLM. The resolution prompt (`scripts/ai-resolve-conflicts.mjs`) is loaded with this fork's exact list of local additions per package, so it knows to preserve debrid types / RPC toggle / settings injection / etc and incorporate any new upstream additions on the same files.

Four auth modes — pick one. The script picks the most-preferred one based on which secrets exist (override via `AI_RESOLVE_MODE` repo variable):

**Mode 1: Cloudflare Workers AI (FREE — recommended for cost-sensitive use)**

Truly free up to 10,000 neurons/day (~166 conflict resolutions). Uses Cloudflare's hosted open-weight models — Qwen2.5-Coder-32B by default since it's code-specific. No Anthropic account needed, no per-token cost.

1. Create a Cloudflare API token at [/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) with **Workers AI: Read** permission
2. Find your CF account ID at [dash.cloudflare.com](https://dash.cloudflare.com/) (sidebar shows "Account ID" — 32 hex chars)
3. Set repo secrets:
   - `CF_WORKERS_AI_TOKEN` = the API token
   - `CF_WORKERS_AI_ACCOUNT_ID` = your account ID
4. (optional) `CF_WORKERS_AI_MODEL` repo variable to switch models — e.g. `@cf/meta/llama-3.3-70b-instruct-fp8-fast` for general use, `@cf/openchat/openchat-3.5-0106` for smaller/faster

Quality caveat: open-weight models follow our "preserve fork additions / incorporate upstream additions" prompt less reliably than Opus. Always verify the AI-resolved PR carefully before merging — if you see fork features dropped or upstream code missing, switch to Mode 2.

**Mode 2: Cloudflare AI Gateway with Unified Billing (PAID — Cloudflare credits)**

Charged to your Cloudflare credits, gets you Claude Opus quality. No Anthropic account needed.

1. Create a Gateway at [Cloudflare AI Gateway](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway)
2. Top up credits in the "Credits Available" card
3. Create a CF API token with **AI Gateway: Edit** permission
4. Set repo secrets:
   - `CF_AI_GATEWAY_URL` = `https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-name>/anthropic`
   - `CF_AI_GATEWAY_TOKEN` = the API token from step 3

**Mode 3: Cloudflare BYOK (PAID — Anthropic billing through CF for caching)**

Charged to your Anthropic account, gets CF's caching/analytics on top.

- `CF_AI_GATEWAY_URL` = same as Mode 2
- `ANTHROPIC_API_KEY` = `sk-ant-...` from [console.anthropic.com](https://console.anthropic.com/)

**Mode 4: Direct to Anthropic (PAID — no Cloudflare)**

Simplest, no caching/analytics. Set repo secret `ANTHROPIC_API_KEY` only.

Optional repo variables:
- `ANTHROPIC_MODEL` (Modes 2/3/4 — defaults to `claude-opus-4-5`)
- `CF_WORKERS_AI_MODEL` (Mode 1 — defaults to `@cf/qwen/qwen2.5-coder-32b-instruct`)
- `AI_RESOLVE_MODE` (force a specific mode — `workers-ai` / `cf-unified` / `cf-byok` / `direct`)

Without any of these configured, the workflow falls back to the manual review path — logs which files would conflict and points you at `pnpm sync:upstream <pkg>` for local resolution.

### Auto-merging sync PRs

Both clean and AI-resolved sync PRs can auto-merge when ready. Default behaviour:

| PR type | Default | Override |
|---|---|---|
| **Clean syncs** (`sync PKG from upstream (SHA)`) — upstream changed files we don't touch | **Auto-merge ON** | Set repo variable `AUTO_MERGE_CLEAN_SYNCS=false` to disable |
| **AI-resolved syncs** (`[AI] sync PKG from upstream (SHA)`) — model resolved conflicts | **Auto-merge OFF** | Set repo variable `AUTO_MERGE_AI_PRS=true` to opt in |

The split is risk-based: clean syncs by definition only touch upstream-only files, so the diff carries minimal risk. AI-resolved syncs touch files we have local additions in, and an open-weight model occasionally drops or mangles them silently.

**One-time repo settings to enable auto-merge:**
1. **Settings → General → Pull Requests → Allow auto-merge** (checkbox)
2. (already set up) Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests"

If auto-merge can't fire (e.g. branch protection requires reviewers), the PR stays open for manual handling — the workflow won't fail.

## License

Each subdirectory inherits its upstream license:

- `interface/` — BUSL-1.1 (Business Source License)
- everything else — see the `LICENSE` file inside each subdirectory

The workspace glue (root files + `scripts/`) is MIT. The bundled `electron/resources/proprietary-ffmpeg-win32-x64.dll` is the same `ffmpeg.dll` upstream Hayase distributes in their public installer. `pnpm electron:patch` extracts the patched `electron.exe` from upstream Hayase's signed installer at build time — that binary is the result of compiling Electron with [ThaUnknown/electron-chromium-codecs](https://github.com/ThaUnknown/electron-chromium-codecs) patches applied to Chromium's media stack. We only redistribute it via this fork's installer; rebuilding from source ourselves takes 4-8 hours per release and isn't worthwhile while upstream Hayase keeps publishing freshly-patched binaries.
