import { ArrowRight, Cable, Check, CircleDashed } from 'lucide-react'
import type { DaemonStatus, RouteStatus } from '../../shared/protocol'

function RouteRow({ route }: { route: RouteStatus }) {
  return (
    <div className="route-row">
      <div className="route-identity">
        <span className={`route-state route-state-${route.state}`}>
          {route.state === 'correct' ? <Check size={12} /> : <CircleDashed size={12} />}
        </span>
        <div><strong>{route.label}</strong><span>{route.destination}</span></div>
      </div>
      <ArrowRight className="route-arrow" size={16} aria-hidden="true" />
      <div className="route-endpoint">
        <span className="interface-chip"><Cable size={13} />{route.interface ?? '—'}</span>
        <span>{route.gateway ? `via ${route.gateway}` : 'direct interface'}</span>
      </div>
    </div>
  )
}

export function RouteMatrix({ status }: { status: DaemonStatus }) {
  return (
    <section className="panel route-panel" aria-labelledby="route-title">
      <header className="panel-heading">
        <div><span className="section-index">01</span><h3 id="route-title">分流矩阵</h3></div>
        <span className="panel-meta">{status.routes.length} MANAGED PATHS</span>
      </header>
      {status.routes.length ? (
        <div className="route-list">{status.routes.map((route) => <RouteRow route={route} key={route.id} />)}</div>
      ) : (
        <div className="empty-state">
          <CircleDashed size={22} />
          <span>等待可用隧道后生成路由矩阵</span>
        </div>
      )}
    </section>
  )
}
