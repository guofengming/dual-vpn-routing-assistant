#!/bin/zsh
set -u

typeset -gr ROUTES_SCRIPT_PATH="${(%):-%N}"
typeset -gr ROUTES_SCRIPT_DIR="${ROUTES_SCRIPT_PATH:A:h}"
source "${ROUTES_SCRIPT_DIR}/common.sh"

typeset -gr ROUTE_SNAPSHOT_DIR="${STATE_ROOT}/routes"
typeset -gr ROUTE_TRANSACTION_DIR="${RUN_ROOT}/route-transaction"
typeset -gr ROUTE_OWNERSHIP_FILE="${STATE_ROOT}/managed-routes"
typeset -gr ROUTE_PENDING_FILE="${STATE_ROOT}/managed-routes.pending"
typeset -gr ROUTE_RESTORE_PENDING_FILE="${STATE_ROOT}/managed-routes.restoring"
typeset -gr ROUTE_OWNED_SNAPSHOT_DIR="${STATE_ROOT}/managed-route-snapshots"
typeset -ga ROUTE_TRANSACTION_LEDGER=()
typeset -ga ROUTE_TRANSACTION_OWNERSHIP=()
typeset -ga ROUTE_MUTATION_PLAN=()
typeset -ga TEST_MANAGED_ROUTES=()
typeset -ga TEST_RESTORE_PENDING=()
typeset -gi TEST_OPERATION_COUNT=0

route_snapshot_name() {
  print -r -- "$1" | /usr/bin/tr './:' '---'
}

capture_effective_route() {
  local kind="$1" target="$2"
  fixture_mode_enabled && { print -r -- "snapshot=${target}"; return 0; }
  /bin/mkdir -p "$ROUTE_TRANSACTION_DIR" || return 1
  local snapshot_file="${ROUTE_TRANSACTION_DIR}/$(route_snapshot_name "$target").route"
  route_get "$target" >| "$snapshot_file" || return 1
  if route_output_is_exact "$kind" "$target" "$(<"$snapshot_file")"; then
    print -r -- EXACT >| "${snapshot_file%.route}.state" || return 1
  else
    print -r -- ABSENT >| "${snapshot_file%.route}.state" || return 1
  fi
}

route_target_allowed() {
  local kind="$1" target="$2" candidate
  case "$kind" in
    net)
      for candidate in $RECLAIM_NETS; do [[ "$target" == "$candidate" ]] && return 0; done
      ;;
    host)
      for candidate in $MOBILE_DNS_IPS; do [[ "$target" == "$candidate" ]] && return 0; done
      ;;
  esac
  return 1
}

route_output_is_exact() {
  local kind="$1" target="$2" output="$3" destination mask flags
  destination="$(field_from_route "$output" destination)"
  mask="$(field_from_route "$output" mask)"
  flags="$(field_from_route "$output" flags)"
  case "${kind}|${target}" in
    'net|10.0.0.0/9')
      [[ "$destination" == 10.0.0.0 && ( "$mask" == 255.128.0.0 || "$mask" == 0xff800000 ) ]]
      ;;
    'net|10.128.0.0/9')
      [[ "$destination" == 10.128.0.0 && ( "$mask" == 255.128.0.0 || "$mask" == 0xff800000 ) ]]
      ;;
    host\|*)
      [[ "$destination" == "$target" && "$flags" == *HOST* ]]
      ;;
    *) return 1 ;;
  esac
}

owned_routes_source() {
  if fixture_mode_enabled; then
    read_fixture managed-routes.txt 2>/dev/null || true
  elif [[ -r "$ROUTE_OWNERSHIP_FILE" ]]; then
    /bin/cat "$ROUTE_OWNERSHIP_FILE"
  fi
  if ! fixture_mode_enabled && [[ -r "$ROUTE_PENDING_FILE" ]]; then
    /bin/cat "$ROUTE_PENDING_FILE"
  fi
}

