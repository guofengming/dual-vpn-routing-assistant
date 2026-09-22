#!/bin/zsh
set -u

typeset -gr INSTALL_SCRIPT_PATH="${(%):-%N}"
typeset -gr INSTALL_SOURCE_DIR="${INSTALL_SCRIPT_PATH:A:h}"
source "${INSTALL_SOURCE_DIR}/lib/common.sh"
source "${INSTALL_SOURCE_DIR}/lib/probe.sh"
source "${INSTALL_SOURCE_DIR}/lib/routes.sh"
source "${INSTALL_SOURCE_DIR}/lib/dns.sh"
source "${INSTALL_SOURCE_DIR}/migrate-legacy.sh"

typeset -gr INSTALL_SERVICE_PLIST="/Library/LaunchDaemons/${APP_ID}.plist"
typeset -gr INSTALL_DAEMON_DIR="${SYSTEM_ROOT}/daemon"
typeset -gr INSTALL_BACKUP_DIR="${STATE_ROOT}/install-backup"
typeset -g INSTALL_STARTED=false

test_fail_step() {
  fixture_mode_enabled || return 1
  read_fixture fail-step.txt 2>/dev/null | /usr/bin/grep -Fxq "$1"
}

rollback_installation() {
  # Never mutate network state or installed files while the daemon may still
  # be running. A failed stop leaves the complete installation backup in place
  # so the next authorized attempt can recover it safely.
  stop_installed_service rollback-stop-service || return 1
  if fixture_mode_enabled; then
    print -r -- "operation=restore-network"
    if test_fail_step rollback-cleanup; then
      print -r -- "operation=remove-stale-status"
      return 1
    fi
    print -r -- "operation=remove-stale-status"
    [[ "$(read_fixture had-previous-service.txt 2>/dev/null || print 1)" == 1 ]] && \
      print -r -- "operation=restore-previous-service"
    return 0
  fi
  local failed=0
  revert_supplemental_dns || failed=1
  revert_managed_routes || failed=1
  if (( failed != 0 )); then
    safe_log error "installation rollback left managed network state; service files and backups retained"
    /bin/rm -f "${STATE_ROOT}/status.json" || safe_log error "could not remove stale daemon status"
    return 1
  fi
  /bin/rm -f "${STATE_ROOT}/status.json" || return 1
  /bin/rm -f "$INSTALL_SERVICE_PLIST" || failed=1
  /bin/rm -rf "$INSTALL_DAEMON_DIR" || failed=1
  if [[ -e "${INSTALL_BACKUP_DIR}/had-daemon" ]]; then
    /usr/bin/install -d -o root -g wheel -m 0755 "$SYSTEM_ROOT" || failed=1
    /bin/cp -R "${INSTALL_BACKUP_DIR}/daemon" "$INSTALL_DAEMON_DIR" || failed=1
  fi
  if [[ -e "${INSTALL_BACKUP_DIR}/had-plist" ]]; then
    /bin/cp "${INSTALL_BACKUP_DIR}/service.plist" "$INSTALL_SERVICE_PLIST" || failed=1
    /usr/sbin/chown root:wheel "$INSTALL_SERVICE_PLIST" || failed=1
    /bin/chmod 0644 "$INSTALL_SERVICE_PLIST" || failed=1
    /bin/launchctl bootstrap system "$INSTALL_SERVICE_PLIST" >/dev/null 2>&1 || failed=1
    local expected_version="" restored_state="" restored_version="" attempt restored=false
    [[ -r "${INSTALL_BACKUP_DIR}/daemon/VERSION" ]] && expected_version="$(<"${INSTALL_BACKUP_DIR}/daemon/VERSION")"
    for attempt in {1..10}; do
      restored_state="$(/bin/launchctl print "system/${APP_ID}" 2>/dev/null || true)"
      restored_version="$(/usr/bin/plutil -extract daemonVersion raw -o - "${STATE_ROOT}/status.json" 2>/dev/null || true)"
      if print -r -- "$restored_state" | /usr/bin/grep -q 'state = running' && \
         [[ -z "$expected_version" || "$restored_version" == "$expected_version" ]]; then
        restored=true
        break
      fi
      /bin/sleep 1
    done
    [[ "$restored" == true ]] || failed=1
  fi
  (( failed == 0 ))
}

