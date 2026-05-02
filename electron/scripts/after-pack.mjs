// electron-builder afterPack hook: swap the stock ffmpeg.dll/.so/.dylib that
// shipped with the downloaded Electron release for the proprietary-codec build
// from electron/electron's GitHub releases.
//
// Without this, the packaged app would only decode VP8/VP9/Opus/Vorbis - no
// H.264, H.265, AAC, or AC-3 - which covers approximately none of the torrents
// users actually want to play.

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { installCodecsInto } from '../../scripts/install-codecs.mjs'

const PLATFORM_ARCH = {
  win32: { platformName: 'win32' },
  linux: { platformName: 'linux' },
  darwin: { platformName: 'darwin' }
}

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))

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
  console.log(`[after-pack] Installing proprietary codecs for ${nodePlatform}-${archName} (electron v${version}) into ${targetDir}`)

  try {
    const result = await installCodecsInto({
      targetDir,
      version,
      platformName: nodePlatform,
      archName
    })
    if (result.skipped) {
      console.log(`[after-pack] Codecs already installed at ${result.target}`)
    } else {
      console.log(`[after-pack] Installed proprietary ffmpeg (${result.newSize.toLocaleString()} bytes) at ${result.target}`)
    }
  } catch (err) {
    console.error(`[after-pack] Failed to install proprietary codecs: ${err.message}`)
    console.error(`[after-pack] The packaged app will fall back to stock ffmpeg without H.264/H.265/AAC/AC-3 support.`)
    // Don't fail the build - the app will still run, just without proprietary codecs.
  }
}
