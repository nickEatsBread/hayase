import { optimizer } from '@electron-toolkit/utils'
import { app } from 'electron'

import App from './app.ts'

// Enable HEVC hardware decoding (Chrome ships this off-by-default since
// they only enable it for ChromeOS/Mac/Windows builds with proprietary
// codecs flag). Lets Chromium's media pipeline use the OS-provided HEVC
// decoder for HEVC Main / Main 10 video, which is what most modern anime
// rips use. Without this, HEVC files fall back to no-decode.
//
// Stock Electron's Chromium build still has `proprietary_codecs=false`
// at compile time, so EAC3/AC3 audio decoders are NOT in the HTML5
// allowlist regardless of any command-line flag. Users who hit those
// files can manually enable the mediabunny backend in Settings ->
// Player -> 'EXPERIMENTAL: Custom Player Backend' (which ships its own
// JS AC3/EAC3 decoder via @mediabunny/ac3) - we don't force it on
// because it has audio-worklet edge cases when enabled before the page
// finishes loading.
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport')

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let main: App | undefined

function createWindow () {
  main = new App()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
// Menu.setApplicationMenu(null) // performance, but no keyboard shortcuts, sucks
  app.on('ready', createWindow)

  app.on('activate', () => {
    if (main == null) createWindow()
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
}