restore_pending_routes_source() {
  if fixture_mode_enabled; then
    read_fixture restoring-routes.txt 2>/dev/null || true
    local entry
    for entry in $TEST_RESTORE_PENDING; do
      print -r -- "$entry"
    done
  elif [[ -r "$ROUTE_RESTORE_PENDING_FILE" ]]; then
    /bin/cat "$ROUTE_RESTORE_PENDING_FILE"
  fi
}

route_restore_is_pending() {
  local kind="$1" target="$2" entry_kind entry_target ignored_if ignored_gw
  while IFS='|' read -r entry_kind entry_target ignored_if ignored_gw; do
    [[ "$entry_kind" == "$kind" && "$entry_target" == "$target" ]] && return 0
  done < <(restore_pending_routes_source)
  return 1
}

route_restore_pending_present() {
  if fixture_mode_enabled; then
    [[ -n "$(restore_pending_routes_source)" ]]
    return
  fi
  [[ -s "$ROUTE_RESTORE_PENDING_FILE" ]]
}

record_route_restore_pending() {
  local entry="$1" kind target ignored_if ignored_gw existing
  IFS='|' read -r kind target ignored_if ignored_gw <<<"$entry"
  route_restore_is_pending "$kind" "$target" && return 0
  if fixture_mode_enabled; then
    TEST_RESTORE_PENDING+=("$entry")
    print -r -- "restore_pending=${kind}|${target}"
    return 0
  fi

  local temp_file="${ROUTE_RESTORE_PENDING_FILE}.tmp.$$"
  [[ -r "$ROUTE_RESTORE_PENDING_FILE" ]] && /bin/cp "$ROUTE_RESTORE_PENDING_FILE" "$temp_file" || : >| "$temp_file"
  print -r -- "$entry" >> "$temp_file" || return 1
  /usr/sbin/chown root:wheel "$temp_file" || return 1
  /bin/chmod 0600 "$temp_file" || return 1
  /bin/mv -f "$temp_file" "$ROUTE_RESTORE_PENDING_FILE"
}

clear_route_restore_pending() {
  local kind="$1" target="$2" entry entry_kind entry_target ignored_if ignored_gw
  if fixture_mode_enabled; then
    local -a retained=()
    for entry in $TEST_RESTORE_PENDING; do
      IFS='|' read -r entry_kind entry_target ignored_if ignored_gw <<<"$entry"
      [[ "$entry_kind" == "$kind" && "$entry_target" == "$target" ]] || retained+=("$entry")
    done
    TEST_RESTORE_PENDING=("${retained[@]}")
    return 0
  fi
  [[ -r "$ROUTE_RESTORE_PENDING_FILE" ]] || return 0
  local temp_file="${ROUTE_RESTORE_PENDING_FILE}.tmp.$$"
  : >| "$temp_file" || return 1
  while IFS= read -r entry; do
    IFS='|' read -r entry_kind entry_target ignored_if ignored_gw <<<"$entry"
    [[ "$entry_kind" == "$kind" && "$entry_target" == "$target" ]] || print -r -- "$entry" >> "$temp_file"
  done < "$ROUTE_RESTORE_PENDING_FILE"
  /usr/sbin/chown root:wheel "$temp_file" || return 1
  /bin/chmod 0600 "$temp_file" || return 1
  /bin/mv -f "$temp_file" "$ROUTE_RESTORE_PENDING_FILE"
}

