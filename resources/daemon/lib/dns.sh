#!/bin/zsh
set -u

typeset -gr DNS_SCRIPT_PATH="${(%):-%N}"
typeset -gr DNS_SCRIPT_DIR="${DNS_SCRIPT_PATH:A:h}"
source "${DNS_SCRIPT_DIR}/common.sh"

typeset -gr DNS_SERVICE_KEY="dual-vpn-routing-assistant-dns"
typeset -gr DNS_STATE_KEY="State:/Network/Service/${DNS_SERVICE_KEY}/DNS"
typeset -gr DNS_SNAPSHOT_DIR="${STATE_ROOT}/dns"
typeset -gr DNS_OWNERSHIP_FILE="${STATE_ROOT}/managed-dns"
typeset -gr DNS_PENDING_FILE="${STATE_ROOT}/managed-dns.pending"
typeset -g TEST_DNS_OWNED=false
typeset -g TEST_DNS_PENDING=false
typeset -gi TEST_DNS_RESTORE_ATTEMPTS=0

dns_fixture_fails() {
  local step="$1"
  fixture_mode_enabled || return 1
  read_fixture dns-fail-step.txt 2>/dev/null | /usr/bin/grep -Fxq "$step"
}

dns_pending_present() {
  if fixture_mode_enabled; then
    [[ "$TEST_DNS_PENDING" == true || "$(read_fixture dns-pending.txt 2>/dev/null || true)" == 1 ]]
    return
  fi
  [[ -r "$DNS_PENDING_FILE" ]]
}

snapshot_dns() {
  fixture_mode_enabled && return 0
  [[ -e "${DNS_SNAPSHOT_DIR}/complete" ]] && return 0
  /usr/bin/install -d -o root -g wheel -m 0700 "$DNS_SNAPSHOT_DIR" || return 1
  if /usr/sbin/scutil <<<"show ${DNS_STATE_KEY}" 2>/dev/null | /usr/bin/grep -q ServerAddresses; then
    /usr/sbin/scutil <<<"show ${DNS_STATE_KEY}" >| "${DNS_SNAPSHOT_DIR}/owned.scutil" || return 1
    /usr/bin/touch "${DNS_SNAPSHOT_DIR}/owned-existed" || return 1
  fi
  /usr/bin/touch "${DNS_SNAPSHOT_DIR}/complete" || return 1
}

set_owned_dns() {
  if fixture_mode_enabled; then
    print -r -- "operation=dns-set|${DNS_STATE_KEY}|${(j:,:)OFFICE_DNS_IPS}|${(j:,:)MATCH_DOMAINS}"
    dns_fixture_fails dns-set && return 1
    return 0
  fi

  /usr/sbin/scutil <<EOF >/dev/null
d.init
d.add ServerAddresses * ${OFFICE_DNS_IPS[1]} ${OFFICE_DNS_IPS[2]}
d.add SupplementalMatchDomains * ${MATCH_DOMAINS[1]} ${MATCH_DOMAINS[2]} ${MATCH_DOMAINS[3]}
d.add SupplementalMatchOrders * 101001 101002 101003
set ${DNS_STATE_KEY}
EOF
  /usr/bin/dscacheutil -flushcache >/dev/null 2>&1 || true
  /usr/bin/killall -HUP mDNSResponder >/dev/null 2>&1 || true
}

remove_owned_dns() {
  if fixture_mode_enabled; then
    print -r -- "operation=dns-remove|${DNS_STATE_KEY}"
    return 0
  fi
  /usr/sbin/scutil <<<"remove ${DNS_STATE_KEY}" >/dev/null 2>&1 || return 1
  /usr/bin/dscacheutil -flushcache >/dev/null 2>&1 || true
  /usr/bin/killall -HUP mDNSResponder >/dev/null 2>&1 || true
}

verify_supplemental_dns() {
  if fixture_mode_enabled; then
    dns_fixture_fails dns-verify && return 1
    return 0
  fi
  local current value
  current="$(/usr/sbin/scutil <<<"show ${DNS_STATE_KEY}" 2>/dev/null || true)"
  for value in $OFFICE_DNS_IPS $MATCH_DOMAINS; do
    print -r -- "$current" | /usr/bin/grep -Fq "$value" || return 1
  done
}

