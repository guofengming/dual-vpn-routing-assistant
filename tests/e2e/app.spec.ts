import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DaemonPhase, DaemonStatus } from '../../src/shared/protocol'

const projectRoot = path.resolve(import.meta.dirname, '../..')
const daemonVersion = readFileSync(path.join(projectRoot, 'resources/daemon/VERSION'), 'utf8').trim()

function fixtureStatus(phase: DaemonPhase): DaemonStatus {
  const active = phase === 'ACTIVE'
  return {
    schemaVersion: 1,
    phase,
    message: active ? '分流矩阵稳定' : '',
    updatedAt: '2026-09-22T04:00:00Z',
    physicalInterface: 'en0',
    physicalGateway: '172.19.132.1',
    mobileInterface: active ? 'utun4' : null,
    routes: active ? [{
      id: 'office', label: '办公网段 A', destination: '10.0.0.0/9',
      interface: 'en0', gateway: '172.19.132.1', state: 'correct'
    }] : [],
    dns: {
      state: active ? 'correct' : 'unknown',
      servers: ['172.31.5.60'],
      domains: ['baidu.com'],
      resolvedAddresses: ['10.11.154.217']
    },
    lastCheckAt: '2026-09-22T04:00:00Z',
    lastNetworkChangeAt: phase === 'NETWORK_SETTLING' ? '2026-09-22T04:00:00Z' : null,
    lastError: phase === 'DEGRADED' ? {
      code: 'fixture_error', message: '用户 e2e-user 的 /Users/e2e-user 路径不可用',
      occurredAt: '2026-09-22T04:00:00Z', retryable: true
    } : null,
    autoEnableAtBoot: true,
    paused: phase === 'PAUSED',
    daemonVersion,
    processedRequestId: null,
    events: []
  }
}

async function launchFixture(phase: DaemonPhase): Promise<{
  app: ElectronApplication
  page: Page
  fixtureDir: string
}> {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), 'dual-vpn-e2e-'))
  await mkdir(path.join(fixtureDir, 'ipc'), { mode: 0o700 })
  await writeFile(path.join(fixtureDir, 'status.json'), JSON.stringify(fixtureStatus(phase)))
  const app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      DUALVPN_UI_FIXTURE_DIR: fixtureDir,
      USER: 'e2e-user',
      HOME: '/Users/e2e-user'
    }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page, fixtureDir }
}

test('opens at the expected size, blocks external windows, and emits one repair request', async () => {
  const { app, page, fixtureDir } = await launchFixture('ACTIVE')
  try {
    await expect(page.getByText('分流矩阵稳定')).toBeVisible()
    const bounds = await (await app.browserWindow(page)).evaluate((window) => window.getBounds()) as { width: number; height: number }
    expect(bounds.width).toBeGreaterThanOrEqual(1040)
    expect(bounds.height).toBeGreaterThanOrEqual(700)
    expect(await page.evaluate(() => Boolean(window.open('https://example.com')))).toBe(false)

    await page.getByRole('button', { name: '立即检测并修复' }).click()
    await expect.poll(async () => {
      try {
        return JSON.parse(await readFile(path.join(fixtureDir, 'ipc/request.json'), 'utf8')).type
      } catch { return null }
    }).toBe('repairNow')
  } finally {
    await app.close()
  }
})

test('renders idle, paused, settling, and degraded fixture states', async () => {
  const cases: Array<[DaemonPhase, string]> = [
    ['IDLE', '等待中移 VPN'],
    ['PAUSED', '分流已暂停'],
    ['NETWORK_SETTLING', '网络正在重新校准'],
    ['DEGRADED', '用户 e2e-user 的 /Users/e2e-user 路径不可用']
  ]
  for (const [phase, text] of cases) {
    const { app, page } = await launchFixture(phase)
    try { await expect(page.getByText(text)).toBeVisible() } finally { await app.close() }
  }
})

test('exports a redacted diagnostic bundle through the fixture backend', async () => {
  const { app, page, fixtureDir } = await launchFixture('DEGRADED')
  try {
    await page.getByRole('button', { name: '诊断日志' }).click()
    await page.getByRole('button', { name: '导出脱敏诊断' }).click()
    const exportPath = path.join(fixtureDir, 'diagnostics-export.txt')
    await expect.poll(async () => readFile(exportPath, 'utf8').catch(() => '')).toContain('$USER_HOME')
    const bundle = await readFile(exportPath, 'utf8')
    expect(bundle).not.toContain('/Users/e2e-user')
    expect(bundle).not.toContain('e2e-user')
  } finally {
    await app.close()
  }
})