record_pending_route_ownership() {
  local entry="$1" target="$2"
  fixture_mode_enabled && return 0
  /usr/bin/install -d -o root -g wheel -m 0700 "$ROUTE_OWNED_SNAPSHOT_DIR" || return 1
  local snapshot_name="$(route_snapshot_name "$target").route"
  /bin/cp "${ROUTE_TRANSACTION_DIR}/${snapshot_name}" "${ROUTE_OWNED_SNAPSHOT_DIR}/${snapshot_name}.tmp.$$" || return 1
  /usr/sbin/chown root:wheel "${ROUTE_OWNED_SNAPSHOT_DIR}/${snapshot_name}.tmp.$$" || return 1
  /bin/chmod 0600 "${ROUTE_OWNED_SNAPSHOT_DIR}/${snapshot_name}.tmp.$$" || return 1
  /bin/mv -f "${ROUTE_OWNED_SNAPSHOT_DIR}/${snapshot_name}.tmp.$$" "${ROUTE_OWNED_SNAPSHOT_DIR}/${snapshot_name}" || return 1
  /bin/cp "${ROUTE_TRANSACTION_DIR}/${snapshot_name%.route}.state" "${ROUTE_OWNED_SNAPSHOT_DIR}/${snapshot_name%.route}.state.tmp.$$" || return 1
  /usr/sbin/chown root:wheel "${ROUTE_OWNED_SNAPSHOT_DIR}/${snapshot_name%.route}.state.tmp.$$" || return 1
  /bin/chmod 0600 "${ROUTE_OWNED_SNAPSHOT_DIR}/${snapshot_name%.route}.state.tmp.$$" || return 1
  /bin/mv -f "${ROUTE_OWNED_SNAPSHOT_DIR}/${snapshot_name%.route}.state.tmp.$$" "${ROUTE_OWNED_SNAPSHOT_DIR}/${snapshot_name%.route}.state" || return 1
  local temp_file="${ROUTE_PENDING_FILE}.tmp.$$"
  [[ -r "$ROUTE_PENDING_FILE" ]] && /bin/cp "$ROUTE_PENDING_FILE" "$temp_file" || : >| "$temp_file"
  print -r -- "$entry" >> "$temp_file" || return 1
  /usr/sbin/chown root:wheel "$temp_file" || return 1
  /bin/chmod 0600 "$temp_file" || return 1
  /bin/mv -f "$temp_file" "$ROUTE_PENDING_FILE"
}

clear_pending_route_ownership() {
  fixture_mode_enabled || /bin/rm -f "$ROUTE_PENDING_FILE"
}

fixture_route_record() {
  local target="$1"
  read_fixture route-state.txt 2>/dev/null | /usr/bin/awk -F '|' -v target="$target" '$1 == target { print; exit }'
}

snapshot_routes() {
  fixture_mode_enabled && return 0
  [[ -e "${ROUTE_SNAPSHOT_DIR}/complete" ]] && return 0
  /usr/bin/install -d -o root -g wheel -m 0700 "$ROUTE_SNAPSHOT_DIR" || return 1

  local target
  for target in $RECLAIM_NETS $MOBILE_DNS_IPS; do
    route_get "$target" >| "${ROUTE_SNAPSHOT_DIR}/$(route_snapshot_name "$target").route" || return 1
  done
  /usr/bin/touch "${ROUTE_SNAPSHOT_DIR}/complete" || return 1
}

route_matches() {
  local kind="$1" target="$2" expected_if="$3" expected_gw="$4"
  local output actual_if actual_gw actual_flags
  if fixture_mode_enabled; then
    [[ "${DUALVPN_TEST_ASSUME_MANAGED_CORRECT:-0}" == 1 ]] && return 0
    local record
    record="$(fixture_route_record "$target")"
    IFS='|' read -r _ actual_if actual_gw actual_flags <<<"$record"
    [[ -n "$record" && "$actual_if" == "$expected_if" ]] || return 1
    [[ -z "$expected_gw" || "$actual_gw" == "$expected_gw" ]] || return 1
    [[ "$kind" != host || "$actual_flags" != *GATEWAY* ]]
    return
  fi
  output="$(route_get "$target")"
  actual_if="$(field_from_route "$output" interface)"
  actual_gw="$(field_from_route "$output" gateway)"
  [[ "$actual_if" == "$expected_if" ]] || return 1
  [[ -z "$expected_gw" || "$actual_gw" == "$expected_gw" ]]
}

