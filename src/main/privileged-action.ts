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
  errorCode?: string
}

type ExecFileResult = { stdout: string; stderr: string }
type ExecFileLike = (file: string, args: string[]) => Promise<ExecFileResult>

const PrivilegedResultSchema = z.object({
  ok: z.boolean(),
  action: z.enum(['install', 'uninstall']),
  message: z.string(),
  daemonVersion: z.string().nullable(),
  errorCode: z.string().regex(/^[a-z0-9_]{1,64}$/).optional()
}).strict()

const EXIT_MARKER = '__DUALVPN_EXIT__='

function escapeAppleScriptString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

export function buildPrivilegedAppleScript(scriptPath: string): string {
  const escapedPath = escapeAppleScriptString(scriptPath)
  const shellSuffix = ` 2>&1; dualvpn_exit_code=$?; /usr/bin/printf '\\n${EXIT_MARKER}%s\\n' "$dualvpn_exit_code"; exit 0`
  return `do shell script "/bin/zsh " & quoted form of "${escapedPath}" & "${escapeAppleScriptString(shellSuffix)}" with administrator privileges`
}

function parsePrivilegedOutput(output: string, action: PrivilegedAction): PrivilegedResult {
  const lines = output.replaceAll('\r', '\n').split('\n').map((line) => line.trim()).filter(Boolean)
  const exitLine = lines.at(-1)
  const exitMatch = exitLine?.match(/^__DUALVPN_EXIT__=(0|[1-9][0-9]{0,2})$/)
  const exitCode = exitMatch ? Number(exitMatch[1]) : Number.NaN
  const resultLine = lines.slice(0, -1).findLast((line) => line.startsWith('{'))
  let parsed: ReturnType<typeof PrivilegedResultSchema.safeParse> | null = null
  if (resultLine) {
    try {
      parsed = PrivilegedResultSchema.safeParse(JSON.parse(resultLine))
    } catch {
      parsed = null
    }
  }

  if (Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 && parsed?.success && parsed.data.action === action) {
    if ((exitCode === 0 && parsed.data.ok) || (exitCode !== 0 && !parsed.data.ok)) {
      return parsed.data
    }
  }

  return {
    ok: false,
    action,
    message: '后台服务脚本执行失败，请打开诊断日志查看安装记录',
    daemonVersion: null,
    errorCode: 'privileged_helper_failed'
  }
}

function isAuthorizationCancelled(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { message?: unknown; stderr?: unknown }
  const detail = [candidate.message, candidate.stderr]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
  return /(?:-128|-60006|User canceled|用户取消|已取消)/i.test(detail)
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
      return parsePrivilegedOutput(stdout, action)
    } catch (error) {
      if (isAuthorizationCancelled(error)) {
        return {
          ok: false,
          action,
          message: action === 'install' ? '已取消管理员授权，后台服务未安装' : '已取消管理员授权，后台服务未卸载',
          daemonVersion: null,
          errorCode: 'authorization_cancelled'
        }
      }
      return {
        ok: false,
        action,
        message: '管理员操作未完成，请打开诊断日志查看安装记录',
        daemonVersion: null,
        errorCode: 'privileged_launcher_failed'
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
