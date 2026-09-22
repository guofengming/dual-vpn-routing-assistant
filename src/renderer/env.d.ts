import type { DualVpnApi } from '../preload'

declare global {
  interface Window {
    dualVpn: DualVpnApi
  }
}

export {}
