import { DebridError, type DebridFile, type DebridProvider, type DebridStage, type DebridTorrent } from '../types.ts'

import type { DebridStatus } from 'native'

const BASE = 'https://www.premiumize.me/api'

interface PMAccountInfo {
  status: 'success' | 'error'
  customer_id: string
  premium_until: number
  limit_used: number
  message?: string
}

interface PMTransfer {
  id: string
  name: string
  message?: string
  status: 'queued' | 'waiting' | 'running' | 'finished' | 'seeding' | 'error' | 'timeout' | 'deleted'
  progress?: number
  src?: string
  folder_id?: string
  file_id?: string
}

interface PMItem {
  id: string
  name: string
  type: 'folder' | 'file'
  size?: number
  link?: string
  stream_link?: string
}

function mapStage (s: PMTransfer['status']): DebridStage {
  if (s === 'finished' || s === 'seeding') return 'ready'
  if (s === 'queued' || s === 'waiting' || s === 'running') return 'downloading'
  return 'error'
}

export default class PremiumizeProvider implements DebridProvider {
  id = 'premiumize' as const
  name = 'Premiumize'

  #apiKey: string

  constructor (apiKey: string) {
    if (!apiKey) throw new DebridError('Missing Premiumize API key', { provider: 'premiumize' })
    this.#apiKey = apiKey
  }

  async #form (path: string, fields: Record<string, string | Blob | undefined>): Promise<unknown> {
    const url = new URL(BASE + path)
    url.searchParams.set('apikey', this.#apiKey)
    const body = new FormData()
    for (const [k, v] of Object.entries(fields)) {
      if (v == null) continue
      body.append(k, v)
    }
    const res = await fetch(url.toString(), { method: 'POST', body })
    const data = await res.json() as { status?: string, message?: string }
    if (!res.ok || data.status === 'error') {
      throw new DebridError(`Premiumize: ${data.message ?? res.statusText}`, { provider: 'premiumize', status: res.status })
    }
    return data
  }

  async #get<T> (path: string, params: Record<string, string | undefined> = {}): Promise<T> {
    const url = new URL(BASE + path)
    url.searchParams.set('apikey', this.#apiKey)
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v)
    const res = await fetch(url.toString())
    const data = await res.json() as { status?: string, message?: string } & Record<string, unknown>
    if (!res.ok || data.status === 'error') {
      throw new DebridError(`Premiumize: ${data.message ?? res.statusText}`, { provider: 'premiumize', status: res.status })
    }
    return data as T
  }

  async checkAuth (): Promise<DebridStatus> {
    const info = await this.#get<PMAccountInfo>('/account/info')
    return {
      provider: this.id,
      user: info.customer_id,
      premium: info.premium_until > Date.now() / 1000,
      expiration: info.premium_until ? info.premium_until * 1000 : undefined
    }
  }

  async addMagnet (magnet: string): Promise<DebridTorrent> {
    const res = await this.#form('/transfer/create', { src: magnet }) as PMTransfer & { id: string }
    return await this.getInfo(res.id)
  }

  async addTorrent (data: Uint8Array): Promise<DebridTorrent> {
    const res = await this.#form('/transfer/create', { file: new Blob([data], { type: 'application/x-bittorrent' }) }) as PMTransfer & { id: string }
    return await this.getInfo(res.id)
  }

  async getInfo (id: string): Promise<DebridTorrent> {
    const list = await this.#get<{ transfers: PMTransfer[] }>('/transfer/list')
    const transfer = list.transfers.find(t => t.id === id)
    if (!transfer) throw new DebridError(`Premiumize: transfer ${id} not found`, { provider: 'premiumize' })

    let files: DebridFile[] = []
    let links: string[] = []
    const folderId = transfer.folder_id
    if (transfer.status === 'finished' || transfer.status === 'seeding') {
      if (folderId) {
        const folder = await this.#get<{ content: PMItem[] }>('/folder/list', { id: folderId })
        const flat = await this.#walk(folder.content)
        files = flat.map(f => ({ id: f.id, name: f.name, path: f.name, size: f.size ?? 0, selected: true }))
        links = flat.map(f => f.stream_link ?? f.link ?? '').filter(Boolean)
      } else if (transfer.file_id) {
        const item = await this.#get<{ stream_link?: string, link?: string, size?: number, name?: string }>('/item/details', { id: transfer.file_id })
        files = [{ id: transfer.file_id, name: item.name ?? transfer.name, path: item.name ?? transfer.name, size: item.size ?? 0, selected: true }]
        links = [item.stream_link ?? item.link ?? '']
      }
    }

    return {
      id: transfer.id,
      hash: this.#extractHash(transfer.src) ?? '',
      name: transfer.name,
      status: mapStage(transfer.status),
      progress: transfer.progress ?? (transfer.status === 'finished' ? 1 : 0),
      files,
      links,
      raw: transfer
    }
  }

  async #walk (items: PMItem[]): Promise<PMItem[]> {
    const out: PMItem[] = []
    for (const item of items) {
      if (item.type === 'folder') {
        const sub = await this.#get<{ content: PMItem[] }>('/folder/list', { id: item.id })
        out.push(...await this.#walk(sub.content))
      } else {
        out.push(item)
      }
    }
    return out
  }

  #extractHash (src?: string): string | undefined {
    if (!src) return
    const match = /xt=urn:btih:([a-f0-9]{40}|[A-Z2-7]{32})/i.exec(src)
    return match?.[1]?.toLowerCase()
  }

  async selectAllFiles (): Promise<void> {
    // Premiumize doesn't support selective file downloading.
  }

  async unlock (link: string): Promise<string> {
    // Premiumize stream links are already directly streamable.
    return link
  }
}
