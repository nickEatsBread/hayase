import { DebridError, type DebridFile, type DebridProvider, type DebridStage, type DebridTorrent } from '../types.ts'

import type { DebridStatus } from 'native'

const BASE = 'https://api.torbox.app/v1/api'

interface TBUser {
  email: string
  plan: number
  premium_expires_at?: string
}

interface TBFile {
  id: number
  md5?: string
  hash?: string
  name: string
  size: number
  short_name?: string
  s3_path?: string
  mimetype?: string
}

interface TBTorrent {
  id: number
  hash: string
  name: string
  size: number
  download_state: string
  download_finished: boolean
  download_present: boolean
  active: boolean
  progress: number
  files: TBFile[]
}

function mapStage (t: TBTorrent): DebridStage {
  if (t.download_finished || t.download_present) return 'ready'
  if (t.active || (t.download_state ?? '').toLowerCase().includes('downloading') || (t.download_state ?? '').toLowerCase().includes('queued')) return 'downloading'
  if ((t.download_state ?? '').toLowerCase().includes('error') || (t.download_state ?? '').toLowerCase().includes('dead')) return 'error'
  return 'downloading'
}

export default class TorBoxProvider implements DebridProvider {
  id = 'torbox' as const
  name = 'TorBox'

  #apiKey: string

  constructor (apiKey: string) {
    if (!apiKey) throw new DebridError('Missing TorBox API key', { provider: 'torbox' })
    this.#apiKey = apiKey
  }

  async #request<T> (path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(BASE + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        ...(init.headers ?? {})
      }
    })
    const text = await res.text()
    let data: { success?: boolean, detail?: string, data?: unknown, error?: string } | undefined
    try { data = text ? JSON.parse(text) : undefined } catch {
      throw new DebridError('TorBox: unparseable response', { provider: 'torbox', status: res.status })
    }
    if (!res.ok || data?.success === false) {
      throw new DebridError(`TorBox: ${data?.error ?? data?.detail ?? res.statusText}`, { provider: 'torbox', status: res.status })
    }
    return data?.data as T
  }

  async checkAuth (): Promise<DebridStatus> {
    const user = await this.#request<TBUser>('/user/me')
    return {
      provider: this.id,
      user: user.email,
      premium: user.plan > 0,
      expiration: user.premium_expires_at ? +new Date(user.premium_expires_at) : undefined
    }
  }

  async addMagnet (magnet: string): Promise<DebridTorrent> {
    const form = new FormData()
    form.append('magnet', magnet)
    const created = await this.#request<{ torrent_id: number, hash: string }>('/torrents/createtorrent', { method: 'POST', body: form })
    return await this.getInfo(String(created.torrent_id))
  }

  async addTorrent (data: Uint8Array): Promise<DebridTorrent> {
    const form = new FormData()
    form.append('file', new Blob([data], { type: 'application/x-bittorrent' }), 'hayase.torrent')
    const created = await this.#request<{ torrent_id: number, hash: string }>('/torrents/createtorrent', { method: 'POST', body: form })
    return await this.getInfo(String(created.torrent_id))
  }

  async getInfo (id: string): Promise<DebridTorrent> {
    const list = await this.#request<TBTorrent[]>(`/torrents/mylist?bypass_cache=true&id=${encodeURIComponent(id)}`)
    const item = Array.isArray(list) ? list.find(t => String(t.id) === id) ?? list[0] : list as unknown as TBTorrent
    if (!item) throw new DebridError(`TorBox: torrent ${id} not found`, { provider: 'torbox' })
    const files: DebridFile[] = (item.files ?? []).map(f => ({
      id: f.id,
      name: f.short_name ?? f.name,
      path: f.name,
      size: f.size,
      selected: true
    }))
    return {
      id: String(item.id),
      hash: item.hash?.toLowerCase() ?? '',
      name: item.name,
      status: mapStage(item),
      progress: item.progress ?? 0,
      files,
      links: files.map(f => `tb://${item.id}/${f.id}`),
      raw: item
    }
  }

  async selectAllFiles (): Promise<void> {
    // TorBox auto-selects everything.
  }

  async unlock (link: string): Promise<string> {
    // TorBox uses tb://torrentId/fileId pseudo-links built in getInfo above.
    const match = /^tb:\/\/(\d+)\/(\d+)$/.exec(link)
    if (!match) throw new DebridError(`TorBox: invalid link ${link}`, { provider: 'torbox' })
    const [, torrentId, fileId] = match
    const url = new URL(BASE + '/torrents/requestdl')
    url.searchParams.set('token', this.#apiKey)
    url.searchParams.set('torrent_id', torrentId!)
    url.searchParams.set('file_id', fileId!)
    const res = await fetch(url.toString())
    const text = await res.text()
    let data: { success?: boolean, data?: string, detail?: string } | undefined
    try { data = text ? JSON.parse(text) : undefined } catch {}
    if (!res.ok || !data?.data) throw new DebridError(`TorBox: ${data?.detail ?? res.statusText}`, { provider: 'torbox', status: res.status })
    return data.data
  }
}
