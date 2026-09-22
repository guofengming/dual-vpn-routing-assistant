import path from 'node:path'
import { promisify } from 'node:util'
import { execFile as nodeExecFile } from 'node:child_process'
import { z } from 'zod'

export type PrivilegedAction = 'install' | 'uninstall'

export interface PrivilegedResult {
  ok: boolean
  action: PrivilegedAction
  message: string
  daemonVersion: string | null
}

type ExecFileResult = { stdout: string; stderr: string }
type ExecFileLike = (file: string, args: string[]) => Promise<ExecFileResult>

const PrivilegedResultSchema = z.object({
  ok: z.boolean(),
  action: z.enum(['install', 'uninstall']),
  message: z.string(),
  daemonVersion: z.string().nullable()
}).strict()

function escapeAppleScriptString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

export function buildPrivilegedAppleScript(scriptPath: string): string {
  const escapedPath = escapeAppleScriptString(scriptPath)
  return `do shell script "/bin/zsh " & quoted form of "${escapedPath}" with administrator privileges`
}

export function createPrivilegedActionRunner(options: {
  resourcesPath: string
  execFile: ExecFileLike
}) {
  return async (action: PrivilegedAction): Promise<PrivilegedResult> => {
    if (action !== 'install' && action !== 'uninstall') {
      throw new Error('不支持的特权操作')
    }

    const helperName = action === 'install' ? 'install-helper.sh' : 'uninstall-helper.sh'
    const helperPath = path.join(options.resourcesPath, 'daemon', helperName)
    const appleScript = buildPrivilegedAppleScript(helperPath)

    try {
      const { stdout } = await options.execFile('/usr/bin/osascript', ['-e', appleScript])
      const lines = stdout.trim().split('\n')
      return PrivilegedResultSchema.parse(JSON.parse(lines.at(-1) ?? ''))
    } catch {
      return {
        ok: false,
        action,
        message: '管理员操作未完成',
        daemonVersion: null
      }
    }
  }
}

const execFile = promisify(nodeExecFile) as unknown as ExecFileLike

export function runPrivilegedAction(action: PrivilegedAction): Promise<PrivilegedResult> {
  return createPrivilegedActionRunner({
    resourcesPath: process.resourcesPath,
    execFile
  })(action)
}
