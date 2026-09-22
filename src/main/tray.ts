import type { MenuItemConstructorOptions } from 'electron'
import type { DaemonStatus } from '../shared/protocol'

export interface TrayActions {
  showWindow(): void
  repairNow(): Promise<void>
  setPaused(value: boolean): Promise<void>
  quit(): void
}

interface CloseEvent {
  preventDefault(): void
}

interface HideableWindow {
  hide(): void
}

interface MenuBarTray {
  setToolTip(value: string): void
  popUpContextMenu(menu: unknown): void
  on(event: 'click' | 'right-click', listener: () => void): void
  destroy(): void
}

interface TemplateImage {
  addRepresentation(options: { scaleFactor: number; dataURL: string }): void
  setTemplateImage(value: boolean): void
}

interface NativeImageFactory<T extends TemplateImage> {
  createEmpty(): T
}

export interface MenuBarControllerOptions {
  tray: MenuBarTray
  buildMenu(template: MenuItemConstructorOptions[]): unknown
  readStatus(): Promise<DaemonStatus>
  actions: TrayActions
  scheduleRefresh(refresh: () => void): () => void
}

// Generated from build/tray-icon.svg. Electron supports PNG/JPEG data URLs,
// so keep both standard and Retina representations in the bundled main code.
const TRAY_ICON_1X = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABMUlEQVQ4EZ3SzSpFURiH8eNb5KNkxIBcgAEGZEbIQLkAF+AGjGSs3MSZKSMzU0mUyBnJxAgDBshHisLz7NY6LR37cPzr1373Wu9eZ++1TqFQPe1Mq+YM8sQqzgNrx37NGB1F3OIMK4G1Y0XY82O6GL3AIRbQgpg2ikU4Z4+9Fell5BKz6EYfOpFmmpsr2JulPhZcP/GKKZRwjFPMIaaB4gP2ZmmMRbj62kfYQhOWsYY7mB64QDnpAm+MuvI7/HUzhCXsw7kd+Jb2Zkk/4ZmRJ+Qdlwv04xH2ZkkX8NVOMINRjIfanZ/EBF7gkX77DO7LccOcvME1PLK4iQPU95hHbpqZ2Q08xg6YOmxjD/ZUzTCz7vp60rVB/QDn/hT/TD6wGVg7VlNG6D4IrP+VVp5Sbr4AnGZBhmOCwb8AAAAASUVORK5CYII='
const TRAY_ICON_2X = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAACnUlEQVRYCdWWPYxNQRiG71oFovATEYIblc6iIKFwI5ug06gQi0Kn0OsUotKJUFCsQhAdEQkiodLRE38REj+xfnfxPNeZk8ncc+6ec+9e4k3enW+++d535pyZOXsbjX+MoT7mX4B2T6Yfp33fh1ct6Vqqz8AJ+CujsTnHBoLZuO6Gd2GYtKy1xlo1fWMpDsfgCxhPOEX/GhzNaGwurnlOX60eteHqT8NvMDZ9S/8EbMIU5hyzJtbooVetN7I5MXlI/wCcA6eDNdaqiReiZ2W0qAziscqqzkK1wafVOdxozCpKJrknSb9Od1pt1X2Zz6zr4XA2u0/1AT6Ck1mup6bqAm7hvqlghlfkDsIbBWOVUlW2oJvRMgavwGa3om5jVd/AKCbxFug5Ak/BeXAfPA5ro2wB7nGMT3TuxQniO/AoXAW9YmNwERyC4jH82o7+/Ek929myBXyJhHOjOA0/Z4mdtDLF4SgRe+bpsjPwLq9oNBZGcRo+SxNR/ylx/NSxZ15WtgA/pwErQtBDuzzSxJ55umwBrjY83Ya8ujNY2ZnKM96MjVlPr8I3UHYG1Pktd4It0IMVv066bXgDxHV4CaaH8KyDQK9CdFvATRS7oFuwDX6HwzBghMAbIO7D8wYRvBlh+/SqjSUofkCf/HXWGqecINeEKc6RsFYPvXrCVVSaTGVtOvlL8jtgitUkfGPW69Ez1qH8CTW6DVsZt9I6VraFlxlTo9a6vnARtWZybwUna0K92r6xGAf/62nqJzlcLcIOOGaNtWrUzgi24zIJNX4Di35+m3PMGmvVzCgO4aa5/Ajjw2dsLoxbOxAcwTXcCNuTGeOcNQOFHyfvfnja0Jpz7K9gDbM8gGFyY3O1EX481BYi8LO8PxNeoHUb/j/8Bodqs579v1fvAAAAAElFTkSuQmCC'

