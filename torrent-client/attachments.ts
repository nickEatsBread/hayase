import { createServer } from 'node:http'

import Metadata from 'matroska-metadata'
import networkAddress from 'network-address'

import type EventEmitter from 'node:events'
import type { AddressInfo } from 'node:net'

// Minimal File-like that matroska-metadata can parse via its
// `file[Symbol.asyncIterator]({ start })` interface (the same shape
// WebTorrent's File exposes when slice() isn't available - see
// matroska-metadata/src/util.js getFileStream()). Each iteration issues
// a Range request to the upstream debrid CDN starting at the requested
// byte offset, so getSegment / getSeekHead / getTracks / getAttachments
// / getChapters all work without ever buffering the full file locally.
class DebridFile {
  name: string
  size: number
  url: string
  // Matches WebTorrent's File API field. matroska-metadata reads `size`
  // (used to compute timecode windows in some paths).
  get length () { return this.size }

  constructor (url: string, name: string, size: number) {
    this.url = url
    this.name = name
    this.size = size
  }

  async * [Symbol.asyncIterator] (opts: { start?: number, end?: number } = {}): AsyncGenerator<Uint8Array, void, void> {
    const start = opts.start ?? 0
    const range = opts.end != null ? `bytes=${start}-${opts.end}` : `bytes=${start}-`
    // matroska-metadata frequently reads only the first few KB looking for a
    // specific EBML tag and then stops iterating. We need to abort the fetch
    // when that happens so the debrid CDN doesn't keep streaming gigabytes
    // we'll never read. Async generator's `finally` runs on early
    // `return()` (which `for-await-of` calls implicitly on break/return).
    const controller = new AbortController()
    try {
      const res = await fetch(this.url, {
        headers: {
          range,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
          accept: '*/*'
        },
        redirect: 'follow',
        signal: controller.signal
      })
      if (!res.ok && res.status !== 206) throw new Error(`Debrid file fetch failed: ${res.status} for ${this.url}`)
      if (!res.body) return
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        yield chunk
      }
    } finally {
      controller.abort()
    }
  }
}

