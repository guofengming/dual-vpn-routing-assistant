import { constants } from 'node:fs'
import { link, open, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  ControlRequestSchema,
  DaemonStatusSchema,
  type ControlRequest,
  type DaemonStatus
} from '../shared/protocol'
import { SYSTEM_IPC_DIR, SYSTEM_STATE_DIR } from '../shared/paths'

export interface DaemonClientPaths {
  statusPath: string
  requestDirectory: string
}

function isoNow(): string {
  return new Date().toISOString()
}

function syntheticStatus(phase: 'UNINSTALLED' | 'DEGRADED', message: string): DaemonStatus {
  const now = isoNow()
  return {
    schemaVersion: 1,
    phase,
    message,
    updatedAt: now,
    physicalInterface: null,
    physicalGateway: null,
    mobileInterface: null,
    routes: [],
    dns: {
      state: 'unknown',
      servers: [],
      domains: [],
      resolvedAddresses: []
    },
    lastCheckAt: null,
    lastNetworkChangeAt: null,
    lastError: phase === 'DEGRADED'
      ? {
          code: 'invalid_status',
          message: '服务状态不可读，请执行检测修复',
          occurredAt: now,
          retryable: true
        }
      : null,
    autoEnableAtBoot: true,
    paused: false,
    logLevel: 'standard',
    daemonVersion: null,
    processedRequestId: null,
    events: []
  }
}

function defaultPaths(): DaemonClientPaths {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return {
    statusPath: path.join(SYSTEM_STATE_DIR, 'status.json'),
    requestDirectory: path.join(SYSTEM_IPC_DIR, String(uid))
  }
}

export class DaemonClient {
  readonly paths: DaemonClientPaths

  constructor(paths: DaemonClientPaths = defaultPaths()) {
    this.paths = paths
  }

  async readStatus(): Promise<DaemonStatus> {
    let raw: string
    try {
      raw = await readFile(this.paths.statusPath, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return syntheticStatus('UNINSTALLED', '后台服务尚未安装')
      }
      return syntheticStatus('DEGRADED', '无法读取后台服务状态')
    }

    try {
      return DaemonStatusSchema.parse(JSON.parse(raw))
    } catch {
      return syntheticStatus('DEGRADED', '后台服务返回了无效状态')
    }
  }

  async send(request: ControlRequest): Promise<void> {
    const validated = ControlRequestSchema.parse(request)
    const requestPath = path.join(this.paths.requestDirectory, 'request.json')
    const tempPath = path.join(
      this.paths.requestDirectory,
      `.request-${randomUUID()}.tmp`
    )
    let handle: Awaited<ReturnType<typeof open>> | undefined

    try {
      handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      await handle.writeFile(`${JSON.stringify(validated)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await link(tempPath, requestPath)
      await unlink(tempPath)
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await unlink(tempPath).catch(() => undefined)
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('已有控制请求等待后台服务处理', { cause: error })
      }
      throw error
    }
  }
}
