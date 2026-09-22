import { describe, expect, it, vi } from 'vitest'
import { createPrivilegedActionRunner } from '../../src/main/privileged-action'

describe('privileged action launcher', () => {
  it.each([
    ['install', 'install-helper.sh'],
    ['uninstall', 'uninstall-helper.sh']
  ] as const)('invokes only the bundled %s helper', async (action, helper) => {
    const execFile = vi.fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>>(async () => ({
      stdout: JSON.stringify({ ok: true, action, message: 'ok', daemonVersion: '0.1.0' }),
      stderr: ''
    }))
    const run = createPrivilegedActionRunner({
      resourcesPath: '/Applications/Dual VPN "Lab".app/Contents/Resources',
      execFile
    })

    await expect(run(action)).resolves.toMatchObject({ ok: true, action })
    expect(execFile).toHaveBeenCalledTimes(1)
    const [executable, args] = execFile.mock.calls[0]
    expect(executable).toBe('/usr/bin/osascript')
    expect(args[0]).toBe('-e')
    expect(args[1]).toContain(helper)
    expect(args[1]).toContain('\\"Lab\\"')
    expect(args[1]).toContain('quoted form of')
  })

  it('does not accept a renderer-provided path or action', async () => {
    const execFile = vi.fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>>()
    const run = createPrivilegedActionRunner({ resourcesPath: '/safe', execFile })

    await expect(run('../../evil.sh' as never)).rejects.toThrow('不支持的特权操作')
    expect(execFile).not.toHaveBeenCalled()
  })

  it('returns a stable failure result without exposing stderr', async () => {
    const execFile = vi.fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>>(async () => {
      throw Object.assign(new Error('secret /Users/alice'), { stderr: 'password data' })
    })
    const run = createPrivilegedActionRunner({ resourcesPath: '/safe', execFile })

    await expect(run('install')).resolves.toEqual({
      ok: false,
      action: 'install',
      message: '管理员操作未完成',
      daemonVersion: null
    })
  })
})
