import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi, PluginStatus, RuntimeDiagnostics, RuntimeState, UpdateStatus } from './shared/types.js'

const api: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke('desktop:get-snapshot') as Promise<RuntimeDiagnostics>,
  openDiagnostics: () => ipcRenderer.invoke('desktop:open-diagnostics') as Promise<void>,
  setStatusPanelExpanded: (expanded: boolean) => ipcRenderer.invoke('desktop:set-status-panel-expanded', expanded) as Promise<void>,
  repairRuntime: () => ipcRenderer.invoke('desktop:repair-runtime') as Promise<RuntimeState>,
  restartDesktop: () => ipcRenderer.invoke('desktop:restart-desktop') as Promise<void>,
  checkForUpdate: () => ipcRenderer.invoke('desktop:check-update') as Promise<UpdateStatus>,
  installUpdate: () => ipcRenderer.invoke('desktop:install-update') as Promise<UpdateStatus>,
  syncPlugins: () => ipcRenderer.invoke('desktop:sync-plugins') as Promise<PluginStatus>,
  onRuntimeState: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, state: RuntimeState) => listener(state)
    ipcRenderer.on('desktop:runtime-state', callback)
    return () => ipcRenderer.removeListener('desktop:runtime-state', callback)
  },
  onUpdateState: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => listener(status)
    ipcRenderer.on('desktop:update-status', callback)
    return () => ipcRenderer.removeListener('desktop:update-status', callback)
  },
  onStatusPanelExpanded: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, expanded: boolean) => listener(expanded)
    ipcRenderer.on('desktop:status-panel-expanded', callback)
    return () => ipcRenderer.removeListener('desktop:status-panel-expanded', callback)
  },
}

contextBridge.exposeInMainWorld('desktopApi', api)
