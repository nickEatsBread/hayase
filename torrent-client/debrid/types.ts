import type { DebridProviderId, DebridStatus } from 'native'

export type { DebridProviderId, DebridStatus }

export type DebridStage = 'queued' | 'downloading' | 'ready' | 'error'

export interface DebridFile {
  id: number | string
  name: string
  size: number
  selected: boolean
  // path within the torrent (e.g. "Anime/episode 01.mkv"). Optional - some
  // providers only return flat file lists.
  path?: string
}

export interface DebridTorrent {
  id: string
  hash: string
  name: string
  status: DebridStage
  progress: number
  files: DebridFile[]
  // Provider-specific raw payload, useful for unlocking links etc.
  links?: string[]
  raw?: unknown
}

export class DebridError extends Error {
  provider: DebridProviderId
  status?: number
  code?: string
  constructor (message: string, opts: { provider: DebridProviderId, status?: number, code?: string, cause?: unknown }) {
    super(message)
    this.provider = opts.provider
    this.status = opts.status
    this.code = opts.code
    if (opts.cause) (this as Error & { cause?: unknown }).cause = opts.cause
  }
}

export interface DebridProvider {
  id: DebridProviderId
  name: string

  // Verify the API key. Throws on failure.
  checkAuth (): Promise<DebridStatus>

  // Submit a magnet/hash to the provider, returns provider torrent id + initial state.
  addMagnet (magnet: string): Promise<DebridTorrent>

  // Submit a .torrent file's raw bytes.
  addTorrent (data: Uint8Array): Promise<DebridTorrent>

  // Poll provider for current torrent state.
  getInfo (id: string): Promise<DebridTorrent>

  // Tell the provider we want every video file (some providers require explicit
  // file selection before they start downloading).
  selectAllFiles (id: string, files: DebridFile[]): Promise<void>

  // Convert a restricted/cached link into a streamable HTTP URL.
  unlock (link: string): Promise<string>

  // Free per-instance resources (clear timers, close sockets, etc.).
  destroy?: () => void
}
