#!/bin/zsh
set -u

typeset -gr UNINSTALL_SCRIPT_PATH="${(%):-%N}"
typeset -gr UNINSTALL_SOURCE_DIR="${UNINSTALL_SCRIPT_PATH:A:h}"
source "${UNINSTALL_SOURCE_DIR}/lib/common.sh"
source "${UNINSTALL_SOURCE_DIR}/lib/routes.sh"
source "${UNINSTALL_SOURCE_DIR}/lib/dns.sh"

typeset -gr UNINSTALL_SERVICE_PLIST="/Library/LaunchDaemons/${APP_ID}.plist"

test_uninstall_fail_step() {
  fixture_mode_enabled || return 1
  [[ "$(read_fixture fail-step.txt 2>/dev/null || true)" == "$1" ]]
}

cleanup_network_for_uninstall() {
  fixture_mode_enabled && {
    print -r -- "operation=cleanup-network"
    test_uninstall_fail_step cleanup && return 1
    return 0
  }
  local failed=0
  revert_supplemental_dns || failed=1
  revert_managed_routes || failed=1
  (( failed == 0 ))
}

pause_daemon_for_uninstall() {
  fixture_mode_enabled && return 0
  /bin/launchctl print "system/${APP_ID}" >/dev/null 2>&1 || return 0
  local config_file="${STATE_ROOT}/config.plist" temp_file="${STATE_ROOT}/config.uninstall.$$"
  if [[ -r "$config_file" ]]; then
    /bin/cp "$config_file" "$temp_file" || return 1
  else
    /usr/bin/printf '%s\n' '{"autoEnableAtBoot":true,"paused":true,"logLevel":"standard"}' >| "$temp_file" || return 1
  fi
  /usr/bin/plutil -replace paused -bool true "$temp_file" || return 1
  /usr/sbin/chown root:wheel "$temp_file" || return 1
  /bin/chmod 0600 "$temp_file" || return 1
  /bin/mv -f "$temp_file" "$config_file" || return 1
  /bin/launchctl kickstart -k "system/${APP_ID}" >/dev/null 2>&1 || return 1
  local attempt phase
  for attempt in {1..10}; do
    phase="$(/usr/bin/plutil -extract phase raw -o - "${STATE_ROOT}/status.json" 2>/dev/null || true)"
    [[ "$phase" == PAUSED ]] && return 0
    /bin/sleep 1
  done
  return 1
}

stop_service_for_uninstall() {
  if fixture_mode_enabled; then
    print -r -- "operation=bootout-service"
    return 0
  fi
  /bin/launchctl print "system/${APP_ID}" >/dev/null 2>&1 || return 0
  /bin/launchctl bootout "system/${APP_ID}" >/dev/null 2>&1
}

remove_service_files() {
  if fixture_mode_enabled; then
    print -r -- "operation=remove-service-files"
    return 0
  fi
  /bin/rm -f "$UNINSTALL_SERVICE_PLIST" || return 1
  /bin/rm -rf "$SYSTEM_ROOT" || return 1
  /bin/rm -rf "$RUN_ROOT" || return 1
  /bin/rm -rf "$STATE_ROOT" || return 1
}

uninstall_service() {
  fixture_mode_enabled || (( EUID == 0 )) || { print -u2 "administrator privileges required"; return 77; }
  pause_daemon_for_uninstall || return 1
  cleanup_network_for_uninstall || return 1
  stop_service_for_uninstall || return 1
  remove_service_files || return 1
  if ! fixture_mode_enabled; then
    local log_candidate
    for log_candidate in "$LOG_FILE" "${LOG_FILE}".<1-5>(N); do
      /bin/rm -f "$log_candidate"
    done
  fi
  fixture_mode_enabled || print -r -- '{"ok":true,"action":"uninstall","message":"后台服务已卸载并恢复网络","daemonVersion":null}'
}

if [[ "${1:-}" == --test-plan ]]; then
  uninstall_service
  exit $?
fi

uninstall_service
