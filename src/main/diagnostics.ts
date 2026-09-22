import { homedir, userInfo } from 'node:os'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, dialog } from 'electron'
import type { DaemonStatus } from '../shared/protocol'

export interface DiagnosticBundleInput {
  status: DaemonStatus
  appVersion: string
  homeDirectory: string
  username: string
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
    status: input.status
  }
  let result = `${JSON.stringify(document, null, 2)}\n`
  result = replaceAllLiteral(result, input.homeDirectory, '$USER_HOME')
  result = replaceAllLiteral(result, input.username, '$CONSOLE_USER')
  return result
}

export async function exportDiagnosticBundle(
  status: DaemonStatus,
  fixtureDirectory?: string
): Promise<string | null> {
  let username = process.env.USER ?? ''
  if (!username) {
    try { username = userInfo().username } catch { /* environment fallback */ }
  }
  const bundle = buildDiagnosticBundle({
    status,
    appVersion: app.getVersion(),
    homeDirectory: homedir(),
    username
  })

  if (!app.isPackaged && fixtureDirectory) {
    const destination = path.join(fixtureDirectory, 'diagnostics-export.txt')
    await writeFile(destination, bundle, { mode: 0o600 })
    return destination
  }

  const selection = await dialog.showSaveDialog({
    title: '导出脱敏诊断',
    defaultPath: `双VPN分流助手-诊断-${new Date().toISOString().slice(0, 10)}.txt`,
    filters: [{ name: '文本诊断', extensions: ['txt'] }]
  })
  if (selection.canceled || !selection.filePath) return null
  await writeFile(selection.filePath, bundle, { mode: 0o600 })
  return selection.filePath
}
