import { describe, expect, it, vi } from 'vitest'
import type { DaemonStatus } from '../../src/shared/protocol'
import {
  MenuBarController,
  buildTrayMenuTemplate,
  createTrayIcon,
  handleWindowClose,
  trayPhaseLabel
} from '../../src/main/tray'

function status(phase: DaemonStatus['phase']): DaemonStatus {
  return {
    schemaVersion: 1,
    phase,
    message: '',
    updatedAt: '2026-09-22T08:00:00.000Z',
    physicalInterface: null,
    physicalGateway: null,
    mobileInterface: null,
    routes: [],
    dns: { state: 'unknown', servers: [], domains: [], resolvedAddresses: [] },
    lastCheckAt: null,
    lastNetworkChangeAt: null,
    lastError: null,
    autoEnableAtBoot: true,
    paused: phase === 'PAUSED',
    logLevel: 'standard',
    daemonVersion: phase === 'UNINSTALLED' ? null : '0.2.0',
    processedRequestId: null,
    events: []
  }
}

describe('menu bar controls', () => {
  it.each([
    ['ACTIVE', '运行中'],
    ['PAUSED', '已暂停'],
    ['DEGRADED', '需要修复'],
    ['UNINSTALLED', '后台服务未安装'],
    ['NETWORK_SETTLING', '网络切换中']
  ] as const)('presents %s as a concise Chinese state', (phase, label) => {
    expect(trayPhaseLabel(status(phase))).toBe(label)
  })

  it('offers open, repair, pause, and quit actions while active', async () => {
    const actions = {
      showWindow: vi.fn(),
      repairNow: vi.fn(async () => undefined),
      setPaused: vi.fn(async () => undefined),
      quit: vi.fn()
    }
    const menu = buildTrayMenuTemplate(status('ACTIVE'), actions)

    expect(menu.map((item) => item.label ?? item.type)).toEqual([
      '双 VPN 分流：运行中',
      '打开主窗口',
      'separator',
      '立即检测并修复',
      '暂停分流',
      'separator',
      '退出应用'
    ])

    menu[1].click?.(undefined as never, undefined, {} as never)
    await menu[3].click?.(undefined as never, undefined, {} as never)
    await menu[4].click?.(undefined as never, undefined, {} as never)
    menu[6].click?.(undefined as never, undefined, {} as never)

    expect(actions.showWindow).toHaveBeenCalledOnce()
    expect(actions.repairNow).toHaveBeenCalledOnce()
    expect(actions.setPaused).toHaveBeenCalledWith(true)
    expect(actions.quit).toHaveBeenCalledOnce()
  })

  it('offers resume while paused and disables daemon actions before installation', async () => {
    const pausedActions = {
      showWindow: vi.fn(),
      repairNow: vi.fn(async () => undefined),
      setPaused: vi.fn(async () => undefined),
      quit: vi.fn()
    }
    const pausedMenu = buildTrayMenuTemplate(status('PAUSED'), pausedActions)
    expect(pausedMenu[4].label).toBe('恢复分流')
    await pausedMenu[4].click?.(undefined as never, undefined, {} as never)
    expect(pausedActions.setPaused).toHaveBeenCalledWith(false)

    const uninstalledMenu = buildTrayMenuTemplate(status('UNINSTALLED'), pausedActions)
    expect(uninstalledMenu[3].enabled).toBe(false)
    expect(uninstalledMenu[4].enabled).toBe(false)
  })

  it('hides the window on close unless the application is quitting', () => {
    const event = { preventDefault: vi.fn() }
    const window = { hide: vi.fn() }

    handleWindowClose(event, window, false)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(window.hide).toHaveBeenCalledOnce()

    event.preventDefault.mockClear()
    window.hide.mockClear()
    handleWindowClose(event, window, true)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('creates a monochrome macOS template icon with 1x and 2x PNG representations', () => {
    const icon = { addRepresentation: vi.fn(), setTemplateImage: vi.fn() }
    const nativeImage = { createEmpty: vi.fn(() => icon) }

    expect(createTrayIcon(nativeImage)).toBe(icon)
    expect(icon.addRepresentation).toHaveBeenCalledTimes(2)
    expect(icon.addRepresentation).toHaveBeenNthCalledWith(1, {
      scaleFactor: 1,
      dataURL: expect.stringMatching(/^data:image\/png;base64,/)
    })
    expect(icon.addRepresentation).toHaveBeenNthCalledWith(2, {
      scaleFactor: 2,
      dataURL: expect.stringMatching(/^data:image\/png;base64,/)
    })
    expect(icon.setTemplateImage).toHaveBeenCalledWith(true)
  })

  it('keeps the menu and tooltip synchronized with daemon state', async () => {
    const trayListeners = new Map<string, () => void>()
    const tray = {
      setToolTip: vi.fn(),
      popUpContextMenu: vi.fn(),
      on: vi.fn((event: string, listener: () => void) => { trayListeners.set(event, listener) }),
      destroy: vi.fn()
    }
    const buildMenu = vi.fn((template) => template)
    const readStatus = vi
      .fn<() => Promise<DaemonStatus>>()
      .mockResolvedValueOnce(status('ACTIVE'))
      .mockResolvedValueOnce(status('PAUSED'))
    const showWindow = vi.fn()
    const cancelRefresh = vi.fn()
    let scheduledRefresh: (() => void) | undefined
    const controller = new MenuBarController({
      tray,
      buildMenu,
      readStatus,
      actions: {
        showWindow,
        repairNow: vi.fn(async () => undefined),
        setPaused: vi.fn(async () => undefined),
        quit: vi.fn()
      },
      scheduleRefresh: (refresh) => {
        scheduledRefresh = refresh
        return cancelRefresh
      }
    })

    await controller.start()
    expect(tray.setToolTip).toHaveBeenLastCalledWith('双 VPN 分流助手 · 运行中')
    expect(tray.popUpContextMenu).not.toHaveBeenCalled()

    trayListeners.get('click')?.()
    expect(showWindow).toHaveBeenCalledOnce()

    trayListeners.get('right-click')?.()
    expect(tray.popUpContextMenu).toHaveBeenCalledOnce()
    expect(tray.popUpContextMenu.mock.calls[0][0][0].label).toBe('双 VPN 分流：运行中')

    scheduledRefresh?.()
    await vi.waitFor(() => {
      expect(tray.setToolTip).toHaveBeenLastCalledWith('双 VPN 分流助手 · 已暂停')
    })

    controller.dispose()
    expect(cancelRefresh).toHaveBeenCalledOnce()
    expect(tray.destroy).toHaveBeenCalledOnce()
  })

  it('refreshes the displayed state after a quick action completes', async () => {
    const tray = {
      setToolTip: vi.fn(),
      popUpContextMenu: vi.fn(),
      on: vi.fn(),
      destroy: vi.fn()
    }
    const setPaused = vi.fn(async () => undefined)
    const controller = new MenuBarController({
      tray,
      buildMenu: (template) => template,
      readStatus: vi
        .fn<() => Promise<DaemonStatus>>()
        .mockResolvedValueOnce(status('ACTIVE'))
        .mockResolvedValueOnce(status('PAUSED')),
      actions: {
        showWindow: vi.fn(),
        repairNow: vi.fn(async () => undefined),
        setPaused,
        quit: vi.fn()
      },
      scheduleRefresh: () => vi.fn()
    })

    await controller.start()
    const rightClick = tray.on.mock.calls.find(([event]) => event === 'right-click')?.[1]
    rightClick?.()
    const activeMenu = tray.popUpContextMenu.mock.calls[0][0] as ReturnType<typeof buildTrayMenuTemplate>
    await activeMenu[4].click?.(undefined as never, undefined, {} as never)

    await vi.waitFor(() => {
      expect(setPaused).toHaveBeenCalledWith(true)
      expect(tray.setToolTip).toHaveBeenLastCalledWith('双 VPN 分流助手 · 已暂停')
    })
  })

  it('contains quick-action failures without exposing raw error details', async () => {
    const tray = {
      setToolTip: vi.fn(),
      popUpContextMenu: vi.fn(),
      on: vi.fn(),
      destroy: vi.fn()
    }
    const controller = new MenuBarController({
      tray,
      buildMenu: (template) => template,
      readStatus: vi.fn(async () => status('ACTIVE')),
      actions: {
        showWindow: vi.fn(),
        repairNow: vi.fn(async () => { throw new Error('/Users/alice/private') }),
        setPaused: vi.fn(async () => undefined),
        quit: vi.fn()
      },
      scheduleRefresh: () => vi.fn()
    })

    await controller.start()
    const rightClick = tray.on.mock.calls.find(([event]) => event === 'right-click')?.[1]
    rightClick?.()
    const menu = tray.popUpContextMenu.mock.calls[0][0] as ReturnType<typeof buildTrayMenuTemplate>
    menu[3].click?.(undefined as never, undefined, {} as never)

    await vi.waitFor(() => {
      expect(tray.setToolTip).toHaveBeenLastCalledWith('双 VPN 分流助手 · 快捷操作失败')
    })
    expect(tray.setToolTip.mock.calls.flat().join(' ')).not.toContain('/Users/alice')
  })
})
