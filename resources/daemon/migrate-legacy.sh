#!/bin/zsh
set -u

typeset -gr MIGRATE_SCRIPT_PATH="${(%):-%N}"
typeset -gr MIGRATE_DIR="${MIGRATE_SCRIPT_PATH:A:h}"
source "${MIGRATE_DIR}/lib/common.sh"

typeset -gr LEGACY_LABEL="com.openai.baidu-mobile-dual-vpn"
typeset -gr LEGACY_PLIST="/Library/LaunchDaemons/${LEGACY_LABEL}.plist"
typeset -gr LEGACY_ROOT="/usr/local/libexec/baidu-mobile-dual-vpn"
typeset -gr LEGACY_STATE_ROOT="/var/db/baidu-mobile-dual-vpn"
typeset -gr LEGACY_ROUTE_STATE="/var/run/${LEGACY_LABEL}.state"
typeset -gr LEGACY_DNS_KEY="State:/Network/Service/baidu-mobile-dual-vpn-dns/DNS"
typeset -g LEGACY_MIGRATION_PRESENT=false
typeset -g LEGACY_MIGRATION_WAS_LOADED=false

legacy_route_output_is_exact() {
  local kind="$1" target="$2" output="$3" destination mask flags
  destination="$(field_from_route "$output" destination)"
  mask="$(field_from_route "$output" mask)"
  flags="$(field_from_route "$output" flags)"
  case "${kind}|${target}" in
    'net|10.0.0.0/9') [[ "$destination" == 10.0.0.0 && ( "$mask" == 255.128.0.0 || "$mask" == 0xff800000 ) ]] ;;
    'net|10.128.0.0/9') [[ "$destination" == 10.128.0.0 && ( "$mask" == 255.128.0.0 || "$mask" == 0xff800000 ) ]] ;;
    host\|*) [[ "$destination" == "$target" && "$flags" == *HOST* ]] ;;
    *) return 1 ;;
  esac
}

legacy_snapshot_for_target() {
  case "$1" in
    10.0.0.0/9) print -r -- "${LEGACY_STATE_ROOT}/routes/net-10-0-0-0-9.route" ;;
    10.128.0.0/9) print -r -- "${LEGACY_STATE_ROOT}/routes/net-10-128-0-0-9.route" ;;
    10.57.0.96) print -r -- "${LEGACY_STATE_ROOT}/routes/dns-10-57-0-96.route" ;;
    10.57.0.196) print -r -- "${LEGACY_STATE_ROOT}/routes/dns-10-57-0-196.route" ;;
    *) return 1 ;;
  esac
}

