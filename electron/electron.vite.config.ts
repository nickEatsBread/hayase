import { execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { defineConfig } from 'electron-vite'
import { glob } from 'glob'
import license from 'rollup-plugin-license'
import { cjsInterop } from 'vite-plugin-cjs-interop'

const requireFromHere = createRequire(import.meta.url)

// Walk up looking for a node_modules/<name> directory. Works regardless of
// whether pnpm hoisted the package into our local node_modules or the
// workspace root, and bypasses the package's "exports" map.
function resolvePackageRoot (name: string): string {
  let dir = __dirname
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, 'node_modules', name)
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  // Fall back to require.resolve which respects exports - might still throw,
  // but at least we'll get a real error message.
  return resolve(requireFromHere.resolve(name), '..')
}

function resolveInsidePackage (name: string, subpath: string): string {
  return resolve(resolvePackageRoot(name), subpath)
}

const electronUnzipPlugin = () => {
  return {
    name: 'electron-unzip',
    buildStart () {
      const electronDistPath = resolve(__dirname, 'electron-dist')

      if (!existsSync(electronDistPath)) {
        // electron-dist holds the upstream team's custom Electron (with bytecode
        // support and a hand-built ffmpeg with DTS). For local source builds we
        // use stock Electron from node_modules; proprietary codec coverage
        // comes from `pnpm codecs:install` instead, which swaps the official
        // proprietary ffmpeg into node_modules/electron/dist/.
        console.warn('\n[electron-unzip] electron-dist not present - using stock Electron from node_modules. Run `pnpm codecs:install` from the workspace root if you need H.264/H.265/AAC/AC-3 playback.')
        return
      }

      let zipPattern: string
      switch (process.platform) {
        case 'win32':
          zipPattern = '*win32*.zip'
          break
        case 'freebsd':
        case 'openbsd':
        case 'linux':
          zipPattern = '*linux*.zip'
          break
        default:
          console.warn(`\nBytecode unsuppored platform: ${process.platform}`)
          return
      }

      try {
        const zipFile = glob.sync(zipPattern, { cwd: electronDistPath })[0]

        if (!zipFile) {
          console.warn(`\nNo electron distribution zip file found for pattern: ${zipPattern}`)
          return
        }

        const zipPath = resolve(electronDistPath, zipFile)
        const extractDir = resolve(electronDistPath, zipFile.replace('.zip', ''))

        process.env.ELECTRON_EXEC_PATH = extractDir + (process.platform === 'win32' ? '/electron.exe' : '/electron')

        if (existsSync(extractDir)) {
          console.log(`\nElectron distribution already extracted: ${extractDir}`)
          return
        }

        console.log(`\nExtracting electron distribution: ${zipFile}`)

        mkdirSync(extractDir, { recursive: true })

        if (process.platform === 'win32') {
          execSync(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`)
        } else {
          execSync(`unzip -q "${zipPath}" -d "${extractDir}"`)
          const electronBinary = resolve(extractDir, 'electron')
          execSync(`chmod +x "${electronBinary}"`)
        }

        console.log(`\nSuccessfully extracted: ${zipFile}`)
      } catch (error) {
        console.error('\nFailed to extract electron distribution:', error)
      }
    }
  }
}

// Bytecode compilation needs the custom electron-dist binary (proprietary
// codecs build) to compile to V8 bytecode. Disable in workspace builds since
// we use stock Electron from npm.
const ENABLE_BYTECODE = process.platform !== 'darwin' && existsSync(resolve(__dirname, 'electron-dist'))

export default defineConfig({
  main: {
    build: {
      bytecode: ENABLE_BYTECODE && { transformArrowFunctions: false }
    },
    plugins: [
      electronUnzipPlugin(),
      cjsInterop({ dependencies: ['@paymoapp/electron-shutdown-handler'] }),
      license({
        thirdParty: {
          allow: '(MIT OR Apache-2.0 OR ISC OR BSD-3-Clause OR BSD-2-Clause)',
          output: resolve(__dirname, './out/main/LICENSE.txt'),
          includeSelf: true
        }
      })
    ],
    resolve: {
      alias: {
        'http-tracker': resolveInsidePackage('bittorrent-tracker', 'lib/client/http-tracker.js'),
        'webrtc-polyfill': resolve(__dirname, 'src/main/patches/module.cjs'),
        ws: resolve(__dirname, 'src/main/patches/ws.cjs'),
        '@discordjs/rest': resolve(__dirname, 'src/main/patches/rest.cjs'),
        './transport/WebSocket': resolve(__dirname, 'src/main/patches/module.cjs'),
        './structures/ClientUser': resolve(__dirname, 'src/main/patches/user.cjs'),
        'discord-api-types/v10': resolve(__dirname, 'src/main/patches/module.cjs'),
        debug: resolve(__dirname, 'src/main/patches/debug.cjs')
      }
    }
  },
  preload: {
    // preload is too small for bytecodePlugin to be effective
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          extras: resolve(__dirname, 'src/preload/extras.ts')
        }
      }
    },
    plugins: [
      license({
        thirdParty: {
          allow: '(MIT OR Apache-2.0 OR ISC OR BSD-3-Clause OR BSD-2-Clause)',
          output: resolve(__dirname, './out/preload/LICENSE.txt'),
          includeSelf: true
        }
      })
    ]
  }
})
