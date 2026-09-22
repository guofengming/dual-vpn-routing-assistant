import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonStatus } from '../../src/shared/protocol'
import { App } from '../../src/renderer/App'

function status(phase: DaemonStatus['phase'], overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    schemaVersion: 1,
    phase,
    message: phase === 'ACTIVE' ? '分流矩阵稳定' : '',
    updatedAt: '2026-09-22T04:00:00Z',
    physicalInterface: phase === 'UNINSTALLED' ? null : 'en0',
    physicalGateway: phase === 'UNINSTALLED' ? null : '172.19.132.1',
    mobileInterface: phase === 'ACTIVE' ? 'utun4' : null,
    routes: phase === 'ACTIVE' ? [
      {
        id: 'office-a', label: '办公网段 A', destination: '10.0.0.0/9',
        interface: 'en0', gateway: '172.19.132.1', state: 'correct'
      },
      {
        id: 'mobile-dns', label: '中移 DNS', destination: '10.57.0.96',
        interface: 'utun4', gateway: null, state: 'correct'
      }
    ] : [],
    dns: {
      state: phase === 'ACTIVE' ? 'correct' : 'unknown',
      servers: ['172.31.5.60', '172.31.6.60'],
      domains: ['baidu.com', 'baidu-int.com', 'internal.baidu.com'],
      resolvedAddresses: []
    },
    lastCheckAt: '2026-09-22T04:00:00Z',
    lastNetworkChangeAt: null,
    lastError: null,
    autoEnableAtBoot: true,
    paused: phase === 'PAUSED',
    daemonVersion: phase === 'UNINSTALLED' ? null : '0.1.0',
    processedRequestId: null,
    events: [],
    ...overrides
  }
}

function mockApi(initial: DaemonStatus) {
  const api = {
    getAppVersion: vi.fn(async () => '0.1.0'),
    getStatus: vi.fn(async () => initial),
    repairNow: vi.fn(async () => undefined),
    setPaused: vi.fn(async () => undefined),
    setAutoEnableAtBoot: vi.fn(async () => undefined),
    setLogLevel: vi.fn(async () => undefined),
    installService: vi.fn(async () => ({ ok: true, action: 'install' as const, message: 'ok', daemonVersion: '0.1.0' as string | null })),
    uninstallService: vi.fn(async () => ({ ok: true, action: 'uninstall' as const, message: 'ok', daemonVersion: null })),
    exportDiagnostics: vi.fn(async () => '/tmp/diagnostics.txt')
  }
  window.dualVpn = api
  return api
}

beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('App', () => {
  it('treats an absent mobile VPN as a normal waiting state', async () => {
    mockApi(status('IDLE'))
    render(<App />)

    expect(await screen.findByText('等待中移 VPN')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('renders the stable physical/mobile route matrix', async () => {
    mockApi(status('ACTIVE'))
    render(<App />)

    expect(await screen.findByText('分流矩阵稳定')).toBeInTheDocument()
    expect(screen.getAllByText('en0').length).toBeGreaterThan(0)
    expect(screen.getAllByText('utun4').length).toBeGreaterThan(0)
    expect(screen.getByText('10.0.0.0/9')).toBeInTheDocument()
  })

  it('explains the temporary interruption while a new network settles', async () => {
    mockApi(status('NETWORK_SETTLING'))
    render(<App />)

    expect(await screen.findByText('网络正在重新校准')).toBeInTheDocument()
    expect(screen.getByText(/10–30 秒/)).toBeInTheDocument()
  })

  it('shows a concrete degraded error and can request one repair', async () => {
    const api = mockApi(status('DEGRADED', {
      lastError: {
        code: 'dns_unreachable',
        message: '办公 DNS 当前不可达',
        occurredAt: '2026-09-22T04:00:00Z',
        retryable: true
      }
    }))
    render(<App />)

    expect(await screen.findByText('办公 DNS 当前不可达')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '立即检测并修复' }))
    await waitFor(() => expect(api.repairNow).toHaveBeenCalledTimes(1))
  })

  it('switches pause/resume labels and calls only the preload API', async () => {
    const api = mockApi(status('ACTIVE'))
    const { rerender } = render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '暂停分流' }))
    await waitFor(() => expect(api.setPaused).toHaveBeenCalledWith(true))

    api.getStatus.mockResolvedValue(status('PAUSED'))
    rerender(<App />)
    fireEvent(document, new Event('visibilitychange'))
    expect(await screen.findByRole('button', { name: '恢复分流' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /启动.*VPN/ })).not.toBeInTheDocument()
  })

  it('shows installation only when needed and updates settings via preload', async () => {
    mockApi(status('UNINSTALLED'))
    const { unmount } = render(<App />)
    expect(await screen.findByRole('button', { name: '安装后台服务' })).toBeInTheDocument()
    unmount()

    const api = mockApi(status('ACTIVE'))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '开机自动启用分流' }))
    await waitFor(() => expect(api.setAutoEnableAtBoot).toHaveBeenCalledWith(false))
  })

  it('offers a daemon upgrade when the bundled version differs', async () => {
    mockApi(status('ACTIVE', { daemonVersion: '0.0.9' }))
    render(<App />)

    expect(await screen.findByRole('button', { name: '升级后台服务' })).toBeInTheDocument()
  })

  it('shows a privileged helper failure instead of a false success', async () => {
    const api = mockApi(status('UNINSTALLED'))
    api.installService.mockResolvedValue({
      ok: false,
      action: 'install',
      message: '管理员操作未完成',
      daemonVersion: null
    })
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '安装后台服务' }))
    expect(await screen.findByRole('status')).toHaveTextContent('管理员操作未完成')
    expect(screen.queryByText('后台服务已安装')).not.toBeInTheDocument()
  })
})