export default new class Attachments {
  destroyed = false
  filemap = new Map<string, File & EventEmitter>()
  metadatamap = new Map<File & EventEmitter, Metadata & EventEmitter>()
  server = createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url!, 'http://localhost')
      const [hashid, number] = pathname.split('/').slice(1)
      if (!hashid || !number) throw new Error('Invalid request')

      const file = this.filemap.get(hashid)
      if (!file) throw new Error('File not found')

      const metadata = this.metadatamap.get(file)
      if (!metadata) throw new Error('Metadata not found')

      const attachment = (await metadata.getAttachments())[Number(number)]
      if (!attachment) throw new Error('Attachment not found')

      res.writeHead(200, { 'Content-Type': attachment.mimetype, 'Access-Control-Allow-Origin': '*' })
      res.end(attachment.data)
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
  }).listen()

  _metadata (hash: string, id: number) {
    const file = this.filemap.get(hash + id)
    if (!file) return
    const meta = this.metadatamap.get(file)
    if (meta) return meta
    const metadata = new Metadata(file) as Metadata & EventEmitter
    this.metadatamap.set(file, metadata)
    return metadata
  }

  subtitle (hash: string, id: number, cb: (subtitle: { text: string, time: number, duration: number }, trackNumber: number) => void) {
    const metadata = this._metadata(hash, id)
    if (!metadata) throw new Error('File not found')
    metadata.removeAllListeners('subtitle')
    metadata.on('subtitle', (a, b) => cb(a, b))
  }

  register (files: Array<File & EventEmitter>, hash: string) {
    this.filemap.clear()
    this.debridUrlToKey.clear()
    files.forEach((file, id) => {
      if (file.name.endsWith('.mkv') || file.name.endsWith('.webm')) {
        this.filemap.set(hash + id, file)
        file.on('iterator', ({ iterator }: { iterator: AsyncIterable<Uint8Array> }, cb: (it: AsyncIterable<Uint8Array>) => void) => {
          if (this.destroyed) return cb(iterator)
          cb(this._metadata(hash, id)?.parseStream(iterator) ?? iterator)
        })
      }
    })
  }

  // Map of upstream debrid URL -> "hash + id" key into filemap. Used by the
  // debrid HTTP proxy to feed the bytes it streams from the CDN through
  // matroska-metadata for the registered file.
  debridUrlToKey = new Map<string, string>()

  // Called by torrent-client when starting a debrid playback. Registers a
  // DebridFile (a minimal async-iterable File-like that issues HTTP Range
  // requests against the upstream debrid URL) so the existing _metadata /
  // attachments / tracks / subtitle / chapters methods all work the same
  // way they do for torrents.
  //
  // Also kicks off a background read of the entire file from byte 0 piped
  // through metadata.parseStream. This is what fires 'subtitle' events as
  // playback progresses - subtitle BlockGroups live inside cluster sections
  // scattered throughout the file, NOT in the header, so we need a steady
  // stream of bytes from the start to extract them. This effectively double-
  // downloads the file (once for metadata, once for the player), which is
  // the trade-off for getting live subtitle events from a CDN that only
  // exposes random-access HTTP.
  registerDebrid (debridUrl: string, hash: string, id: number, name: string, size: number) {
    if (!name.endsWith('.mkv') && !name.endsWith('.webm')) return
    const key = hash + id
    const file = new DebridFile(debridUrl, name, size) as unknown as File & EventEmitter
    this.filemap.set(key, file)
    this.debridUrlToKey.set(debridUrl, key)
    this._startBackgroundParse(file).catch(err => console.error('[debrid bg parse]', err))
  }

  // Token for the currently-active background parse. Held so that registering
  // a new debrid file cancels any prior in-flight parse before starting a
  // new one (otherwise an old episode's parse would keep eating bandwidth).
  #activeParseToken: object | null = null

  async _startBackgroundParse (file: File & EventEmitter) {
    const token = {}
    this.#activeParseToken = token
    const metadata = this.metadatamap.get(file) ?? new Metadata(file) as Metadata & EventEmitter
    if (!this.metadatamap.has(file)) this.metadatamap.set(file, metadata)
    const it = (file as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
    try {
      const wrapped = metadata.parseStream(it as unknown as AsyncIterable<Uint8Array>) as AsyncIterable<Uint8Array>
      for await (const _ of wrapped) {
        if (this.destroyed) return
        if (this.#activeParseToken !== token) return // cancelled by a newer playback
      }
    } catch (err) {
      if ((err as Error & { name?: string }).name !== 'AbortError') {
        console.error('[debrid bg parse] error', err)
      }
    } finally {
      // Make sure the underlying generator (which holds the AbortController)
      // gets a chance to clean up its fetch when we exit the loop early.
      try { await (it as { return?: () => Promise<unknown> }).return?.() } catch {}
    }
  }

  async attachments (hash: string, id: number) {
    const metadata = this._metadata(hash, id)
    if (!metadata) throw new Error('File not found')

    const lan = networkAddress()
    return (await metadata.getAttachments()).map(({ filename, mimetype }, number) => {
      const suffix = ':' + (this.server.address() as AddressInfo).port + '/' + hash + id + '/' + number
      return { filename, mimetype, id, url: 'http://localhost' + suffix, lan: 'http://' + lan + suffix }
    })
  }

  chapters (hash: string, id: number) {
    const metadata = this._metadata(hash, id)
    if (!metadata) throw new Error('File not found')
    return metadata.getChapters()
  }

  tracks (hash: string, id: number) {
    const metadata = this._metadata(hash, id)
    if (!metadata) throw new Error('File not found')
    return metadata.getTracks() as Promise<Array<{ number: string, language?: string, type: string, header: string }>>
  }

  async destroy () {
    this.destroyed = true
    await new Promise(resolve => this.server.close(resolve))
  }
}()
