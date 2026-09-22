#!/bin/zsh
set -u

[[ "${DUALVPN_PROBE_LOADED:-0}" == 1 ]] && return 0
typeset -gr DUALVPN_PROBE_LOADED=1

typeset -gr PROBE_SCRIPT_PATH="${(%):-%N}"
typeset -gr PROBE_SCRIPT_DIR="${PROBE_SCRIPT_PATH:A:h}"
source "${PROBE_SCRIPT_DIR}/common.sh"

detect_console_user() {
  local detected=""

  if fixture_mode_enabled; then
    detected="$(read_fixture console-user.txt 2>/dev/null || true)"
  else
    detected="$(/usr/bin/stat -f '%Su' /dev/console 2>/dev/null || true)"
  fi

  [[ -n "$detected" && "$detected" != root && "$detected" != loginwindow ]] || return 0
  print -r -- "$detected"
}

console_user_home() {
  local console_user="$1"
  local user_home=""

  if [[ -n "$console_user" ]]; then
    user_home="$(/usr/bin/dscl . -read "/Users/${console_user}" NFSHomeDirectory 2>/dev/null | /usr/bin/awk '{ print $2; exit }' || true)"
  fi
  [[ -n "$user_home" ]] || user_home="/Users/${console_user}"
  print -r -- "$user_home"
}

probe_physical_route() {
  local default_route physical_if physical_gw
  default_route="$(route_get default)"
  physical_if="$(field_from_route "$default_route" interface)"
  physical_gw="$(field_from_route "$default_route" gateway)"

  [[ -n "$physical_if" && "$physical_if" != utun<-> ]] || return 0
  [[ -n "$physical_gw" ]] || return 0
  interface_has_address "$physical_if" || return 0
  print -r -- "${physical_if}|${physical_gw}"
}

probe_mobile_interface() {
  local console_user="$1"
  local mobile_state candidate=""

  if fixture_mode_enabled; then
    candidate="$(read_fixture mobile-ifname.txt 2>/dev/null || true)"
  else
    [[ -n "$console_user" ]] || return 0
    mobile_state="$(console_user_home "$console_user")/Library/Application Support/com.chinamobileonline.vpnclientx/secureutun.plist"
    if [[ -r "$mobile_state" ]]; then
      candidate="$(/usr/bin/plutil -extract ifname raw -o - "$mobile_state" 2>/dev/null || true)"
    fi
  fi

  [[ "$candidate" == utun<-> ]] || return 0
  interface_has_address "$candidate" || return 0
  print -r -- "$candidate"
}

enterprise_dns_reachable() {
  local physical_if="$1"
  local ip

  if fixture_mode_enabled; then
    [[ "$(read_fixture enterprise-dns-reachable.txt 2>/dev/null || true)" == 1 ]]
    return
  fi

  [[ -n "$physical_if" ]] || return 1
  for ip in $OFFICE_DNS_IPS; do
    [[ "$(field_from_route "$(route_get "$ip")" interface)" == "$physical_if" ]] || continue
    /usr/bin/nc -z -G 3 -w 3 "$ip" 53 >/dev/null 2>&1 && return 0
  done
  return 1
}

intranet_backend_reachable() {
  local ip
  if fixture_mode_enabled; then
    [[ "$(read_fixture intranet-backend-reachable.txt 2>/dev/null || print 1)" == 1 ]]
    return
  fi
  for ip in $VERIFY_IPS; do
    /usr/bin/nc -z -G 3 -w 3 "$ip" 443 >/dev/null 2>&1 && return 0
  done
  return 1
}

network_signature() {
  local physical_if="$1"
  local physical_gw="$2"
  local mobile_if="$3"
  print -rn -- "${physical_if}|${physical_gw}|${mobile_if}" | /usr/bin/shasum -a 256 | /usr/bin/awk '{ print $1 }'
}

print_probe_result() {
  local console_user physical_record physical_if="" physical_gw="" mobile_if signature
  console_user="$(detect_console_user)"
  physical_record="$(probe_physical_route)"

  if [[ -n "$physical_record" ]]; then
    physical_if="${physical_record%%|*}"
    physical_gw="${physical_record#*|}"
  fi

  mobile_if="$(probe_mobile_interface "$console_user")"
  signature="$(network_signature "$physical_if" "$physical_gw" "$mobile_if")"

  print -r -- "console_user=${console_user}"
  print -r -- "physical_if=${physical_if}"
  print -r -- "physical_gw=${physical_gw}"
  print -r -- "mobile_if=${mobile_if}"
  print -r -- "network_signature=${signature}"
}

if [[ "${1:-}" == --print ]]; then
  print_probe_result
fi
