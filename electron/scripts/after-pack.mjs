// electron-builder afterPack hook: swap the stock ffmpeg.dll/.so/.dylib that
// shipped with the downloaded Electron release for the proprietary-codec build
// from electron/electron's GitHub releases.
//
// Without this, the packaged app would only decode VP8/VP9/Opus/Vorbis - no
// H.264, H.265, AAC, or AC-3 - which covers approximately none of the torrents
// users actually want to play.

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { env, platform as procPlatform } from 'node:process'
import { fileURLToPath } from 'node:url'

import { installCodecsInto } from '../../scripts/install-codecs.mjs'

const HOOK_DIR = dirname(fileURLToPath(import.meta.url))
const ELECTRON_RESOURCES = resolve(HOOK_DIR, '..', 'resources')

const PLATFORM_ARCH = {
  win32: { platformName: 'win32', fileName: 'ffmpeg.dll' },
  linux: { platformName: 'linux', fileName: 'libffmpeg.so' },
  darwin: { platformName: 'darwin', fileName: 'libffmpeg.dylib' }
}

// Look in well-known Hayase install locations for an ffmpeg.dll/.so/.dylib
// that already includes DTS and other codecs not in the official Electron
// proprietary build. Used as the default source for packaged builds when
// HAYASE_FFMPEG_SOURCE isn't explicitly set.
function findRichLocalFfmpeg (nodePlatform, fileName) {
  const candidates = []
  if (nodePlatform === 'win32') {
    candidates.push(`C:/Program Files/Hayase/${fileName}`, `C:/Program Files (x86)/Hayase/${fileName}`)
    if (env.LOCALAPPDATA) candidates.push(`${env.LOCALAPPDATA}/Programs/Hayase/${fileName}`)
  } else if (nodePlatform === 'darwin') {
    candidates.push(`/Applications/Hayase.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/${fileName}`)
  } else {
    candidates.push(`/opt/Hayase/${fileName}`, `/usr/lib/hayase/${fileName}`)
  }
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).size > 3_000_000) return c
    } catch {}
  }
  return null
}

export default async function afterPack (context) {
  const { appOutDir, packager, electronPlatformName, arch } = context
  const archName = ['ia32', 'x64', 'armv7l', 'arm64'][arch] || 'x64'

  // Map electron-builder's platform string back to Node's process.platform values.
  const nodePlatform = electronPlatformName === 'mas' ? 'darwin' : electronPlatformName
  const platformInfo = PLATFORM_ARCH[nodePlatform]
  if (!platformInfo) {
    console.warn(`[after-pack] Unknown platform ${electronPlatformName}, skipping codec install`)
    return
  }

  // The framework directory holds ffmpeg next to the Electron binary.
  // - win/linux: <appOutDir>/
  // - mac:       <appOutDir>/Hayase.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/
  let targetDir = appOutDir
  if (nodePlatform === 'darwin') {
    targetDir = resolve(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Libraries')
  }

  const version = packager.config.electronVersion ?? packager.info.framework.version

  // Source precedence:
  //   1. HAYASE_FFMPEG_SOURCE env var (explicit, file path or URL)
  //   2. A workspace-checked-in DTS-enabled ffmpeg at electron/resources/
  //      proprietary-ffmpeg-<platform>-<arch>.<ext>. This is the canonical
  //      source - we ship this in git so the build is reproducible.
  //   3. A richer ffmpeg from a local Hayase install on the build machine
  //   4. Official Electron proprietary build (no DTS)
  let source = env.HAYASE_FFMPEG_SOURCE
  if (!source) {
    const ext = nodePlatform === 'win32' ? 'dll' : nodePlatform === 'darwin' ? 'dylib' : 'so'
    const checkedIn = resolve(ELECTRON_RESOURCES, `proprietary-ffmpeg-${nodePlatform}-${archName}.${ext}`)
    if (existsSync(checkedIn)) {
      console.log(`[after-pack] Using checked-in ffmpeg from workspace: ${checkedIn}`)
      source = checkedIn
    }
  }
  if (!source && nodePlatform === procPlatform) {
    const local = findRichLocalFfmpeg(nodePlatform, platformInfo.fileName)
    if (local) {
      console.log(`[after-pack] Auto-detected richer ffmpeg from local Hayase install: ${local}`)
      source = local
    }
  }

  console.log(`[after-pack] Installing proprietary codecs for ${nodePlatform}-${archName} (electron v${version}) into ${targetDir}`)
  if (source) console.log(`[after-pack] Using ffmpeg source: ${source}`)
  else console.log(`[after-pack] Using official Electron proprietary build (no DTS support)`)

  try {
    const result = await installCodecsInto({
      targetDir,
      version,
      platformName: nodePlatform,
      archName,
      source
    })
    if (result.skipped) {
      console.log(`[after-pack] Codecs already installed at ${result.target}`)
    } else {
      console.log(`[after-pack] Installed ffmpeg (${result.newSize.toLocaleString()} bytes) at ${result.target}`)
    }
  } catch (err) {
    console.error(`[after-pack] Failed to install proprietary codecs: ${err.message}`)
    console.error(`[after-pack] The packaged app will fall back to stock ffmpeg without H.264/H.265/AAC/AC-3 support.`)
    // Don't fail the build - the app will still run, just without proprietary codecs.
  }

  // Strip backup files left behind by scripts/install-patched-electron.mjs
  // and scripts/install-codecs.mjs. Without this, the installer balloons by
  // ~230 MB because the patched-Electron extraction backs up the entire
  // stock dist (electron.exe, ffmpeg.dll, snapshot_blob.bin, v8_context_
  // snapshot.bin, resources.pak, icudtl.dat) under .electron-original
  // sidecars in node_modules/electron/dist - and electron-builder's
  // electronDist mode copies the entire source dir verbatim, backups and
  // all. The 'files' glob filter only applies to project files (the asar
  // bundle), not to the unpacked Electron contents. So we delete the
  // sidecars from the staged appOutDir before NSIS packs it.
  //
  // Backups stay intact in node_modules/electron/dist itself - they're
  // only stripped from the packaged build, so `pnpm electron:restore`
  // still works for local dev.
  let stripped = 0
  let strippedBytes = 0
  try {
    for (const entry of readdirSync(targetDir)) {
      if (entry.endsWith('.electron-original') || entry.endsWith('.original') || entry === '.patched-electron-version') {
        const full = join(targetDir, entry)
        try {
          const size = statSync(full).size
          rmSync(full, { force: true })
          stripped++
          strippedBytes += size
        } catch {}
      }
    }
    if (stripped > 0) {
      console.log(`[after-pack] Stripped ${stripped} backup/sentinel file(s) from packaged build (${(strippedBytes / 1_000_000).toFixed(1)} MB freed)`)
    }
  } catch (err) {
    console.warn(`[after-pack] Could not strip backup files: ${err.message}`)
  }
}