managed_route_matches() {
  local kind="$1" target="$2" expected_if="$3" expected_gw="$4"
  if fixture_mode_enabled; then
    route_matches "$kind" "$target" "$expected_if" "$expected_gw"
    return
  fi
  local output flags
  output="$(route_get "$target")"
  route_output_is_exact "$kind" "$target" "$output" || return 1
  [[ "$(field_from_route "$output" interface)" == "$expected_if" ]] || return 1
  [[ -z "$expected_gw" || "$(field_from_route "$output" gateway)" == "$expected_gw" ]] || return 1
  flags="$(field_from_route "$output" flags)"
  [[ "$kind" != host || "$flags" != *GATEWAY* ]]
}

current_route_is_exact() {
  local kind="$1" target="$2"
  if fixture_mode_enabled; then
    [[ -n "$(fixture_route_record "$target")" ]]
    return
  fi
  route_output_is_exact "$kind" "$target" "$(route_get "$target")"
}

route_snapshot_is_exact() {
  local kind="$1" target="$2" snapshot_file="$3"
  [[ -s "$snapshot_file" ]] || return 1
  local state_file="${snapshot_file%.route}.state"
  [[ ! -r "$state_file" || "$(<"$state_file")" == EXACT ]] || return 1
  route_output_is_exact "$kind" "$target" "$(<"$snapshot_file")"
}

test_mutation_allowed() {
  (( TEST_OPERATION_COUNT += 1 ))
  local fail_at
  fail_at="$(read_fixture fail-operation.txt 2>/dev/null || print 0)"
  [[ "$fail_at" != "$TEST_OPERATION_COUNT" ]]
}

add_net_route() {
  local target="$1" gateway="$2"
  if fixture_mode_enabled; then
    test_mutation_allowed || return 1
    print -r -- "operation=add-net|${target}|${gateway}"
    TEST_MANAGED_ROUTES+=("net:${target}:${gateway}")
    return 0
  fi
  /sbin/route -n add -net "$target" "$gateway" >/dev/null 2>&1 || \
    /sbin/route -n change -net "$target" "$gateway" >/dev/null 2>&1
}

add_host_interface_route() {
  local target="$1" interface_name="$2"
  if fixture_mode_enabled; then
    test_mutation_allowed || return 1
    print -r -- "operation=add-host-if|${target}|${interface_name}"
    TEST_MANAGED_ROUTES+=("host:${target}:${interface_name}")
    return 0
  fi
  /sbin/route -n add -host "$target" -interface "$interface_name" >/dev/null 2>&1 || \
    /sbin/route -n change -host "$target" -interface "$interface_name" >/dev/null 2>&1
}

delete_managed_route() {
  local kind="$1" target="$2" token="$3"
  if fixture_mode_enabled; then
    print -r -- "operation=rollback-${kind}|${target}"
    TEST_MANAGED_ROUTES=("${(@)TEST_MANAGED_ROUTES:#${token}}")
    return 0
  fi
  /sbin/route -n delete "-${kind}" "$target" >/dev/null 2>&1
}

restore_route_file() {
  local kind="$1" target="$2" snapshot_file="$3"
  [[ -s "$snapshot_file" ]] || return 0

  local output original_if original_gw original_flags
  output="$(<"$snapshot_file")"
  [[ "$output" == *"route to:"* ]] || return 0
  route_output_is_exact "$kind" "$target" "$output" || return 0
  original_if="$(field_from_route "$output" interface)"
  original_gw="$(field_from_route "$output" gateway)"
  original_flags="$(field_from_route "$output" flags)"

  if ! route_snapshot_is_restorable "$snapshot_file"; then
    safe_log warn "snapshot_stale target=${target} interface=${original_if:-none} gateway=${original_gw:-none}"
    return 0
  fi

  if [[ "$original_flags" == *GATEWAY* && -n "$original_gw" ]]; then
    /sbin/route -n add "-${kind}" "$target" "$original_gw" >/dev/null 2>&1
  elif [[ -n "$original_if" ]]; then
    /sbin/route -n add "-${kind}" "$target" -interface "$original_if" >/dev/null 2>&1
  fi
}

