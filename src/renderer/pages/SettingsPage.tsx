import { Power, Settings2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { DaemonStatus } from '../../shared/protocol'

export function SettingsPage(props: {
  status: DaemonStatus
  busy: boolean
  onAutoEnableChange: (value: boolean) => void
  onLogLevelChange: (value: 'standard' | 'detailed') => void
  onUninstall: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  return (
    <div className="page-stack">
      <section className="page-intro">
        <span className="section-index">PREFERENCES</span>
        <h2>设置</h2>
        <p>后台服务只维护固定的四条路由和三组补充 DNS 域。</p>
      </section>
      <section className="panel settings-panel">
        <div className="setting-row">
          <div className="setting-icon"><Power size={18} /></div>
          <div className="setting-copy"><strong>开机自动启用分流</strong><span>服务随系统启动；关闭后服务保留，但处于暂停状态。</span></div>
          <label className="switch">
            <input type="checkbox" aria-label="开机自动启用分流" checked={props.status.autoEnableAtBoot} disabled={props.busy} onChange={(event) => props.onAutoEnableChange(event.target.checked)} />
            <span />
          </label>
        </div>
        <div className="setting-row">
          <div className="setting-icon"><Settings2 size={18} /></div>
          <div className="setting-copy"><strong>日志详细度</strong><span>详细模式会记录探测结果，但不会记录网络内容。</span></div>
          <select aria-label="日志详细度" value={props.status.logLevel ?? 'standard'} disabled={props.busy} onChange={(event) => props.onLogLevelChange(event.target.value as 'standard' | 'detailed')}>
            <option value="standard">标准</option><option value="detailed">详细</option>
          </select>
        </div>
      </section>
      <section className="panel about-panel">
        <div><span className="section-index">SERVICE</span><h3>后台服务</h3></div>
        <dl><div><dt>Daemon</dt><dd>{props.status.daemonVersion ?? '未安装'}</dd></div><div><dt>协议</dt><dd>schema v{props.status.schemaVersion}</dd></div><div><dt>运行原则</dt><dd>最小权限 · 本机处理</dd></div></dl>
        {props.status.phase !== 'UNINSTALLED' && <button className="button button-danger" onClick={() => setConfirming(true)}><Trash2 size={15} />卸载后台服务</button>}
      </section>
      {confirming && (
        <div className="dialog-backdrop" role="presentation">
          <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="uninstall-title">
            <span className="dialog-mark"><Trash2 size={22} /></span>
            <h3 id="uninstall-title">确认卸载后台服务？</h3>
            <p>将先恢复本助手管理的路由和 DNS，再移除守护服务。两个 VPN 应用不会被卸载。</p>
            <div className="inline-actions"><button className="button button-secondary" onClick={() => setConfirming(false)}>取消</button><button className="button button-danger" disabled={props.busy} onClick={props.onUninstall}>确认卸载</button></div>
          </div>
        </div>
      )}
    </div>
  )
}
