import { DebridError, type DebridFile, type DebridProvider, type DebridStage, type DebridTorrent } from '../types.ts'

import type { DebridStatus } from 'native'

const BASE = 'https://api.real-debrid.com/rest/1.0'

interface RDTorrentInfo {
  id: string
  filename: string
  hash: string
  bytes: number
  progress: number
  status: 'magnet_error' | 'magnet_conversion' | 'waiting_files_selection' | 'queued' | 'downloading' | 'downloaded' | 'error' | 'virus' | 'compressing' | 'uploading' | 'dead'
  files: Array<{ id: number, path: string, bytes: number, selected: 0 | 1 }>
  links: string[]
}

function mapStage (s: RDTorrentInfo['status']): DebridStage {
  if (s === 'downloaded') return 'ready'
  if (s === 'downloading' || s === 'compressing' || s === 'uploading' || s === 'queued' || s === 'magnet_conversion') return 'downloading'
  if (s === 'waiting_files_selection') return 'queued'
  return 'error'
}

function mapTorrent (info: RDTorrentInfo): DebridTorrent {
  const files: DebridFile[] = info.files.map(f => ({
    id: f.id,
    name: f.path.split('/').pop() ?? f.path,
    path: f.path,
    size: f.bytes,
    selected: f.selected === 1
  }))
  return {
    id: info.id,
    hash: info.hash.toLowerCase(),
    name: info.filename,
    status: mapStage(info.status),
    progress: (info.progress ?? 0) / 100,
    files,
    links: info.links,
    raw: info
  }
}

export default class RealDebridProvider implements DebridProvider {
  id = 'realdebrid' as const
  name = 'Real-Debrid'

  #apiKey: string

  constructor (apiKey: string) {
    if (!apiKey) throw new DebridError('Missing Real-Debrid API key', { provider: 'realdebrid' })
    this.#apiKey = apiKey
  }

  async #request<T> (path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(BASE + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        ...(init.body && !(init.body instanceof FormData) && !(init.body instanceof URLSearchParams) ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {})
      }
    })
    if (res.status === 204) return undefined as unknown as T
    const text = await res.text()
    let data: unknown
    try { data = text ? JSON.parse(text) : undefined } catch { data = text }
    if (!res.ok) {
      const err = data as { error?: string, error_code?: number } | undefined
      throw new DebridError(`Real-Debrid: ${err?.error ?? res.statusText}`, {
        provider: 'realdebrid',
        status: res.status,
        code: err?.error_code != null ? String(err.error_code) : undefined
      })
    }
    return data as T
  }

  async checkAuth (): Promise<DebridStatus> {
    const user = await this.#request<{ username: string, type: 'free' | 'premium', expiration?: string }>('/user')
    return {
      provider: this.id,
      user: user.username,
      premium: user.type === 'premium',
      expiration: user.expiration ? +new Date(user.expiration) : undefined
    }
  }

  async addMagnet (magnet: string): Promise<DebridTorrent> {
    const body = new URLSearchParams({ magnet })
    const res = await this.#request<{ id: string }>('/torrents/addMagnet', { method: 'POST', body })
    return await this.getInfo(res.id)
  }

  async addTorrent (data: Uint8Array): Promise<DebridTorrent> {
    const res = await this.#request<{ id: string }>('/torrents/addTorrent', {
      method: 'PUT',
      body: data,
      headers: { 'Content-Type': 'application/x-bittorrent' }
    })
    return await this.getInfo(res.id)
  }

  async getInfo (id: string): Promise<DebridTorrent> {
    const info = await this.#request<RDTorrentInfo>(`/torrents/info/${id}`)
    return mapTorrent(info)
  }

  async selectAllFiles (id: string, files: DebridFile[]): Promise<void> {
    // Pick video files when available, otherwise fall back to all files.
    const videoFiles = files.filter(f => /\.(mkv|mp4|avi|webm|mov|flv|wmv|m4v|ts|mpg|mpeg)$/i.test(f.name))
    const target = videoFiles.length ? videoFiles : files
    const body = new URLSearchParams({ files: target.map(f => f.id).join(',') || 'all' })
    await this.#request(`/torrents/selectFiles/${id}`, { method: 'POST', body })
  }

  async unlock (link: string): Promise<string> {
    const body = new URLSearchParams({ link })
    const res = await this.#request<{ download: string }>('/unrestrict/link', { method: 'POST', body })
    return res.download
  }
}
