import { Pause, Play, RotateCw } from 'lucide-react'
import type { DaemonStatus } from '../../shared/protocol'

export function ActionBar(props: {
  status: DaemonStatus
  busy: boolean
  onRepair: () => void
  onTogglePause: () => void
}) {
  const isPaused = props.status.paused || props.status.phase === 'PAUSED'
  return (
    <div className="action-bar">
      <button className="button button-primary" disabled={props.busy} onClick={props.onRepair}>
        <RotateCw size={16} className={props.busy ? 'spin-once' : ''} />
        立即检测并修复
      </button>
      <button className="button button-secondary" disabled={props.busy} onClick={props.onTogglePause}>
        {isPaused ? <Play size={16} /> : <Pause size={16} />}
        {isPaused ? '恢复分流' : '暂停分流'}
      </button>
      <span className="action-hint">助手不会启动、关闭或登录任何 VPN</span>
    </div>
  )
}
