#!/bin/zsh

# Shared constants and deliberately small helpers for the privileged daemon.
# This file may be sourced by tests, but fixture overrides are never honoured
# by a root process.

[[ "${DUALVPN_COMMON_LOADED:-0}" == 1 ]] && return 0
typeset -gr DUALVPN_COMMON_LOADED=1

typeset -gr APP_ID="com.guofengming.dual-vpn-routing-assistant"
typeset -gr SYSTEM_ROOT="/Library/Application Support/DualVPNRoutingAssistant"
typeset -gr STATE_ROOT="/var/db/dual-vpn-routing-assistant"
typeset -gr RUN_ROOT="/var/run/dual-vpn-routing-assistant"
typeset -gr LOG_FILE="/var/log/dual-vpn-routing-assistant.log"

typeset -gra RECLAIM_NETS=(10.0.0.0/9 10.128.0.0/9)
typeset -gra MOBILE_DNS_IPS=(10.57.0.96 10.57.0.196)
typeset -gra OFFICE_DNS_IPS=(172.31.5.60 172.31.6.60)
typeset -gra MATCH_DOMAINS=(baidu.com baidu-int.com internal.baidu.com)
typeset -gra VERIFY_IPS=(10.11.154.217 10.11.173.70)

fixture_mode_enabled() {
  [[ "${DUALVPN_TEST_MODE:-0}" == 1 && EUID -ne 0 && -n "${DUALVPN_FIXTURE_DIR:-}" ]]
}

fixture_path() {
  fixture_mode_enabled || return 1
  print -r -- "${DUALVPN_FIXTURE_DIR}/$1"
}

read_fixture() {
  local path
  path="$(fixture_path "$1")" || return 1
  [[ -r "$path" ]] || return 1
  /bin/cat "$path"
}

field_from_route() {
  local route_output="$1"
  local key="$2"
  /usr/bin/awk -v key="${key}:" '$1 == key { print $2; exit }' <<<"$route_output"
}

interface_has_address() {
  local interface_name="$1"
  local output

  if fixture_mode_enabled; then
    output="$(read_fixture "ifconfig-${interface_name}.txt" 2>/dev/null)" || return 1
  else
    output="$(/sbin/ifconfig "$interface_name" 2>/dev/null)" || return 1
  fi

  print -r -- "$output" | /usr/bin/grep -qE '^[[:space:]]+inet6? '
}

route_get() {
  local target="$1"
  if fixture_mode_enabled && [[ "$target" == default ]]; then
    read_fixture default-route.txt 2>/dev/null || true
    return 0
  fi
  /sbin/route -n get "$target" 2>/dev/null || true
}

safe_log() {
  local level="$1"
  shift
  local message="$*"
  local timestamp
  timestamp="$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')"

  if fixture_mode_enabled; then
    print -r -- "log=${level}|${message}"
  else
    print -r -- "${timestamp} [${level}] ${message}" >> "$LOG_FILE"
  fi
}

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  print -rn -- "$value"
}

rotate_log_if_needed() {
  fixture_mode_enabled && return 0
  [[ -f "$LOG_FILE" ]] || return 0
  local bytes
  bytes="$(/usr/bin/stat -f '%z' "$LOG_FILE" 2>/dev/null || print 0)"
  (( bytes < 1048576 )) && return 0

  local index
  /bin/rm -f "${LOG_FILE}.5"
  for (( index = 4; index >= 1; index-- )); do
    [[ -e "${LOG_FILE}.${index}" ]] && /bin/mv "${LOG_FILE}.${index}" "${LOG_FILE}.$(( index + 1 ))"
  done
  /bin/mv "$LOG_FILE" "${LOG_FILE}.1"
  /usr/bin/touch "$LOG_FILE"
  /usr/sbin/chown root:wheel "$LOG_FILE"
  /bin/chmod 0644 "$LOG_FILE"
}