restore_owned_dns_snapshot() {
  remove_owned_dns || return 1
  if fixture_mode_enabled; then
    (( TEST_DNS_RESTORE_ATTEMPTS += 1 ))
    print -r -- "dns_restore_attempt=${TEST_DNS_RESTORE_ATTEMPTS}"
    local fail_count
    fail_count="$(read_fixture fail-dns-restore-count.txt 2>/dev/null || print 0)"
    (( TEST_DNS_RESTORE_ATTEMPTS <= fail_count )) && return 1
    return 0
  fi
  [[ -e "${DNS_SNAPSHOT_DIR}/owned-existed" && -s "${DNS_SNAPSHOT_DIR}/owned.scutil" ]] || return 0

  local snapshot servers domains orders line section=""
  typeset -a servers=() domains=() orders=()
  snapshot="$(<"${DNS_SNAPSHOT_DIR}/owned.scutil")"
  while IFS= read -r line; do
    [[ "$line" == *"ServerAddresses :"* ]] && { section=servers; continue; }
    [[ "$line" == *"SupplementalMatchDomains :"* ]] && { section=domains; continue; }
    [[ "$line" == *"SupplementalMatchOrders :"* ]] && { section=orders; continue; }
    [[ "$line" == *" : <array>"* ]] && { section=""; continue; }
    if [[ "$line" =~ '^[[:space:]]+[0-9]+[[:space:]]+:[[:space:]]+(.+)$' ]]; then
      [[ "$section" == servers ]] && servers+=("${match[1]}")
      [[ "$section" == domains ]] && domains+=("${match[1]}")
      [[ "$section" == orders ]] && orders+=("${match[1]}")
    fi
  done <<<"$snapshot"

  (( ${#servers} > 0 )) || return 0
  /usr/sbin/scutil <<EOF >/dev/null
d.init
d.add ServerAddresses * ${servers[@]}
${${#domains}:+d.add SupplementalMatchDomains * ${domains[@]}}
${${#orders}:+d.add SupplementalMatchOrders * ${orders[@]}}
set ${DNS_STATE_KEY}
EOF
}

verify_dns_snapshot_restored() {
  fixture_mode_enabled && return 0
  local restored
  restored="$(/usr/sbin/scutil <<<"show ${DNS_STATE_KEY}" 2>/dev/null || true)"
  if [[ -e "${DNS_SNAPSHOT_DIR}/owned-existed" ]]; then
    [[ "$restored" == "$(<"${DNS_SNAPSHOT_DIR}/owned.scutil")" ]]
  else
    ! print -r -- "$restored" | /usr/bin/grep -q ServerAddresses
  fi
}

clear_dns_ownership_markers() {
  if fixture_mode_enabled; then
    TEST_DNS_OWNED=false
    TEST_DNS_PENDING=false
    return 0
  fi
  /bin/rm -f "$DNS_OWNERSHIP_FILE" "$DNS_PENDING_FILE"
}

restore_and_clear_dns_journal() {
  restore_owned_dns_snapshot || return 1
  verify_dns_snapshot_restored || return 1
  clear_dns_ownership_markers
}

family_baidu_resolves_intranet() {
  if fixture_mode_enabled; then
    [[ "$(read_fixture family-baidu-resolves-intranet.txt 2>/dev/null || print 1)" == 1 ]]
    return
  fi
  /usr/bin/dscacheutil -q host -a name family.baidu.com 2>/dev/null | \
    /usr/bin/awk '/ip_address/ { print $2 }' | /usr/bin/grep -q '^10\.11\.'
}

apply_supplemental_dns() {
  if dns_pending_present; then
    safe_log warn "DNS apply refused while snapshot restoration is pending"
    return 1
  fi
  snapshot_dns || return 1
  if ! fixture_mode_enabled && [[ -e "${DNS_SNAPSHOT_DIR}/owned-existed" && ! -e "$DNS_OWNERSHIP_FILE" && ! -e "$DNS_PENDING_FILE" ]]; then
    safe_log error "refusing to replace a preexisting supplemental DNS key"
    return 1
  fi
  if ! fixture_mode_enabled; then
    local pending_temp="${DNS_PENDING_FILE}.tmp.$$"
    /usr/bin/printf '%s\n' "$DNS_STATE_KEY" >| "$pending_temp" || return 1
    /usr/sbin/chown root:wheel "$pending_temp" || return 1
    /bin/chmod 0600 "$pending_temp" || return 1
    /bin/mv -f "$pending_temp" "$DNS_PENDING_FILE" || return 1
  else
    TEST_DNS_PENDING=true
  fi
  if ! set_owned_dns; then
    restore_and_clear_dns_journal || true
    return 1
  fi
  if ! verify_supplemental_dns || ! family_baidu_resolves_intranet; then
    restore_and_clear_dns_journal || true
    return 1
  fi
  if fixture_mode_enabled; then
    if dns_fixture_fails dns-ownership; then
      restore_and_clear_dns_journal || true
      return 1
    fi
    TEST_DNS_OWNED=true
    TEST_DNS_PENDING=false
  else
    local temp_file="${DNS_OWNERSHIP_FILE}.tmp.$$"
    if ! /usr/sbin/scutil <<<"show ${DNS_STATE_KEY}" >| "$temp_file" || \
       ! /usr/sbin/chown root:wheel "$temp_file" || \
       ! /bin/chmod 0600 "$temp_file" || \
       ! /bin/mv -f "$temp_file" "$DNS_OWNERSHIP_FILE"; then
      /bin/rm -f "$temp_file"
      restore_and_clear_dns_journal || true
      return 1
    fi
    /bin/rm -f "$DNS_PENDING_FILE" || return 1
  fi
}

revert_supplemental_dns() {
  if fixture_mode_enabled; then
    if dns_pending_present; then
      TEST_DNS_PENDING=true
      restore_and_clear_dns_journal
      return $?
    fi
    [[ "$TEST_DNS_OWNED" == true ]] || return 0
  else
    [[ -r "$DNS_OWNERSHIP_FILE" || -r "$DNS_PENDING_FILE" ]] || return 0
    if [[ -r "$DNS_PENDING_FILE" ]]; then
      restore_and_clear_dns_journal
      return $?
    fi
    local current_owned_dns
    current_owned_dns="$(/usr/sbin/scutil <<<"show ${DNS_STATE_KEY}" 2>/dev/null || true)"
    if [[ -r "$DNS_OWNERSHIP_FILE" && "$current_owned_dns" != "$(<"$DNS_OWNERSHIP_FILE")" ]]; then
      safe_log info "DNS ownership lost; resolver left unchanged"
      /bin/rm -f "$DNS_OWNERSHIP_FILE"
      return 0
    fi
  fi
  if ! verify_supplemental_dns; then
    safe_log info "DNS ownership lost; resolver left unchanged"
    fixture_mode_enabled || /bin/rm -f "$DNS_OWNERSHIP_FILE"
    TEST_DNS_OWNED=false
    return 0
  fi
  if ! restore_and_clear_dns_journal; then
    safe_log error "DNS cleanup verification failed"
    return 1
  fi
}

print_preserved_test_dns() {
  local key
  while IFS= read -r key; do
    [[ -n "$key" ]] && print -r -- "preserved_dns=${key}"
  done < "$(fixture_path existing-dns-keys.txt)"
}

case "${1:-}" in
  --test-apply)
    apply_supplemental_dns
    ;;
  --test-sequence)
    print_preserved_test_dns
    apply_supplemental_dns
    revert_supplemental_dns
    ;;
  --test-failure-restart)
    apply_supplemental_dns || true
    print -r -- "pending_after_apply=${TEST_DNS_PENDING}"
    revert_supplemental_dns || exit 1
    print -r -- "pending_after_restart=${TEST_DNS_PENDING}"
    ;;
esac
