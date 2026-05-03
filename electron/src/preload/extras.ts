// Preload for the Hayase+ Extras window. Exposes a tiny IPC bridge that the
// inline HTML script uses to read/write settings + test debrid keys.

import { contextBridge, ipcRenderer } from 'electron'

import type { ExtrasSettings } from '../main/store'

contextBridge.exposeInMainWorld('extrasAPI', {
  get: () => ipcRenderer.invoke('extras:get') as Promise<ExtrasSettings>,
  set: (extras: ExtrasSettings) => ipcRenderer.invoke('extras:set', extras),
  testKey: (provider: ExtrasSettings['debridProvider'], apiKey: string) => ipcRenderer.invoke('extras:test-debrid', provider, apiKey)
})
