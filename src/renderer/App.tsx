import { Activity, Gauge, ScrollText, Settings, Shield, Wifi } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { DaemonStatus } from '../shared/protocol'
import { DiagnosticsPage } from './pages/DiagnosticsPage'
import { SettingsPage } from './pages/SettingsPage'
import { StatusPage } from './pages/StatusPage'

type Page = 'status' | 'diagnostics' | 'settings'

export function App() {
  const [page, setPage] = useState<Page>('status')
  const [status, setStatus] = useState<DaemonStatus | null>(null)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const next = await window.dualVpn.getStatus()
    setStatus(next)
  }, [])

  useEffect(() => {
    void refresh()
    void window.dualVpn.getAppVersion().then(setAppVersion)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 1000)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh])

  const run = async (action: () => Promise<unknown>, success?: string) => {
    setBusy(true)
    setToast(null)
    try {
      const result = await action()
      if (typeof result === 'object' && result !== null && 'ok' in result) {
        const privileged = result as { ok: boolean; message: string }
        if (!privileged.ok) throw new Error(privileged.message)
        setToast(privileged.message)
      } else if (success) setToast(success)
      await refresh()
    } catch (error) {
      setToast(error instanceof Error ? error.message : '操作未完成，请查看诊断信息')
    } finally {
      setBusy(false)
    }
  }

  if (!status) {
    return <main className="boot-screen"><div className="boot-radar"><Activity size={24} /></div><span>正在同步后台状态…</span></main>
  }

  return (
    <div className="dual-vpn-app">
      <aside className="sidebar">
        <div className="window-drag-zone" aria-hidden="true" />
        <div className="brand">
          <span className="brand-mark"><Shield size={21} /></span>
          <div><strong>DUAL//VPN</strong><span>ROUTING ASSISTANT</span></div>
        </div>
        <nav aria-label="主导航">
          <button aria-label="状态" className={page === 'status' ? 'active' : ''} onClick={() => setPage('status')}><Gauge size={18} /><span>状态</span><i aria-hidden="true">01</i></button>
          <button aria-label="诊断日志" className={page === 'diagnostics' ? 'active' : ''} onClick={() => setPage('diagnostics')}><ScrollText size={18} /><span>诊断日志</span><i aria-hidden="true">02</i></button>
          <button aria-label="设置" className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}><Settings size={18} /><span>设置</span><i aria-hidden="true">03</i></button>
        </nav>
        <div className="sidebar-status">
          <span className={`side-signal phase-${status.phase.toLowerCase()}`}><Wifi size={14} /></span>
          <div><small>DAEMON LINK</small><strong>{status.phase === 'UNINSTALLED' ? 'OFFLINE' : 'SECURE / LOCAL'}</strong></div>
        </div>
        <div className="build-number">CORE {status.daemonVersion ?? '—'}</div>
      </aside>
      <main className="content-shell">
        <header className="topbar">
          <div><span className="topbar-kicker">LOCAL NETWORK CONTROL</span><h1>{page === 'status' ? '运行状态' : page === 'diagnostics' ? '诊断日志' : '系统设置'}</h1></div>
          <div className="live-clock"><span className="pulse-dot" /><div><small>LAST SYNC</small><strong>{new Date(status.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}</strong></div></div>
        </header>
        <div className="page-content">
          {page === 'status' && <StatusPage status={status} busy={busy} needsUpgrade={status.phase !== 'UNINSTALLED' && appVersion !== null && status.daemonVersion !== appVersion} onRepair={() => void run(() => window.dualVpn.repairNow(), '检测请求已发送')} onTogglePause={() => void run(() => window.dualVpn.setPaused(!(status.paused || status.phase === 'PAUSED')))} onInstall={() => void run(() => window.dualVpn.installService())} />}
          {page === 'diagnostics' && <DiagnosticsPage status={status} onExport={() => void run(() => window.dualVpn.exportDiagnostics(), '诊断文件已导出')} />}
          {page === 'settings' && <SettingsPage status={status} busy={busy} onAutoEnableChange={(value) => void run(() => window.dualVpn.setAutoEnableAtBoot(value))} onLogLevelChange={(value) => void run(() => window.dualVpn.setLogLevel(value))} onUninstall={() => void run(() => window.dualVpn.uninstallService(), '后台服务已卸载')} />}
        </div>
        {toast && <div className="toast" role="status">{toast}</div>}
      </main>
    </div>
  )
}
