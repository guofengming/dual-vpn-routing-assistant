#!/bin/zsh
set -u

next_phase() {
  local current="$1" event="$2"

  [[ "$event" == pause ]] && { print PAUSED; return 0; }
  case "${current}:${event}" in
    IDLE:vpn_up) print PROBING ;;
    PROBING:verification_ok) print ACTIVE ;;
    ACTIVE:vpn_down) print IDLE ;;
    ACTIVE:network_changed) print NETWORK_SETTLING ;;
    NETWORK_SETTLING:stable) print PROBING ;;
    PAUSED:resume) print PROBING ;;
    REPAIRING:repair_failed_[123]) print REPAIRING ;;
    REPAIRING:repair_failed_4) print DEGRADED ;;
    DEGRADED:environment_change) print PROBING ;;
    *) return 1 ;;
  esac
}

retry_delay() {
  case "$1" in
    1) print 2 ;;
    2) print 5 ;;
    3) print 10 ;;
    *) return 1 ;;
  esac
}

case "${1:-}" in
  --transition)
    next_phase "${2:-}" "${3:-}"
    ;;
  --retry)
    retry_delay "${2:-}"
    ;;
esac
