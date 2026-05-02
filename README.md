# Hayase (nickEatsBread fork)

Personal fork of [hayase-app](https://github.com/hayase-app) consolidated into a single pnpm workspace, with a few additions:

- **Debrid streaming** — Real-Debrid, AllDebrid, Premiumize, TorBox support in the torrent-client (Settings → Client → Debrid Service).
- **Discord RPC toggle** — full enable/disable switch for Discord Rich Presence (Settings → Interface → Rich Presence Settings), restoring a feature upstream removed.
- **Self-contained Windows build** — bundles the SvelteKit interface into the installer via an `app://` protocol handler so the packaged app doesn't depend on `https://hayase.app/`.
- **Proprietary codecs by default** — `pnpm codecs:install` swaps the official Electron proprietary-codec ffmpeg in (H.264, H.265, AAC, AC-3, etc.). Same script runs automatically as an `afterPack` hook for packaged builds.

## Layout

```
hayase/
├── electron/           Electron desktop wrapper (originally hayase-app/electron)
├── interface/          SvelteKit UI (originally hayase-app/interface)
├── torrent-client/     WebTorrent + debrid client (originally hayase-app/torrent-client)
├── native/             Shared IPC type schema (originally hayase-app/native)
├── wiki/               Documentation (originally hayase-app/wiki)
├── capacitor/          Mobile wrapper (originally hayase-app/capacitor)
├── free-torrents/      Example extension (originally hayase-app/free-torrents)
├── scripts/
│   ├── install-codecs.mjs    Download + swap proprietary ffmpeg
│   ├── after-pack.mjs        electron-builder hook (called by build:win etc.)
│   ├── setup-remotes.sh      Register hayase-app upstreams as remotes
│   └── sync-upstream.sh      Pull updates from a single upstream into the matching subdir
├── pnpm-workspace.yaml
└── .npmrc                    shamefully-hoist=true (legacy hayase requirement)
```

Each subdirectory used to be its own git repository on the hayase-app org. We've flattened them into a monorepo and track each upstream separately via `upstream-<name>` remotes.

## Setup

Requires Node 20+ and pnpm.

```bash
# clone + install
git clone https://github.com/nickEatsBread/hayase.git
cd hayase
pnpm install

# install proprietary codecs (one-time, idempotent)
pnpm codecs:install

# register hayase-app upstream remotes for syncing
bash scripts/setup-remotes.sh
```

## Run from source

```bash
# terminal 1 — interface dev server on :7344
pnpm dev:interface

# terminal 2 — electron pointing at the dev server
pnpm dev:electron
```

## Build a Windows installer

```bash
pnpm build:electron       # plain build
pnpm --filter hayase build:win   # NSIS installer in electron/dist/
```

The `build:win` script chains `build:interface → electron-vite build → electron-builder --win → afterPack codec swap → NSIS package`.

## Pull updates from upstream

```bash
# pull updates for one package
bash scripts/sync-upstream.sh electron

# or all of them
bash scripts/sync-upstream.sh all
```

`sync-upstream.sh` uses `git merge --squash -X subtree=<package>` to remap upstream changes onto the corresponding subdirectory. If a sync conflicts with our local changes (debrid module, RPC toggle, protocol handler, etc.) git halts with conflict markers — resolve, `git add`, `git commit`.

## License

Each subdirectory inherits its upstream license. Notable ones:

- `interface/` — BUSL-1.1 (Business Source License)
- everything else — see the LICENSE file inside each subdirectory.

The workspace glue (root files + `scripts/`) is MIT.
