#!/usr/bin/env node
// Replaces stock Electron's binaries with the proprietary-codec patched
// build that upstream Hayase ships in their installer.
//
// The audio codec problem in stock Electron is NOT just ffmpeg - it's an
// allowlist baked into Chromium's media stack at compile time:
//
//   media/filters/ffmpeg_glue.cc::kAllowedDecoders
//   media/base/supported_types.cc::IsAudioCodecProprietary()
//
// Both are statically linked into the Electron binary. With
// proprietary_codecs=false (Electron's default), AC3/EAC3/HEVC etc are
// not in the allowlist regardless of which ffmpeg is loaded - the media
// pipeline rejects them before ffmpeg ever sees them. This is why a
// DTS-enabled ffmpeg works for HEVC video (which can use the OS HW
// decoder via PlatformHEVCDecoderSupport, bypassing the allowlist) but
// not for EAC3 audio (no OS-decoder bypass exists for audio).
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
// Building this from source ourselves requires VS 2022 (or clang on Linux),
// ~500 GB disk, 32 GB RAM, and 4-8 hours per build. Until we set that up,
// we extract the resulting binaries from upstream's signed installers:
//
//   Windows: NSIS installer (win-hayase-VERSION-installer.exe)
//     1. 7z extract NSIS shell -> $PLUGINSDIR/app-64.7z
//     2. 7z extract app-64.7z -> app/ with Hayase.exe + ffmpeg.dll + ...
//
//   Linux: Debian package (linux-hayase-VERSION-linux.deb)
//     1. ar / dpkg-deb -x to extract data.tar.xz -> opt/Hayase/ with
//        hayase + libffmpeg.so + ...
//     (Picked .deb over .AppImage because AppImage extraction needs
//     libfuse2 or unsquashfs setup; .deb is just a clean ar archive.)
//
// In both cases we then rename + swap the patched binaries into
// node_modules/electron/dist/, with .electron-original sidecars saved
// for restore. electron-builder picks them up via electronDist:
// node_modules/electron/dist in electron/electron-builder.yml.
//
// Result: Electron has a Chromium media stack that permits AC3/EAC3/HEVC,
// plus a DTS-enabled ffmpeg. EAC3 audio plays natively in <video> -
// no mediabunny workaround needed. The mediabunny fallback stays
// available for users who prefer it.
//
// This is idempotent - rerun safely. To revert, run with --restore.
//
// pnpm install runs Electron's postinstall which re-downloads stock dist
// and overwrites our patched binaries. Re-run this script after every
// pnpm install or use `pnpm electron:patch` for the convenience.

import { spawnSync } from 'node:child_process'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { argv, env, exit, platform } from 'node:process'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SCRIPT_DIR, '..')
const RELEASE_MANIFEST_URL = 'https://api.hayase.watch/latest'
const SENTINEL_NAME = '.patched-electron-version'

// Per-platform mapping for extraction. Each platform knows which manifest
// entry to grab, what the binary's name is in upstream's packaging, what
// to rename it to in our dist, and which other files to copy alongside it.
const PLATFORM_CONFIG = {
  win32: {
    label: 'Windows x64',
    manifestPattern: /^win-hayase-[\d.]+-installer\.exe$/,
    downloadSizeHint: '~90 MB',
    extract: extractWindowsInstaller,
    // After extraction, the patched files live in the root of the extract dir.
    extractSubdir: '',
    // Upstream renames electron.exe -> Hayase.exe at packaging time. We do the
    // reverse here so node_modules/electron/dist looks like a stock dist.
    binaryFromName: 'Hayase.exe',
    binaryToName: 'electron.exe',
    // Other binaries we replace alongside the main exe. Matches what
    // electron-builder ships in win-unpacked.
    patchedFiles: [
      'ffmpeg.dll',
      'snapshot_blob.bin',
      'v8_context_snapshot.bin',
      'resources.pak',
      'icudtl.dat'
    ]
  },
  linux: {
    label: 'Linux x64',
    manifestPattern: /^linux-hayase-[\d.]+-linux\.deb$/,
    downloadSizeHint: '~90 MB',
    extract: extractDebPackage,
    // Inside the .deb the app payload is at opt/Hayase/.
    extractSubdir: 'opt/Hayase',
    // Linux electron binary is just `hayase` (or `electron` after rename).
    // Note: electron-builder's linux-unpacked also names it `hayase`, so
    // we copy as `electron` here and let the builder rename later.
    binaryFromName: 'hayase',
    binaryToName: 'electron',
    // Linux ffmpeg is a .so, not .dll. Snapshot blobs are platform-neutral
    // names but their content is platform-specific.
    patchedFiles: [
      'libffmpeg.so',
      'snapshot_blob.bin',
      'v8_context_snapshot.bin',
      'resources.pak',
      'icudtl.dat'
    ]
  }
}

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
  // transitively). Try common locations and fall back to PATH. On Linux
  // CI runners this is /usr/bin/7z (preinstalled with p7zip-full).
  const candidates = platform === 'win32' ? [
    'C:/Program Files/7-Zip/7z.exe',
    'C:/Program Files (x86)/7-Zip/7z.exe',
    join(env.LOCALAPPDATA ?? '', 'Programs', '7-Zip', '7z.exe')
  ] : [
    '/usr/bin/7z',
    '/usr/local/bin/7z',
    '/usr/bin/7zz' // newer p7zip naming
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return platform === 'win32' ? '7z' : '7z'
}

