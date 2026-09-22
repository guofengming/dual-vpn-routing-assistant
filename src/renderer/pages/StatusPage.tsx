import { Clock3, Download, Network, RadioTower } from 'lucide-react'
import type { DaemonStatus } from '../../shared/protocol'
import { ActionBar } from '../components/ActionBar'
import { RouteMatrix } from '../components/RouteMatrix'
import { StatusBanner } from '../components/StatusBanner'

function Metric(props: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="metric-card">
      <span className="metric-icon">{props.icon}</span>
      <span className="metric-label">{props.label}</span>
      <strong>{props.value}</strong>
      <small>{props.detail}</small>
    </div>
  )
}

export function StatusPage(props: {
  status: DaemonStatus
  busy: boolean
  needsUpgrade: boolean
  onRepair: () => void
  onTogglePause: () => void
  onInstall: () => void
}) {
  return (
    <div className="page-stack">
      <StatusBanner status={props.status} />
      {props.status.phase === 'UNINSTALLED' || props.needsUpgrade ? (
        <section className="panel install-panel">
          <div>
            <span className="section-index">SETUP</span>
            <h3>{props.needsUpgrade ? '升级自动分流守护' : '启用自动分流守护'}</h3>
            <p>{props.needsUpgrade ? 'App 与后台服务版本不一致。升级会先备份现有服务，验证新版本正常后再完成替换。' : '首次安装会弹出 macOS 管理员授权。安装后后台服务随系统启动，窗口不会自动弹出。'}</p>
          </div>
          <button className="button button-primary" disabled={props.busy} onClick={props.onInstall}>
            <Download size={16} />{props.busy ? (props.needsUpgrade ? '正在升级后台服务…' : '正在安装后台服务…') : (props.needsUpgrade ? '升级后台服务' : '安装后台服务')}
          </button>
        </section>
      ) : (
        <>
          <div className="metric-grid">
            <Metric icon={<Network size={17} />} label="物理出口" value={props.status.physicalInterface ?? '—'} detail={props.status.physicalGateway ?? '等待网关'} />
            <Metric icon={<RadioTower size={17} />} label="中移隧道" value={props.status.mobileInterface ?? '未连接'} detail="仅承载中移业务" />
            <Metric icon={<Clock3 size={17} />} label="最近检测" value={props.status.lastCheckAt ? new Date(props.status.lastCheckAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'} detail="后台持续低频巡检" />
          </div>
          <RouteMatrix status={props.status} />
          <ActionBar status={props.status} busy={props.busy} onRepair={props.onRepair} onTogglePause={props.onTogglePause} />
        </>
      )}
    </div>
  )
}
