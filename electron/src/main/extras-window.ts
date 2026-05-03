// "Hayase+ Extras" window: a tiny standalone settings panel for features
// this fork adds on top of upstream (debrid streaming + Discord RPC toggle).
//
// We can't put these into the main UI because the main UI is loaded from
// https://hayase.app/ (upstream's hosted SvelteKit build) which doesn't
// have our settings. Bundling our modified interface broke external API
// access (Cloudflare bot detection on hayase.ani.zip) so this is the
// cleaner alternative.

import { join } from 'node:path'

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'

import store, { type ExtrasSettings } from './store.ts'

import type IPC from './ipc.ts'

const HTML = /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Hayase+ Extras</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    margin: 0;
    padding: 24px;
    background: #0b0d12;
    color: #e2e6f0;
    font-size: 14px;
    -webkit-user-select: none;
  }
  h1 { font-size: 20px; margin: 0 0 4px; font-weight: 700; }
  .subtitle { color: #7c8493; margin: 0 0 24px; font-size: 13px; }
  section {
    background: #161922;
    border: 1px solid #232735;
    border-radius: 10px;
    padding: 16px 18px;
    margin-bottom: 14px;
  }
  section h2 { font-size: 15px; margin: 0 0 4px; font-weight: 600; }
  section p { color: #7c8493; margin: 0 0 14px; font-size: 12.5px; line-height: 1.45; }
  .row { display: flex; align-items: center; gap: 10px; margin: 10px 0; }
  .row.column { flex-direction: column; align-items: stretch; }
  .row label { flex: 1; cursor: pointer; }
  .row label.subtle { color: #7c8493; }
  .row label.subtle.disabled { opacity: 0.4; pointer-events: none; }
  .field { display: flex; gap: 8px; }
  input[type="password"], input[type="text"], select {
    background: #0b0d12;
    border: 1px solid #2c3142;
    color: #e2e6f0;
    padding: 8px 10px;
    border-radius: 6px;
    font: inherit;
    flex: 1;
    -webkit-user-select: text;
  }
  input:focus, select:focus { outline: none; border-color: #4a87e0; }
  button {
    background: #2c3142;
    color: #e2e6f0;
    border: 1px solid #383e52;
    padding: 8px 14px;
    border-radius: 6px;
    font: inherit;
    cursor: pointer;
    transition: background 80ms;
  }
  button:hover:not(:disabled) { background: #383e52; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.primary { background: #2563eb; border-color: #1e40af; }
  button.primary:hover:not(:disabled) { background: #1d4ed8; }
  .status { margin-top: 10px; font-size: 12.5px; min-height: 18px; }
  .status.ok { color: #5dd896; }
  .status.err { color: #ff7373; }
  .switch {
    position: relative;
    width: 38px; height: 20px;
    background: #2c3142;
    border-radius: 10px;
    cursor: pointer;
    transition: background 120ms;
    flex-shrink: 0;
  }
  .switch::after {
    content: '';
    position: absolute;
    top: 2px; left: 2px;
    width: 16px; height: 16px;
    background: #cfd6e6;
    border-radius: 50%;
    transition: transform 120ms;
  }
  .switch.on { background: #2563eb; }
  .switch.on::after { transform: translateX(18px); background: #fff; }
  .footer {
    margin-top: 18px;
    color: #5b6273;
    font-size: 11.5px;
    text-align: center;
  }
  a { color: #4a87e0; }
</style>
</head>
<body>
<h1>Hayase+ Extras</h1>
<p class="subtitle">Settings for the features this fork adds on top of upstream Hayase.</p>

<section>
  <h2>Discord Rich Presence</h2>
  <p>Show your Hayase activity in your Discord profile. Turn this off to disconnect from Discord entirely.</p>
  <div class="row">
    <label for="enable-rpc">Enable Discord Rich Presence</label>
    <div id="enable-rpc" class="switch" data-checked></div>
  </div>
  <div class="row">
    <label for="show-details" class="subtle">Show anime title + episode in RPC</label>
    <div id="show-details" class="switch" data-checked></div>
  </div>
</section>

<section>
  <h2>Debrid Streaming</h2>
  <p>Route torrents through a debrid service instead of streaming peer-to-peer. Requires a paid account with the chosen provider. Once configured, every torrent you click will resolve via the debrid CDN.</p>
  <div class="row column">
    <label for="debrid-provider">Provider</label>
    <select id="debrid-provider">
      <option value="none">Disabled (use BitTorrent)</option>
      <option value="realdebrid">Real-Debrid</option>
      <option value="alldebrid">AllDebrid</option>
      <option value="premiumize">Premiumize</option>
      <option value="torbox">TorBox</option>
    </select>
  </div>
  <div class="row column" id="key-row" hidden>
    <label for="debrid-key">API Key (stored locally)</label>
    <div class="field">
      <input type="password" id="debrid-key" autocomplete="off" placeholder="paste your API key here">
      <button id="test-key" class="primary">Test</button>
    </div>
    <div id="debrid-status" class="status"></div>
  </div>
</section>

<p class="footer">nickEatsBread/hayase &middot; settings persist in <code>%APPDATA%/hayase/settings.json</code></p>

<script>
  const api = window.extrasAPI
  const el = id => document.getElementById(id)

  let settings = null
  let testing = false

  function toggleSwitch (sw, on) {
    sw.classList.toggle('on', !!on)
    sw.dataset.checked = on ? 'true' : ''
  }

  function syncUI () {
    toggleSwitch(el('enable-rpc'), settings.enableRPC)
    toggleSwitch(el('show-details'), settings.showDetailsInRPC)
    el('debrid-provider').value = settings.debridProvider
    el('debrid-key').value = settings.debridApiKey
    el('key-row').hidden = settings.debridProvider === 'none'
    el('show-details').classList.toggle('disabled', !settings.enableRPC)
    el('debrid-status').textContent = ''
    el('debrid-status').className = 'status'
  }

  function save () {
    api.set(settings)
  }

  el('enable-rpc').addEventListener('click', () => {
    settings.enableRPC = !settings.enableRPC
    syncUI(); save()
  })
  el('show-details').addEventListener('click', () => {
    if (!settings.enableRPC) return
    settings.showDetailsInRPC = !settings.showDetailsInRPC
    syncUI(); save()
  })
  el('debrid-provider').addEventListener('change', () => {
    settings.debridProvider = el('debrid-provider').value
    syncUI(); save()
  })
  el('debrid-key').addEventListener('input', () => {
    settings.debridApiKey = el('debrid-key').value
    save()
  })
  el('test-key').addEventListener('click', async () => {
    if (testing) return
    testing = true
    el('test-key').disabled = true
    el('debrid-status').textContent = 'Testing...'
    el('debrid-status').className = 'status'
    try {
      const status = await api.testKey(settings.debridProvider, settings.debridApiKey)
      el('debrid-status').textContent =
        'Authenticated as ' + status.user +
        (status.premium ? ' (premium)' : ' (free - limited functionality)') +
        (status.expiration ? ' until ' + new Date(status.expiration).toLocaleDateString() : '')
      el('debrid-status').className = 'status ok'
    } catch (e) {
      el('debrid-status').textContent = e.message ?? String(e)
      el('debrid-status').className = 'status err'
    } finally {
      testing = false
      el('test-key').disabled = false
    }
  })

  ;(async () => {
    settings = await api.get()
    syncUI()
  })()
</script>
</body>
</html>
`

// IPC channel names live here so the preload + main agree without sharing
// types via the abslink layer.
const CHANNEL_GET = 'extras:get'
const CHANNEL_SET = 'extras:set'
const CHANNEL_TEST = 'extras:test-debrid'

let extrasWindow: BrowserWindow | undefined
let handlersRegistered = false

function registerHandlers (ipc: IPC) {
  if (handlersRegistered) return
  handlersRegistered = true
  ipcMain.handle(CHANNEL_GET, () => store.get('extras'))
  ipcMain.handle(CHANNEL_SET, (_e: IpcMainInvokeEvent, extras: ExtrasSettings) => {
    ipc.applyExtras(extras)
  })
  ipcMain.handle(CHANNEL_TEST, async (_e: IpcMainInvokeEvent, provider: ExtrasSettings['debridProvider'], key: string) => {
    return await ipc.checkDebridKey(provider, key)
  })
}

export function applyStoredExtrasOnStartup (ipc: IPC) {
  registerHandlers(ipc)
  ipc.applyExtras(store.get('extras'))
}

export function openExtrasWindow (ipc: IPC) {
  registerHandlers(ipc)
  if (extrasWindow && !extrasWindow.isDestroyed()) {
    extrasWindow.focus()
    return
  }
  extrasWindow = new BrowserWindow({
    width: 540,
    height: 640,
    title: 'Hayase+ Extras',
    autoHideMenuBar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#0b0d12',
    webPreferences: {
      // electron-vite emits both preloads side-by-side under out/preload/.
      preload: join(__dirname, '../preload/extras.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  extrasWindow.setMenuBarVisibility(false)
  extrasWindow.loadURL('data:text/html;base64,' + Buffer.from(HTML, 'utf8').toString('base64'))
  extrasWindow.on('closed', () => { extrasWindow = undefined })
}

// Channel constants exported so the preload script (which is bundled
// separately) imports the same strings. They're tiny so duplicating is
// cheap, but we still want a single source of truth.
export const EXTRAS_CHANNELS = { get: CHANNEL_GET, set: CHANNEL_SET, test: CHANNEL_TEST } as const
