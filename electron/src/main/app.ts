import { join } from 'node:path'
import process from 'node:process'

import { electronApp, is } from '@electron-toolkit/utils'
import electronShutdownHandler from '@paymoapp/electron-shutdown-handler'
import { expose } from 'abslink/electron'
import { BrowserWindow, MessageChannelMain, app, dialog, ipcMain, powerMonitor, shell, utilityProcess, Tray, Menu, protocol, nativeImage, session, nativeTheme, webFrame } from 'electron' // type NativeImage, Notification, nativeImage,
import log from 'electron-log/main'
import { autoUpdater } from 'electron-updater'

import ico from '../../build/icon.ico?asset'
import icon from '../../build/icon.png?asset'

import './util.ts'
import { rewriteInternalRequest } from './al.ts'
import forkPath from './background/background.ts?modulePath'
import Discord from './discord.ts'
import { applyStoredExtrasOnStartup, openExtrasWindow } from './extras-window.ts'
// import Protocol from './protocol.ts'
import IPC from './ipc.ts'
import Protocol from './protocol.ts'
import store from './store.ts'
import Updater from './updater.ts'

log.initialize({ spyRendererConsole: true, preload: false })
log.transports.file.level = 'debug'
log.transports.file.maxSize = 10 * 1024 * 1024 // 10MB

log.hooks.push(message => {
  const hasMatch = message.data.some(part => typeof part === 'string' && (part.includes('Mixed Content:') || part.includes('was loaded over HTTPS, but requested an insecure')))

  if (hasMatch) return false

  return message
})

autoUpdater.logger = log

// const TRANSPARENCY = store.get('transparency')

// Match upstream: production builds load the UI directly from
// https://hayase.app/. Dev mode optionally points at a local interface
// dev server on :7344 (run via `pnpm dev:interface`). Override via
// HAYASE_BASE_URL if you ever need to point this elsewhere.
const BASE_URL = process.env.HAYASE_BASE_URL ?? (is.dev ? 'http://localhost:7344/' : 'https://hayase.app/')

protocol.registerSchemesAsPrivileged([
  { scheme: 'https', privileges: { standard: true, bypassCSP: true, allowServiceWorkers: true, supportFetchAPI: true, corsEnabled: false, stream: true, codeCache: true, secure: true } }
])

function setCors (record?: Record<string, string[]>, credentails = false) {
  if (!record) return
  if (record['access-control-allow-origin'] ?? record['Access-Control-Allow-Origin']) return
  record['access-control-allow-origin'] = ['*']
  record['access-control-allow-methods'] = ['GET, POST, PUT, DELETE, OPTIONS, PATCH']
  record['access-control-allow-headers'] = ['*']
  if (credentails) record['access-control-allow-credentials'] = ['true']
}

export default class App {
  torrentProcess = utilityProcess.fork(forkPath, ['--disallow-code-generation-from-strings --disable-proto=throw --frozen-intrinsics --js-flags="--disallow-code-generation-from-strings"'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    serviceName: 'Hayase Torrent Client',
    execArgv: ['--disallow-code-generation-from-strings --disable-proto=throw --frozen-intrinsics --js-flags="--disallow-code-generation-from-strings"']
  })