route_snapshot_is_restorable() {
  local snapshot_file="$1" output original_if original_gw original_flags gateway_if
  [[ -s "$snapshot_file" ]] || return 1
  output="$(<"$snapshot_file")"
  original_if="$(field_from_route "$output" interface)"
  original_gw="$(field_from_route "$output" gateway)"
  original_flags="$(field_from_route "$output" flags)"
  [[ -n "$original_if" ]] || return 1
  interface_has_ipv4_address "$original_if" || return 1
  if [[ "$original_flags" == *GATEWAY* ]]; then
    [[ -n "$original_gw" ]] || return 1
    gateway_if="$(field_from_route "$(route_get "$original_gw")" interface)"
    [[ "$gateway_if" == "$original_if" ]] || return 1
  fi
}

verify_restored_route() {
  local kind="$1" target="$2" snapshot_file="$3" owned_if="$4" owned_gw="$5"
  if ! route_snapshot_is_exact "$kind" "$target" "$snapshot_file"; then
    local current
    current="$(route_get "$target")"
    ! route_output_is_exact "$kind" "$target" "$current"
    return
  fi
  if ! route_snapshot_is_restorable "$snapshot_file"; then
    local stale_current
    stale_current="$(route_get "$target")"
    ! route_output_is_exact "$kind" "$target" "$stale_current"
    return
  fi
  local expected current field expected_value
  expected="$(<"$snapshot_file")"
  current="$(route_get "$target")"
  for field in interface gateway destination mask; do
    expected_value="$(field_from_route "$expected" "$field")"
    [[ -z "$expected_value" || "$(field_from_route "$current" "$field")" == "$expected_value" ]] || return 1
  done
}

restore_route_for_cleanup() {
  local kind="$1" target="$2" snapshot_file="$3" expected_if="$4" expected_gw="$5"
  if fixture_mode_enabled; then
    [[ "$(read_fixture fail-restore.txt 2>/dev/null || true)" == 1 ]] && return 1
    print -r -- "restore=${kind}|${target}"
    return 0
  fi
  restore_route_file "$kind" "$target" "$snapshot_file" && \
    verify_restored_route "$kind" "$target" "$snapshot_file" "$expected_if" "$expected_gw"
}

