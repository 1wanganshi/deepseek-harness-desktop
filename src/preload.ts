import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi, RepairReport, RuntimeDiagnostics, RuntimeState } from './shared/types.js'
import type { DesktopRestartResult } from './main/desktop-restart.js'

const api: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke('desktop:get-snapshot') as Promise<RuntimeDiagnostics>,
  openDiagnostics: () => ipcRenderer.invoke('desktop:open-diagnostics') as Promise<void>,
  openRepairWindow: () => ipcRenderer.invoke('desktop:open-repair-window') as Promise<void>,
  closeRepairWindow: () => ipcRenderer.invoke('desktop:close-repair-window') as Promise<void>,
  setShellOverlayVisible: (visible: boolean) => ipcRenderer.invoke('desktop:set-shell-overlay-visible', visible) as Promise<void>,
  setStatusPanelExpanded: (expanded: boolean) => ipcRenderer.invoke('desktop:set-status-panel-expanded', expanded) as Promise<void>,
  getStatusPanelExpanded: () => ipcRenderer.invoke('desktop:get-status-panel-expanded') as Promise<boolean>,
  repairRuntime: () => ipcRenderer.invoke('desktop:repair-runtime') as Promise<RepairReport>,
  restartDesktop: () => ipcRenderer.invoke('desktop:restart-desktop') as Promise<DesktopRestartResult>,
  onRuntimeState: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, state: RuntimeState) => listener(state)
    ipcRenderer.on('desktop:runtime-state', callback)
    return () => ipcRenderer.removeListener('desktop:runtime-state', callback)
  },
  onStatusPanelExpanded: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, expanded: boolean) => listener(expanded)
    ipcRenderer.on('desktop:status-panel-expanded', callback)
    return () => ipcRenderer.removeListener('desktop:status-panel-expanded', callback)
  },
  onRepairProgress: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, report: RepairReport) => listener(report)
    ipcRenderer.on('desktop:repair-progress', callback)
    return () => ipcRenderer.removeListener('desktop:repair-progress', callback)
  },
}

contextBridge.exposeInMainWorld('desktopApi', api)
