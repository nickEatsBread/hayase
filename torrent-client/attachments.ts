import { createServer } from 'node:http'

import Metadata from 'matroska-metadata'
import networkAddress from 'network-address'

import type EventEmitter from 'node:events'
import type { AddressInfo } from 'node:net'

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

  // Called by torrent-client when starting a debrid playback. We register a
  // fake File-like so the existing _metadata / attachments / tracks /
  // subtitle / chapters methods all work the same way they do for torrents.
  registerDebrid (debridUrl: string, hash: string, id: number, name: string) {
    if (!name.endsWith('.mkv') && !name.endsWith('.webm')) return
    const key = hash + id
    const fake = Object.assign(Object.create(null) as Record<string, unknown>, { name }) as unknown as File & EventEmitter
    this.filemap.set(key, fake)
    this.debridUrlToKey.set(debridUrl, key)
  }

  // Called by the proxy as bytes flow from the debrid CDN. Returns a wrapped
  // async iterable that the proxy should pipe to the client; matroska-metadata
  // parses these bytes inline so getTracks / getAttachments / getChapters
  // resolve and 'subtitle' events fire as the player streams.
  feedDebrid (debridUrl: string, iterator: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
    const key = this.debridUrlToKey.get(debridUrl)
    if (!key) return iterator
    const file = this.filemap.get(key)
    if (!file) return iterator
    let metadata = this.metadatamap.get(file)
    if (!metadata) {
      metadata = new Metadata(file) as Metadata & EventEmitter
      this.metadatamap.set(file, metadata)
    }
    try { return (metadata.parseStream(iterator) ?? iterator) as AsyncIterable<Uint8Array> } catch { return iterator }
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
