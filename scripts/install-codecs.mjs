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
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
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

// Reusable: download and install the proprietary ffmpeg into a specific
// Electron distribution directory (e.g. dist/win-unpacked or
// node_modules/electron/dist). Called from electron-builder's afterPack hook
// to patch packaged builds.
export async function installCodecsInto ({ targetDir, version, platformName, archName, force = false } = {}) {
  if (!targetDir || !existsSync(targetDir)) throw new Error(`targetDir does not exist: ${targetDir}`)
  if (!version) throw new Error('version is required')
  const platformKey = PLATFORM_MAP[platformName ?? platform]
  const archKey = ARCH_MAP[archName ?? arch]
  if (!platformKey || !archKey) throw new Error(`Unsupported platform: ${platformName ?? platform}-${archName ?? arch}`)

  const target = join(targetDir, FFMPEG_FILENAME[platformName ?? platform])
  const backup = target + '.original'
  if (!existsSync(target)) throw new Error(`Stock ffmpeg not found at ${target}`)

  if (existsSync(backup) && !force) return { skipped: true, target }

  const url = `https://github.com/electron/electron/releases/download/v${version}/ffmpeg-v${version}-${platformKey}-${archKey}.zip`
  const tmp = join(tmpdir(), `hayase-ffmpeg-${version}-${platformKey}-${archKey}-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  const zipPath = join(tmp, 'ffmpeg.zip')

  try {
    await download(url, zipPath)
  } catch (err) {
    const mirror = `https://npmmirror.com/mirrors/electron/v${version}/ffmpeg-v${version}-${platformKey}-${archKey}.zip`
    console.log(`  Primary download failed (${err.message}); trying mirror...`)
    await download(mirror, zipPath)
  }

  unzip(zipPath, tmp)
  const replacement = join(tmp, FFMPEG_FILENAME[platformName ?? platform])
  if (!existsSync(replacement)) throw new Error(`Extracted zip did not contain ${FFMPEG_FILENAME[platformName ?? platform]}`)

  if (!existsSync(backup)) renameSync(target, backup)
  else rmSync(target, { force: true })
  renameSync(replacement, target)
  rmSync(tmp, { recursive: true, force: true })

  const newSize = statSync(target).size
  return { skipped: false, target, newSize }
}

async function main () {
  const force = argv.includes('--force') || argv.includes('-f')
  const restoreOriginal = argv.includes('--restore')

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
    console.log(`Pass --force to redownload, or --restore to revert to the stock ffmpeg.`)
    return
  }

  const platformKey = PLATFORM_MAP[platform]
  const archKey = ARCH_MAP[arch]
  if (!platformKey || !archKey) throw new Error(`Unsupported platform: ${platform}-${arch}`)

  const url = `https://github.com/electron/electron/releases/download/v${version}/ffmpeg-v${version}-${platformKey}-${archKey}.zip`
  const tmp = join(tmpdir(), `hayase-ffmpeg-${version}-${platformKey}-${archKey}`)
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  const zipPath = join(tmp, 'ffmpeg.zip')

  console.log('\nDownloading proprietary ffmpeg from electron/electron releases...')
  try {
    await download(url, zipPath)
  } catch (err) {
    // Fall back to the npmmirror mirror used elsewhere in this project.
    const mirror = `https://npmmirror.com/mirrors/electron/v${version}/ffmpeg-v${version}-${platformKey}-${archKey}.zip`
    console.log(`Primary download failed (${err.message}); trying mirror...`)
    await download(mirror, zipPath)
  }

  console.log('Extracting...')
  unzip(zipPath, tmp)

  const replacement = join(tmp, FFMPEG_FILENAME[platform])
  if (!existsSync(replacement)) throw new Error(`Extracted zip did not contain ${FFMPEG_FILENAME[platform]}`)

  if (!existsSync(backup)) {
    console.log(`Backing up stock ffmpeg → ${backup}`)
    renameSync(target, backup)
  } else {
    rmSync(target, { force: true })
  }

  renameSync(replacement, target)

  const newSize = statSync(target).size
  console.log(`\nProprietary ffmpeg installed: ${newSize.toLocaleString()} bytes (was ${stockSize.toLocaleString()}).`)
  console.log(`Now decoding: H.264, H.265/HEVC, AAC, AC-3, E-AC-3, MP3, Opus, FLAC, Vorbis, TrueHD.`)
  console.log(`\nNot included (rare in anime, common on Blu-ray rips):`)
  console.log(`  - DTS / DTS-HD: Requires a custom ffmpeg with --enable-decoder=dca compiled in.`)
  console.log(`    Hayase's official builds ship a hand-rolled ffmpeg.dll with DTS enabled.`)
  console.log(`    For DTS support, drop a custom-built ffmpeg.${platform === 'win32' ? 'dll' : platform === 'darwin' ? 'dylib' : 'so'} into ${distDir(electronDir)}/`)
  console.log(`    or use Castlabs Electron (npm i electron@npm:@castlabs/electron-releases).`)
  console.log(`\nRestore the stock ffmpeg with: pnpm codecs:restore`)

  rmSync(tmp, { recursive: true, force: true })
}

// Only run the CLI when invoked directly. When imported as a module (e.g. by
// the electron-builder afterPack hook) we just expose installCodecsInto.
if (import.meta.url === pathToFileURL(argv[1] ?? '').href) {
  main().catch(err => {
    console.error('\nFailed to install codecs:', env.DEBUG ? err : err.message)
    exit(1)
  })
}
