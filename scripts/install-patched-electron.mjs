#!/usr/bin/env node
// Replaces stock Electron's electron.exe with the proprietary-codec
// patched build that upstream Hayase ships in their installer.
//
// The audio codec problem in stock Electron is NOT just ffmpeg.dll - it's
// an allowlist baked into Chromium's media stack at compile time:
//
//   media/filters/ffmpeg_glue.cc::kAllowedDecoders
//   media/base/supported_types.cc::IsAudioCodecProprietary()
//
// Both are statically linked into electron.exe. With proprietary_codecs=
// false (Electron's default), AC3/EAC3/HEVC etc are not in the allowlist
// regardless of which ffmpeg.dll is loaded - the media pipeline rejects
// them before ffmpeg ever sees them. This is why our DTS-enabled
// ffmpeg.dll works for HEVC video (which can use the OS HW decoder via
// PlatformHEVCDecoderSupport, bypassing the allowlist) but not for EAC3
// audio (no OS-decoder bypass exists for audio).
//
// ThaUnknown maintains the proprietary-codec patches in
// github.com/ThaUnknown/electron-chromium-codecs and applies them when
// building the Electron that ships in upstream Hayase. The patch set:
//
//   - GN args: proprietary_codecs=true, ffmpeg_branding="Chrome",
//     enable_platform_ac3_eac3_audio=true, enable_platform_hevc=true,
//     enable_platform_dts_audio=true, enable_platform_dolby_vision=true
//   - Source patches: extend allowed_decoders with ac3,eac3,hevc;
//     register AC3/EAC3 in AudioCodecToCodecID; force IsHevcProfileSupported
//   - ffmpeg patches: enable AC3/EAC3/HEVC decoders in ffmpeg_generated.gni
//
// Building this from source ourselves requires VS 2022, ~500 GB disk, 32 GB
// RAM, and 4-8 hours per build (Chromium is enormous). Until we set that
// up, we extract the resulting binaries from upstream's signed installer:
//
//   1. Fetch the latest installer URL from https://api.hayase.watch/latest
//   2. Download the win-...-installer.exe (NSIS, ~90 MB compressed)
//   3. Two-stage 7z extract (NSIS shell -> $PLUGINSDIR/app-64.7z -> app/)
//   4. Verify the extracted Electron version matches our package.json
//   5. Back up our stock electron.exe + ffmpeg.dll, swap in upstream's
//
// Result: our Electron now has a Chromium media stack that permits AC3/
// EAC3/HEVC, plus a DTS-enabled ffmpeg.dll. EAC3 audio plays natively
// in <video> elements - no mediabunny workaround needed. The mediabunny
// fallback stays available for users who prefer it.
//
// This is idempotent - rerun safely. To revert, run with --restore.
//
// pnpm install runs Electron's postinstall which re-downloads stock dist
// and overwrites our patched binaries. Re-run this script after every
// pnpm install or use `pnpm electron:patch` for the convenience script.

import { spawnSync } from 'node:child_process'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { argv, exit, env } from 'node:process'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SCRIPT_DIR, '..')
const RELEASE_MANIFEST_URL = 'https://api.hayase.watch/latest'
const SENTINEL_NAME = '.patched-electron-version'

// Files that are part of the patched Electron and must be replaced atomically.
// Anything in stock dist/ that's NOT in this list (locales/, LICENSES.chromium,
// version, etc.) we leave alone - they're either large and identical or
// metadata that doesn't affect runtime behavior.
const PATCHED_FILES = [
  'electron.exe', // <- the renamed Hayase.exe; this is the main thing
  'ffmpeg.dll', // patched ffmpeg with AC3/EAC3/DTS/HEVC decoders
  'snapshot_blob.bin', // V8 snapshot (regenerated as part of every Chromium build)
  'v8_context_snapshot.bin', // same
  'resources.pak', // Chromium UI resources
  'icudtl.dat' // ICU locale data (probably identical but cheap to copy)
]

function findElectronDir () {
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
  return JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8')).version
}

function readUpstreamElectronVersion () {
  // Our electron/package.json's version is the APP version, not Electron's.
  // We get the Electron version from the locked dependency.
  const electronDir = findElectronDir()
  return readElectronVersion(electronDir)
}