legacy_restore_route() {
  local kind="$1" target="$2" snapshot="$3"
  [[ -s "$snapshot" ]] || return 0
  local output original_if original_gw original_flags
  output="$(<"$snapshot")"
  [[ "$output" == *"route to:"* ]] || return 0
  legacy_route_output_is_exact "$kind" "$target" "$output" || return 0
  original_if="$(field_from_route "$output" interface)"
  original_gw="$(field_from_route "$output" gateway)"
  original_flags="$(field_from_route "$output" flags)"
  [[ -z "$original_if" || "$original_if" == [a-zA-Z][a-zA-Z0-9]## ]] || return 1
  [[ -z "$original_gw" || "$original_gw" == <->.<->.<->.<-> ]] || return 1
  if [[ "$original_flags" == *GATEWAY* && -n "$original_gw" ]]; then
    /sbin/route -n add "-${kind}" "$target" "$original_gw" >/dev/null 2>&1
  elif [[ -n "$original_if" ]]; then
    /sbin/route -n add "-${kind}" "$target" -interface "$original_if" >/dev/null 2>&1
  fi
}

legacy_current_route_matches() {
  local kind="$1" target="$2" expected_if="$3" expected_gw="$4" output flags
  if fixture_mode_enabled; then
    output="$(read_fixture legacy-current-route.txt 2>/dev/null || true)"
  else
    output="$(route_get "$target")"
  fi
  legacy_route_output_is_exact "$kind" "$target" "$output" || return 1
  [[ "$(field_from_route "$output" interface)" == "$expected_if" ]] || return 1
  [[ -z "$expected_gw" || "$(field_from_route "$output" gateway)" == "$expected_gw" ]] || return 1
  flags="$(field_from_route "$output" flags)"
  [[ "$kind" != host || "$flags" != *GATEWAY* ]]
}

legacy_route_matches_snapshot() {
  local kind="$1" target="$2" snapshot="$3"
  local current
  current="$(route_get "$target")"
  if [[ ! -s "$snapshot" ]] || ! legacy_route_output_is_exact "$kind" "$target" "$(<"$snapshot")"; then
    ! legacy_route_output_is_exact "$kind" "$target" "$current"
    return
  fi
  local expected field expected_value
  expected="$(<"$snapshot")"
  [[ "$expected" == *"route to:"* ]] || return 0
  current="$(route_get "$target")"
  for field in interface gateway destination mask; do
    expected_value="$(field_from_route "$expected" "$field")"
    [[ -z "$expected_value" || "$(field_from_route "$current" "$field")" == "$expected_value" ]] || return 1
  done
}

legacy_restore_routes() {
  local old_if="" old_gw="" old_mobile=""
  if [[ -r "$LEGACY_ROUTE_STATE" ]]; then
    IFS='|' read -r old_if old_gw old_mobile < "$LEGACY_ROUTE_STATE"
  fi
  local kind target expected_if expected_gw snapshot failed=0
  for target in $RECLAIM_NETS $MOBILE_DNS_IPS; do
    if [[ "$target" == 10.*.*.*/9 ]]; then
      kind=net; expected_if="$old_if"; expected_gw="$old_gw"
    else
      kind=host; expected_if="$old_mobile"; expected_gw=""
    fi
    snapshot="$(legacy_snapshot_for_target "$target")" || return 1
    local current_output
    current_output="$(route_get "$target")"
    if [[ -n "$expected_if" ]] && legacy_current_route_matches "$kind" "$target" "$expected_if" "$expected_gw"; then
      /sbin/route -n delete "-${kind}" "$target" >/dev/null 2>&1 || { failed=1; continue; }
      if ! legacy_restore_route "$kind" "$target" "$snapshot" || ! legacy_route_matches_snapshot "$kind" "$target" "$snapshot"; then
        failed=1
      fi
    elif legacy_route_output_is_exact "$kind" "$target" "$current_output"; then
      safe_log error "legacy route ownership cannot be proven for ${target}; manual cleanup required"
      failed=1
    else
      safe_log info "no exact legacy route remains for ${target}"
    fi
  done
  (( failed == 0 ))
}

legacy_dns_is_owned() {
  local current
  current="$(/usr/sbin/scutil <<<"show ${LEGACY_DNS_KEY}" 2>/dev/null || true)"
  [[ "$current" == *"172.31.5.60"* && "$current" == *"172.31.6.60"* && "$current" == *"baidu.com"* ]]
}

legacy_restore_dns() {
  legacy_dns_is_owned || {
    if /usr/sbin/scutil <<<"show ${LEGACY_DNS_KEY}" 2>/dev/null | /usr/bin/grep -q ServerAddresses; then
      safe_log error "legacy DNS ownership cannot be proven; manual cleanup required"
      return 1
    fi
    safe_log info "no legacy DNS resolver remains"
    return 0
  }
  local preexisting=0 contents="${LEGACY_STATE_ROOT}/dns/contents"
  [[ -r "${LEGACY_STATE_ROOT}/dns/preexisting" ]] && preexisting="$(<"${LEGACY_STATE_ROOT}/dns/preexisting")"
  if [[ "$preexisting" == 1 && -s "$contents" ]]; then
    local servers domains orders
    servers="$(/usr/bin/awk '/ServerAddresses/{on=1; next} on && /^[[:space:]]*[0-9]+ :/{print $3} on && /^[^[:space:]]/{on=0}' "$contents" | /usr/bin/paste -sd ' ' -)"
    domains="$(/usr/bin/awk '/SupplementalMatchDomains/{on=1; next} on && /^[[:space:]]*[0-9]+ :/{print $3} on && /^[^[:space:]]/{on=0}' "$contents" | /usr/bin/paste -sd ' ' -)"
    orders="$(/usr/bin/awk '/SupplementalMatchOrders/{on=1; next} on && /^[[:space:]]*[0-9]+ :/{print $3} on && /^[^[:space:]]/{on=0}' "$contents" | /usr/bin/paste -sd ' ' -)"
    [[ -n "$servers" ]] || return 1
    /usr/sbin/scutil <<EOF >/dev/null || return 1
d.init
d.add ServerAddresses * ${servers}
${${#domains}:+d.add SupplementalMatchDomains * ${domains}}
${${#orders}:+d.add SupplementalMatchOrders * ${orders}}
set ${LEGACY_DNS_KEY}
quit
EOF
    local restored
    restored="$(/usr/sbin/scutil <<<"show ${LEGACY_DNS_KEY}" 2>/dev/null || true)"
    local value
    for value in ${(z)servers} ${(z)domains} ${(z)orders}; do
      [[ -z "$value" ]] || print -r -- "$restored" | /usr/bin/grep -Fq "$value" || return 1
    done
  else
    /usr/sbin/scutil <<<"remove ${LEGACY_DNS_KEY}" >/dev/null 2>&1 || return 1
    /usr/sbin/scutil <<<"show ${LEGACY_DNS_KEY}" 2>/dev/null | /usr/bin/grep -q ServerAddresses && return 1
  fi
  /usr/bin/dscacheutil -flushcache >/dev/null 2>&1 || true
  /usr/bin/killall -HUP mDNSResponder >/dev/null 2>&1 || true
}

remove_legacy_files() {
  /bin/rm -f "$LEGACY_PLIST" "$LEGACY_ROUTE_STATE" || return 1
  /bin/rm -rf "$LEGACY_ROOT" "$LEGACY_STATE_ROOT" || return 1
}

backup_legacy_assets() {
  local backup_dir="$1"
  /usr/bin/install -d -o root -g wheel -m 0700 "$backup_dir" || return 1
  if [[ -f "$LEGACY_PLIST" ]]; then
    /bin/cp -p "$LEGACY_PLIST" "${backup_dir}/service.plist" || return 1
    /usr/bin/touch "${backup_dir}/had-plist" || return 1
  fi
  if [[ -d "$LEGACY_ROOT" ]]; then
    /bin/cp -Rp "$LEGACY_ROOT" "${backup_dir}/legacy-root" || return 1
    /usr/bin/touch "${backup_dir}/had-root" || return 1
  fi
  if [[ -d "$LEGACY_STATE_ROOT" ]]; then
    /bin/cp -Rp "$LEGACY_STATE_ROOT" "${backup_dir}/legacy-state" || return 1
    /usr/bin/touch "${backup_dir}/had-state" || return 1
  fi
  if [[ -f "$LEGACY_ROUTE_STATE" ]]; then
    /bin/cp -p "$LEGACY_ROUTE_STATE" "${backup_dir}/route-state" || return 1
    /usr/bin/touch "${backup_dir}/had-route-state" || return 1
  fi
}

restore_legacy_assets() {
  local backup_dir="$1"
  [[ -d "$backup_dir" ]] || return 1
  [[ ! -e "${backup_dir}/had-plist" ]] || /bin/cp -p "${backup_dir}/service.plist" "$LEGACY_PLIST" || return 1
  if [[ -e "${backup_dir}/had-root" ]]; then
    /bin/rm -rf "$LEGACY_ROOT" || return 1
    /bin/cp -Rp "${backup_dir}/legacy-root" "$LEGACY_ROOT" || return 1
  fi
  if [[ -e "${backup_dir}/had-state" ]]; then
    /bin/rm -rf "$LEGACY_STATE_ROOT" || return 1
    /bin/cp -Rp "${backup_dir}/legacy-state" "$LEGACY_STATE_ROOT" || return 1
  fi
  [[ ! -e "${backup_dir}/had-route-state" ]] || /bin/cp -p "${backup_dir}/route-state" "$LEGACY_ROUTE_STATE" || return 1
}

legacy_file_is_root_trusted() {
  local path="$1" mode
  [[ -f "$path" && ! -L "$path" ]] || return 1
  [[ "$(/usr/bin/stat -f '%u' "$path" 2>/dev/null)" == 0 ]] || return 1
  mode="$(/usr/bin/stat -f '%OLp' "$path" 2>/dev/null)"
  [[ "$mode" == <-> ]] || return 1
  (( (8#$mode & 8#022) == 0 ))
}

restart_legacy_service() {
  legacy_file_is_root_trusted "$LEGACY_PLIST" || return 1
  legacy_file_is_root_trusted "${LEGACY_ROOT}/reclaim-routes.sh" || return 1
  [[ ! -e "${LEGACY_ROOT}/fix-intranet-dns.sh" ]] || legacy_file_is_root_trusted "${LEGACY_ROOT}/fix-intranet-dns.sh" || return 1
  [[ "$(/usr/bin/plutil -extract Label raw -o - "$LEGACY_PLIST" 2>/dev/null)" == "$LEGACY_LABEL" ]] || return 1
  [[ "$(/usr/bin/plutil -extract ProgramArguments.0 raw -o - "$LEGACY_PLIST" 2>/dev/null)" == /bin/zsh ]] || return 1
  [[ "$(/usr/bin/plutil -extract ProgramArguments.1 raw -o - "$LEGACY_PLIST" 2>/dev/null)" == "${LEGACY_ROOT}/reclaim-routes.sh" ]] || return 1
  [[ "$(/usr/bin/plutil -extract ProgramArguments.2 raw -o - "$LEGACY_PLIST" 2>/dev/null)" == auto ]] || return 1
  /bin/launchctl bootstrap system "$LEGACY_PLIST" >/dev/null 2>&1 || return 1
  /bin/launchctl print "system/${LEGACY_LABEL}" >/dev/null 2>&1
}

rollback_legacy_migration() {
  local backup_dir="$1"
  [[ "$LEGACY_MIGRATION_PRESENT" == true ]] || return 0
  if fixture_mode_enabled; then
    print -r -- "operation=legacy-restart-service"
    return 0
  fi
  restore_legacy_assets "$backup_dir" || return 1
  [[ "$LEGACY_MIGRATION_WAS_LOADED" == true ]] || return 0
  /bin/launchctl bootout "system/${LEGACY_LABEL}" >/dev/null 2>&1 || true
  restart_legacy_service
}

prepare_legacy_migration() {
  local backup_dir="$1"
  if fixture_mode_enabled; then
    LEGACY_MIGRATION_PRESENT=true
    LEGACY_MIGRATION_WAS_LOADED=true
    print -r -- "operation=legacy-cleanup-bundled"
    print -r -- "operation=legacy-bootout"
    print -r -- "operation=legacy-restore-network"
    if [[ "$(read_fixture fail-step.txt 2>/dev/null || true)" == legacy-restore ]]; then
      rollback_legacy_migration "$backup_dir"
      return 1
    fi
    return 0
  fi

  [[ -e "$LEGACY_PLIST" || -d "$LEGACY_ROOT" || -d "$LEGACY_STATE_ROOT" ]] || return 0
  LEGACY_MIGRATION_PRESENT=true
  /bin/launchctl print "system/${LEGACY_LABEL}" >/dev/null 2>&1 && LEGACY_MIGRATION_WAS_LOADED=true
  backup_legacy_assets "$backup_dir" || return 1
  if [[ "$LEGACY_MIGRATION_WAS_LOADED" == true ]]; then
    if ! /bin/launchctl bootout "system/${LEGACY_LABEL}" >/dev/null 2>&1; then
      rollback_legacy_migration "$backup_dir" || true
      return 1
    fi
  fi
  if ! legacy_restore_routes || ! legacy_restore_dns; then
    rollback_legacy_migration "$backup_dir" || safe_log error "legacy service rollback failed"
    return 1
  fi
}

commit_legacy_migration() {
  [[ "$LEGACY_MIGRATION_PRESENT" == true ]] || return 0
  if fixture_mode_enabled; then
    print -r -- "operation=legacy-remove-files"
    return 0
  fi
  remove_legacy_files || return 1
  safe_log info "legacy Skill service removed with built-in compatibility cleanup"
}

migrate_legacy_service() {
  local backup_dir="${1:-${STATE_ROOT}/legacy-migration-backup}"
  prepare_legacy_migration "$backup_dir" || return 1
  commit_legacy_migration
}

if [[ "${ZSH_EVAL_CONTEXT:-}" == toplevel ]]; then
  case "${1:-}" in
    --test-plan)
      migrate_legacy_service
      ;;
    --test-current-route-match)
      legacy_current_route_matches "${2:-}" "${3:-}" "${4:-}" "${5:-}"
      exit $?
      ;;
  esac
fi
