import { Clipboard, Download, FileWarning } from 'lucide-react'
import type { DaemonStatus } from '../../shared/protocol'

function diagnosticSummary(status: DaemonStatus): string {
  return [
    `phase: ${status.phase}`,
    `message: ${status.message}`,
    `physical: ${status.physicalInterface ?? '-'} via ${status.physicalGateway ?? '-'}`,
    `mobile: ${status.mobileInterface ?? '-'}`,
    `daemon: ${status.daemonVersion ?? '-'}`,
    status.lastError ? `error: ${status.lastError.code} ${status.lastError.message}` : 'error: none'
  ].join('\n')
}

export function DiagnosticsPage(props: { status: DaemonStatus; onExport: () => void }) {
  const copySummary = () => navigator.clipboard?.writeText(diagnosticSummary(props.status))
  return (
    <div className="page-stack">
      <section className="page-intro">
        <span className="section-index">DIAGNOSTICS</span>
        <h2>诊断日志</h2>
        <p>仅展示结构化状态与分流事件，不采集网络内容、账号或 VPN 凭据。</p>
      </section>
      <section className="panel diagnostic-summary">
        <header className="panel-heading"><div><FileWarning size={17} /><h3>当前诊断摘要</h3></div></header>
        <pre>{diagnosticSummary(props.status)}</pre>
        <div className="inline-actions">
          <button className="button button-secondary" onClick={copySummary}><Clipboard size={15} />复制摘要</button>
          <button className="button button-primary" onClick={props.onExport}><Download size={15} />导出脱敏诊断</button>
        </div>
      </section>
      <section className="panel event-panel">
        <header className="panel-heading"><div><span className="section-index">02</span><h3>最近事件</h3></div><span className="panel-meta">MAX 200</span></header>
        {props.status.events.length ? (
          <ol className="event-list">{props.status.events.map((event) => (
            <li key={event.id} className={`event-${event.level}`}>
              <time>{new Date(event.occurredAt).toLocaleString('zh-CN', { hour12: false })}</time>
              <strong>{event.code}</strong><span>{event.message}</span>
            </li>
          ))}</ol>
        ) : <div className="empty-state"><span>暂无异常事件</span></div>}
      </section>
    </div>
  )
}
