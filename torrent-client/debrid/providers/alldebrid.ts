import { DebridError, type DebridFile, type DebridProvider, type DebridStage, type DebridTorrent } from '../types.ts'

import type { DebridStatus } from 'native'

const BASE = 'https://api.alldebrid.com/v4'
const AGENT = 'hayase'

interface ADUser {
  username: string
  isPremium: boolean
  premiumUntil: number
}

interface ADMagnetUploadEntry {
  magnet: string
  hash: string
  name: string
  filename_original?: string
  size: number
  ready: boolean
  id: number
  error?: { code: string, message: string }
}

interface ADMagnetStatus {
  id: number
  filename: string
  size: number
  hash: string
  status: string
  statusCode: number
  downloaded: number
  uploaded: number
  seeders: number
  downloadSpeed: number
  uploadSpeed: number
  type: 'm' | 't'
  files: Array<ADMagnetFile>
  links: Array<{ link: string, filename: string, size: number }>
}

interface ADMagnetFile {
  n: string // name
  s?: number // size
  l?: string // link
  e?: ADMagnetFile[] // children
}

function flattenFiles (files: ADMagnetFile[], prefix = ''): DebridFile[] {
  const out: DebridFile[] = []
  let i = 0
  for (const f of files) {
    const p = prefix ? `${prefix}/${f.n}` : f.n
    if (f.e) {
      out.push(...flattenFiles(f.e, p))
    } else {
      out.push({
        id: p, // AllDebrid doesn't expose stable IDs - use the path
        name: f.n,
        path: p,
        size: f.s ?? 0,
        selected: true
      })
    }
    i++
  }
  return out
}

function mapStage (statusCode: number): DebridStage {
  // AllDebrid status codes: https://docs.alldebrid.com/#status-codes
  // 0..3 = pending/downloading, 4 = ready, 5+ = error
  if (statusCode === 4) return 'ready'
  if (statusCode < 4) return 'downloading'
  return 'error'
}

export default class AllDebridProvider implements DebridProvider {
  id = 'alldebrid' as const
  name = 'AllDebrid'

  #apiKey: string

  constructor (apiKey: string) {
    if (!apiKey) throw new DebridError('Missing AllDebrid API key', { provider: 'alldebrid' })
    this.#apiKey = apiKey
  }

  async #request<T> (path: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(BASE + path)
    url.searchParams.set('agent', AGENT)
    url.searchParams.set('apikey', this.#apiKey)
    const res = await fetch(url.toString(), init)
    const text = await res.text()
    let data: { status?: 'success' | 'error', data?: unknown, error?: { code?: string, message: string } } | undefined
    try { data = text ? JSON.parse(text) : undefined } catch {
      throw new DebridError('AllDebrid: unparseable response', { provider: 'alldebrid', status: res.status })
    }
    if (!res.ok || data?.status !== 'success') {
      throw new DebridError(`AllDebrid: ${data?.error?.message ?? res.statusText}`, {
        provider: 'alldebrid',
        status: res.status,
        code: data?.error?.code
      })
    }
    return data.data as T
  }

  async checkAuth (): Promise<DebridStatus> {
    const { user } = await this.#request<{ user: ADUser }>('/user')
    return {
      provider: this.id,
      user: user.username,
      premium: user.isPremium,
      expiration: user.premiumUntil ? user.premiumUntil * 1000 : undefined
    }
  }

  async #upload (magnetOrFile: { magnet?: string, file?: { data: Uint8Array, name: string } }): Promise<number> {
    if (magnetOrFile.magnet) {
      const url = new URL(BASE + '/magnet/upload')
      url.searchParams.set('agent', AGENT)
      url.searchParams.set('apikey', this.#apiKey)
      url.searchParams.append('magnets[]', magnetOrFile.magnet)
      const res = await fetch(url.toString())
      const json = await res.json() as { status?: string, data?: { magnets: ADMagnetUploadEntry[] }, error?: { message: string } }
      if (json.status !== 'success') throw new DebridError(`AllDebrid: ${json.error?.message ?? 'upload failed'}`, { provider: 'alldebrid' })
      const entry = json.data?.magnets?.[0]
      if (!entry) throw new DebridError('AllDebrid: empty upload response', { provider: 'alldebrid' })
      if (entry.error) throw new DebridError(`AllDebrid: ${entry.error.message}`, { provider: 'alldebrid', code: entry.error.code })
      return entry.id
    } else if (magnetOrFile.file) {
      const url = new URL(BASE + '/magnet/upload/file')
      url.searchParams.set('agent', AGENT)
      url.searchParams.set('apikey', this.#apiKey)
      const form = new FormData()
      form.append('files[]', new Blob([magnetOrFile.file.data], { type: 'application/x-bittorrent' }), magnetOrFile.file.name)
      const res = await fetch(url.toString(), { method: 'POST', body: form })
      const json = await res.json() as { status?: string, data?: { files: ADMagnetUploadEntry[] }, error?: { message: string } }
      if (json.status !== 'success') throw new DebridError(`AllDebrid: ${json.error?.message ?? 'upload failed'}`, { provider: 'alldebrid' })
      const entry = json.data?.files?.[0]
      if (!entry) throw new DebridError('AllDebrid: empty upload response', { provider: 'alldebrid' })
      if (entry.error) throw new DebridError(`AllDebrid: ${entry.error.message}`, { provider: 'alldebrid', code: entry.error.code })
      return entry.id
    }
    throw new DebridError('AllDebrid: nothing to upload', { provider: 'alldebrid' })
  }

  async addMagnet (magnet: string): Promise<DebridTorrent> {
    const id = await this.#upload({ magnet })
    return await this.getInfo(String(id))
  }

  async addTorrent (data: Uint8Array): Promise<DebridTorrent> {
    const id = await this.#upload({ file: { data, name: 'hayase.torrent' } })
    return await this.getInfo(String(id))
  }

  async getInfo (id: string): Promise<DebridTorrent> {
    const { magnets } = await this.#request<{ magnets: ADMagnetStatus | ADMagnetStatus[] }>(`/magnet/status?id=${encodeURIComponent(id)}`)
    const magnet = Array.isArray(magnets) ? magnets[0] : magnets
    if (!magnet) throw new DebridError(`AllDebrid: torrent ${id} not found`, { provider: 'alldebrid' })

    const files = magnet.files ? flattenFiles(magnet.files) : []
    // Map links onto files when shapes match (AllDebrid lists links in the same
    // traversal order as the file tree).
    const links = magnet.links ?? []
    return {
      id: String(magnet.id),
      hash: magnet.hash.toLowerCase(),
      name: magnet.filename,
      status: mapStage(magnet.statusCode),
      progress: magnet.size ? magnet.downloaded / magnet.size : 0,
      files,
      links: links.map(l => l.link),
      raw: magnet
    }
  }

  async selectAllFiles (): Promise<void> {
    // AllDebrid auto-selects everything.
  }

  async unlock (link: string): Promise<string> {
    const url = new URL(BASE + '/link/unlock')
    url.searchParams.set('agent', AGENT)
    url.searchParams.set('apikey', this.#apiKey)
    url.searchParams.set('link', link)
    const res = await fetch(url.toString())
    const json = await res.json() as { status?: string, data?: { link: string }, error?: { message: string, code?: string } }
    if (json.status !== 'success' || !json.data?.link) {
      throw new DebridError(`AllDebrid: ${json.error?.message ?? 'unlock failed'}`, { provider: 'alldebrid', code: json.error?.code })
    }
    return json.data.link
  }
}
