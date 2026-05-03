#!/usr/bin/env node
// Replaces stock Electron's "free" ffmpeg.dll/.so/.dylib with the official
// "proprietary codecs" build from electron/electron releases.
//
// Electron publishes two ffmpeg builds per release:
//   electron-vX.Y.Z-<platform>-<arch>.zip   ships ffmpeg compiled with
//                                           proprietary_codecs=false (Chromium branding)
//   ffmpeg-vX.Y.Z-<platform>-<arch>.zip     ships the same ffmpeg compiled with
//                                           proprietary_codecs=true ffmpeg_branding="Chrome"
//
// The Chrome-branded build adds H.264, H.265/HEVC, AAC, AC-3, MPEG audio and
// other non-free codecs that anime/movie torrents commonly use.
//
// Docs: https://www.electronjs.org/docs/latest/tutorial/proprietary-codecs

import { spawnSync } from 'node:child_process'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { argv, exit, platform, arch, env } from 'node:process'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SCRIPT_DIR, '..')

const PLATFORM_MAP = { win32: 'win32', linux: 'linux', darwin: 'darwin' }
const ARCH_MAP = { x64: 'x64', ia32: 'ia32', arm64: 'arm64', arm: 'armv7l' }
const FFMPEG_FILENAME = { win32: 'ffmpeg.dll', linux: 'libffmpeg.so', darwin: 'libffmpeg.dylib' }

function findElectronDir () {
  // pnpm with shamefully-hoist may put electron at workspace root or anywhere
  // up the tree. Check the common spots in priority order.
  const candidates = [
    join(ROOT, 'node_modules', 'electron'),
    join(ROOT, 'electron', 'node_modules', 'electron')
  ]
  for (const c of candidates) {
    if (existsSync(join(c, 'package.json'))) return c
  }
  throw new Error(`Could not find node_modules/electron under ${ROOT} - run pnpm install first.`)
}

function readElectronVersion (electronDir) {
  const pkg = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8'))
  return pkg.version
}

function distDir (electronDir) {
  // On macOS the contents live under Electron.app/Contents/Frameworks/...
  if (platform === 'darwin') {
    return join(electronDir, 'dist', 'Electron.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Libraries')
  }
  return join(electronDir, 'dist')
}

function ffmpegPath (electronDir) {
  return join(distDir(electronDir), FFMPEG_FILENAME[platform])
}

async function download (url, dest) {
  console.log(`  → ${url}`)
  let response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText} for ${url}`)
  }
  if (!response.body) throw new Error('Empty response body')
  await pipeline(response.body, createWriteStream(dest))
}

function unzip (zipPath, destDir) {
  if (platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error('powershell Expand-Archive failed')
  } else {
    const r = spawnSync('unzip', ['-oq', zipPath, '-d', destDir], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error('unzip failed - install the `unzip` package')
  }
}

// Resolve the source ffmpeg binary into a local file. Supports:
//   - undefined    download the official Electron proprietary build (no DTS)
//   - file path    use that file as-is (e.g. C:/Program Files/Hayase/ffmpeg.dll)
//   - http(s):// URL pointing at a raw ffmpeg.dll/.so/.dylib
//   - http(s):// URL pointing at a .zip containing one
async function resolveSource ({ source, version, platformKey, archKey, fileName }) {
  if (source && !/^https?:\/\//i.test(source)) {
    if (!existsSync(source)) throw new Error(`--source path does not exist: ${source}`)
    return { kind: 'file', path: source }
  }

  const tmp = join(tmpdir(), `hayase-ffmpeg-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })

  if (source) {
    const dest = join(tmp, source.toLowerCase().endsWith('.zip') ? 'ffmpeg.zip' : fileName)
    await download(source, dest)
    if (dest.endsWith('.zip')) {
      unzip(dest, tmp)
      const extracted = join(tmp, fileName)
      if (!existsSync(extracted)) throw new Error(`Source zip did not contain ${fileName}`)
      return { kind: 'file', path: extracted, cleanup: tmp }
    }
    return { kind: 'file', path: dest, cleanup: tmp }
  }

  // Default: download official Electron proprietary build
  const url = `https://github.com/electron/electron/releases/download/v${version}/ffmpeg-v${version}-${platformKey}-${archKey}.zip`
  const zipPath = join(tmp, 'ffmpeg.zip')
  try {
    await download(url, zipPath)
  } catch (err) {
    const mirror = `https://npmmirror.com/mirrors/electron/v${version}/ffmpeg-v${version}-${platformKey}-${archKey}.zip`
    console.log(`  Primary download failed (${err.message}); trying mirror...`)
    await download(mirror, zipPath)
  }
  unzip(zipPath, tmp)
  const extracted = join(tmp, fileName)
  if (!existsSync(extracted)) throw new Error(`Extracted zip did not contain ${fileName}`)
  return { kind: 'file', path: extracted, cleanup: tmp }
}

