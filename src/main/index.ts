import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Tray,
  type BrowserWindowConstructorOptions
} from 'electron'
import { z } from 'zod'
import { DaemonClient } from './daemon-client'
import { exportDiagnosticBundle } from './diagnostics'
import { runPrivilegedAction } from './privileged-action'
import type { ControlRequest, DaemonStatus } from '../shared/protocol'
import { createTrayIcon, handleWindowClose, MenuBarController } from './tray'

export const IPC_CHANNELS = [
  'dual-vpn:get-app-version',
  'dual-vpn:get-status',
  'dual-vpn:repair-now',
  'dual-vpn:set-paused',
  'dual-vpn:set-auto-enable',
  'dual-vpn:set-log-level',
  'dual-vpn:install-service',
  'dual-vpn:uninstall-service',
  'dual-vpn:export-diagnostics'
] as const

const BooleanSchema = z.boolean()
const LogLevelSchema = z.enum(['standard', 'detailed'])

export interface DaemonControlClient {
  readStatus(): Promise<DaemonStatus>
  send(request: ControlRequest): Promise<void>
}

let mainWindow: BrowserWindow | null = null
let menuBarController: MenuBarController | null = null
let isQuitting = false

export function createWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1040,
    height: 700,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    backgroundColor: '#07111f',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  }
}

export function isAllowedRendererUrl(target: string, allowed: string): boolean {
  try {
    const targetUrl = new URL(target)
    const allowedUrl = new URL(allowed)
    targetUrl.hash = ''
    allowedUrl.hash = ''
    return targetUrl.href === allowedUrl.href
  } catch {
    return false
  }
}

function requestBase() {
  return {
    schemaVersion: 1 as const,
    requestId: randomUUID(),
    createdAt: new Date().toISOString()
  }
}

export function createDaemonClient(): DaemonClient {
  const fixtureDirectory = process.env.DUALVPN_UI_FIXTURE_DIR
  if (!app.isPackaged && fixtureDirectory) {
    return new DaemonClient({
      statusPath: path.join(fixtureDirectory, 'status.json'),
      requestDirectory: path.join(fixtureDirectory, 'ipc')
    })
  }
  return new DaemonClient()
}

export function registerIpcHandlers(client: DaemonControlClient = createDaemonClient()): void {
  ipcMain.handle('dual-vpn:get-app-version', () => app.getVersion())
  ipcMain.handle('dual-vpn:get-status', () => client.readStatus())
  ipcMain.handle('dual-vpn:repair-now', () => client.send({
    ...requestBase(),
    type: 'repairNow'
  }))
  ipcMain.handle('dual-vpn:set-paused', (_event, value: unknown) => client.send({
    ...requestBase(),
    type: 'setPaused',
    value: BooleanSchema.parse(value)
  }))
  ipcMain.handle('dual-vpn:set-auto-enable', (_event, value: unknown) => client.send({
    ...requestBase(),
    type: 'setAutoEnableAtBoot',
    value: BooleanSchema.parse(value)
  }))
  ipcMain.handle('dual-vpn:set-log-level', (_event, value: unknown) => client.send({
    ...requestBase(),
    type: 'setLogLevel',
    value: LogLevelSchema.parse(value)
  }))
  ipcMain.handle('dual-vpn:install-service', () => runPrivilegedAction('install'))
  ipcMain.handle('dual-vpn:uninstall-service', () => runPrivilegedAction('uninstall'))
  ipcMain.handle('dual-vpn:export-diagnostics', async () => {
    const status = await client.readStatus()
    const fixtureDirectory = !app.isPackaged ? process.env.DUALVPN_UI_FIXTURE_DIR : undefined
    return exportDiagnosticBundle(status, fixtureDirectory)
  })
}

export async function createMainWindow(): Promise<BrowserWindow> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
  const preloadPath = path.join(moduleDirectory, '../preload/index.js')
  const rendererPath = path.join(moduleDirectory, '../renderer/index.html')
  const rendererUrl = pathToFileURL(rendererPath).href
  const window = new BrowserWindow(createWindowOptions(preloadPath))

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedRendererUrl(targetUrl, rendererUrl)) event.preventDefault()
  })
  window.once('ready-to-show', () => window.show())

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await window.loadFile(rendererPath)
  }
  return window
}

async function showMainWindow(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = await createMainWindow()
    mainWindow.on('close', (event) => handleWindowClose(event, mainWindow!, isQuitting))
    mainWindow.on('closed', () => { mainWindow = null })
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

export async function startApplication(
  client: DaemonControlClient = createDaemonClient()
): Promise<void> {
  await app.whenReady()
  isQuitting = false
  app.on('before-quit', () => { isQuitting = true })
  app.on('will-quit', () => {
    menuBarController?.dispose()
    menuBarController = null
  })
  registerIpcHandlers(client)
  await showMainWindow()

  const tray = new Tray(createTrayIcon(nativeImage))
  menuBarController = new MenuBarController({
    tray,
    buildMenu: (template) => Menu.buildFromTemplate(template),
    readStatus: () => client.readStatus(),
    actions: {
      showWindow: () => { void showMainWindow() },
      repairNow: () => client.send({
        ...requestBase(),
        type: 'repairNow'
      }),
      setPaused: (value) => client.send({
        ...requestBase(),
        type: 'setPaused',
        value
      }),
      quit: () => app.quit()
    },
    scheduleRefresh: (refresh) => {
      const interval = setInterval(refresh, 5_000)
      return () => clearInterval(interval)
    }
  })
  await menuBarController.start()
  app.on('activate', () => {
    void showMainWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

if (!process.env.VITEST) {
  void startApplication()
}