rollback_route_transaction() {
  local index entry kind target token snapshot_file ownership ownership_kind ownership_target expected_if expected_gw failed=0
  for (( index = ${#ROUTE_TRANSACTION_LEDGER}; index >= 1; index-- )); do
    entry="${ROUTE_TRANSACTION_LEDGER[$index]}"
    kind="${entry%%|*}"
    entry="${entry#*|}"
    target="${entry%%|*}"
    token="${entry#*|}"
    ownership=""
    for ownership in $ROUTE_TRANSACTION_OWNERSHIP; do
      IFS='|' read -r ownership_kind ownership_target expected_if expected_gw <<<"$ownership"
      [[ "$ownership_kind" == "$kind" && "$ownership_target" == "$target" ]] && break
      ownership=""
    done
    [[ -n "$ownership" ]] || { failed=1; continue; }
    if ! record_route_restore_pending "$ownership"; then
      failed=1
      continue
    fi
    if ! delete_managed_route "$kind" "$target" "$token"; then
      failed=1
      continue
    fi
    snapshot_file="${ROUTE_OWNED_SNAPSHOT_DIR}/$(route_snapshot_name "$target").route"
    if ! restore_route_for_cleanup "$kind" "$target" "$snapshot_file" "$expected_if" "$expected_gw"; then
      failed=1
      continue
    fi
    if ! clear_route_restore_pending "$kind" "$target"; then
      failed=1
      continue
    fi
    fixture_mode_enabled || /bin/rm -f "$snapshot_file" "${snapshot_file%.route}.state"
  done
  if (( failed == 0 )); then
    clear_pending_route_ownership
    if ! fixture_mode_enabled; then
      for ownership in $ROUTE_TRANSACTION_OWNERSHIP; do
        IFS='|' read -r ownership_kind ownership_target expected_if expected_gw <<<"$ownership"
        snapshot_file="${ROUTE_OWNED_SNAPSHOT_DIR}/$(route_snapshot_name "$ownership_target").route"
        /bin/rm -f "$snapshot_file" "${snapshot_file%.route}.state"
      done
    fi
    ROUTE_TRANSACTION_LEDGER=()
    ROUTE_TRANSACTION_OWNERSHIP=()
  fi
  (( failed == 0 ))
}

commit_route_transaction() {
  (( ${#ROUTE_TRANSACTION_OWNERSHIP} > 0 )) || return 0
  fixture_mode_enabled && return 0

  /usr/bin/install -d -o root -g wheel -m 0700 "$ROUTE_OWNED_SNAPSHOT_DIR" || return 1
  local entry kind target expected_if expected_gw snapshot_name
  for entry in $ROUTE_TRANSACTION_OWNERSHIP; do
    IFS='|' read -r kind target expected_if expected_gw <<<"$entry"
    route_target_allowed "$kind" "$target" || return 1
    snapshot_name="$(route_snapshot_name "$target").route"
    if [[ -e "${ROUTE_TRANSACTION_DIR}/${snapshot_name}" ]]; then
      /bin/cp "${ROUTE_TRANSACTION_DIR}/${snapshot_name}" "${ROUTE_OWNED_SNAPSHOT_DIR}/${snapshot_name}.tmp.$$" || return 1
      /usr/sbin/chown root:wheel "${ROUTE_OWNED_SNAPSHOT_DIR}/${snapshot_name}.tmp.$$" || return 1
      /bin/chmod 0600 "${ROUTE_OWNED_SNAPSHOT_DIR}/${snapshot_name}.tmp.$$" || return 1
      /bin/mv -f "${ROUTE_OWNED_SNAPSHOT_DIR}/${snapshot_name}.tmp.$$" "${ROUTE_OWNED_SNAPSHOT_DIR}/${snapshot_name}" || return 1
      /bin/cp "${ROUTE_TRANSACTION_DIR}/${snapshot_name%.route}.state" "${ROUTE_OWNED_SNAPSHOT_DIR}/${snapshot_name%.route}.state.tmp.$$" || return 1
      /usr/sbin/chown root:wheel "${ROUTE_OWNED_SNAPSHOT_DIR}/${snapshot_name%.route}.state.tmp.$$" || return 1
      /bin/chmod 0600 "${ROUTE_OWNED_SNAPSHOT_DIR}/${snapshot_name%.route}.state.tmp.$$" || return 1
      /bin/mv -f "${ROUTE_OWNED_SNAPSHOT_DIR}/${snapshot_name%.route}.state.tmp.$$" "${ROUTE_OWNED_SNAPSHOT_DIR}/${snapshot_name%.route}.state" || return 1
    fi
  done

  local temp_file="${ROUTE_OWNERSHIP_FILE}.tmp.$$" existing changed
  : >| "$temp_file" || return 1
  while IFS='|' read -r kind target expected_if expected_gw; do
    route_target_allowed "$kind" "$target" || continue
    changed=false
    for entry in $ROUTE_TRANSACTION_OWNERSHIP; do
      [[ "${entry#*|}" == "${target}|"* ]] && { changed=true; break; }
    done
    [[ "$changed" == false ]] && print -r -- "${kind}|${target}|${expected_if}|${expected_gw}" >> "$temp_file"
  done < <(owned_routes_source)
  for entry in $ROUTE_TRANSACTION_OWNERSHIP; do print -r -- "$entry" >> "$temp_file"; done
  /usr/sbin/chown root:wheel "$temp_file" || return 1
  /bin/chmod 0600 "$temp_file" || return 1
  /bin/mv -f "$temp_file" "$ROUTE_OWNERSHIP_FILE" || return 1
  clear_pending_route_ownership || return 1
  ROUTE_TRANSACTION_OWNERSHIP=()
}

apply_managed_routes() {
  local physical_if="$1" physical_gw="$2" mobile_if="$3"
  local target token entry kind expected_if expected_gw
  [[ -n "$physical_if" && -n "$physical_gw" && -n "$mobile_if" ]] || return 1
  if route_restore_pending_present; then
    safe_log warn "route apply refused while snapshot restoration is pending"
    return 1
  fi
  ROUTE_TRANSACTION_LEDGER=()
  ROUTE_TRANSACTION_OWNERSHIP=()
  ROUTE_MUTATION_PLAN=()
  fixture_mode_enabled || /bin/rm -rf "$ROUTE_TRANSACTION_DIR"

  for target in $RECLAIM_NETS; do
    managed_route_matches net "$target" "$physical_if" "$physical_gw" && continue
    capture_effective_route net "$target" || { rollback_route_transaction; return 1; }
    token="net:${target}:${physical_gw}"
    ROUTE_TRANSACTION_OWNERSHIP+=("net|${target}|${physical_if}|${physical_gw}")
    if ! record_pending_route_ownership "${ROUTE_TRANSACTION_OWNERSHIP[-1]}" "$target"; then
      rollback_route_transaction
      return 1
    fi
    ROUTE_MUTATION_PLAN+=("net|${target}|${physical_if}|${physical_gw}|${token}")
  done

  for target in $MOBILE_DNS_IPS; do
    managed_route_matches host "$target" "$mobile_if" "" && continue
    capture_effective_route host "$target" || { rollback_route_transaction; return 1; }
    token="host:${target}:${mobile_if}"
    ROUTE_TRANSACTION_OWNERSHIP+=("host|${target}|${mobile_if}|")
    if ! record_pending_route_ownership "${ROUTE_TRANSACTION_OWNERSHIP[-1]}" "$target"; then
      rollback_route_transaction
      return 1
    fi
    ROUTE_MUTATION_PLAN+=("host|${target}|${mobile_if}||${token}")
  done

  for entry in $ROUTE_MUTATION_PLAN; do
    IFS='|' read -r kind target expected_if expected_gw token <<<"$entry"
    if [[ "$kind" == net ]]; then
      add_net_route "$target" "$expected_gw" || { rollback_route_transaction; return 1; }
    elif ! add_host_interface_route "$target" "$expected_if"; then
      rollback_route_transaction
      return 1
    fi
    ROUTE_TRANSACTION_LEDGER+=("${kind}|${target}|${token}")
  done
  if ! commit_route_transaction; then
    rollback_route_transaction
    return 1
  fi
}

verify_managed_routes() {
  local physical_if="$1" physical_gw="$2" mobile_if="$3" target
  for target in $RECLAIM_NETS; do
    managed_route_matches net "$target" "$physical_if" "$physical_gw" || return 1
  done
  for target in $MOBILE_DNS_IPS; do
    managed_route_matches host "$target" "$mobile_if" "" || return 1
  done
}

revert_managed_routes() {
  if fixture_mode_enabled && [[ "$(read_fixture fail-cleanup.txt 2>/dev/null || true)" == 1 ]]; then
    print -r -- "operation=cleanup-attempt"
    return 1
  fi
  local kind target expected_if expected_gw snapshot_file token entry restore_pending=false failed=0
  local temp_file="${ROUTE_OWNERSHIP_FILE}.tmp.$$"
  fixture_mode_enabled || : >| "$temp_file" || return 1
  while IFS='|' read -r kind target expected_if expected_gw; do
    [[ -n "$kind" ]] || continue
    if ! route_target_allowed "$kind" "$target"; then
      safe_log warn "invalid_route_ownership target=${target}"
      failed=1
      continue
    fi
    entry="${kind}|${target}|${expected_if}|${expected_gw}"
    token="${kind}:${target}:"
    snapshot_file="${ROUTE_OWNED_SNAPSHOT_DIR}/$(route_snapshot_name "$target").route"
    restore_pending=false
    route_restore_is_pending "$kind" "$target" && restore_pending=true

    if [[ "$restore_pending" == true ]] && ! fixture_mode_enabled && \
       verify_restored_route "$kind" "$target" "$snapshot_file" "$expected_if" "$expected_gw"; then
      clear_route_restore_pending "$kind" "$target" || {
        print -r -- "$entry" >> "$temp_file"
        failed=1
        continue
      }
      /bin/rm -f "$snapshot_file" "${snapshot_file%.route}.state"
      continue
    fi

    if managed_route_matches "$kind" "$target" "$expected_if" "$expected_gw"; then
      if [[ "$restore_pending" != true ]] && ! record_route_restore_pending "$entry"; then
        safe_log error "route_restore_journal_failed target=${target}"
        fixture_mode_enabled || print -r -- "$entry" >> "$temp_file"
        failed=1
        continue
      fi
      if ! delete_managed_route "$kind" "$target" "$token"; then
        safe_log error "route_cleanup_failed target=${target}"
        fixture_mode_enabled || print -r -- "$entry" >> "$temp_file"
        failed=1
        continue
      fi
    elif [[ "$restore_pending" == true ]] && ! current_route_is_exact "$kind" "$target"; then
      : # A previous cleanup deleted the owned route; resume the snapshot restore.
    else
      safe_log info "ownership_lost target=${target}; route left unchanged"
      if ! clear_route_restore_pending "$kind" "$target"; then
        fixture_mode_enabled || print -r -- "$entry" >> "$temp_file"
        failed=1
        continue
      fi
      fixture_mode_enabled || /bin/rm -f "$snapshot_file" "${snapshot_file%.route}.state"
      continue
    fi

    if ! restore_route_for_cleanup "$kind" "$target" "$snapshot_file" "$expected_if" "$expected_gw"; then
      safe_log error "route_restore_failed target=${target}"
      fixture_mode_enabled || print -r -- "$entry" >> "$temp_file"
      failed=1
      continue
    fi
    if ! clear_route_restore_pending "$kind" "$target"; then
      safe_log error "route_restore_journal_clear_failed target=${target}"
      fixture_mode_enabled || print -r -- "$entry" >> "$temp_file"
      failed=1
      continue
    fi
    fixture_mode_enabled || /bin/rm -f "$snapshot_file" "${snapshot_file%.route}.state"
  done < <(owned_routes_source)

  if ! fixture_mode_enabled; then
    /usr/sbin/chown root:wheel "$temp_file" || return 1
    /bin/chmod 0600 "$temp_file" || return 1
    /bin/mv -f "$temp_file" "$ROUTE_OWNERSHIP_FILE" || return 1
    clear_pending_route_ownership || return 1
  fi
  (( failed == 0 ))
}

print_test_routes() {
  local route
  for route in $TEST_MANAGED_ROUTES; do
    print -r -- "final_route=${route}"
  done
}

if [[ "${1:-}" == --test-apply ]]; then
  if apply_managed_routes "${2:-}" "${3:-}" "${4:-}"; then
    print_test_routes
    exit 0
  fi
  print_test_routes
  exit 1
fi

if [[ "${1:-}" == --test-revert ]]; then
  revert_managed_routes
  exit $?
fi

if [[ "${1:-}" == --test-snapshot-policy ]]; then
  route_output_is_exact "${2:-}" "${3:-}" "$(read_fixture "${4:-}" 2>/dev/null)"
  exit $?
fi

if [[ "${1:-}" == --test-snapshot-restorable ]]; then
  route_snapshot_is_restorable "$(fixture_path "${2:-}")"
  exit $?
fi
