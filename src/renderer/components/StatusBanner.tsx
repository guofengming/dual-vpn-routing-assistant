import { Activity, CircleAlert, CirclePause, Radio, Satellite, ShieldCheck } from 'lucide-react'
import type { DaemonStatus } from '../../shared/protocol'

const phaseCopy: Record<DaemonStatus['phase'], { title: string; detail: string; tone: string }> = {
  UNINSTALLED: {
    title: '后台服务尚未安装',
    detail: '安装一次后台服务，之后切换网络无需重复输入管理员密码。',
    tone: 'neutral'
  },
  IDLE: {
    title: '等待中移 VPN',
    detail: '当前保持网络原状；登录中移 VPN 后会自动建立分流。',
    tone: 'standby'
  },
  PROBING: {
    title: '正在检测网络',
    detail: '正在确认物理网关、中移隧道和办公 DNS。',
    tone: 'working'
  },
  ACTIVE: {
    title: '分流矩阵稳定',
    detail: '度管家与百度办公网走当前物理网络，中移业务保留在专用隧道。',
    tone: 'healthy'
  },
  NETWORK_SETTLING: {
    title: '网络正在重新校准',
    detail: '已清理旧网络配置，预计 10–30 秒内按新网关恢复，期间办公网可能短暂中断。',
    tone: 'working'
  },
  REPAIRING: {
    title: '正在自动修复',
    detail: '检测到分流漂移，正在进行受限重试。',
    tone: 'warning'
  },
  PAUSED: {
    title: '分流已暂停',
    detail: '已撤销本助手管理的路由和 DNS，不影响两个 VPN 应用本身。',
    tone: 'neutral'
  },
  DEGRADED: {
    title: '需要处理',
    detail: '自动恢复暂未完成，可立即重新检测或查看诊断信息。',
    tone: 'danger'
  }
}

function PhaseIcon({ phase }: { phase: DaemonStatus['phase'] }) {
  const props = { size: 25, strokeWidth: 1.7, 'aria-hidden': true }
  if (phase === 'ACTIVE') return <ShieldCheck {...props} />
  if (phase === 'PAUSED') return <CirclePause {...props} />
  if (phase === 'DEGRADED') return <CircleAlert {...props} />
  if (phase === 'IDLE') return <Radio {...props} />
  if (phase === 'NETWORK_SETTLING') return <Satellite {...props} />
  return <Activity {...props} />
}

export function StatusBanner({ status }: { status: DaemonStatus }) {
  const copy = phaseCopy[status.phase]
  return (
    <section className={`status-banner tone-${copy.tone}`} aria-labelledby="system-state-title">
      <div className="status-orbit" aria-hidden="true"><span /></div>
      <div className="status-icon"><PhaseIcon phase={status.phase} /></div>
      <div className="status-copy">
        <div className="eyebrow">SYSTEM ROUTING STATE</div>
        <h2 id="system-state-title">{copy.title}</h2>
        <p>{copy.detail}</p>
        {status.lastError && (
          <p className="status-error" role="alert">
            <span>{status.lastError.code}</span>{status.lastError.message}
          </p>
        )}
      </div>
      <div className="status-code" aria-label={`当前状态 ${status.phase}`}>
        <span className="pulse-dot" />{status.phase}
      </div>
    </section>
  )
}