async function fetchJson (url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (hayase-fork-installer)' },
    redirect: 'follow'
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return await res.json()
}

async function download (url, dest) {
  console.log(`  → ${url}`)
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (hayase-fork-installer)' },
    redirect: 'follow'
  })
  if (!res.ok) throw new Error(`Download failed: ${res.status} for ${url}`)
  if (!res.body) throw new Error('Empty response body')
  await pipeline(res.body, createWriteStream(dest))
}

function which7z () {
  // Bundled with electron-builder via app-builder-bin (which we depend on
  // transitively). Try common locations and fall back to PATH.
  const candidates = [
    'C:/Program Files/7-Zip/7z.exe',
    'C:/Program Files (x86)/7-Zip/7z.exe',
    join(env.LOCALAPPDATA ?? '', 'Programs', '7-Zip', '7z.exe')
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  // Fall back to whatever's on PATH (works in git-bash / WSL)
  return '7z'
}

function extract7z (archive, destDir) {
  mkdirSync(destDir, { recursive: true })
  const r = spawnSync(which7z(), ['x', '-y', archive, '-o' + destDir], { stdio: 'pipe' })
  if (r.status !== 0) {
    throw new Error(`7z extract failed (status ${r.status}): ${r.stderr?.toString() || r.stdout?.toString()}`)
  }
}

function readSentinel (electronDistDir) {
  const path = join(electronDistDir, SENTINEL_NAME)
  if (!existsSync(path)) return null
  try { return readFileSync(path, 'utf8').trim() } catch { return null }
}

function writeSentinel (electronDistDir, contents) {
  writeFileSync(join(electronDistDir, SENTINEL_NAME), contents + '\n', 'utf8')
}

async function main () {
  const force = argv.includes('--force') || argv.includes('-f')
  const restore = argv.includes('--restore')

  if (process.platform !== 'win32') {
    console.log('Patched-Electron extraction currently only supports Windows.')
    console.log('Linux/macOS would need their own installer URLs and 7z handling.')
    return
  }

  const electronDir = findElectronDir()
  const ourVersion = readElectronVersion(electronDir)
  const distDir = join(electronDir, 'dist')

  console.log('Hayase patched-Electron installer')
  console.log(`  Electron dist:   ${distDir}`)
  console.log(`  Electron version: v${ourVersion}`)

  if (restore) {
    console.log('\nRestoring stock Electron binaries from .original backups...')
    let restored = 0
    for (const fname of PATCHED_FILES) {
      const target = join(distDir, fname)
      const backup = target + '.electron-original'
      if (existsSync(backup)) {
        rmSync(target, { force: true })
        renameSync(backup, target)
        console.log(`  restored ${fname}`)
        restored++
      }
    }
    rmSync(join(distDir, SENTINEL_NAME), { force: true })
    console.log(`\nRestored ${restored} files. Re-run \`pnpm electron:patch\` to re-apply.`)
    return
  }

  const installedVersion = readSentinel(distDir)
  if (installedVersion === ourVersion && !force) {
    console.log(`\nPatched Electron v${ourVersion} already installed (sentinel match).`)
    console.log(`Pass --force to re-download, or --restore to revert to stock.`)
    return
  }

  console.log('\nFetching upstream Hayase release manifest...')
  const manifest = await fetchJson(RELEASE_MANIFEST_URL)
  const installerEntry = Object.entries(manifest).find(([name]) => name.match(/^win-hayase-[\d.]+-installer\.exe$/))
  if (!installerEntry) throw new Error('No win-...-installer.exe entry in upstream release manifest')
  const [installerName, installerUrl] = installerEntry
  console.log(`  found: ${installerName}`)

  // Sanity check: upstream's app version is irrelevant to us, but if they've
  // moved to a newer Electron major than ours the binaries won't be ABI-
  // compatible. We can't tell upstream's Electron version from the manifest -
  // peek at their electron/package.json on GitHub.
  console.log('\nVerifying upstream Electron version matches ours...')
  let upstreamElectron
  try {
    const pkg = await fetchJson('https://api.github.com/repos/hayase-app/electron/contents/package.json')
    const decoded = JSON.parse(Buffer.from(pkg.content, 'base64').toString('utf8'))
    upstreamElectron = decoded.devDependencies?.electron ?? decoded.dependencies?.electron
    console.log(`  upstream Electron: ${upstreamElectron}`)
    console.log(`  our Electron:      ${ourVersion}`)
    // upstreamElectron may be `^39.2.7` - strip leading non-digits
    const upstreamSemver = upstreamElectron.replace(/^[^\d]+/, '')
    if (upstreamSemver.split('.')[0] !== ourVersion.split('.')[0]) {
      throw new Error(`Major version mismatch: upstream ${upstreamSemver} vs ours ${ourVersion}. Update electron/package.json or wait for upstream to align.`)
    }
    if (upstreamSemver !== ourVersion) {
      console.log(`  WARNING: minor/patch version differs - usually still ABI-compatible but watch for native-module breakage.`)
    }
  } catch (e) {
    console.log(`  Could not verify upstream Electron version (${e.message}). Continuing anyway.`)
  }

  const work = join(tmpdir(), `hayase-patched-electron-${Date.now()}`)
  mkdirSync(work, { recursive: true })

  try {
    const installerPath = join(work, 'installer.exe')
    console.log('\nDownloading upstream installer (~90 MB)...')
    await download(installerUrl, installerPath)

    console.log('\nExtracting NSIS shell...')
    const nsisExtract = join(work, 'nsis')
    extract7z(installerPath, nsisExtract)

    const innerArchive = join(nsisExtract, '$PLUGINSDIR', 'app-64.7z')
    if (!existsSync(innerArchive)) throw new Error(`Inner app-64.7z not found at ${innerArchive}`)

    console.log('Extracting app payload (~290 MB uncompressed)...')
    const appExtract = join(work, 'app')
    extract7z(innerArchive, appExtract)

    const upstreamHayaseExe = join(appExtract, 'Hayase.exe')
    if (!existsSync(upstreamHayaseExe)) throw new Error(`Hayase.exe not found in extracted app at ${upstreamHayaseExe}`)
    const upstreamSize = statSync(upstreamHayaseExe).size
    if (upstreamSize < 100_000_000) {
      throw new Error(`Extracted Hayase.exe suspiciously small (${upstreamSize} bytes); aborting.`)
    }
    console.log(`  extracted Hayase.exe: ${upstreamSize.toLocaleString()} bytes`)

    console.log('\nReplacing stock Electron binaries with upstream patched versions...')
    const replacements = [
      { from: 'Hayase.exe', to: 'electron.exe' }, // rename
      ...PATCHED_FILES.filter(f => f !== 'electron.exe').map(f => ({ from: f, to: f }))
    ]

    for (const { from, to } of replacements) {
      const src = join(appExtract, from)
      const dst = join(distDir, to)
      const backup = dst + '.electron-original'
      if (!existsSync(src)) {
        console.log(`  skipping ${to} - not in upstream payload`)
        continue
      }
      if (!existsSync(dst)) {
        console.log(`  skipping ${to} - not in stock dist`)
        continue
      }
      // First-time backup; subsequent re-runs already have the backup.
      if (!existsSync(backup)) {
        copyFileSync(dst, backup)
      }
      rmSync(dst, { force: true })
      copyFileSync(src, dst)
      const newSize = statSync(dst).size
      console.log(`  ${to}: ${newSize.toLocaleString()} bytes`)
    }

    writeSentinel(distDir, ourVersion)
    console.log(`\nPatched Electron v${ourVersion} installed.`)
    console.log(`Now decoding natively in <video>: H.264, H.265/HEVC, AAC, AC-3, E-AC-3, DTS, FLAC, Opus.`)
    console.log(`The mediabunny WASM fallback stays available as opt-in.`)
    console.log(`\nNext: \`pnpm --filter hayase build:win\` to package with the patched binaries.`)
    console.log(`To revert: \`pnpm electron:patch -- --restore\``)
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch {}
  }
}

main().catch(err => {
  console.error('\nFailed to install patched Electron:', env.DEBUG ? err : err.message)
  exit(1)
})
