import { contextBridge, ipcRenderer } from 'electron'
import type { DaemonStatus } from '../shared/protocol'
import type { PrivilegedResult } from '../main/privileged-action'

export interface DualVpnApi {
  getAppVersion(): Promise<string>
  getStatus(): Promise<DaemonStatus>
  repairNow(): Promise<void>
  setPaused(value: boolean): Promise<void>
  setAutoEnableAtBoot(value: boolean): Promise<void>
  setLogLevel(value: 'standard' | 'detailed'): Promise<void>
  installService(): Promise<PrivilegedResult>
  uninstallService(): Promise<PrivilegedResult>
  exportDiagnostics(): Promise<string | null>
}

const dualVpnApi: DualVpnApi = {
  getAppVersion: () => ipcRenderer.invoke('dual-vpn:get-app-version'),
  getStatus: () => ipcRenderer.invoke('dual-vpn:get-status'),
  repairNow: () => ipcRenderer.invoke('dual-vpn:repair-now'),
  setPaused: (value) => ipcRenderer.invoke('dual-vpn:set-paused', value),
  setAutoEnableAtBoot: (value) => ipcRenderer.invoke('dual-vpn:set-auto-enable', value),
  setLogLevel: (value) => ipcRenderer.invoke('dual-vpn:set-log-level', value),
  installService: () => ipcRenderer.invoke('dual-vpn:install-service'),
  uninstallService: () => ipcRenderer.invoke('dual-vpn:uninstall-service'),
  exportDiagnostics: () => ipcRenderer.invoke('dual-vpn:export-diagnostics')
}

contextBridge.exposeInMainWorld('dualVpn', dualVpnApi)