backup_previous_service() {
  if fixture_mode_enabled; then
    print -r -- "operation=backup-previous-service"
    test_fail_step backup && return 1
    return 0
  fi
  /bin/rm -rf "$INSTALL_BACKUP_DIR" || return 1
  /usr/bin/install -d -o root -g wheel -m 0700 "$INSTALL_BACKUP_DIR" || return 1
  if [[ -d "$INSTALL_DAEMON_DIR" ]]; then
    /bin/cp -R "$INSTALL_DAEMON_DIR" "${INSTALL_BACKUP_DIR}/daemon" || return 1
    /usr/bin/touch "${INSTALL_BACKUP_DIR}/had-daemon" || return 1
  fi
  if [[ -f "$INSTALL_SERVICE_PLIST" ]]; then
    /bin/cp "$INSTALL_SERVICE_PLIST" "${INSTALL_BACKUP_DIR}/service.plist" || return 1
    /usr/bin/touch "${INSTALL_BACKUP_DIR}/had-plist" || return 1
  fi
}

install_files() {
  fixture_mode_enabled && {
    print -r -- "operation=install-service-files"
    test_fail_step install-files && return 1
    return 0
  }
  /usr/bin/install -d -o root -g wheel -m 0755 "$SYSTEM_ROOT" "$INSTALL_DAEMON_DIR" "${INSTALL_DAEMON_DIR}/lib" || return 1
  /usr/bin/install -o root -g wheel -m 0755 "${INSTALL_SOURCE_DIR}/daemon.sh" "${INSTALL_DAEMON_DIR}/daemon.sh" || return 1
  /usr/bin/install -o root -g wheel -m 0644 "${INSTALL_SOURCE_DIR}/VERSION" "${INSTALL_DAEMON_DIR}/VERSION" || return 1
  local source_file
  for source_file in "${INSTALL_SOURCE_DIR}"/lib/*.sh; do
    /usr/bin/install -o root -g wheel -m 0755 "$source_file" "${INSTALL_DAEMON_DIR}/lib/${source_file:t}" || return 1
  done
  /usr/bin/install -o root -g wheel -m 0644 "${INSTALL_SOURCE_DIR}/${APP_ID}.plist" "$INSTALL_SERVICE_PLIST" || return 1
  /usr/bin/plutil -lint "$INSTALL_SERVICE_PLIST" >/dev/null || return 1
}

create_user_ipc_directory() {
  fixture_mode_enabled && { test_fail_step ipc && return 1; return 0; }
  local console_user console_uid console_gid
  console_user="$(detect_console_user)"
  [[ -n "$console_user" ]] || return 1
  console_uid="$(/usr/bin/id -u "$console_user")"
  console_gid="$(/usr/bin/id -g "$console_user")"
  [[ ! -L "${SYSTEM_ROOT}/ipc" && ! -L "${SYSTEM_ROOT}/ipc/${console_uid}" ]] || return 1
  /usr/bin/install -d -o root -g wheel -m 0755 "${SYSTEM_ROOT}/ipc" || return 1
  /usr/bin/install -d -o "$console_uid" -g "$console_gid" -m 0700 "${SYSTEM_ROOT}/ipc/${console_uid}" || return 1
}

snapshot_network_for_install() {
  if fixture_mode_enabled; then
    print -r -- "operation=snapshot-network"
    test_fail_step snapshot && return 1
    return 0
  fi
  snapshot_routes || return 1
  snapshot_dns || return 1
}

stop_installed_service() {
  local failure_step="${1:-stop-service}"
  if fixture_mode_enabled; then
    if [[ "$failure_step" == rollback-stop-service ]]; then
      print -r -- "operation=stop-rollback-service"
    else
      print -r -- "operation=stop-new-service"
    fi
    test_fail_step "$failure_step" && return 1
    return 0
  fi

  # A missing job is already stopped. If launchd knows the label, bootout and
  # verify that it actually disappeared before replacing any service files.
  /bin/launchctl print "system/${APP_ID}" >/dev/null 2>&1 || return 0
  /bin/launchctl bootout "system/${APP_ID}" >/dev/null 2>&1 || return 1
  local attempt
  for attempt in {1..20}; do
    /bin/launchctl print "system/${APP_ID}" >/dev/null 2>&1 || return 0
    /bin/sleep 0.1
  done
  return 1
}

bootstrap_installed_service() {
  if fixture_mode_enabled; then
    test_fail_step bootstrap && return 1
    print -r -- "operation=bootstrap-new"
    return 0
  fi
  /bin/rm -f "${STATE_ROOT}/status.json" || return 1
  /bin/launchctl bootstrap system "$INSTALL_SERVICE_PLIST" || return 1
  /bin/launchctl kickstart -k "system/${APP_ID}" || return 1
}

verify_installed_service() {
  if fixture_mode_enabled; then
    print -r -- "operation=verify-running-service"
    test_fail_step verify && return 1
    return 0
  fi
  local expected_version status_file="${STATE_ROOT}/status.json" launch_state="" attempt phase schema version uid mode
  expected_version="$(/bin/cat "${INSTALL_SOURCE_DIR}/VERSION" 2>/dev/null)" || return 1
  for attempt in {1..10}; do
    launch_state="$(/bin/launchctl print "system/${APP_ID}" 2>/dev/null || true)"
    if print -r -- "$launch_state" | /usr/bin/grep -q 'state = running' && [[ -r "$status_file" ]]; then
      schema="$(/usr/bin/plutil -extract schemaVersion raw -o - "$status_file" 2>/dev/null || true)"
      version="$(/usr/bin/plutil -extract daemonVersion raw -o - "$status_file" 2>/dev/null || true)"
      phase="$(/usr/bin/plutil -extract phase raw -o - "$status_file" 2>/dev/null || true)"
      uid="$(/usr/bin/stat -f '%u' "$status_file" 2>/dev/null || true)"
      mode="$(/usr/bin/stat -f '%OLp' "$status_file" 2>/dev/null || true)"
      if [[ "$schema" == 1 && "$version" == "$expected_version" && "$uid" == 0 && "$mode" == 644 ]] && \
         print -r -- "$phase" | /usr/bin/grep -Eq '^(IDLE|NETWORK_SETTLING|PROBING|ACTIVE|REPAIRING|DEGRADED|PAUSED)$'; then
        return 0
      fi
    fi
    /bin/sleep 1
  done
  return 1
}

run_test_install_plan() {
  install_service
}

rollback_full_installation() {
  local legacy_backup_dir="$1"
  rollback_installation || return 1
  rollback_legacy_migration "$legacy_backup_dir"
}

install_service() {
  fixture_mode_enabled || (( EUID == 0 )) || { print -u2 "administrator privileges required"; return 77; }
  backup_previous_service || return 1
  local legacy_backup_dir="${INSTALL_BACKUP_DIR}/legacy"
  prepare_legacy_migration "$legacy_backup_dir" || return 1
  snapshot_network_for_install || { rollback_legacy_migration "$legacy_backup_dir"; return 1; }
  INSTALL_STARTED=true
  # Nothing from the current service has been replaced yet. If it cannot be
  # stopped, leave it untouched and only restore the prepared legacy service.
  stop_installed_service || { rollback_legacy_migration "$legacy_backup_dir"; return 1; }
  install_files || { rollback_full_installation "$legacy_backup_dir"; return 1; }
  create_user_ipc_directory || { rollback_full_installation "$legacy_backup_dir"; return 1; }
  bootstrap_installed_service || { rollback_full_installation "$legacy_backup_dir"; return 1; }
  verify_installed_service || { rollback_full_installation "$legacy_backup_dir"; return 1; }
  local daemon_version
  daemon_version="$(/bin/cat "${INSTALL_SOURCE_DIR}/VERSION")" || { rollback_full_installation "$legacy_backup_dir"; return 1; }
  if fixture_mode_enabled; then
    commit_legacy_migration || { rollback_full_installation "$legacy_backup_dir"; return 1; }
    print -r -- "operation=installation-complete"
    return 0
  fi
  /usr/bin/printf '%s\n' "$daemon_version" >| "${STATE_ROOT}/version" || { rollback_full_installation "$legacy_backup_dir"; return 1; }
  /usr/sbin/chown root:wheel "${STATE_ROOT}/version" || { rollback_full_installation "$legacy_backup_dir"; return 1; }
  /bin/chmod 0644 "${STATE_ROOT}/version" || { rollback_full_installation "$legacy_backup_dir"; return 1; }
  commit_legacy_migration || { rollback_full_installation "$legacy_backup_dir"; return 1; }
  /bin/rm -rf "$INSTALL_BACKUP_DIR" || safe_log warn "installation backup could not be removed"
  print -r -- "{\"ok\":true,\"action\":\"install\",\"message\":\"后台服务已安装\",\"daemonVersion\":\"${daemon_version}\"}"
}

if [[ "${1:-}" == --test-plan ]]; then
  run_test_install_plan
  exit $?
fi

install_service
