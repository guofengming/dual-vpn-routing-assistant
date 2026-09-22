import { describe, expect, it, vi } from 'vitest'
import { createPrivilegedActionRunner } from '../../src/main/privileged-action'

describe('privileged action launcher', () => {
  it.each([
    ['install', 'install-helper.sh'],
    ['uninstall', 'uninstall-helper.sh']
  ] as const)('invokes only the bundled %s helper', async (action, helper) => {
    const execFile = vi.fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>>(async () => ({
      stdout: `${JSON.stringify({ ok: true, action, message: 'ok', daemonVersion: '0.1.0' })}\n__DUALVPN_EXIT__=0`,
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
    expect(args[1]).toContain('__DUALVPN_EXIT__')
    expect(args[1]).toContain('dualvpn_exit_code')
  })

  it('does not accept a renderer-provided path or action', async () => {
    const execFile = vi.fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>>()
    const run = createPrivilegedActionRunner({ resourcesPath: '/safe', execFile })

    await expect(run('../../evil.sh' as never)).rejects.toThrow('不支持的特权操作')
    expect(execFile).not.toHaveBeenCalled()
  })

  it('returns a structured helper failure while keeping raw output private', async () => {
    const failure = {
      ok: false,
      action: 'install' as const,
      message: '安装服务文件失败，原有网络配置已保留',
      daemonVersion: null,
      errorCode: 'service_files_failed'
    }
    const execFile = vi.fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>>(async () => ({
      stdout: `private /Users/alice\n${JSON.stringify(failure)}\n__DUALVPN_EXIT__=1`,
      stderr: ''
    }))
    const run = createPrivilegedActionRunner({ resourcesPath: '/safe', execFile })

    await expect(run('install')).resolves.toEqual(failure)
  })

  it('distinguishes a cancelled administrator prompt without exposing stderr', async () => {
    const execFile = vi.fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>>(async () => {
      throw Object.assign(new Error('secret /Users/alice'), {
        stderr: 'execution error: User canceled. (-128) password data'
      })
    })
    const run = createPrivilegedActionRunner({ resourcesPath: '/safe', execFile })

    await expect(run('install')).resolves.toEqual({
      ok: false,
      action: 'install',
      message: '已取消管理员授权，后台服务未安装',
      daemonVersion: null,
      errorCode: 'authorization_cancelled'
    })
  })

  it('uses a sanitized fallback for an unstructured launcher failure', async () => {
    const execFile = vi.fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>>(async () => {
      throw Object.assign(new Error('secret /Users/alice'), { stderr: 'password data' })
    })
    const run = createPrivilegedActionRunner({ resourcesPath: '/safe', execFile })

    await expect(run('install')).resolves.toEqual({
      ok: false,
      action: 'install',
      message: '管理员操作未完成，请打开诊断日志查看安装记录',
      daemonVersion: null,
      errorCode: 'privileged_launcher_failed'
    })
  })

  it.each([
    [`${JSON.stringify({ ok: false, action: 'install', message: 'safe', daemonVersion: null, errorCode: 'failed' })}`, 'missing marker'],
    [`${JSON.stringify({ ok: false, action: 'install', message: 'safe', daemonVersion: null, errorCode: 'failed' })}\n__DUALVPN_EXIT__=1suffix`, 'invalid marker'],
    [`${JSON.stringify({ ok: false, action: 'install', message: 'safe', daemonVersion: null, errorCode: 'failed' })}\n__DUALVPN_EXIT__=1\ntrailing output`, 'non-final marker'],
    [`{malformed}\n__DUALVPN_EXIT__=1`, 'malformed result']
  ])('rejects a %s protocol response without exposing its contents', async (stdout) => {
    const execFile = vi.fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>>(async () => ({ stdout, stderr: '' }))
    const run = createPrivilegedActionRunner({ resourcesPath: '/safe', execFile })

    await expect(run('install')).resolves.toEqual({
      ok: false,
      action: 'install',
      message: '后台服务脚本执行失败，请打开诊断日志查看安装记录',
      daemonVersion: null,
      errorCode: 'privileged_helper_failed'
    })
  })
})