// Reusable: install a proprietary ffmpeg into a specific Electron
// distribution directory (e.g. dist/win-unpacked or node_modules/electron/dist).
// Called from electron-builder's afterPack hook to patch packaged builds.
//
// Pass `source` (file path or URL) to use a richer ffmpeg than the official
// Electron release. Useful for sourcing DTS-enabled builds.
export async function installCodecsInto ({ targetDir, version, platformName, archName, force = false, source } = {}) {
  if (!targetDir || !existsSync(targetDir)) throw new Error(`targetDir does not exist: ${targetDir}`)
  if (!version) throw new Error('version is required')
  const platformKey = PLATFORM_MAP[platformName ?? platform]
  const archKey = ARCH_MAP[archName ?? arch]
  if (!platformKey || !archKey) throw new Error(`Unsupported platform: ${platformName ?? platform}-${archName ?? arch}`)
  const fileName = FFMPEG_FILENAME[platformName ?? platform]

  const target = join(targetDir, fileName)
  const backup = target + '.original'
  if (!existsSync(target)) throw new Error(`Stock ffmpeg not found at ${target}`)

  if (existsSync(backup) && !force) return { skipped: true, target }

  const resolved = await resolveSource({ source, version, platformKey, archKey, fileName })

  if (!existsSync(backup)) renameSync(target, backup)
  else rmSync(target, { force: true })

  // Use copy (not rename) so the source file isn't moved out from under the
  // user when they pointed at a permanent location like Program Files.
  copyFileSync(resolved.path, target)

  if (resolved.cleanup) rmSync(resolved.cleanup, { recursive: true, force: true })

  const newSize = statSync(target).size
  return { skipped: false, target, newSize, source: resolved.path }
}

function arg (name) {
  const i = argv.indexOf(name)
  if (i < 0) return undefined
  return argv[i + 1]
}

// Look in well-known Hayase install locations for an ffmpeg.dll/.so/.dylib
// that already includes DTS and other extras the official Electron build
// omits. Returns null if nothing usable is found.
function findRichLocalFfmpeg () {
  const fileName = FFMPEG_FILENAME[platform]
  const candidates = []
  if (platform === 'win32') {
    candidates.push(`C:/Program Files/Hayase/${fileName}`, `C:/Program Files (x86)/Hayase/${fileName}`)
    if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'Programs', 'Hayase', fileName))
  } else if (platform === 'darwin') {
    candidates.push(`/Applications/Hayase.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/${fileName}`)
  } else {
    candidates.push(`/opt/Hayase/${fileName}`, `/usr/lib/hayase/${fileName}`)
  }
  for (const c of candidates) {
    try {
      if (existsSync(c)) {
        const size = statSync(c).size
        // The DTS-enabled build is ~4.5 MB; the standard proprietary build is
        // ~1.6 MB. Anything notably larger than the standard build implies
        // extra codecs.
        if (size > 3_000_000) return { path: c, size }
      }
    } catch {}
  }
  return null
}