export function createTrayIcon<T extends TemplateImage>(nativeImage: NativeImageFactory<T>): T {
  const icon = nativeImage.createEmpty()
  icon.addRepresentation({ scaleFactor: 1, dataURL: `data:image/png;base64,${TRAY_ICON_1X}` })
  icon.addRepresentation({ scaleFactor: 2, dataURL: `data:image/png;base64,${TRAY_ICON_2X}` })
  icon.setTemplateImage(true)
  return icon
}

export function trayPhaseLabel(status: DaemonStatus): string {
  switch (status.phase) {
    case 'ACTIVE': return '运行中'
    case 'PAUSED': return '已暂停'
    case 'DEGRADED': return '需要修复'
    case 'UNINSTALLED': return '后台服务未安装'
    case 'NETWORK_SETTLING': return '网络切换中'
    case 'REPAIRING': return '正在修复'
    case 'PROBING': return '正在检测'
    case 'IDLE': return '等待 VPN 连接'
  }
}

export function buildTrayMenuTemplate(
  status: DaemonStatus,
  actions: TrayActions
): MenuItemConstructorOptions[] {
  const daemonAvailable = status.phase !== 'UNINSTALLED'
  const isPaused = status.paused || status.phase === 'PAUSED'
  return [
    { label: `双 VPN 分流：${trayPhaseLabel(status)}`, enabled: false },
    { label: '打开主窗口', click: actions.showWindow },
    { type: 'separator' },
    {
      label: '立即检测并修复',
      enabled: daemonAvailable,
      click: () => { void actions.repairNow() }
    },
    {
      label: isPaused ? '恢复分流' : '暂停分流',
      enabled: daemonAvailable,
      click: () => { void actions.setPaused(!isPaused) }
    },
    { type: 'separator' },
    { label: '退出应用', click: actions.quit }
  ]
}

export function handleWindowClose(
  event: CloseEvent,
  window: HideableWindow,
  isQuitting: boolean
): void {
  if (isQuitting) return
  event.preventDefault()
  window.hide()
}

export class MenuBarController {
  private cancelRefresh: (() => void) | undefined
  private contextMenu: unknown

  constructor(private readonly options: MenuBarControllerOptions) {}

  async start(): Promise<void> {
    this.options.tray.on('click', this.options.actions.showWindow)
    this.options.tray.on('right-click', () => {
      if (this.contextMenu) this.options.tray.popUpContextMenu(this.contextMenu)
    })
    await this.refresh()
    this.cancelRefresh = this.options.scheduleRefresh(() => { void this.refresh() })
  }

  async refresh(): Promise<void> {
    const status = await this.options.readStatus()
    this.options.tray.setToolTip(`双 VPN 分流助手 · ${trayPhaseLabel(status)}`)
    this.contextMenu = this.options.buildMenu(buildTrayMenuTemplate(status, {
        showWindow: this.options.actions.showWindow,
        repairNow: () => this.runQuickAction(() => this.options.actions.repairNow()),
        setPaused: (value) => this.runQuickAction(() => this.options.actions.setPaused(value)),
        quit: this.options.actions.quit
      }))
  }

  private async runQuickAction(action: () => Promise<void>): Promise<void> {
    try {
      await action()
      await this.refresh()
    } catch {
      this.options.tray.setToolTip('双 VPN 分流助手 · 快捷操作失败')
    }
  }

  dispose(): void {
    this.cancelRefresh?.()
    this.cancelRefresh = undefined
    this.contextMenu = undefined
    this.options.tray.destroy()
  }
}
