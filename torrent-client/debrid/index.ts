import AllDebridProvider from './providers/alldebrid.ts'
import PremiumizeProvider from './providers/premiumize.ts'
import RealDebridProvider from './providers/realdebrid.ts'
import TorBoxProvider from './providers/torbox.ts'
import { DebridError, type DebridFile, type DebridProvider, type DebridProviderId, type DebridStatus, type DebridTorrent } from './types.ts'

export { DebridError, type DebridFile, type DebridProvider, type DebridProviderId, type DebridStatus, type DebridTorrent }

const PROVIDERS: Record<Exclude<DebridProviderId, 'none'>, new (apiKey: string) => DebridProvider> = {
  realdebrid: RealDebridProvider,
  alldebrid: AllDebridProvider,
  premiumize: PremiumizeProvider,
  torbox: TorBoxProvider
}

export function createProvider (id: DebridProviderId, apiKey: string): DebridProvider | null {
  if (id === 'none' || !apiKey) return null
  const Ctor = PROVIDERS[id]
  if (!Ctor) throw new DebridError(`Unknown debrid provider: ${id}`, { provider: id })
  return new Ctor(apiKey)
}

export async function checkAuth (id: DebridProviderId, apiKey: string): Promise<DebridStatus> {
  if (id === 'none') throw new DebridError('No debrid provider selected', { provider: id })
  const provider = createProvider(id, apiKey)
  if (!provider) throw new DebridError('Missing API key', { provider: id })
  return await provider.checkAuth()
}

const VIDEO_RX = /\.(mkv|mp4|avi|webm|mov|flv|wmv|m4v|ts|mpg|mpeg)$/i
const SAMPLE_RX = /[\\/.\b](sample|trailer|extras?)[\\/.\b]/i

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms).unref())

interface ResolveOptions {
  signal?: AbortSignal
  pollIntervalMs?: number
  maxWaitMs?: number
  onProgress?: (torrent: DebridTorrent) => void
}

export interface DebridResolvedFile {
  name: string
  path: string
  size: number
  url: string
}

// Submit a torrent (magnet/hash or .torrent buffer) to the debrid provider,
// wait until it's ready, and return playable HTTP URLs for the video files.
export async function resolveDebrid (
  provider: DebridProvider,
  source: { kind: 'magnet', value: string } | { kind: 'torrent', value: Uint8Array },
  options: ResolveOptions = {}
): Promise<DebridResolvedFile[]> {
  const { pollIntervalMs = 3000, maxWaitMs = 10 * 60 * 1000, onProgress, signal } = options

  signal?.throwIfAborted()

  let torrent = source.kind === 'magnet'
    ? await provider.addMagnet(source.value)
    : await provider.addTorrent(source.value)

  onProgress?.(torrent)

  if (torrent.status === 'error') {
    throw new DebridError(`${provider.name}: torrent rejected`, { provider: provider.id })
  }

  // Some providers need an explicit selection step before they start downloading.
  if (torrent.files.length && !torrent.files.some(f => f.selected)) {
    await provider.selectAllFiles(torrent.id, torrent.files)
    torrent = await provider.getInfo(torrent.id)
    onProgress?.(torrent)
  }

  const start = Date.now()
  while (torrent.status !== 'ready') {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (Date.now() - start > maxWaitMs) {
      throw new DebridError(`${provider.name}: timed out waiting for torrent to download (${Math.round(torrent.progress * 100)}%)`, { provider: provider.id })
    }
    if (torrent.status === 'error') {
      throw new DebridError(`${provider.name}: torrent failed to download`, { provider: provider.id })
    }
    await sleep(pollIntervalMs)
    torrent = await provider.getInfo(torrent.id)
    onProgress?.(torrent)
  }

  const candidates = pickPlayableFiles(torrent)
  if (!candidates.length) throw new DebridError(`${provider.name}: no playable files found`, { provider: provider.id })

  const results: DebridResolvedFile[] = []
  const links = torrent.links ?? []

  // Map files to links by index. Most providers list links and files in the
  // same order; for those that don't, we fall back to using the file path.
  for (const file of candidates) {
    let link: string | undefined
    if (typeof file.id === 'number' && links[file.id - 1]) link = links[file.id - 1]
    if (!link) {
      const fileIndex = torrent.files.indexOf(file)
      if (fileIndex >= 0 && links[fileIndex]) link = links[fileIndex]
    }
    if (!link && links.length === 1) link = links[0]
    if (!link) {
      // Last-ditch: try matching by filename suffix
      link = links.find(l => l.toLowerCase().endsWith(encodeURIComponent(file.name).toLowerCase())) ?? links[0]
    }
    if (!link) throw new DebridError(`${provider.name}: no link for file ${file.name}`, { provider: provider.id })

    const url = await provider.unlock(link)
    results.push({
      name: file.name,
      path: file.path ?? file.name,
      size: file.size,
      url
    })
  }

  return results
}

function pickPlayableFiles (torrent: DebridTorrent): DebridFile[] {
  // Sort by size desc so that the main video file comes first, drop sample/trailer junk.
  const all = [...torrent.files].sort((a, b) => b.size - a.size)
  const videos = all.filter(f => VIDEO_RX.test(f.name) && !SAMPLE_RX.test(f.path ?? f.name))
  if (videos.length) return videos
  // No video files - return everything (could be fonts/subs); the player will
  // ignore non-playable mimetypes.
  return all
}