async function main () {
  const force = argv.includes('--force') || argv.includes('-f')
  const restoreOriginal = argv.includes('--restore')
  const noAutoDetect = argv.includes('--no-auto-detect')
  let source = arg('--source') ?? env.HAYASE_FFMPEG_SOURCE

  const electronDir = findElectronDir()
  const version = readElectronVersion(electronDir)
  const target = ffmpegPath(electronDir)
  const backup = target + '.original'

  console.log(`Hayase codec installer`)
  console.log(`  Electron: ${electronDir}`)
  console.log(`  Version:  v${version}`)
  console.log(`  Platform: ${platform}-${arch}`)
  console.log(`  Target:   ${target}`)

  if (restoreOriginal) {
    if (!existsSync(backup)) throw new Error(`No backup found at ${backup}`)
    rmSync(target, { force: true })
    renameSync(backup, target)
    console.log(`Restored original ffmpeg from ${backup}`)
    return
  }

  if (!existsSync(target)) {
    throw new Error(`Stock ffmpeg not found at ${target}. Did Electron's postinstall run? Try: cd node_modules/electron && node install.js`)
  }

  const stockSize = statSync(target).size

  // Idempotency: presence of the .original backup means we already swapped in
  // the proprietary build at some point. Skip unless --force.
  if (existsSync(backup) && !force) {
    console.log(`\nProprietary codecs already installed (backup exists at ${backup}).`)
    console.log(`Pass --force to redownload, --restore to revert to the stock ffmpeg,`)
    console.log(`or --source <path|url> to install a different ffmpeg build.`)
    return
  }

  // If no explicit source given, look for a richer ffmpeg from a local Hayase
  // install. Mention what we picked so it's not invisible behaviour.
  if (!source && !noAutoDetect) {
    const local = findRichLocalFfmpeg()
    if (local) {
      console.log(`\nAuto-detected richer ffmpeg from local Hayase install:`)
      console.log(`  ${local.path} (${local.size.toLocaleString()} bytes - includes DTS)`)
      console.log(`  Pass --no-auto-detect to skip this and download the official Electron build instead.`)
      source = local.path
    }
  }

  if (source) {
    console.log(`\nInstalling ffmpeg from custom source: ${source}`)
  } else {
    console.log(`\nDownloading official Electron proprietary ffmpeg (no DTS support)...`)
  }

  const result = await installCodecsInto({
    targetDir: distDir(electronDir),
    version,
    force,
    source
  })

  console.log(`\nffmpeg installed: ${result.newSize.toLocaleString()} bytes (was ${stockSize.toLocaleString()}).`)
  if (result.newSize > 3_000_000) {
    console.log(`Now decoding: H.264, H.265/HEVC, AAC, AC-3, E-AC-3, MP3, Opus, FLAC, Vorbis, TrueHD, DTS/DTS-HD.`)
  } else {
    console.log(`Now decoding: H.264, H.265/HEVC, AAC, AC-3, E-AC-3, MP3, Opus, FLAC, Vorbis, TrueHD.`)
    console.log(`\nNot included (DTS/DTS-HD): pass --source <path-or-url-to-ffmpeg.dll>`)
    console.log(`pointing at a build with --enable-decoder=dca compiled in.`)
    console.log(`The simplest source is the production Hayase install's ffmpeg.dll, e.g.:`)
    console.log(`  pnpm codecs:install --source "C:/Program Files/Hayase/ffmpeg.dll" --force`)
  }
  console.log(`\nRestore the stock ffmpeg with: pnpm codecs:restore`)
}

// Only run the CLI when invoked directly. When imported as a module (e.g. by
// the electron-builder afterPack hook) we just expose installCodecsInto.
if (import.meta.url === pathToFileURL(argv[1] ?? '').href) {
  main().catch(err => {
    console.error('\nFailed to install codecs:', env.DEBUG ? err : err.message)
    exit(1)
  })
}
