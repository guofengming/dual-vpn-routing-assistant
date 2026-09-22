import { randomUUID } from 'node:crypto'
import { homedir, userInfo } from 'node:os'
import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, dialog } from 'electron'
import type { DaemonStatus } from '../shared/protocol'
import { SYSTEM_LOG_PATH } from '../shared/paths'

export interface DiagnosticBundleInput {
  status: DaemonStatus
  appVersion: string
  homeDirectory: string
  username: string
  logTail: string | null
}

function replaceAllLiteral(value: string, target: string, replacement: string): string {
  return target ? value.split(target).join(replacement) : value
}

export function buildDiagnosticBundle(input: DiagnosticBundleInput): string {
  const document = {
    product: '双 VPN 分流助手',
    appVersion: input.appVersion,
    exportedAt: new Date().toISOString(),
    privacy: '用户名和用户目录已脱敏；不含 VPN 凭据或网络内容。',
    status: input.status,
    logTail: input.logTail
  }
  let result = `${JSON.stringify(document, null, 2)}\n`
  result = replaceAllLiteral(result, input.homeDirectory, '$USER_HOME')
  result = replaceAllLiteral(result, input.username, '$CONSOLE_USER')
  return result
}

export async function writePrivateDiagnosticFile(destination: string, contents: string): Promise<void> {
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' })
    await chmod(temporary, 0o600)
    await rename(temporary, destination)
    await chmod(destination, 0o600)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

export async function exportDiagnosticBundle(
  status: DaemonStatus,
  fixtureDirectory?: string
): Promise<string | null> {
  let username = process.env.USER ?? ''
  if (!username) {
    try { username = userInfo().username } catch { /* environment fallback */ }
  }
  let logTail: string | null = null
  try {
    const log = await readFile(SYSTEM_LOG_PATH, 'utf8')
    logTail = log.split('\n').slice(-200).join('\n')
  } catch {
    // The log does not exist before the privileged helper starts.
  }

  const bundle = buildDiagnosticBundle({
    status,
    appVersion: app.getVersion(),
    homeDirectory: homedir(),
    username,
    logTail
  })

  if (!app.isPackaged && fixtureDirectory) {
    const destination = path.join(fixtureDirectory, 'diagnostics-export.txt')
    await writePrivateDiagnosticFile(destination, bundle)
    return destination
  }

  const selection = await dialog.showSaveDialog({
    title: '导出脱敏诊断',
    defaultPath: `双VPN分流助手-诊断-${new Date().toISOString().slice(0, 10)}.txt`,
    filters: [{ name: '文本诊断', extensions: ['txt'] }]
  })
  if (selection.canceled || !selection.filePath) return null
  await writePrivateDiagnosticFile(selection.filePath, bundle)
  return selection.filePath
}
