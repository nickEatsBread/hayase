import { proxy } from 'abslink'
import { wrap } from 'abslink/electron'
import { wrap as wrapPort } from 'abslink/w3c'
import { contextBridge, ipcRenderer } from 'electron'

import type IPC from '../main/ipc.ts'
import type { Remote } from 'abslink'
import type { Native } from 'native'
import type TorrentClient from 'torrent-client'
import type { PROVIDERS } from 'torrent-client/doh'

ipcRenderer.send('preload-done')

// Force-enable hayase.app's mediabunny player backend BEFORE the page's
// settings store loads. mediabunny includes JS decoders for AC3/EAC3
// (via @mediabunny/ac3) which bypass Chromium's HTML5 audio allowlist
// entirely - that allowlist excludes AC3/EAC3 because stock Electron's
// Chromium build sets `proprietary_codecs=false` at compile time.
//
// The setting is `bunnyPlayer`, persisted via svelte-persisted-store
// under localStorage key 'settings'. We just need to set it to true
// before the page initialises its store.
//
// Upstream gates this behind a dev-mode toggle (Settings -> Player ->
// 'EXPERIMENTAL: Custom Player Backend') because mediabunny is newer
// and might have edge cases. In our build we default it on so users
// don't have to dig through dev tools to play modern releases.
try {
  const raw = localStorage.getItem('settings')
  let settings: Record<string, unknown> = {}
  if (raw) {
    try { settings = JSON.parse(raw) as Record<string, unknown> } catch { settings = {} }
  }
  if (settings.bunnyPlayer !== true) {
    settings.bunnyPlayer = true
    localStorage.setItem('settings', JSON.stringify(settings))
  }
} catch {
  // localStorage might not be ready yet for non-page contexts; ignore.
}

const torrent = new Promise<Remote<TorrentClient>>(resolve => {
  ipcRenderer.once('port', ({ ports }) => {
    if (!ports[0]) return
    ports[0].start()
    resolve(wrapPort<TorrentClient>(ports[0]) as unknown as Remote<TorrentClient>)
  })
})
const version = ipcRenderer.invoke('version')

const main = wrap<typeof IPC.prototype>(ipcRenderer)

const native: Partial<Native> = {
  openURL: (url: string) => main.openURL(url),
  selectPlayer: () => main.selectPlayer(),
  selectDownload: async () => {
    const path = await main.selectDownload()
    await (await torrent).verifyDirectoryPermissions(path)
    return path
  },
  setAngle: (angle: string) => main.setAngle(angle),
  getLogs: () => main.getLogs(),
  getDeviceInfo: () => main.getDeviceInfo(),
  openUIDevtools: () => main.openUIDevtools(),
  minimise: () => main.minimise(),
  maximise: () => main.maximise(),
  close: () => main.close(),
  checkUpdate: () => main.checkUpdate(),
  updateAndRestart: () => main.updateAndRestart(),
  updateReady: () => main.updateReady(),
  enableCORS: (urls) => main.enableCORS(urls),
  unsafeUseInternalALAPI: () => main.unsafeUseInternalALAPI(),
  updateProgress: async (cb: (progress: number) => void) => {
    // the less proxies used, the better, could use proxy(cb) here, but this has less overhead
    main.updateProgress()
    ipcRenderer.on('update-progress', (_e, data) => cb(data))
  },
  toggleDiscordDetails: (bool: boolean) => main.toggleDiscordDetails(bool),
  toggleDiscordRPC: (bool: boolean) => main.toggleDiscordRPC(bool),
  // Fork-only APIs used by the settings cards we inject into hayase.app's
  // existing settings pages. Exposed here so the injected scripts can call
  // them without needing their own preload.
  openExtras: () => main.openExtras(),
  getExtras: () => main.getExtras(),
  setExtras: (extras: Parameters<typeof main.applyExtras>[0]) => main.applyExtras(extras),
  testDebridKey: (provider: Parameters<typeof main.checkDebridKey>[0], apiKey: string) => main.checkDebridKey(provider, apiKey),
  setMediaSession: async (metadata, id) => {
    navigator.mediaSession.metadata = new MediaMetadata({ title: metadata.title, artist: metadata.description, artwork: [{ src: metadata.image }] })
    await main.setMediaSession(metadata, id)
  },
  setPositionState: async e => {
    navigator.mediaSession.setPositionState(e)
    await main.setPositionState(e)
  },
  setPlayBackState: async e => {
    navigator.mediaSession.playbackState = e
    await main.setPlayBackState(e)
  },
  checkAvailableSpace: async () => await (await torrent).checkAvailableSpace(),
  checkIncomingConnections: async (port) => await (await torrent).checkIncomingConnections(port),
  updatePeerCounts: async (hashes) => await (await torrent).scrape(hashes),
  playTorrent: async (id, mediaID, episode) => await (await torrent).playTorrent(id, mediaID, episode),
  rescanTorrents: async (hashes) => await (await torrent).rescanTorrents(hashes),
  deleteTorrents: async (hashes) => await (await torrent).deleteTorrents(hashes),
  library: async () => await (await torrent).library(),
  attachments: async (hash, id) => await (await torrent).attachments.attachments(hash, id),
  tracks: async (hash, id) => await (await torrent).attachments.tracks(hash, id),
  subtitles: async (hash, id, cb) => await (await torrent).attachments.subtitle(hash, id, proxy(cb)),
  errors: async (cb) => await (await torrent).errors(proxy(cb)),
  chapters: async (hash, id) => await (await torrent).attachments.chapters(hash, id),
  torrentInfo: async (hash) => await (await torrent).torrentInfo(hash),
  peerInfo: async (hash) => await (await torrent).peerInfo(hash),
  fileInfo: async (hash) => await (await torrent).fileInfo(hash),
  protocolStatus: async (hash) => await (await torrent).protocolStatus(hash),
  updateSettings: (settings) => main.updateSettings(settings),
  cachedTorrents: async () => await (await torrent).cached(),
  createNZB: async (id, url, domain, port, login, password, poolSize) => await (await torrent).createNZBWebSeed(id, url, domain, port, login, password, poolSize),
  getDisplays: async cb => await (await torrent).listenDisplay(proxy(cb)),
  castPlay: async (host, hash, id, media) => await (await torrent).playDisplay(host, hash, id, media),
  castClose: async (host) => await (await torrent).closeDisplay(host),
  setHideToTray: (enabled: boolean) => main.setHideToTray(enabled),
  isApp: true,
  spawnPlayer: (url) => main.spawnPlayer(url),
  setDOH: async (dns) => {
    await main.setDOH(dns)
    await (await torrent).setDOH(dns as `https://${keyof typeof PROVIDERS}`)
  },
  checkDebrid: async (provider, apiKey) => await (await torrent).checkDebrid(provider, apiKey),
  downloadProgress: (percent: number) => main.downloadProgress(percent),
  restart: () => main.restart(),
  focus: () => main.focus(),
  setZoom: (scale: number) => main.setZoom(scale),
  version: () => version,
  navigate: async (cb) => {
    ipcRenderer.on('navigate', (_e, data) => cb(data))
  },
  share: async (data) => {
    if (!data) return
    await navigator.clipboard.writeText(data.url ?? data.text ?? data.title!)
  },
  defaultTransparency: () => false,
  debug: async (levels) => await (await torrent).debug(levels)
}

try {
  contextBridge.exposeInMainWorld('native', native)
} catch (error) {
  console.error(error)
}
// const {electron, chrome, node} = electron.process.versions
