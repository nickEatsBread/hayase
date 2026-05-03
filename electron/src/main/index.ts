import { optimizer } from '@electron-toolkit/utils'
import { app } from 'electron'

import App from './app.ts'

// Enable HEVC hardware decoding (Chrome ships this off-by-default since
// they only enable it for ChromeOS/Mac/Windows builds with proprietary
// codecs flag). Lets Chromium's media pipeline use the OS-provided HEVC
// decoder for HEVC Main / Main 10 video, which is what most modern anime
// rips use. Without this, HEVC files fall back to no-decode and either
// stall or trigger 'Audio Codec Unsupported' false positives.
//
// Stock Electron's Chromium build still has `proprietary_codecs=false`
// at compile time, so EAC3/AC3 audio decoders are NOT in the HTML5
// allowlist regardless of any command-line flag - those are handled
// separately by switching the player to the mediabunny backend (which
// uses its own JS AC3/EAC3 decoder via @mediabunny/ac3, bypassing
// Chromium's audio pipeline entirely).
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