  mainWindow = new BrowserWindow({
    width: 1600,
    height: 869,
    frame: false, // process.platform === 'darwin', // Only keep the native frame on Mac
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    // transparent: TRANSPARENCY,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    show: false,
    title: 'Hayase',
    backgroundColor: '#000000',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: true,
      enableBlinkFeatures: 'FluentOverlayScrollbars,FluentOverlayScrollbar',
      backgroundThrottling: true
    }
  })

  protocol = new Protocol(this.mainWindow)
  updater = new Updater()
  discord = new Discord()
  ipc = new IPC(this, this.torrentProcess, this.discord)
  tray = new Tray(process.platform === 'win32' ? ico : process.platform === 'darwin' ? nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }) : icon)

  unsafeUseInternalALAPI = process.argv.includes('--use-internal-al-api')

  constructor () {
    if (store.data.doh) this.setDOH(store.data.doh)
    nativeTheme.themeSource = 'dark'

    expose(this.ipc, ipcMain, this.mainWindow.webContents)
    this.mainWindow.setMenuBarVisibility(false)
    this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://anilist.co/api/v2/oauth/authorize')) {
        return {
          action: 'allow',
          createWindow (options) {
            const win = new BrowserWindow({ ...options, resizable: false, fullscreenable: false, title: 'AniList', titleBarOverlay: { color: '#0b1622' }, titleBarStyle: 'hidden', backgroundColor: '#0b1622' })
            win.setMenuBarVisibility(false)
            win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
            return win.webContents
          }
        }
      } else if (url.startsWith('https://myanimelist.net/v1/oauth2/authorize')) {
        return {
          action: 'allow',
          createWindow (options) {
            const win = new BrowserWindow({ ...options, resizable: false, fullscreenable: false, title: 'MyAnimeList', titleBarOverlay: { color: '#ffffff' }, titleBarStyle: 'hidden', backgroundColor: '#ffffff' })
            win.setMenuBarVisibility(false)
            win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
            return win.webContents
          }
        }
      }
      return { action: 'deny' }
    })
    this.torrentProcess.stderr?.on('data', d => log.error('' + d))
    this.torrentProcess.stdout?.on('data', d => log.log('' + d))
    // if (TRANSPARENCY) {
    // // Transparency fixes, window is resizable when fullscreen/maximized
    //   this.mainWindow.on('enter-html-full-screen', () => {
    //     this.mainWindow.setResizable(false)
    //   })
    //   this.mainWindow.on('leave-html-full-screen', () => {
    //     this.mainWindow.setResizable(!this.mainWindow.isMaximized())
    //   })
    //   this.mainWindow.on('enter-full-screen', () => {
    //     this.mainWindow.setResizable(false)
    //   })
    //   this.mainWindow.on('leave-full-screen', () => {
    //     this.mainWindow.setResizable(!this.mainWindow.isMaximized())
    //   })
    //   this.mainWindow.on('maximize', () => {
    //     this.mainWindow.setResizable(false)
    //   })
    //   this.mainWindow.on('unmaximize', () => {
    //     this.mainWindow.setResizable(true)
    //   })

    //   this.mainWindow.on('will-move', (e) => {
    //     if (this.mainWindow.isMaximized()) {
    //       this.mainWindow.setResizable(true)
    //       this.mainWindow.unmaximize()
    //       e.preventDefault()
    //     }
    //   })
    // }

    if (this.unsafeUseInternalALAPI) {
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://graphql.anilist.co/*'] }, (details, callback) => {
        if (details.method !== 'POST') return callback({ cancel: false })
        callback({ redirectURL: 'https://anilist.co/graphql/' })
      })
    }

    session.defaultSession.webRequest.onBeforeSendHeaders(async (details, callback) => {
      if (details.url.startsWith('https://graphql.anilist.co')) {
        details.requestHeaders.Referer = 'https://anilist.co/'
        details.requestHeaders.Origin = 'https://anilist.co'
        delete details.requestHeaders['User-Agent']
      }

      if (details.url.startsWith('https://anilist.co/graphql') && this.unsafeUseInternalALAPI && details.method !== 'GET') await rewriteInternalRequest(details)

      callback({ cancel: false, requestHeaders: details.requestHeaders })
    })

    // anilist.... forgot to set the cache header on their preflights..... pathetic.... this just wastes rate limits, this fixes it!
    // they also don't set CORS headers on errors
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      if (details.url.startsWith('https://graphql.anilist.co') && details.responseHeaders) {
        setCors(details.responseHeaders)
        if (details.method === 'OPTIONS') {
          details.responseHeaders['Cache-Control'] = ['public, max-age=86400']
          details.responseHeaders['access-control-max-age'] = ['86400']
          details.statusLine = '204 No Content'
          details.statusCode = 204
        }
      }

      if (details.url.startsWith('https://anilist.co/graphql') && this.unsafeUseInternalALAPI) setCors(details.responseHeaders)

      // MAL doesn't implement CORS....
      // enable CORS for any extensions that want it, but only for specific urls
      if (details.url.startsWith('https://myanimelist.net/v1/oauth2') || details.url.startsWith('https://api.myanimelist.net/v2/') || this.ipc.corsURLS.some(corsUrl => details.url.startsWith(corsUrl))) {
        setCors(details.responseHeaders, true)
        if (details.method === 'OPTIONS' && details.statusCode === 405) {
          details.statusLine = '200 OK'
          details.statusCode = 200
        }
      }

      callback(details)
    })

    this.tray.setToolTip('Hayase')
    // this needs to be way better lol
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Hayase', enabled: false },
      { type: 'separator' },
      {
        label: 'Show App',
        click: () => {
          this.mainWindow.show()
          this.mainWindow.focus()
        }
      },
      {
        label: 'Hayase+ Extras (debrid / RPC)',
        click: () => openExtrasWindow(this.ipc)
      },
      { type: 'separator' },
      { label: 'Exit Hayase', click: () => this.destroy() }
    ]))
    this.tray.on('click', () => {
      this.mainWindow.show()
      this.mainWindow.focus()
    })

    this.mainWindow.once('ready-to-show', () => {
      this.mainWindow.show()
    })

    this.mainWindow.on('closed', () => this.destroy())
    this.torrentProcess.on('exit', () => this.destroy())
    ipcMain.on('close', () => this.destroy())
    app.on('before-quit', e => {
      if (this.destroyed) return
      e.preventDefault()
      this.destroy()
    })

    // Inject the fork's debrid + RPC settings into hayase.app's existing
    // settings pages so they look like part of the upstream UI:
    //   - "Debrid" section appended at the end of /app/settings/client
    //   - "Enable Discord Rich Presence" toggle prepended inside the
    //     existing "Rich Presence Settings" group on /app/settings/interface
    //
    // Hayase.app uses SvelteKit SPA routing (no full page loads) so we
    // re-check on every DOM mutation, but bail fast unless the URL is one
    // of the two settings pages. Section markers prevent duplicates.
    //
    // All cards mirror interface/src/lib/components/SettingCard.svelte's
    // markup (flex + bg-neutral-950) so they're visually identical to
    // upstream cards.
    const HAYASE_INJECT = /* js */ `
      (() => {
        if (window.__hayaseInjector) return
        window.__hayaseInjector = true
        const get = () => window.native?.getExtras?.() ?? Promise.resolve(null)
        const set = (e) => window.native?.setExtras?.(e) ?? Promise.resolve()
        const test = (p, k) => window.native?.testDebridKey?.(p, k) ?? Promise.reject(new Error('unavailable'))

        const PROVIDERS = {
          none: 'Disabled (use BitTorrent)',
          realdebrid: 'Real-Debrid',
          alldebrid: 'AllDebrid',
          premiumize: 'Premiumize',
          torbox: 'TorBox'
        }

        function header (text, marker) {
          const h = document.createElement('div')
          h.className = 'font-weight-bold text-xl font-bold'
          h.dataset.injected = marker
          h.textContent = text
          return h
        }

        function card (title, description, control, marker) {
          const wrap = document.createElement('div')
          wrap.className = 'flex flex-col md:flex-row md:items-center justify-between bg-neutral-950 rounded-md px-6 py-4 gap-3'
          wrap.dataset.injected = marker
          const label = document.createElement('label')
          label.className = 'space-1 block leading-[unset] grow'
          const titleEl = document.createElement('div')
          titleEl.className = 'font-bold'
          titleEl.textContent = title
          const descEl = document.createElement('div')
          descEl.className = 'text-muted-foreground text-xs whitespace-pre-wrap block'
          descEl.textContent = description
          label.append(titleEl, descEl)
          wrap.append(label, control)
          return wrap
        }

        function makeSwitch (checked, onChange) {
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.setAttribute('role', 'switch')
          btn.setAttribute('aria-checked', String(!!checked))
          btn.style.cssText = 'position:relative;width:32px;height:16px;border-radius:9999px;border:2px solid transparent;cursor:pointer;flex-shrink:0;transition:background 120ms;background:' + (checked ? '#fff' : '#3f3f46')
          const thumb = document.createElement('span')
          thumb.style.cssText = 'display:block;width:12px;height:12px;border-radius:50%;background:' + (checked ? '#000' : '#a1a1aa') + ';transform:translateX(' + (checked ? '16px' : '0') + ');transition:transform 120ms,background 120ms'
          btn.appendChild(thumb)
          btn.addEventListener('click', () => {
            const next = btn.getAttribute('aria-checked') !== 'true'
            btn.setAttribute('aria-checked', String(next))
            btn.style.background = next ? '#fff' : '#3f3f46'
            thumb.style.background = next ? '#000' : '#a1a1aa'
            thumb.style.transform = next ? 'translateX(16px)' : 'translateX(0)'
            onChange(next)
          })
          return btn
        }

        // Find the container that holds upstream's settings cards on the
        // current page. We use the last existing section header's parent -
        // that's the same container the rest of the page's cards live in.
        function findSettingsContainer () {
          const headers = document.querySelectorAll("div.font-weight-bold.text-xl.font-bold:not([data-injected])")
          for (let i = headers.length - 1; i >= 0; i--) {
            const p = headers[i].parentElement
            if (p && p.querySelector('div.bg-neutral-950.rounded-md')) return p
          }
          return null
        }

        async function injectDebrid () {
          if (document.querySelector('[data-injected="debrid"]')) return
          const container = findSettingsContainer()
          if (!container) return
          const extras = await get()
          if (!extras) return

          const select = document.createElement('select')
          select.className = 'w-64 shrink-0 bg-background border border-input rounded-md px-3 py-2 text-sm'
          for (const [v, label] of Object.entries(PROVIDERS)) {
            const opt = document.createElement('option')
            opt.value = v
            opt.textContent = label
            if (v === extras.debridProvider) opt.selected = true
            select.appendChild(opt)
          }

          const keyInput = document.createElement('input')
          keyInput.type = 'password'
          keyInput.autocomplete = 'off'
          keyInput.placeholder = 'paste your API key'
          keyInput.value = extras.debridApiKey
          keyInput.className = 'bg-background rounded-md border border-input px-3 py-2 text-sm w-64'

          const testBtn = document.createElement('button')
          testBtn.type = 'button'
          testBtn.textContent = 'Test'
          testBtn.style.cssText = 'background:#27272a;color:#fff;cursor:pointer;border:1px solid #3f3f46;border-radius:6px;padding:8px 14px;font:inherit'

          const statusEl = document.createElement('div')
          statusEl.style.cssText = 'font-size:12px;min-height:16px;color:#a1a1aa'

          const keyRow = document.createElement('div')
          keyRow.style.cssText = 'display:flex;gap:8px;align-items:center'
          keyRow.append(keyInput, testBtn)
          const keyCol = document.createElement('div')
          keyCol.style.cssText = 'display:flex;flex-direction:column;gap:6px;flex-shrink:0'
          keyCol.append(keyRow, statusEl)

          const debridHeader = header('Debrid', 'debrid')
          const providerCard = card('Debrid Provider', 'Stream torrents through a debrid service instead of peer-to-peer. Once a provider and key are configured, every torrent resolves via the debrid CDN — no local torrenting. Requires a paid account.', select, 'debrid')
          const keyCard = card('API Key', "Your debrid token. Stored locally in Hayase's settings.json. Hit Test to verify.", keyCol, 'debrid')
          keyCard.style.display = extras.debridProvider === 'none' ? 'none' : ''

          select.addEventListener('change', async () => {
            extras.debridProvider = select.value
            await set(extras)
            keyCard.style.display = extras.debridProvider === 'none' ? 'none' : ''
            statusEl.textContent = ''
          })
          keyInput.addEventListener('input', async () => {
            extras.debridApiKey = keyInput.value
            await set(extras)
            statusEl.textContent = ''
          })
          let testing = false
          testBtn.addEventListener('click', async () => {
            if (testing) return
            testing = true
            testBtn.disabled = true
            const t = testBtn.textContent
            testBtn.textContent = 'Testing…'
            statusEl.style.color = '#a1a1aa'
            statusEl.textContent = ''
            try {
              const status = await test(extras.debridProvider, extras.debridApiKey)
              statusEl.style.color = '#5dd896'
              statusEl.textContent = 'Authenticated as ' + status.user + (status.premium ? ' (premium)' : ' (free)')
            } catch (e) {
              statusEl.style.color = '#ff7373'
              statusEl.textContent = (e && e.message) || String(e)
            } finally {
              testing = false
              testBtn.disabled = false
              testBtn.textContent = t
            }
          })

          container.append(debridHeader, providerCard, keyCard)
        }

        async function injectRpcMaster () {
          if (document.querySelector('[data-injected="rpc"]')) return
          // Find the existing "Show Details in Discord Rich Presence" card
          // and prepend the master toggle just before it (so both live in
          // the existing "Rich Presence Settings" group).
          const labels = document.querySelectorAll('div.font-bold')
          let detailsCard = null
          for (const l of labels) {
            if (l.textContent && l.textContent.includes('Show Details in Discord Rich Presence')) {
              detailsCard = l.closest('div.bg-neutral-950')
              break
            }
          }
          if (!detailsCard) return
          const extras = await get()
          if (!extras) return

          const sw = makeSwitch(extras.enableRPC, async (v) => {
            extras.enableRPC = v
            await set(extras)
            // Reflect the disabled state of the upstream "Show Details"
            // switch when the master is off (matches upstream's intended
            // behaviour from when this toggle was in the source).
            const detailsSwitch = detailsCard.querySelector('button[role="switch"]')
            if (detailsSwitch) detailsSwitch.style.opacity = v ? '' : '0.4'
          })
          const masterCard = card(
            'Enable Discord Rich Presence',
            'Shows your Hayase activity in your Discord profile. Turn this off to disconnect from Discord entirely — nothing will be sent.',
            sw,
            'rpc'
          )
          detailsCard.parentElement && detailsCard.parentElement.insertBefore(masterCard, detailsCard)

          // Sync upstream details switch opacity with master state.
          const detailsSwitch = detailsCard.querySelector('button[role="switch"]')
          if (detailsSwitch) detailsSwitch.style.opacity = extras.enableRPC ? '' : '0.4'
        }

        function tick () {
          const path = location.pathname.replace(/\\/+$/, '')
          if (path.endsWith('/app/settings/client')) injectDebrid().catch(() => undefined)
          else if (path.endsWith('/app/settings/interface')) injectRpcMaster().catch(() => undefined)
        }

        new MutationObserver(tick).observe(document.documentElement, { childList: true, subtree: true })
        tick()
      })()
    `
    const inject = () => this.mainWindow.webContents.executeJavaScript(HAYASE_INJECT).catch(() => undefined)
    this.mainWindow.webContents.on('did-finish-load', inject)
    this.mainWindow.webContents.on('did-frame-finish-load', (_e, isMainFrame) => { if (isMainFrame) inject() })

    this.mainWindow.webContents.on('frame-created', (_, { frame }) => {
      frame?.once('dom-ready', () => {
        if (frame.url.startsWith('https://www.youtube-nocookie.com')) {
          frame.executeJavaScript(/* js */`
            new MutationObserver(() => {
              if (document.querySelector('div.ytp-error-content-wrap-subreason a[href*="www.youtube"]')) location.reload()
            }).observe(document.body, { childList: true, subtree: true })
          `)
        }
      })
    })

    // @ts-expect-error idk brokey
    powerMonitor.on('shutdown', (e: Event) => {
      if (this.destroyed) return
      e.preventDefault()
      this.destroy()
    })

    // TODO
    // ipcMain.on('notification', async (_e, opts: { icon?: string | NativeImage, data: { id?: number }}) => {
    //   if (opts.icon != null) {
    //     const res = await fetch(opts.icon as string)
    //     const buffer = await res.arrayBuffer()
    //     opts.icon = nativeImage.createFromBuffer(Buffer.from(buffer))
    //   }
    //   const notification = new Notification(opts)
    //   notification.on('click', () => {
    //     if (opts.data.id != null) {
    //       this.mainWindow.show()
    //       this.protocol.protocolMap.anime(',' + opts.data.id)
    //     }
    //   })
    //   notification.show()
    // })

    electronApp.setAppUserModelId('com.github.hayase-app')
    if (process.platform === 'win32') {
      // this message usually fires in dev-mode from the parent process
      process.on('message', data => {
        if (data === 'graceful-exit') this.destroy()
      })
      electronShutdownHandler.setWindowHandle(this.mainWindow.getNativeWindowHandle())
      electronShutdownHandler.blockShutdown('Saving torrent data...')
      electronShutdownHandler.on('shutdown', async () => {
        await this.destroy()
        electronShutdownHandler.releaseShutdown()
      })
    } else {
      process.on('SIGTERM', () => this.destroy())
    }

    if (is.dev) this.mainWindow.webContents.openDevTools()
    this.mainWindow.loadURL(BASE_URL + this.protocol.navigateTarget()).catch(err => {
      log.error(err)
      if (this.hasDOH) return
      this.setDOH('https://cloudflare-dns.com/dns-query')
      queueMicrotask(() => this.mainWindow.loadURL(BASE_URL + this.protocol.navigateTarget()))
    })
    this.mainWindow.webContents.on('will-navigate', (e, url) => {
      const parsedUrl = new URL(url)
      if (parsedUrl.origin !== BASE_URL) {
        e.preventDefault()
      }
    })

    let crashcount = 0
    this.mainWindow.webContents.on('render-process-gone', async (_e, { reason }) => {
      if (reason === 'crashed') {
        if (++crashcount > 10) {
          // TODO
          await dialog.showMessageBox({ message: 'Crashed too many times.', title: 'Hayase', detail: 'App crashed too many times. For a fix visit https://hayase.watch/faq/', icon })
          shell.openExternal('https://hayase.watch/faq/')
        } else {
          app.relaunch()
        }
        app.quit()
      }
    })

    const reloadPorts = () => {
      if (this.destroyed) return
      const { port1, port2 } = new MessageChannelMain()
      this.torrentProcess.postMessage({ id: 'settings', data: { ...store.data.torrentSettings, path: store.data.torrentPath, debridProvider: store.data.extras.debridProvider, debridApiKey: store.data.extras.debridApiKey } }, [port1])

      this.mainWindow.webContents.postMessage('port', null, [port2])
    }

    const { port1, port2 } = new MessageChannelMain()
    this.torrentProcess.once('spawn', () => {
      this.torrentProcess.postMessage({ id: 'settings', data: { ...store.data.torrentSettings, path: store.data.torrentPath, doh: this.hasDOH && store.data.doh, debridProvider: store.data.extras.debridProvider, debridApiKey: store.data.extras.debridApiKey } }, [port1])
      // Apply Hayase+ extras (debrid + RPC) once the torrent process is up,
      // so a configured RPC toggle / debrid provider is live from launch.
      applyStoredExtrasOnStartup(this.ipc)
    })
    ipcMain.once('preload-done', () => {
      this.mainWindow.webContents.postMessage('port', null, [port2])
      ipcMain.on('preload-done', () => reloadPorts())
    })

    app.on('second-instance', (_event, commandLine) => {
      if (this.destroyed) return
      // Someone tried to run a second instance, we should focus our window.
      this.mainWindow.show()
      this.mainWindow.focus()
      if (this.mainWindow.isMinimized()) this.mainWindow.restore()
      this.mainWindow.focus()
      // There's probably a better way to do this instead of a for loop and split[1][0]
      // but for now it works as a way to fix multiple OS's commandLine differences
      for (const line of commandLine) {
        this.protocol.handleProtocol(line)
      }
    })

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    app.setJumpList?.([
      {
        type: 'custom',
        name: 'Frequent',
        items: [
          {
            type: 'task',
            program: 'hayase://schedule/',
            title: 'Airing Schedule',
            description: 'Open The Airing Schedule'
          },
          {
            type: 'task',
            program: 'hayase://w2g/',
            title: 'Watch Together',
            description: 'Create a New Watch Together Lobby'
          },
          {
            type: 'task',
            program: 'hayase://donate/',
            title: 'Donate',
            description: 'Support This App'
          },
          {
            type: 'task',
            program: 'hayase://devtools/',
            title: 'Devtools',
            description: 'Open Devtools'
          }
        ]
      }
    ])
  }

  hasDOH = false
  setDOH (dns: string) {
    try {
      app.configureHostResolver({
        secureDnsMode: 'secure',
        secureDnsServers: [dns]
      })
      this.hasDOH = true
    } catch (e) {
      const err = e as Error
      log.error('Failed to set DOH: ', err.stack)
      this.hasDOH = false
    }
  }

  destroyed = false

  hideToTray () {
    if (this.destroyed) return
    this.mainWindow.hide()
    webFrame.clearCache()
  }

  async destroy (forceRunAfter = false) {
    if (this.destroyed) return
    this.destroyed = true
    this.mainWindow.hide()
    this.torrentProcess.postMessage({ id: 'destroy' })
    await new Promise(resolve => {
      this.torrentProcess.once('exit', resolve)
      setTimeout(resolve, 5000).unref()
    })
    if (!this.updater.install(forceRunAfter)) app.quit()
  }
}
