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

  // Drop Electron's default_app.asar. It's the placeholder UI Electron shows
  // when no main module is provided ("Welcome to Electron" splash). We
  // always have a main module via the electronFuses.onlyLoadAppFromAsar
  // setting in electron-builder.yml, so the runtime never falls back to it.
  // Tiny win (~108 KB) but free.
  if (nodePlatform === 'win32' || nodePlatform === 'linux') {
    const defaultApp = join(targetDir, 'resources', 'default_app.asar')
    if (existsSync(defaultApp)) {
      const sz = statSync(defaultApp).size
      rmSync(defaultApp, { force: true })
      console.log(`[after-pack] Removed default_app.asar (${(sz / 1024).toFixed(0)} KB)`)
    }
  }

  // Drop SwiftShader (Chromium's software Vulkan/D3D11 fallback used when
  // no usable GPU is present - VMs, RDP sessions, broken drivers) and the
  // Vulkan loader DLL it depends on. Saves ~6 MB unpacked / ~1.5 MB
  // installer. The only user-visible effect is that machines with no
  // working GPU and no usable Vulkan driver will see a black canvas
  // instead of WebGL UI effects (the underlying <video> hardware path
  // and software ffmpeg decode still work, since those don't go through
  // SwiftShader). For a torrent video player this is an acceptable
  // trade-off - if you hit it, opt-out via HAYASE_KEEP_SWIFTSHADER=1.
  if (nodePlatform === 'win32' && !env.HAYASE_KEEP_SWIFTSHADER) {
    const swiftshaderTargets = ['vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll']
    let removedBytes = 0
    for (const f of swiftshaderTargets) {
      const p = join(targetDir, f)
      if (existsSync(p)) {
        const sz = statSync(p).size
        rmSync(p, { force: true })
        removedBytes += sz
      }
    }
    if (removedBytes > 0) {
      console.log(`[after-pack] Removed SwiftShader + Vulkan loader (${(removedBytes / 1_000_000).toFixed(1)} MB - re-include via HAYASE_KEEP_SWIFTSHADER=1 if WebGL breaks on no-GPU machines)`)
    }
  }

  // Tried gzip-compressing LICENSES.chromium.html here (15 MB plain text
  // -> 1.9 MB gzipped). It saves disk space at install time but the
  // installer actually got LARGER by ~1 MB because NSIS LZMA-solid compresses
  // the raw HTML to ~3 MB on its own (and can't compress an already-gzipped
  // payload further). Net trade-off was: -13 MB on user disk, +1 MB to
  // download. For a torrent/streaming app where users care more about quick
  // install + small download than the 13 MB on a multi-TB SSD, the trade
  // isn't worth it. Leaving it uncompressed - NSIS handles the install-
  // size compression for free.
}
