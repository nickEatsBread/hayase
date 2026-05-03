import { randomBytes } from 'node:crypto'
import { readFile, writeFile, statfs, unlink, mkdir, readdir, access, constants } from 'node:fs/promises'
import { Agent as HttpAgent, createServer as createHttpServer, request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { join } from 'node:path'
import { exit } from 'node:process'
import querystring from 'querystring'

import bencode from 'bencode'
import BitField from 'bitfield'
import peerid from 'bittorrent-peerid'
import debug from 'debug'
// @ts-expect-error no export
import HTTPTracker from 'http-tracker'
import MemoryChunkStore from 'memory-chunk-store'
import networkAddress from 'network-address'
import parseTorrent from 'parse-torrent'
import { hex2bin, arr2hex, text2arr, concat } from 'uint8-util'
import WebTorrent from 'webtorrent'

import attachments from './attachments.ts'
// import DoHResolver from './doh'
import { ChromeCasts } from './chromecast/index.ts'
import { checkAuth as checkDebridAuth, createProvider as createDebridProvider, resolveDebrid, type DebridProvider } from './debrid/index.ts'
import { DLNAs } from './dlna/index.ts'
import DoHResolver from './doh'
import { createNZB } from './nzb.ts'

import type { PROVIDERS } from './doh'
import type { MediaInformation } from 'chromecast-caf-receiver/cast.framework.messages'
import type { DebridProviderId, DebridStatus, LibraryEntry, PeerInfo, TorrentFile, TorrentInfo, TorrentSettings } from 'native'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type Torrent from 'webtorrent/lib/torrent.js'

interface ScrapeResponse { hash: string, complete: string, downloaded: string, incomplete: string }

const sleep = (t: number) => new Promise(resolve => setTimeout(resolve, t).unref())

const querystringStringify = (obj: Record<string, string>) => {
  let ret = querystring.stringify(obj, undefined, undefined, { encodeURIComponent: escape })
  ret = ret.replace(/[@*/+]/g, char => // `escape` doesn't encode the characters @*/+ so we do it manually
  `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return ret
}

interface TorrentMetadata {
  info: unknown
  announce?: string[]
  urlList?: string[]
  private?: boolean
  bitfield?: Uint8Array
  date: number
  mediaID: number
  episode: number
}

interface TorrentData {
  info: unknown
  'announce-list'?: Uint8Array[][]
  'url-list'?: string[]
  private?: number
  _bitfield?: Uint8Array
  announce?: string
  date: number
  mediaID: number
  episode: number
}

function structTorrent ({ info, urlList, bitfield, announce, private: priv, mediaID, episode, date }: TorrentMetadata) {
  const torrent: TorrentData = {
    info,
    'url-list': urlList ?? [],
    _bitfield: bitfield,
    'announce-list': (announce ?? []).map(url => [text2arr(url)]),
    date,
    mediaID,
    episode
  }
  torrent.announce ??= announce?.[0]
  if (priv !== undefined) torrent.private = Number(priv)

  return torrent
}

const ANNOUNCE = [
  // WSS trackers, for now WebRTC is disabled
  // atob('d3NzOi8vdHJhY2tlci5vcGVud2VidG9ycmVudC5jb20='),
  // atob('d3NzOi8vdHJhY2tlci53ZWJ0b3JyZW50LmRldg=='),
  // atob('d3NzOi8vdHJhY2tlci5maWxlcy5mbTo3MDczL2Fubm91bmNl'),
  // atob('d3NzOi8vdHJhY2tlci5idG9ycmVudC54eXov'),
  atob('dWRwOi8vb3Blbi5zdGVhbHRoLnNpOjgwL2Fubm91bmNl'),
  atob('aHR0cDovL255YWEudHJhY2tlci53Zjo3Nzc3L2Fubm91bmNl'),
  atob('dWRwOi8vdHJhY2tlci5vcGVudHJhY2tyLm9yZzoxMzM3L2Fubm91bmNl'),
  atob('dWRwOi8vZXhvZHVzLmRlc3luYy5jb206Njk2OS9hbm5vdW5jZQ=='),
  atob('dWRwOi8vdHJhY2tlci5jb3BwZXJzdXJmZXIudGs6Njk2OS9hbm5vdW5jZQ=='),
  atob('dWRwOi8vOS5yYXJiZy50bzoyNzEwL2Fubm91bmNl'),
  atob('dWRwOi8vdHJhY2tlci50b3JyZW50LmV1Lm9yZzo0NTEvYW5ub3VuY2U='),
  atob('aHR0cDovL29wZW4uYWNnbnh0cmFja2VyLmNvbTo4MC9hbm5vdW5jZQ=='),
  atob('aHR0cDovL2FuaWRleC5tb2U6Njk2OS9hbm5vdW5jZQ=='),
  atob('aHR0cDovL3RyYWNrZXIuYW5pcmVuYS5jb206ODAvYW5ub3VuY2U='),
  atob('aHR0cHM6Ly90cmFja2VyLm5la29idC50by9hcGkvdHJhY2tlci9wdWJsaWMvYW5ub3VuY2U=')
]

const client = Symbol('client')
const server = Symbol('server')
const store = Symbol('store')
const path = Symbol('path')
const opts = Symbol('opts')
const tmp = Symbol('tmp')
const doh = Symbol('doh')
const debrid = Symbol('debrid')
const debridProxy = Symbol('debridProxy')
const debridStats = Symbol('debridStats')
const tracker = new HTTPTracker({}, atob('aHR0cDovL255YWEudHJhY2tlci53Zjo3Nzc3L2Fubm91bmNl'))

// Keep-alive HTTP(S) agents for the debrid CDN proxy. Without these every
// range request opens a fresh TCP+TLS connection (~200ms handshake each)
// which adds up to seconds of latency over a single playback session.
// maxSockets=8 leaves room for parallel chunk fetches that mediabunny
// makes for the seekhead + multiple cluster reads.
const debridUpstreamHttpsAgent = new HttpsAgent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 8,
  // Real-Debrid CDN supports HTTP/2 but Node's https module is HTTP/1.1
  // only. With keep-alive enabled this is still much better than fresh
  // connections per request.
  scheduling: 'lifo'
})
const debridUpstreamHttpAgent = new HttpAgent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 8,
  scheduling: 'lifo'
})

const VIDEO_MIME_BY_EXT: Record<string, string> = {
  mkv: 'video/x-matroska',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  ts: 'video/mp2t',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg'
}

interface DebridStats {
  name: string
  size: number
  downloaded: number
  // bytes downloaded since the last sample, used to compute speed
  windowStart: number
  windowBytes: number
  // last computed speed (bytes/sec) and when we computed it
  lastSpeed: number
  lastSpeedAt: number
}

class Store {
  cacheFolder
  constructor (path: string) {
    const targetPath = join(path, 'hayase-cache')
    this.cacheFolder = mkdir(targetPath, { recursive: true }).then(() => targetPath)
  }

  async get (key?: string) {
    if (!key) return null
    try {
      const data = await readFile(join(await this.cacheFolder, key))
      if (!data.length) return
      // this double decoded bencoded data, unfortunate, but I wish to preserve my sanity
      const bencoded: TorrentData = bencode.decode(data)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/await-thenable
      const torrent: any = await parseTorrent(data)

      return { bencoded, torrent }
    } catch (error) {
      // means it doesnt exist
    }
  }

  async set (key: string, value: TorrentData) {
    try {
      return await writeFile(join(await this.cacheFolder, key), bencode.encode(value), { mode: 0o666 })
    } catch (e) {
      console.error(e)
    }
  }

  async delete (key: string) {
    try {
      return await unlink(join(await this.cacheFolder, key))
    } catch (err) {
      return null
    }
  }

  async * entries () {
    try {
      const files = await readdir(await this.cacheFolder, { withFileTypes: true })
      for (const file of files) {
        if (!file.isDirectory()) {
          const res = await this.get(file.name)
          if (res) yield res
        }
      }
    } catch (error) {
      console.error(error)
    }
  }

  async list () {
    try {
      return (await readdir(await this.cacheFolder, { withFileTypes: true }))
        .filter(item => !item.isDirectory())
        .map(({ name }) => name)
    } catch (err) {
      return []
    }
  }
}

const megaBitsToBytes = 1024 * 1024 / 8

process.on('uncaughtException', err => console.error(err))

// this could... be a bad idea and needs to be verified
const peerId = concat([[45, 113, 66, 53, 48, 51, 48, 45], randomBytes(12)])

export default class TorrentClient {
  [client]: WebTorrent;
  [server]: Server;
  [store]: Store;
  [path]: string;
  [opts]: Record<string, unknown>;
  [tmp]: string
  [doh]: DoHResolver | undefined
  [debrid]: DebridProvider | null = null;
  [debridProxy]: Server | null = null;
  [debridStats]: DebridStats | null = null;
  // Set of upstream debrid URLs that have already had their initial
  // sequential stream tee'd through matroska-metadata. Subsequent range
  // requests for the same URL bypass parseStream (it's stateful and would
  // break on mid-file bytes).
  #debridStreamingForUrl = new Set<string>()

  attachments = attachments

  chromecasts = new ChromeCasts(attachments)
  dlnas = new DLNAs()

  streamed = false
  persist = false

  constructor (settings: TorrentSettings & {path: string }, temp: string) {
    this[opts] = {
      dht: !settings.torrentDHT,
      utPex: !settings.torrentPeX,
      downloadLimit: Math.round(settings.torrentSpeed * megaBitsToBytes),
      uploadLimit: Math.round(settings.torrentSpeed * megaBitsToBytes * 1.2),
      natUpnp: 'permanent',
      torrentPort: settings.torrentPort,
      dhtPort: settings.dhtPort,
      maxConns: settings.maxConns,
      peerId
    }
    this[client] = new WebTorrent(this[opts])
    this[client].on('error', console.error)
    // @ts-expect-error bad types
    this[server] = this[client].createServer({}, 'node').listen(0)
    this[tmp] = temp
    this[path] = settings.path || temp
    this[store] = new Store(this[path])
    // try {
    //   if (settings.doh) this[doh] = new DoHResolver(settings.doh)
    // } catch (error) {
    //   console.error(error)
    // }
    this.streamed = settings.torrentStreamedDownload
    this.persist = settings.torrentPersist
    this._setDebrid(settings.debridProvider, settings.debridApiKey)
  }

  _setDebrid (provider: DebridProviderId | undefined, apiKey: string | undefined) {
    try {
      this[debrid] = createDebridProvider(provider ?? 'none', apiKey ?? '')
    } catch (error) {
      console.error('Failed to initialise debrid provider', error)
      this[debrid] = null
    }
  }

  async checkDebrid (provider: DebridProviderId, apiKey: string): Promise<DebridStatus> {
    return await checkDebridAuth(provider, apiKey)
  }

  updateSettings (settings: TorrentSettings & { path: string }) {
    this[client].throttleDownload(Math.round(settings.torrentSpeed * megaBitsToBytes))
    this[client].throttleUpload(Math.round(settings.torrentSpeed * megaBitsToBytes * 1.2))
    this[opts] = {
      dht: !settings.torrentDHT,
      utPex: !settings.torrentPeX,
      downloadLimit: Math.round(settings.torrentSpeed * megaBitsToBytes),
      uploadLimit: Math.round(settings.torrentSpeed * megaBitsToBytes * 1.2),
      natUpnp: 'permanent',
      torrentPort: settings.torrentPort,
      dhtPort: settings.dhtPort,
      maxConns: settings.maxConns,
      peerId
    }
    this[path] = settings.path || this[tmp]
    this[store] = new Store(this[path])
    this.streamed = settings.torrentStreamedDownload
    this.persist = settings.torrentPersist
    this._setDebrid(settings.debridProvider, settings.debridApiKey)
  }

  setDOH (dohServer: `https://${keyof typeof PROVIDERS}`) {
    this[doh]?.destroy()
    try {
      this[doh] = new DoHResolver(dohServer)
    } catch (error) {
      console.error(error)
    }
  }

  cleanupLast: undefined | (() => Promise<void>) = undefined

  // WARN: ONLY CALL THIS DURING SETUP!!!
  async checkIncomingConnections (torrentPort: number): Promise<boolean> {
    await this.cleanupLast?.()
    await new Promise(resolve => this[client].destroy(resolve))

    return await new Promise(resolve => {
      const checkClient = new WebTorrent({ torrentPort, natUpnp: 'permanent', peerId })
      const torrent = checkClient.add(
        atob('bWFnbmV0Oj94dD11cm46YnRpaDpkZDgyNTVlY2RjN2NhNTVmYjBiYmY4MTMyM2Q4NzA2MmRiMWY2ZDFjJmRuPUJpZytCdWNrK0J1bm55JnRyPXVkcCUzQSUyRiUyRmV4cGxvZGllLm9yZyUzQTY5NjkmdHI9dWRwJTNBJTJGJTJGdHJhY2tlci5jb3BwZXJzdXJmZXIudGslM0E2OTY5JnRyPXVkcCUzQSUyRiUyRnRyYWNrZXIuZW1waXJlLWpzLnVzJTNBMTMzNyZ0cj11ZHAlM0ElMkYlMkZ0cmFja2VyLmxlZWNoZXJzLXBhcmFkaXNlLm9yZyUzQTY5NjkmdHI9dWRwJTNBJTJGJTJGdHJhY2tlci5vcGVudHJhY2tyLm9yZyUzQTEzMzc='),
        { store: MemoryChunkStore }
      )
      // patching library to not create outgoing connections
      torrent._drain = () => undefined
      checkClient.on('error', console.error)
      const cleanup = this.cleanupLast = async (val = false) => {
        if (checkClient.destroyed) return
        await new Promise(resolve => checkClient.destroy(resolve))
        this[client] = new WebTorrent(this[opts])
        this[store] = new Store(this[path])
        this[client].on('error', console.error)
        // @ts-expect-error bad types
        this[server] = this[client].createServer({}, 'node').listen(0)
        resolve(val)
      }

      setTimeout(() => cleanup(), 60_000).unref()
      torrent.on('wire', () => cleanup(true))
    })
  }

  async checkAvailableSpace () {
    const { bsize, bavail } = await statfs(this[path])
    return bsize * bavail
  }

  async scrape (infoHashes: string[]): Promise<ScrapeResponse[]> {
    // this seems to give the best speed, and lowest failure rate
    const MAX_ANNOUNCE_LENGTH = 1300 // it's likely 2048, but lets undercut it
    const RATE_LIMIT = 200 // ms

    const ANNOUNCE_LENGTH = tracker.scrapeUrl.length

    let batch: string[] = []
    let currentLength = ANNOUNCE_LENGTH // fuzz the size a little so we don't always request the same amt of hashes
    const results: ScrapeResponse[] = []

    const scrape = async () => {
      if (results.length) await sleep(RATE_LIMIT)
      const data = await new Promise((resolve, reject) => {
        tracker._request(tracker.scrapeUrl, { info_hash: batch }, (err: Error | null, data: unknown) => {
          if (err) return reject(err)
          resolve(data)
        })
      })

      const { files } = data as { files: Array<Pick<ScrapeResponse, 'complete' | 'downloaded' | 'incomplete'>> }
      const result = []
      for (const [key, data] of Object.entries(files)) {
        result.push({ hash: key.length !== 40 ? arr2hex(text2arr(key)) : key, ...data })
      }

      results.push(...result)
      batch = []
      currentLength = ANNOUNCE_LENGTH
    }

    for (const infoHash of infoHashes.sort(() => 0.5 - Math.random()).map(infoHash => hex2bin(infoHash))) {
      const qsLength = querystringStringify({ info_hash: infoHash }).length + 1 // qs length + 1 for the & or ? separator
      if (currentLength + qsLength > MAX_ANNOUNCE_LENGTH) {
        await scrape()
      }

      batch.push(infoHash)
      currentLength += qsLength
    }
    if (batch.length) await scrape()

    return results
  }

  async toInfoHash (torrentId: string | ArrayBufferView) {
    let parsed: { infoHash: string } | undefined

    // @ts-expect-error bad typedefs
    // eslint-disable-next-line @typescript-eslint/await-thenable
    try { parsed = await parseTorrent(torrentId) } catch (err) {}
    return parsed?.infoHash
  }

  async playTorrent (id: string | ArrayBufferView, mediaID: number, episode: number): Promise<TorrentFile[]> {
    if (this[debrid]) {
      try {
        return await this._playDebrid(id, mediaID, episode)
      } catch (error) {
        console.error('Debrid playback failed, falling back to WebTorrent', error)
        // Re-throw so the UI surfaces the error - falling back to torrenting
        // would be confusing because the user explicitly enabled debrid.
        throw error
      }
    }

    const existing = await this[client].get(id)

    // race condition hell, if some1 added a torrent Z in path A, switched torrents, then changed to path B and played torrent Z again, and that torrent was cached in path B, we want that cache data before its removed by non-existing check
    const storeData = !existing ? await this[store].get(await this.toInfoHash(id)) : undefined

    if (!existing && this[client].torrents[0]) {
      const hash = this[client].torrents[0].infoHash
      // @ts-expect-error bad typedefs
      await this[client].remove(this[client].torrents[0], { destroyStore: !this.persist })
      if (!this.persist) await this[store].delete(hash)
    }

    const torrent: Torrent = existing ?? this[client].add(storeData?.torrent ?? id, {
      path: this[path],
      announce: ANNOUNCE,
      bitfield: storeData?.bencoded._bitfield,
      deselect: this.streamed
    })
    // torrent._drain = () => undefined

    if (!torrent.ready) await new Promise(resolve => torrent.once('ready', resolve))

    this.attachments.register(torrent.files, torrent.infoHash)

    const baseInfo = structTorrent({
      // @ts-expect-error bad typedefs
      info: torrent.info,
      announce: torrent.announce,
      private: torrent.private,
      urlList: torrent.urlList,
      bitfield: torrent.bitfield!.buffer,
      date: Date.now(),
      mediaID,
      episode
    })

    // store might be updated during the torrent download, but the torrent won't be magically moved, so we want to persist this cached store location
    const cachedStore = this[store]
    const savebitfield = () => cachedStore.set(torrent.infoHash, baseInfo)
    const finish = () => {
      savebitfield()
      clearInterval(interval)
    }

    const interval = setInterval(savebitfield, 1000 * 20).unref()

    // so the cached() function is populated and can be called instantly after the torrent is added
    await savebitfield()

    torrent.on('done', finish)
    torrent.on('close', finish)

    const lan = networkAddress()

    return torrent.files.map(({ name, type, size, path, streamURL }, id) => {
      const suffix = ':' + (this[server].address() as AddressInfo).port + streamURL
      return {
        hash: torrent.infoHash, name, type, size, path, id, url: 'http://localhost' + suffix, lan: 'http://' + lan + suffix
      }
    })
  }

  async _playDebrid (id: string | ArrayBufferView, mediaID: number, episode: number): Promise<TorrentFile[]> {
    const provider = this[debrid]
    if (!provider) throw new Error('Debrid provider not configured')

    const { source, hash } = await this._toDebridSource(id)

    // Stop any existing WebTorrent so we don't waste bandwidth.
    if (this[client].torrents[0]) {
      const existingHash = this[client].torrents[0].infoHash
      // @ts-expect-error bad typedefs
      await this[client].remove(this[client].torrents[0], { destroyStore: !this.persist })
      if (!this.persist) await this[store].delete(existingHash)
    }

    const files = await resolveDebrid(provider, source, {
      onProgress: t => console.log(`[debrid:${provider.id}] ${t.name} ${Math.round(t.progress * 100)}% (${t.status})`)
    })

    const fakeHash = (hash || files[0]?.url || `${provider.id}-${mediaID}-${episode}`).slice(0, 40).padEnd(40, '0')

    // Track download stats for the largest (likely main video) file so the
    // UI can show real bytes/s during playback.
    const main = [...files].sort((a, b) => b.size - a.size)[0]
    if (main) {
      this[debridStats] = {
        name: main.name,
        size: main.size,
        downloaded: 0,
        windowStart: Date.now(),
        windowBytes: 0,
        lastSpeed: 0,
        lastSpeedAt: 0
      }
    }

    const proxyPort = this._ensureDebridProxy()

    // Reset per-play attachment state so the previous torrent's metadata
    // doesn't bleed into this one.
    this.attachments.filemap.clear()
    this.attachments.debridUrlToKey.clear()
    this.#debridStreamingForUrl.clear()

    return files.map((file, id) => {
      // Register MKV/WebM files for matroska-metadata parsing so the player
      // gets audio tracks, subtitle tracks, attachments (fonts) and
      // chapters - same as it would when playing via WebTorrent.
      this.attachments.registerDebrid(file.url, fakeHash, id, file.name, file.size)
      return {
        hash: fakeHash,
        name: file.name,
        type: this._guessMime(file.name),
        size: file.size,
        path: file.path,
        id,
        url: this._buildDebridProxyUrl('localhost', proxyPort, file.url, file.name),
        lan: this._buildDebridProxyUrl(networkAddress(), proxyPort, file.url, file.name)
      }
    })
  }

  // Spin up a tiny localhost HTTP server that forwards range requests to the
  // debrid CDN with sensible Content-Type / CORS headers. We need this
  // because the renderer's mediabunny player fetches the URL with CORS mode,
  // and debrid CDNs serve files with `application/force-download` and no
  // `Access-Control-Allow-Origin` header - so the browser blocks the
  // response with ERR_FAILED before MSE can decode anything.
  _ensureDebridProxy (): number {
    if (this[debridProxy]) return (this[debridProxy].address() as AddressInfo).port
    const srv = createHttpServer((req, res) => this._handleDebridProxy(req, res))
    srv.listen(0, '127.0.0.1')
    this[debridProxy] = srv
    return (srv.address() as AddressInfo).port
  }

  _buildDebridProxyUrl (host: string, port: number, debridUrl: string, fileName: string): string {
    // Encode the upstream URL as base64url in the path so the renderer's
    // request URL still ends in the right extension (mediabunny sniffs ext).
    const encoded = Buffer.from(debridUrl, 'utf8').toString('base64url')
    return `http://${host}:${port}/${encoded}/${encodeURIComponent(fileName)}`
  }

  _handleDebridProxy (req: IncomingMessage, res: ServerResponse) {
    // CORS preflight - mediabunny's UrlSource sometimes preflights.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400'
      })
      res.end()
      return
    }

    const reqUrl = req.url ?? '/'
    const firstSlash = reqUrl.indexOf('/', 1)
    const encoded = reqUrl.slice(1, firstSlash > 0 ? firstSlash : undefined)
    let upstream: string
    try {
      upstream = Buffer.from(encoded, 'base64url').toString('utf8')
      // Validate it's a real URL we'd be willing to proxy.
      const parsed = new URL(upstream)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol')
    } catch {
      res.writeHead(400)
      res.end('bad upstream url')
      return
    }

    const parsed = new URL(upstream)
    const lib = parsed.protocol === 'https:' ? httpsRequest : httpRequest
    const agent = parsed.protocol === 'https:' ? debridUpstreamHttpsAgent : debridUpstreamHttpAgent
    const headers: Record<string, string> = {
      // Forward range so the player can seek; everything else gets a clean
      // Chrome-ish UA so debrid CDNs don't reject us.
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
      accept: '*/*',
      // Explicit keep-alive for the upstream so the CDN doesn't close the
      // socket between range reads (matches what the agent will do anyway).
      connection: 'keep-alive'
    }
    if (req.headers.range) headers.range = String(req.headers.range)

    const upstreamReq = lib({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: req.method ?? 'GET',
      headers,
      agent
    }, upstreamRes => {
      const ext = (parsed.pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? '').toLowerCase()
      const mime = VIDEO_MIME_BY_EXT[ext] ?? upstreamRes.headers['content-type'] ?? 'application/octet-stream'

      const outHeaders: Record<string, string | string[]> = {
        'content-type': Array.isArray(mime) ? mime[0]! : mime,
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
        'access-control-allow-headers': '*',
        'access-control-expose-headers': 'content-length, content-range, accept-ranges',
        'accept-ranges': 'bytes',
        'cache-control': 'no-cache'
      }
      // Pass through length / range / etag.
      for (const k of ['content-length', 'content-range', 'last-modified', 'etag']) {
        const v = upstreamRes.headers[k]
        if (v != null) outHeaders[k] = Array.isArray(v) ? v[0]! : v
      }

      res.writeHead(upstreamRes.statusCode ?? 502, outHeaders)

      // Track bytes for the stats overlay.
      const stats = this[debridStats]
      upstreamRes.on('data', chunk => {
        if (stats) {
          stats.downloaded += chunk.length
          stats.windowBytes += chunk.length
        }
      })

      // For the player's initial sequential read from byte 0 we tee the
      // bytes through matroska-metadata.parseStream so live 'subtitle'
      // events fire as clusters arrive. Same byte stream - no extra CDN
      // connection (Real-Debrid rate-limits per-file concurrent
      // connections, and a parallel background download was triggering
      // 502s on the player's range requests).
      //
      // We mark the URL as "first-stream-consumed" after this so subsequent
      // seek requests bypass parseStream entirely (parseStream is stateful
      // and would choke on mid-file bytes).
      const reqRange = String(req.headers.range ?? '')
      const isInitialFullStream = !reqRange || reqRange === 'bytes=0-' || /^bytes=0-\d/.test(reqRange)
      const alreadyTeed = this.#debridStreamingForUrl.has(upstream)
      if (isInitialFullStream && !alreadyTeed) {
        this.#debridStreamingForUrl.add(upstream)
        const wrapped = this.attachments.feedDebrid(upstream, this._streamToAsyncIterable(upstreamRes))
        ;(async () => {
          try {
            for await (const chunk of wrapped) {
              if (!res.write(chunk)) await new Promise(resolve => res.once('drain', resolve))
            }
          } catch (e) {
            console.error('[debrid-proxy] tee stream error', e)
          } finally {
            res.end()
          }
        })()
      } else {
        upstreamRes.pipe(res)
      }
    })

    upstreamReq.on('error', err => {
      // ECONNRESET / socket hang up on `destroy()` are expected when we
      // abort upstream after the player closes its range request - silence
      // those, only log unexpected ones.
      const code = (err as Error & { code?: string }).code
      if (code !== 'ECONNRESET' && code !== 'ERR_STREAM_PREMATURE_CLOSE' && !req.destroyed && !res.writableEnded) {
        console.error('[debrid-proxy] upstream error', err)
        try { res.writeHead(502, { 'access-control-allow-origin': '*' }); res.end(String(err)) } catch {}
      }
    })

    // Aggressively tear down the upstream socket the moment the player
    // disconnects, otherwise the CDN keeps streaming gigabytes we'll never
    // forward (Real-Debrid serves `bytes=N-` as N-to-EOF, which can be
    // 16+ GB per request - the v6.4.71 HAR showed a single request taking
    // 22 seconds because we kept consuming bytes after the player aborted).
    const abortUpstream = () => {
      try { upstreamReq.destroy() } catch {}
    }
    req.once('close', abortUpstream)
    req.once('aborted', abortUpstream)
    res.once('close', abortUpstream)
    upstreamReq.end()
  }

  // Convert a Node IncomingMessage to an AsyncIterable<Uint8Array> for
  // matroska-metadata's parseStream.
  async * _streamToAsyncIterable (stream: IncomingMessage): AsyncIterable<Uint8Array> {
    for await (const chunk of stream) {
      yield chunk as Uint8Array
    }
  }


  async _toDebridSource (id: string | ArrayBufferView): Promise<{ source: { kind: 'magnet', value: string } | { kind: 'torrent', value: Uint8Array }, hash: string }> {
    if (typeof id === 'string') {
      if (id.startsWith('magnet:')) {
        const match = /xt=urn:btih:([a-f0-9]{40}|[A-Z2-7]{32})/i.exec(id)
        return { source: { kind: 'magnet', value: id }, hash: match?.[1]?.toLowerCase() ?? '' }
      }
      if (/^[a-f0-9]{40}$/i.test(id) || /^[A-Z2-7]{32}$/i.test(id)) {
        const magnet = `magnet:?xt=urn:btih:${id}` + ANNOUNCE.map(a => `&tr=${encodeURIComponent(a)}`).join('')
        return { source: { kind: 'magnet', value: magnet }, hash: id.toLowerCase() }
      }
    }
    if (ArrayBuffer.isView(id)) {
      const buf = new Uint8Array(id.buffer, id.byteOffset, id.byteLength)
      // Best-effort hash extraction so library tracking still has a key.
      let hash = ''
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/await-thenable
        const parsed: any = await parseTorrent(buf)
        hash = parsed?.infoHash ?? ''
      } catch {}
      return { source: { kind: 'torrent', value: buf }, hash }
    }
    throw new Error('Unsupported torrent identifier for debrid playback')
  }

  _guessMime (name: string): string {
    const ext = name.toLowerCase().split('.').pop() ?? ''
    const map: Record<string, string> = {
      mkv: 'video/x-matroska',
      mp4: 'video/mp4',
      m4v: 'video/mp4',
      webm: 'video/webm',
      avi: 'video/x-msvideo',
      mov: 'video/quicktime',
      wmv: 'video/x-ms-wmv',
      flv: 'video/x-flv',
      ts: 'video/mp2t',
      mpg: 'video/mpeg',
      mpeg: 'video/mpeg',
      mp3: 'audio/mpeg',
      flac: 'audio/flac',
      aac: 'audio/aac',
      m4a: 'audio/mp4'
    }
    return map[ext] ?? 'application/octet-stream'
  }

  async rescanTorrents (hashes: string[]) {
    const tmpclient = new WebTorrent({
      dht: false,
      utPex: false,
      downloadLimit: 0,
      maxConns: 0,
      peerId,
      tracker: {},
      natUpnp: false,
      natPmp: false,
      utp: false
    })

    const promises: Array<Promise<void>> = []

    const cachedStore = this[store]

    const currentHash = this[client].torrents[0]?.infoHash

    for (const hash of hashes) {
      if (hash === currentHash) continue
      promises.push(
        (async () => {
          const storeData = await cachedStore.get(hash)
          if (!storeData) return
          const torrent = tmpclient.add(storeData.torrent, { path: this[path], announce: [], deselect: true, paused: true })

          await new Promise(resolve => torrent.once('ready', resolve))

          cachedStore.set(torrent.infoHash, structTorrent({
            // @ts-expect-error bad typedefs
            info: torrent.info,
            announce: torrent.announce,
            private: torrent.private,
            urlList: torrent.urlList,
            bitfield: torrent.bitfield!.buffer,
            date: Date.now(),
            mediaID: storeData.bencoded.mediaID,
            episode: storeData.bencoded.episode
          }))

          await new Promise(resolve => tmpclient.remove(torrent, { destroyStore: false }, resolve))
        })()
      )
    }

    await Promise.allSettled(promises)

    await new Promise(resolve => tmpclient.destroy(resolve))
  }

  async deleteTorrents (hashes: string[]) {
    const tmpclient = new WebTorrent({
      dht: false,
      utPex: false,
      downloadLimit: 0,
      maxConns: 0,
      peerId,
      tracker: {},
      natUpnp: false,
      natPmp: false,
      utp: false
    })

    const cachedStore = this[store]

    const promises: Array<Promise<void>> = []

    const currentHash = this[client].torrents[0]?.infoHash

    for (const hash of hashes) {
      if (hash === currentHash) continue
      promises.push(
        (async () => {
          const storeData = await cachedStore.get(hash)
          if (!storeData) return

          const torrent = tmpclient.add(storeData.torrent, { path: this[path], announce: [], deselect: true, paused: true, skipVerify: true })

          if (!torrent.ready) await new Promise(resolve => torrent.once('ready', resolve))

          await new Promise(resolve => tmpclient.remove(torrent, { destroyStore: true }, resolve))

          await cachedStore.delete(hash)
        })()
      )
    }

    await Promise.allSettled(promises)

    await new Promise(resolve => tmpclient.destroy(resolve))
  }

  async cached () {
    return await this[store].list()
  }

  // TODO: use https://www.npmjs.com/package/comlink-async-generator?activeTab=code
  async library () {
    const torrents: LibraryEntry[] = []
    for await (const { torrent, bencoded } of this[store].entries()) {
      const bitfield = new BitField(bencoded._bitfield ?? new Uint8Array(0))

      let downloaded = 0
      for (let index = 0, len = torrent.pieces.length; index < len; ++index) {
        if (bitfield.get(index)) { // verified data
          downloaded += (index === len - 1) ? torrent.lastPieceLength : torrent.pieceLength
        }
      }
      const progress = torrent.length ? downloaded / torrent.length : 0

      torrents.push({
        mediaID: bencoded.mediaID,
        episode: bencoded.episode,
        files: torrent.files.length,
        hash: torrent.infoHash,
        progress,
        date: bencoded.date,
        size: torrent.length,
        name: torrent.name
      })
    }
    return torrents
  }

  errors (cb: (errors: Error) => void) {
    this[client].on('error', err => cb(err))
    process.on('uncaughtException', err => cb(err))
  }

  debug (levels: string) {
    debug.disable()
    if (levels) debug.enable(levels)
  }

  torrents () {
    return this[client].torrents.map(t => this.makeStats(t))
  }

  async createNZBWebSeed (id: string, url: string, domain: string, port: number, login: string, password: string, poolSize: number) {
    const torrent = await this[client].get(id)
    if (!torrent) throw new Error('Torrent not found')

    await createNZB(torrent, url, domain, port, login, password, poolSize)
  }

  async torrentInfo (id: string): Promise<TorrentInfo> {
    const torrent = await this[client].get(id)
    if (torrent) return this.makeStats(torrent)
    // Debrid playback path: no real torrent, fabricate stats from the
    // proxy's byte counter so the UI's speed/progress bar reflects
    // actual debrid download throughput.
    const stats = this[debridStats]
    if (stats) return this._makeDebridStats(id, stats)
    throw new Error('Torrent not found')
  }

  _makeDebridStats (id: string, stats: DebridStats): TorrentInfo {
    const now = Date.now()
    // Recompute speed once per ~1s window so the value is responsive but
    // not jittery.
    if (now - stats.windowStart >= 1000 || stats.lastSpeedAt === 0) {
      const elapsed = (now - stats.windowStart) / 1000
      stats.lastSpeed = elapsed > 0 ? Math.round(stats.windowBytes / elapsed) : 0
      stats.lastSpeedAt = now
      stats.windowStart = now
      stats.windowBytes = 0
    }
    return {
      hash: id,
      name: stats.name,
      peers: { seeders: 0, leechers: 0, wires: 0 },
      progress: stats.size ? Math.min(stats.downloaded / stats.size, 1) : 0,
      speed: { down: stats.lastSpeed, up: 0 },
      size: { downloaded: stats.downloaded, uploaded: 0, total: stats.size },
      time: { remaining: stats.lastSpeed > 0 ? (stats.size - stats.downloaded) / stats.lastSpeed : 0, elapsed: 0 },
      pieces: { total: 0, size: 0 }
    }
  }

  async peerInfo (id: string) {
    const torrent = await this[client].get(id)

    // No peers when streaming via debrid - return empty list cleanly so
    // hayase.app's peer list panel doesn't error out.
    if (!torrent) {
      if (this[debridStats]) return []
      throw new Error('Torrent not found')
    }
    const peers: PeerInfo[] = torrent.wires.map(wire => {
      const flags: Array<'incoming' | 'outgoing' | 'utp' | 'encrypted'> = []

      const type = wire.type
      if (type.startsWith('utp')) flags.push('utp')
      flags.push(type.endsWith('Incoming') ? 'incoming' : 'outgoing')
      if (wire._cryptoHandshakeDone) flags.push('encrypted')

      const parsed = peerid(wire.peerId!)

      const progress = this._wireProgress(wire, torrent)

      return {
        ip: wire.type === 'webSeed' ? wire.domain : wire.remoteAddress.replace(/^::ffff:/, '') + ':' + wire.remotePort,
        seeder: wire.isSeeder,
        client: wire.type === 'webSeed' ? 'nntp' : `${parsed.client} ${parsed.version ?? ''}`,
        progress,
        size: {
          downloaded: wire.downloaded,
          uploaded: wire.uploaded
        },
        speed: {
          down: wire.downloadSpeed(),
          up: wire.uploadSpeed()
        },
        time: 0,
        flags
      }
    })

    return peers
  }

  async verifyDirectoryPermissions (path: string) {
    try {
      await access(path || this[tmp], constants.R_OK | constants.W_OK)
    } catch {
      throw new Error(`Insufficient permissions to access directory: ${path}`)
    }
  }

  _wireProgress (wire: Torrent['wires'][number], torrent: Torrent): number {
    if (!wire.peerPieces) return 0
    let downloaded = 0
    for (let index = 0, len = torrent.pieces.length; index < len; ++index) {
      if (wire.peerPieces.get(index)) { // verified data
        // @ts-expect-error bad typedefs
        downloaded += (index === len - 1) ? torrent.lastPieceLength : torrent.pieceLength
      }
    }
    // @ts-expect-error bad typedefs
    return torrent.length ? downloaded / torrent.length : 0
  }

  async fileInfo (id: string) {
    const torrent = await this[client].get(id)
    if (!torrent) {
      if (this[debridStats]) {
        const s = this[debridStats]
        return [{ name: s.name, size: s.size, progress: s.size ? s.downloaded / s.size : 0, selections: 1 }]
      }
      throw new Error('Torrent not found')
    }
    return torrent.files.map(({ name, length, progress, _iterators }) => ({
      name,
      size: length,
      progress,
      selections: _iterators.size
    }))
  }

  async protocolStatus (id: string) {
    const torrent = await this[client].get(id)
    if (!torrent) {
      if (this[debridStats]) {
        return { dht: false, lsd: false, pex: false, nat: false, forwarding: false, persisting: false, streaming: true }
      }
      throw new Error('Torrent not found')
    }
    return {
      dht: !!this[client].dhtPort,
      lsd: !!torrent.discovery?.lsd?.server,
      pex: !torrent.private,
      nat: !!this[client].natTraversal?._pmpClient && !!this[client].natTraversal?._upnpClient, //! !await this[client].natTraversal?.externalIp(),
      forwarding: !!torrent._peers.values().find(peer => peer.type === 'utpIncoming' || peer.type === 'tcpIncoming'),
      persisting: !!this.persist,
      streaming: !!torrent._startAsDeselected
    }
  }

  makeStats (torrent: Torrent): TorrentInfo {
    const seeders = torrent.wires.filter(wire => wire.isSeeder).length
    const leechers = torrent.wires.length - seeders
    const wires = torrent._peersLength
    // @ts-expect-error bad typedefs
    const { infoHash: hash, timeRemaining: remaining, length: total, name, progress, downloadSpeed: down, uploadSpeed: up, downloaded, uploaded, pieces, pieceLength } = torrent

    return {
      hash,
      name,
      peers: {
        seeders, leechers, wires
      },
      progress,
      speed: {
        down,
        up
      },
      size: {
        downloaded,
        uploaded,
        total
      },
      time: {
        remaining,
        elapsed: 0
      },
      pieces: {
        total: pieces.length,
        size: pieceLength
      }
    }
  }

  listenDisplay (cb: (displays: Array<{ friendlyName: string, host: string }>) => void) {
    const emit = () => cb([...Object.values(this.chromecasts.casts), ...Object.values(this.dlnas.displays)])

    this.chromecasts.listen(emit)
    this.dlnas.listen(emit)
  }

  playDisplay (host: string, hash: string, id: number, media: MediaInformation) {
    if (host.startsWith('cast://')) {
      return this.chromecasts.play(host.substring(7), hash, id, media)
    } else if (host.startsWith('dlna://')) {
      return this.dlnas.play(host.substring(7), hash, id, media)
    }
  }

  closeDisplay (host: string) {
    if (host.startsWith('cast://')) {
      return this.chromecasts.close(host.substring(7))
    } else if (host.startsWith('dlna://')) {
      return this.dlnas.close(host.substring(7))
    }
  }

  async destroy () {
    await Promise.all([
      this.attachments.destroy(),
      this.chromecasts.destroy(),
      this.dlnas.destroy(),
      new Promise(resolve => this[client].destroy(resolve)),
      new Promise(resolve => tracker.destroy(resolve)),
      this[debridProxy] ? new Promise<void>(resolve => this[debridProxy]!.close(() => resolve())) : Promise.resolve()
    ])
    this[doh]?.destroy()
    exit()
  }
}
