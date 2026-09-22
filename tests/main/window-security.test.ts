import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    whenReady: vi.fn(async () => undefined),
    on: vi.fn(),
    getVersion: vi.fn(() => '0.1.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn() }
}))

import { IPC_CHANNELS, createWindowOptions, isAllowedRendererUrl } from '../../src/main/index'

describe('secure Electron shell', () => {
  it('enables isolation and sandbox while disabling renderer Node access', () => {
    const options = createWindowOptions('/fixed/preload.js')

    expect(options).toMatchObject({ width: 1040, height: 700, minWidth: 1040, minHeight: 700 })
    expect(options.webPreferences).toEqual({
      preload: '/fixed/preload.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    })
  })

  it('allows only the exact packaged renderer URL', () => {
    const allowed = 'file:///Applications/App.app/Contents/Resources/app.asar/out/renderer/index.html'
    expect(isAllowedRendererUrl(allowed, allowed)).toBe(true)
    expect(isAllowedRendererUrl('https://example.com', allowed)).toBe(false)
    expect(isAllowedRendererUrl(`${allowed}#settings`, allowed)).toBe(true)
    expect(isAllowedRendererUrl('file:///tmp/evil.html', allowed)).toBe(false)
  })

  it('has an exact, narrow IPC allowlist', () => {
    expect(IPC_CHANNELS).toEqual([
      'dual-vpn:get-app-version',
      'dual-vpn:get-status',
      'dual-vpn:repair-now',
      'dual-vpn:set-paused',
      'dual-vpn:set-auto-enable',
      'dual-vpn:set-log-level',
      'dual-vpn:install-service',
      'dual-vpn:uninstall-service',
      'dual-vpn:export-diagnostics'
    ])
  })

  it('ships a local-only CSP and no broad preload API', async () => {
    const root = path.resolve(import.meta.dirname, '../..')
    const html = await readFile(path.join(root, 'src/renderer/index.html'), 'utf8')
    const preload = await readFile(path.join(root, 'src/preload/index.ts'), 'utf8')

    expect(html).toContain("default-src 'self'")
    expect(html).toContain("connect-src 'none'")
    expect(html).toContain("object-src 'none'")
    expect(preload).not.toContain('ipcRenderer:')
    expect(preload).not.toContain('send:')
    expect(preload).not.toContain('shell')
  })
})
