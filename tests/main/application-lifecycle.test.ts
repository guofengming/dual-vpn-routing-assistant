import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonStatus } from '../../src/shared/protocol'

const electronState = vi.hoisted(() => ({
  appHandlers: new Map<string, () => void>(),
  windows: [] as Array<{
    handlers: Map<string, (event?: { preventDefault(): void }) => void>
    show: ReturnType<typeof vi.fn>
    hide: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    isDestroyed: ReturnType<typeof vi.fn>
    isMinimized: ReturnType<typeof vi.fn>
    restore: ReturnType<typeof vi.fn>
  }>,
  trays: [] as Array<{
    handlers: Map<string, () => void>
    setToolTip: ReturnType<typeof vi.fn>
    popUpContextMenu: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
  }>
}))

vi.mock('electron', () => {
  class BrowserWindow {
    static getAllWindows = vi.fn(() => electronState.windows)
    handlers = new Map<string, (event?: { preventDefault(): void }) => void>()
    show = vi.fn()
    hide = vi.fn()
    focus = vi.fn()
    isDestroyed = vi.fn(() => false)
    isMinimized = vi.fn(() => false)
    restore = vi.fn()
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn()
    }
    once = vi.fn((event: string, listener: () => void) => {
      if (event === 'ready-to-show') listener()
    })
    on = vi.fn((event: string, listener: (event?: { preventDefault(): void }) => void) => {
      this.handlers.set(event, listener)
    })
    loadURL = vi.fn(async () => undefined)
    loadFile = vi.fn(async () => undefined)

    constructor() {
      electronState.windows.push(this)
    }
  }

  class Tray {
    handlers = new Map<string, () => void>()
    setToolTip = vi.fn()
    popUpContextMenu = vi.fn()
    destroy = vi.fn()
    on = vi.fn((event: string, listener: () => void) => { this.handlers.set(event, listener) })

    constructor() {
      electronState.trays.push(this)
    }
  }

  const trayImage = { addRepresentation: vi.fn(), setTemplateImage: vi.fn() }
  return {
    app: {
      isPackaged: true,
      whenReady: vi.fn(async () => undefined),
      on: vi.fn((event: string, listener: () => void) => { electronState.appHandlers.set(event, listener) }),
      quit: vi.fn(),
      getVersion: vi.fn(() => '0.2.0')
    },
    BrowserWindow,
    Tray,
    Menu: { buildFromTemplate: vi.fn((template) => template) },
    nativeImage: {
      createEmpty: vi.fn(() => trayImage)
    },
    ipcMain: { handle: vi.fn() },
    dialog: { showSaveDialog: vi.fn() },
    contextBridge: { exposeInMainWorld: vi.fn() },
    ipcRenderer: { invoke: vi.fn() }
  }
})

import { startApplication } from '../../src/main/index'

function activeStatus(): DaemonStatus {
  return {
    schemaVersion: 1,
    phase: 'ACTIVE',
    message: '分流正常',
    updatedAt: '2026-09-22T08:00:00.000Z',
    physicalInterface: 'en0',
    physicalGateway: '172.19.132.1',
    mobileInterface: 'utun6',
    routes: [],
    dns: { state: 'correct', servers: [], domains: [], resolvedAddresses: [] },
    lastCheckAt: '2026-09-22T08:00:00.000Z',
    lastNetworkChangeAt: null,
    lastError: null,
    autoEnableAtBoot: true,
    paused: false,
    logLevel: 'standard',
    daemonVersion: '0.2.0',
    processedRequestId: null,
    events: []
  }
}

describe('application menu bar lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    electronState.appHandlers.clear()
    electronState.windows.length = 0
    electronState.trays.length = 0
  })

  it('creates a persistent tray that reopens the hidden window', async () => {
    let resolveStatus: ((value: DaemonStatus) => void) | undefined
    const client = {
      readStatus: vi.fn(() => new Promise<DaemonStatus>((resolve) => { resolveStatus = resolve })),
      send: vi.fn(async () => undefined)
    }

    const starting = startApplication(client)
    await vi.waitFor(() => expect(electronState.windows).toHaveLength(1))

    expect(electronState.trays).toHaveLength(1)
    const window = electronState.windows[0]
    const closeEvent = { preventDefault: vi.fn() }

    window.handlers.get('close')?.(closeEvent)
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce()
    expect(window.hide).toHaveBeenCalledOnce()

    const beforeQuitDuringStartup = electronState.appHandlers.get('before-quit')
    expect(beforeQuitDuringStartup).toBeTypeOf('function')
    beforeQuitDuringStartup?.()

    resolveStatus?.(activeStatus())
    await starting

    const tray = electronState.trays[0]
    tray.handlers.get('click')?.()
    expect(window.show).toHaveBeenCalledTimes(2)
    expect(window.focus).toHaveBeenCalledOnce()

    closeEvent.preventDefault.mockClear()
    window.handlers.get('close')?.(closeEvent)
    expect(closeEvent.preventDefault).not.toHaveBeenCalled()

    electronState.appHandlers.get('will-quit')?.()
    expect(tray.destroy).toHaveBeenCalledOnce()
  })
})