function extract7z (archive, destDir) {
  mkdirSync(destDir, { recursive: true })
  const r = spawnSync(which7z(), ['x', '-y', archive, '-o' + destDir], { stdio: 'pipe' })
  if (r.status !== 0) {
    throw new Error(`7z extract failed (status ${r.status}): ${(r.stderr?.toString() || r.stdout?.toString() || '').slice(0, 500)}`)
  }
}

function extractWindowsInstaller (installerPath, work) {
  // NSIS-wrapped 7z. Two stages: outer NSIS extract gives us the bundled
  // 7z payload; inner extract gives us the actual app dir.
  console.log('  Stage 1/2: extracting NSIS shell...')
  const nsisExtract = join(work, 'nsis')
  extract7z(installerPath, nsisExtract)

  const innerArchive = join(nsisExtract, '$PLUGINSDIR', 'app-64.7z')
  if (!existsSync(innerArchive)) throw new Error(`Inner app-64.7z not found at ${innerArchive}`)

  console.log('  Stage 2/2: extracting app payload (~290 MB uncompressed)...')
  const appExtract = join(work, 'app')
  extract7z(innerArchive, appExtract)
  return appExtract
}

function extractDebPackage (debPath, work) {
  // .deb is an ar archive containing data.tar.{xz,gz,zst}. dpkg-deb -x
  // is the simplest tool when available, falls back to ar + tar.
  const appExtract = join(work, 'app')
  mkdirSync(appExtract, { recursive: true })

  // Try dpkg-deb first (preinstalled on Ubuntu/Debian, including CI runners).
  let r = spawnSync('dpkg-deb', ['-x', debPath, appExtract], { stdio: 'pipe' })
  if (r.status === 0) {
    console.log('  Extracted via dpkg-deb')
    return appExtract
  }

  // Fall back to ar + tar (on systems without dpkg-deb, e.g. macOS with
  // homebrew-installed binutils).
  console.log('  dpkg-deb not available; trying ar + tar...')
  const arExtract = join(work, 'ar')
  mkdirSync(arExtract, { recursive: true })
  r = spawnSync('ar', ['x', debPath], { cwd: arExtract, stdio: 'pipe' })
  if (r.status !== 0) {
    throw new Error(`ar extract failed (status ${r.status}): ${(r.stderr?.toString() || '').slice(0, 500)}`)
  }
  // The tarball can be data.tar.xz, .gz, or .zst depending on dpkg version.
  const dataTar = ['data.tar.xz', 'data.tar.gz', 'data.tar.zst', 'data.tar']
    .map(n => join(arExtract, n))
    .find(existsSync)
  if (!dataTar) throw new Error('No data.tar.* found in .deb after ar extract')
  r = spawnSync('tar', ['-xf', dataTar, '-C', appExtract], { stdio: 'pipe' })
  if (r.status !== 0) {
    throw new Error(`tar extract failed (status ${r.status}): ${(r.stderr?.toString() || '').slice(0, 500)}`)
  }
  console.log('  Extracted via ar + tar')
  return appExtract
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

  const config = PLATFORM_CONFIG[platform]
  if (!config) {
    console.log(`Patched-Electron extraction doesn't support platform '${platform}' yet.`)
    console.log('Supported: ' + Object.keys(PLATFORM_CONFIG).join(', '))
    return
  }

  const electronDir = findElectronDir()
  const ourVersion = readElectronVersion(electronDir)
  const distDir = join(electronDir, 'dist')

  console.log('Hayase patched-Electron installer')
  console.log(`  Platform:         ${config.label}`)
  console.log(`  Electron dist:    ${distDir}`)
  console.log(`  Electron version: v${ourVersion}`)

  // Sanity: dist/ has to exist with the actual stock binaries before we can
  // swap. pnpm-workspace.yaml has electron in ignoredBuiltDependencies so a
  // fresh `pnpm install` doesn't trigger Electron's install.js. CI flows
  // need to run `cd node_modules/electron && node install.js` first - on
  // dev machines this happens once after the very first install and stays
  // populated. Detect + error out clearly if dist/ is missing.
  if (!existsSync(distDir) || !existsSync(join(distDir, config.binaryToName))) {
    throw new Error(`node_modules/electron/dist/ doesn't have ${config.binaryToName} - Electron's postinstall hasn't run.\n` +
      `Run: cd ${electronDir} && node install.js\n` +
      `(pnpm skips this because electron is in pnpm-workspace.yaml ignoredBuiltDependencies.)`)
  }

  // The full file list including the renamed binary.
  const allPatchedFiles = [config.binaryToName, ...config.patchedFiles]

  if (restore) {
    console.log('\nRestoring stock Electron binaries from .electron-original backups...')
    let restored = 0
    for (const fname of allPatchedFiles) {
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
  const installerEntry = Object.entries(manifest).find(([name]) => config.manifestPattern.test(name))
  if (!installerEntry) throw new Error(`No upstream installer matching ${config.manifestPattern} in release manifest`)
  const [installerName, installerUrl] = installerEntry
  console.log(`  found: ${installerName}`)

  // Sanity check: upstream's app version is irrelevant to us, but if they've
  // moved to a newer Electron major than ours the binaries won't be ABI-
  // compatible. We can't tell upstream's Electron version from the manifest -
  // peek at their electron/package.json on GitHub.
  console.log('\nVerifying upstream Electron version matches ours...')
  try {
    const pkg = await fetchJson('https://api.github.com/repos/hayase-app/electron/contents/package.json')
    const decoded = JSON.parse(Buffer.from(pkg.content, 'base64').toString('utf8'))
    const upstreamElectron = decoded.devDependencies?.electron ?? decoded.dependencies?.electron
    console.log(`  upstream Electron: ${upstreamElectron}`)
    console.log(`  our Electron:      ${ourVersion}`)
    const upstreamSemver = upstreamElectron.replace(/^[^\d]+/, '')
    if (upstreamSemver.split('.')[0] !== ourVersion.split('.')[0]) {
      throw new Error(`Major version mismatch: upstream ${upstreamSemver} vs ours ${ourVersion}. Update electron/package.json or wait for upstream to align.`)
    }
    if (upstreamSemver !== ourVersion) {
      console.log('  WARNING: minor/patch version differs - usually still ABI-compatible but watch for native-module breakage.')
    }
  } catch (e) {
    console.log(`  Could not verify upstream Electron version (${e.message}). Continuing anyway.`)
  }

  const work = join(tmpdir(), `hayase-patched-electron-${Date.now()}`)
  mkdirSync(work, { recursive: true })

  try {
    const installerPath = join(work, installerName)
    console.log(`\nDownloading upstream installer (${config.downloadSizeHint})...`)
    await download(installerUrl, installerPath)

    console.log('\nExtracting installer payload...')
    const extracted = config.extract(installerPath, work)
    const payloadDir = config.extractSubdir ? join(extracted, config.extractSubdir) : extracted

    const upstreamBinaryPath = join(payloadDir, config.binaryFromName)
    if (!existsSync(upstreamBinaryPath)) {
      throw new Error(`Patched binary ${config.binaryFromName} not found at ${upstreamBinaryPath}`)
    }
    const upstreamSize = statSync(upstreamBinaryPath).size
    if (upstreamSize < 100_000_000) {
      throw new Error(`Extracted ${config.binaryFromName} suspiciously small (${upstreamSize} bytes); aborting.`)
    }
    console.log(`  extracted ${config.binaryFromName}: ${upstreamSize.toLocaleString()} bytes`)

    console.log('\nReplacing stock Electron binaries with upstream patched versions...')
    const replacements = [
      { from: config.binaryFromName, to: config.binaryToName },
      ...config.patchedFiles.map(f => ({ from: f, to: f }))
    ]

    for (const { from, to } of replacements) {
      const src = join(payloadDir, from)
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
    console.log('Now decoding natively in <video>: H.264, H.265/HEVC, AAC, AC-3, E-AC-3, DTS, FLAC, Opus.')
    console.log('The mediabunny WASM fallback stays available as opt-in.')

    const buildCmd = platform === 'win32' ? 'pnpm --filter hayase build:win' : 'pnpm --filter hayase build:linux'
    console.log(`\nNext: \`${buildCmd}\` to package with the patched binaries.`)
    console.log('To revert: `pnpm electron:restore`')
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch {}
  }
}

main().catch(err => {
  console.error('\nFailed to install patched Electron:', env.DEBUG ? err : err.message)
  exit(1)
})
