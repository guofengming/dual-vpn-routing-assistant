#!/bin/zsh
set -u

typeset -gr DAEMON_SCRIPT_PATH="${(%):-%N}"
typeset -gr DAEMON_DIR="${DAEMON_SCRIPT_PATH:A:h}"
source "${DAEMON_DIR}/lib/common.sh"
source "${DAEMON_DIR}/lib/probe.sh"
source "${DAEMON_DIR}/lib/routes.sh"
source "${DAEMON_DIR}/lib/dns.sh"
source "${DAEMON_DIR}/lib/state-machine.sh"
source "${DAEMON_DIR}/lib/requests.sh"

typeset -gr DAEMON_VERSION="$(/bin/cat "${DAEMON_DIR}/VERSION" 2>/dev/null || print 0.1.0)"
typeset -gr STATUS_FILE="${STATE_ROOT}/status.json"
typeset -gr CONFIG_FILE="${STATE_ROOT}/config.plist"
typeset -gr DEGRADED_LATCH_FILE="${STATE_ROOT}/degraded-signature"
typeset -gr EVENTS_FILE="${STATE_ROOT}/events.jsonl"
typeset -g CURRENT_PHASE="IDLE"
typeset -g LAST_SIGNATURE=""
typeset -gi SETTLE_STARTED_AT=0
typeset -gi RETRY_ATTEMPT=0
typeset -gi NEXT_RETRY_AT=0
typeset -g LAST_STATUS_FINGERPRINT=""
typeset -gi LAST_STATUS_WRITTEN_AT=0
typeset -g DEGRADED_SIGNATURE=""
typeset -g DEGRADED_ERROR_CODE="repair_failed"
typeset -g LAST_NETWORK_CHANGE_JSON="null"
typeset -g PROCESSED_REQUEST_ID_JSON="null"
typeset -g AUTO_ENABLE="true"
typeset -g PAUSED="false"
typeset -g LOG_LEVEL="standard"
typeset -g LAST_EVENT_JSON=""

iso_now() {
  /bin/date -u '+%Y-%m-%dT%H:%M:%SZ'
}

load_config() {
  AUTO_ENABLE="true"
  PAUSED="false"
  LOG_LEVEL="standard"
  [[ -r "$CONFIG_FILE" ]] || return 0
  local value
  value="$(/usr/bin/plutil -extract autoEnableAtBoot raw -o - "$CONFIG_FILE" 2>/dev/null || true)"
  [[ "$value" == false ]] && AUTO_ENABLE="false"
  value="$(/usr/bin/plutil -extract paused raw -o - "$CONFIG_FILE" 2>/dev/null || true)"
  [[ "$value" == true ]] && PAUSED="true"
  value="$(/usr/bin/plutil -extract logLevel raw -o - "$CONFIG_FILE" 2>/dev/null || true)"
  [[ "$value" == detailed ]] && LOG_LEVEL="detailed"
}

write_config_value() {
  local key="$1" value="$2"
  if fixture_mode_enabled; then
    print -r -- "config=${key}|${value}"
    return 0
  fi

  /bin/mkdir -p "$STATE_ROOT"
  local temp_file="${CONFIG_FILE}.tmp.$$"
  if [[ -r "$CONFIG_FILE" ]]; then
    /bin/cp "$CONFIG_FILE" "$temp_file"
  else
    /usr/bin/printf '%s\n' '{"autoEnableAtBoot":true,"paused":false,"logLevel":"standard"}' >| "$temp_file"
  fi
  /usr/bin/plutil -replace "$key" -string "$value" "$temp_file" 2>/dev/null || {
    /bin/rm -f "$temp_file"
    return 1
  }
  if [[ "$key" == paused || "$key" == autoEnableAtBoot ]]; then
    /usr/bin/plutil -replace "$key" -bool "$value" "$temp_file" || {
      /bin/rm -f "$temp_file"
      return 1
    }
  fi
  /usr/sbin/chown root:wheel "$temp_file"
  /bin/chmod 0600 "$temp_file"
  /bin/mv -f "$temp_file" "$CONFIG_FILE"
}

apply_accepted_request() {
  case "$REQUEST_TYPE" in
    repairNow)
      RETRY_ATTEMPT=0
      NEXT_RETRY_AT=0
      CURRENT_PHASE=PROBING
      clear_degraded_latch
      ;;
    setPaused)
      write_config_value paused "$REQUEST_VALUE" || return 1
      PAUSED="$REQUEST_VALUE"
      ;;
    setAutoEnableAtBoot)
      write_config_value autoEnableAtBoot "$REQUEST_VALUE" || return 1
      AUTO_ENABLE="$REQUEST_VALUE"
      ;;
    setLogLevel)
      write_config_value logLevel "$REQUEST_VALUE" || return 1
      ;;
    *) return 1 ;;
  esac
}

persist_degraded_latch() {
  DEGRADED_SIGNATURE="$1"
  DEGRADED_ERROR_CODE="${2:-repair_failed}"
  fixture_mode_enabled && return 0
  local temp_file="${DEGRADED_LATCH_FILE}.tmp.$$"
  /usr/bin/printf '%s\n%s\n' "$DEGRADED_SIGNATURE" "$DEGRADED_ERROR_CODE" >| "$temp_file" || return 1
  /usr/sbin/chown root:wheel "$temp_file" || return 1
  /bin/chmod 0600 "$temp_file" || return 1
  /bin/mv -f "$temp_file" "$DEGRADED_LATCH_FILE"
}

clear_degraded_latch() {
  DEGRADED_SIGNATURE=""
  DEGRADED_ERROR_CODE="repair_failed"
  fixture_mode_enabled || /bin/rm -f "$DEGRADED_LATCH_FILE"
}

load_degraded_latch() {
  fixture_mode_enabled && return 0
  [[ -r "$DEGRADED_LATCH_FILE" ]] || return 0
  DEGRADED_SIGNATURE="$(/usr/bin/sed -n '1p' "$DEGRADED_LATCH_FILE" 2>/dev/null || true)"
  DEGRADED_ERROR_CODE="$(/usr/bin/sed -n '2p' "$DEGRADED_LATCH_FILE" 2>/dev/null || print repair_failed)"
  [[ "$DEGRADED_ERROR_CODE" == cleanup_failed || "$DEGRADED_ERROR_CODE" == repair_failed ]] || DEGRADED_ERROR_CODE=repair_failed
  if print -r -- "$DEGRADED_SIGNATURE" | /usr/bin/grep -Eq '^[0-9a-f]{64}$'; then
    CURRENT_PHASE=DEGRADED
    LAST_SIGNATURE="$DEGRADED_SIGNATURE"
  else
    clear_degraded_latch
  fi
}

process_pending_request() {
  local console_user console_uid request_path
  console_user="$(detect_console_user)"
  [[ -n "$console_user" ]] || return 0
  console_uid="$(/usr/bin/id -u "$console_user" 2>/dev/null || true)"
  [[ -n "$console_uid" ]] || return 0
  request_path="${SYSTEM_ROOT}/ipc/${console_uid}/request.json"
  [[ -f "$request_path" || -L "$request_path" ]] || return 0
  if consume_request "$console_uid" "$request_path"; then
    if apply_accepted_request && mark_request_processed; then
      PROCESSED_REQUEST_ID_JSON="\"${REQUEST_ID}\""
      fixture_mode_enabled && print -r -- "processed_request=${REQUEST_ID}"
    else
      safe_log error "accepted request could not be applied"
      discard_staged_request
    fi
  else
    safe_log warn "rejected invalid control request"
    discard_staged_request
    /bin/rm -f "$request_path"
  fi
}

status_route_json() {
  local id="$1" label="$2" destination="$3" interface_name="$4" gateway="$5" state="$6"
  local interface_json="null" gateway_json="null"
  [[ -n "$interface_name" ]] && interface_json="\"$(json_escape "$interface_name")\""
  [[ -n "$gateway" ]] && gateway_json="\"$(json_escape "$gateway")\""
  print -rn -- "{\"id\":\"${id}\",\"label\":\"${label}\",\"destination\":\"${destination}\",\"interface\":${interface_json},\"gateway\":${gateway_json},\"state\":\"${state}\"}"
}

write_status() {
  local phase="$1" message="$2" physical_if="$3" physical_gw="$4" mobile_if="$5"
  local error_code="${6:-}" error_message="${7:-}"
  local now state interface_json="null" gateway_json="null" mobile_json="null" error_json="null"
  now="$(iso_now)"
  state="missing"
  [[ "$phase" == ACTIVE ]] && state="correct"
  [[ "$phase" == REPAIRING || "$phase" == DEGRADED ]] && state="drifted"
  [[ -n "$physical_if" ]] && interface_json="\"$(json_escape "$physical_if")\""
  [[ -n "$physical_gw" ]] && gateway_json="\"$(json_escape "$physical_gw")\""
  [[ -n "$mobile_if" ]] && mobile_json="\"$(json_escape "$mobile_if")\""
  if [[ -n "$error_code" ]]; then
    error_json="{\"code\":\"$(json_escape "$error_code")\",\"message\":\"$(json_escape "$error_message")\",\"occurredAt\":\"${now}\",\"retryable\":true}"
  fi

  local fingerprint="${phase}|${message}|${physical_if}|${physical_gw}|${mobile_if}|${error_code}|${AUTO_ENABLE}|${PAUSED}|${PROCESSED_REQUEST_ID_JSON}"
  local now_epoch
  now_epoch="$(/bin/date +%s)"
  [[ "$fingerprint" == "$LAST_STATUS_FINGERPRINT" && $(( now_epoch - LAST_STATUS_WRITTEN_AT )) -lt 30 ]] && return 0
  LAST_STATUS_FINGERPRINT="$fingerprint"
  LAST_STATUS_WRITTEN_AT="$now_epoch"

  local routes_json
  routes_json="$(status_route_json split-a "办公网段 A" 10.0.0.0/9 "$physical_if" "$physical_gw" "$state"),$(status_route_json split-b "办公网段 B" 10.128.0.0/9 "$physical_if" "$physical_gw" "$state"),$(status_route_json mobile-dns-a "中移 DNS A" 10.57.0.96 "$mobile_if" "" "$state"),$(status_route_json mobile-dns-b "中移 DNS B" 10.57.0.196 "$mobile_if" "" "$state")"

  local events_json=""
  if ! fixture_mode_enabled && [[ -s "$EVENTS_FILE" ]]; then
    events_json="$(/usr/bin/tail -n 200 "$EVENTS_FILE" | /usr/bin/paste -sd ',' -)"
  elif [[ -n "$LAST_EVENT_JSON" ]]; then
    events_json="$LAST_EVENT_JSON"
  fi
  local status_json
  status_json="{\"schemaVersion\":1,\"phase\":\"${phase}\",\"message\":\"$(json_escape "$message")\",\"updatedAt\":\"${now}\",\"physicalInterface\":${interface_json},\"physicalGateway\":${gateway_json},\"mobileInterface\":${mobile_json},\"routes\":[${routes_json}],\"dns\":{\"state\":\"${state}\",\"servers\":[\"172.31.5.60\",\"172.31.6.60\"],\"domains\":[\"baidu.com\",\"baidu-int.com\",\"internal.baidu.com\"],\"resolvedAddresses\":[]},\"lastCheckAt\":\"${now}\",\"lastNetworkChangeAt\":${LAST_NETWORK_CHANGE_JSON},\"lastError\":${error_json},\"autoEnableAtBoot\":${AUTO_ENABLE},\"paused\":${PAUSED},\"logLevel\":\"${LOG_LEVEL}\",\"daemonVersion\":\"${DAEMON_VERSION}\",\"processedRequestId\":${PROCESSED_REQUEST_ID_JSON},\"events\":[${events_json}]}"

  if fixture_mode_enabled; then
    if [[ "${DUALVPN_TEST_PRINT_STATUS_JSON:-0}" == 1 ]]; then
      print -r -- "status_json=${status_json}"
    else
      print -r -- "phase=${phase}"
    fi
    return 0
  fi

  /bin/mkdir -p "$STATE_ROOT"
  local temp_file="${STATUS_FILE}.tmp.$$"
  /usr/bin/printf '%s\n' "$status_json" >| "$temp_file"
  /bin/chmod 0644 "$temp_file"
  /bin/mv -f "$temp_file" "$STATUS_FILE"
}

persist_event() {
  local event_json="$1"
  fixture_mode_enabled && return 0
  /usr/bin/install -d -o root -g wheel -m 0755 "$STATE_ROOT" || return 1
  local temp_file="${EVENTS_FILE}.tmp.$$"
  [[ -r "$EVENTS_FILE" ]] && /usr/bin/tail -n 199 "$EVENTS_FILE" >| "$temp_file" || : >| "$temp_file"
  print -r -- "$event_json" >> "$temp_file" || return 1
  /usr/sbin/chown root:wheel "$temp_file" || return 1
  /bin/chmod 0600 "$temp_file" || return 1
  /bin/mv -f "$temp_file" "$EVENTS_FILE"
}

cleanup_managed_state() {
  local failed=0
  revert_supplemental_dns || failed=1
  revert_managed_routes || failed=1
  (( failed == 0 ))
}

managed_state_present() {
  if fixture_mode_enabled; then
    [[ "$(read_fixture managed-state-present.txt 2>/dev/null || true)" == 1 ]]
    return
  fi
  [[ -s "$ROUTE_OWNERSHIP_FILE" || -s "$ROUTE_PENDING_FILE" || -s "$ROUTE_RESTORE_PENDING_FILE" || \
     -s "$DNS_OWNERSHIP_FILE" || -s "$DNS_PENDING_FILE" ]]
}

report_cleanup_failure() {
  local physical_if="$1" physical_gw="$2" mobile_if="$3" signature="$4"
  LAST_SIGNATURE="$signature"
  persist_degraded_latch "$signature" cleanup_failed || true
  record_transition DEGRADED "受管网络状态清理失败"
  write_status DEGRADED "清理未完成，请查看诊断" "$physical_if" "$physical_gw" "$mobile_if" cleanup_failed "无法安全恢复受管路由或 DNS"
}

record_transition() {
  local next="$1" message="$2"
  if [[ "$CURRENT_PHASE" != "$next" ]]; then
    safe_log info "phase ${CURRENT_PHASE} -> ${next}: ${message}"
    local occurred_at event_level=info
    occurred_at="$(iso_now)"
    [[ "$next" == REPAIRING ]] && event_level=warning
    [[ "$next" == DEGRADED ]] && event_level=error
    LAST_EVENT_JSON="{\"id\":\"${occurred_at}-${next}\",\"occurredAt\":\"${occurred_at}\",\"level\":\"${event_level}\",\"code\":\"phase_${next:l}\",\"message\":\"$(json_escape "$message")\"}"
    persist_event "$LAST_EVENT_JSON" || safe_log error "could not persist diagnostic event"
    CURRENT_PHASE="$next"
  fi
}

record_repair_failure() {
  local message="$1" physical_if="$2" physical_gw="$3" mobile_if="$4"
  (( RETRY_ATTEMPT += 1 ))
  local delay
  if delay="$(retry_delay "$RETRY_ATTEMPT")"; then
    NEXT_RETRY_AT=$(( $(/bin/date +%s) + delay ))
    record_transition REPAIRING "$message"
    write_status REPAIRING "检测到异常，将自动重试" "$physical_if" "$physical_gw" "$mobile_if" repair_failed "$message"
  else
    persist_degraded_latch "$LAST_SIGNATURE" repair_failed || safe_log error "could not persist degraded latch"
    record_transition DEGRADED "$message"
    write_status DEGRADED "自动修复未完成，请查看诊断" "$physical_if" "$physical_gw" "$mobile_if" repair_failed "$message"
  fi
}

reconcile_once() {
  load_config
  local console_user physical_record physical_if="" physical_gw="" mobile_if signature now
  console_user="$(detect_console_user)"
  physical_record="$(probe_physical_route)"
  if [[ -n "$physical_record" ]]; then
    physical_if="${physical_record%%|*}"
    physical_gw="${physical_record#*|}"
  fi
  mobile_if="$(probe_mobile_interface "$console_user")"
  signature="$(network_signature "$physical_if" "$physical_gw" "$mobile_if")"
  now="$(/bin/date +%s)"
  if [[ "$LOG_LEVEL" == detailed ]]; then
    safe_log info "probe physical=${physical_if:-none} gateway=${physical_gw:-none} mobile=${mobile_if:-none} signature=${signature}"
  fi

  if [[ "$CURRENT_PHASE" == DEGRADED && "$signature" == "$DEGRADED_SIGNATURE" ]]; then
    if [[ "$DEGRADED_ERROR_CODE" == cleanup_failed ]]; then
      write_status DEGRADED "清理未完成，请查看诊断" "$physical_if" "$physical_gw" "$mobile_if" cleanup_failed "无法安全恢复受管路由或 DNS"
    else
      write_status DEGRADED "自动修复已停止，等待网络变化或手动检测修复" "$physical_if" "$physical_gw" "$mobile_if" repair_failed "已达到自动修复次数上限"
    fi
    return 0
  fi
  if [[ "$CURRENT_PHASE" == DEGRADED && "$signature" != "$DEGRADED_SIGNATURE" ]]; then
    clear_degraded_latch
    RETRY_ATTEMPT=0
  fi

  # A crash may leave a route or resolver mutation only partly restored. Finish
  # that recovery before settling or a new apply can replace its saved baseline.
  if route_restore_pending_present || dns_pending_present; then
    if ! cleanup_managed_state; then
      report_cleanup_failure "$physical_if" "$physical_gw" "$mobile_if" "$signature"
      return 1
    fi
    LAST_SIGNATURE="$signature"
    RETRY_ATTEMPT=0
    clear_degraded_latch
    if [[ -n "$physical_if" && -n "$physical_gw" && -n "$mobile_if" ]]; then
      SETTLE_STARTED_AT="$now"
      record_transition NETWORK_SETTLING "已完成中断的路由恢复，等待网络稳定"
      write_status NETWORK_SETTLING "已恢复原路由，正在重新确认网络" "$physical_if" "$physical_gw" "$mobile_if"
    else
      record_transition IDLE "已完成中断的路由恢复"
      write_status IDLE "等待中移 VPN" "$physical_if" "$physical_gw" "$mobile_if"
    fi
    return 0
  fi

  if [[ "$PAUSED" == true || "$AUTO_ENABLE" == false ]]; then
    if [[ "$CURRENT_PHASE" != PAUSED ]] && ! cleanup_managed_state; then
      report_cleanup_failure "$physical_if" "$physical_gw" "$mobile_if" "$signature"
      return 1
    fi
    record_transition PAUSED "分流已暂停"
    write_status PAUSED "分流已暂停" "$physical_if" "$physical_gw" "$mobile_if"
    LAST_SIGNATURE="$signature"
    clear_degraded_latch
    return 0
  fi

  if [[ -z "$physical_if" || -z "$physical_gw" ]]; then
    if [[ "$CURRENT_PHASE" != IDLE ]] || managed_state_present; then
      if ! cleanup_managed_state; then
        report_cleanup_failure "$physical_if" "$physical_gw" "$mobile_if" "$signature"
        return 1
      fi
    fi
    record_transition IDLE "等待可用网络"
    write_status IDLE "等待可用网络" "$physical_if" "$physical_gw" "$mobile_if"
    LAST_SIGNATURE="$signature"
    clear_degraded_latch
    return 0
  fi

  if [[ -z "$mobile_if" ]]; then
    if [[ "$CURRENT_PHASE" != IDLE ]] || managed_state_present; then
      if ! cleanup_managed_state; then
        report_cleanup_failure "$physical_if" "$physical_gw" "$mobile_if" "$signature"
        return 1
      fi
    fi
    record_transition IDLE "等待中移 VPN"
    write_status IDLE "等待中移 VPN" "$physical_if" "$physical_gw" ""
    LAST_SIGNATURE="$signature"
    RETRY_ATTEMPT=0
    clear_degraded_latch
    return 0
  fi

  if [[ -z "$LAST_SIGNATURE" ]]; then
    SETTLE_STARTED_AT="$now"
    LAST_SIGNATURE="$signature"
    record_transition NETWORK_SETTLING "等待网络稳定"
    write_status NETWORK_SETTLING "正在确认网络稳定，约需 3 秒" "$physical_if" "$physical_gw" "$mobile_if"
    return 0
  fi

  if [[ "$signature" != "$LAST_SIGNATURE" ]]; then
    if ! cleanup_managed_state; then
      report_cleanup_failure "$physical_if" "$physical_gw" "$mobile_if" "$signature"
      return 1
    fi
    SETTLE_STARTED_AT="$now"
    LAST_NETWORK_CHANGE_JSON="\"$(iso_now)\""
    LAST_SIGNATURE="$signature"
    RETRY_ATTEMPT=0
    clear_degraded_latch
    record_transition NETWORK_SETTLING "网络已切换"
    write_status NETWORK_SETTLING "网络切换中，办公网可能短暂中断 10–30 秒" "$physical_if" "$physical_gw" "$mobile_if"
    return 0
  fi
  LAST_SIGNATURE="$signature"

  if [[ "$CURRENT_PHASE" == NETWORK_SETTLING && $(( now - SETTLE_STARTED_AT )) -lt 3 ]]; then
    return 0
  fi
  if [[ "$CURRENT_PHASE" == REPAIRING && "$now" -lt "$NEXT_RETRY_AT" ]]; then
    return 0
  fi

  if [[ "$CURRENT_PHASE" == ACTIVE ]] && \
     verify_managed_routes "$physical_if" "$physical_gw" "$mobile_if" && \
     verify_supplemental_dns && \
     family_baidu_resolves_intranet && \
     intranet_backend_reachable; then
    write_status ACTIVE "分流矩阵稳定" "$physical_if" "$physical_gw" "$mobile_if"
    return 0
  fi

  record_transition PROBING "正在检测分流"
  write_status PROBING "正在检测网络与分流" "$physical_if" "$physical_gw" "$mobile_if"
  if ! enterprise_dns_reachable "$physical_if"; then
    record_repair_failure "办公 DNS 当前不可达" "$physical_if" "$physical_gw" "$mobile_if"
    return 1
  fi

  snapshot_routes
  snapshot_dns
  if apply_managed_routes "$physical_if" "$physical_gw" "$mobile_if" && \
     apply_supplemental_dns && \
     verify_managed_routes "$physical_if" "$physical_gw" "$mobile_if" && \
     verify_supplemental_dns && \
     intranet_backend_reachable; then
    RETRY_ATTEMPT=0
    clear_degraded_latch
    record_transition ACTIVE "分流矩阵稳定"
    write_status ACTIVE "分流矩阵稳定" "$physical_if" "$physical_gw" "$mobile_if"
    return 0
  fi

  if cleanup_managed_state; then
    record_repair_failure "路由、DNS 或业务连通性验证失败" "$physical_if" "$physical_gw" "$mobile_if"
  else
    report_cleanup_failure "$physical_if" "$physical_gw" "$mobile_if" "$signature"
  fi
  return 1
}

simulate_events() {
  CURRENT_PHASE="$1"
  shift
  local event next
  for event in "$@"; do
    if [[ "$event" == vpn_down || "$event" == network_changed || "$event" == pause ]]; then
      print -r -- "operation=cleanup"
    fi
    next="$(next_phase "$CURRENT_PHASE" "$event")" || return 1
    CURRENT_PHASE="$next"
    print -r -- "phase=${CURRENT_PHASE}"
  done
}

case "${1:-}" in
  --test-events)
    shift
    simulate_events "$@"
    exit $?
    ;;
  --test-reconcile)
    reconcile_once
    exit 0
    ;;
  --test-request)
    REQUEST_TEST_SCENARIO="${2:-}"
    run_request_test_scenario "$REQUEST_TEST_SCENARIO" || exit 1
    apply_accepted_request || exit 1
    mark_request_processed || exit 1
    PROCESSED_REQUEST_ID_JSON="\"${REQUEST_ID}\""
    fixture_mode_enabled && print -r -- "processed_request=${REQUEST_ID}"
    exit $?
    ;;
  --test-steady-active)
    CURRENT_PHASE=ACTIVE
    export DUALVPN_TEST_ASSUME_MANAGED_CORRECT=1
    test_user="$(detect_console_user)"
    test_physical="$(probe_physical_route)"
    test_if="${test_physical%%|*}"
    test_gw="${test_physical#*|}"
    test_mobile="$(probe_mobile_interface "$test_user")"
    LAST_SIGNATURE="$(network_signature "$test_if" "$test_gw" "$test_mobile")"
    reconcile_once
    reconcile_once
    exit 0
    ;;
  --test-status)
    export DUALVPN_TEST_PRINT_STATUS_JSON=1
    record_transition "${2:-ACTIVE}" "状态测试"
    write_status "${2:-ACTIVE}" "状态测试" en0 172.19.132.1 utun4
    exit 0
    ;;
  --test-degraded-hold)
    CURRENT_PHASE=DEGRADED
    test_user="$(detect_console_user)"
    test_physical="$(probe_physical_route)"
    test_if="${test_physical%%|*}"
    test_gw="${test_physical#*|}"
    test_mobile="$(probe_mobile_interface "$test_user")"
    LAST_SIGNATURE="$(network_signature "$test_if" "$test_gw" "$test_mobile")"
    DEGRADED_SIGNATURE="$LAST_SIGNATURE"
    reconcile_once
    reconcile_once
    exit 0
    ;;
  --test-backend-failure)
    test_user="$(detect_console_user)"
    test_physical="$(probe_physical_route)"
    test_if="${test_physical%%|*}"
    test_gw="${test_physical#*|}"
    test_mobile="$(probe_mobile_interface "$test_user")"
    LAST_SIGNATURE="$(network_signature "$test_if" "$test_gw" "$test_mobile")"
    reconcile_once || true
    exit 0
    ;;
  --test-cleanup-degraded-hold)
    test_user="$(detect_console_user)"
    test_physical="$(probe_physical_route)"
    test_if="${test_physical%%|*}"
    test_gw="${test_physical#*|}"
    test_mobile="$(probe_mobile_interface "$test_user")"
    test_signature="$(network_signature "$test_if" "$test_gw" "$test_mobile")"
    CURRENT_PHASE=ACTIVE
    LAST_SIGNATURE="$test_signature"
    cleanup_managed_state || report_cleanup_failure "$test_if" "$test_gw" "$test_mobile" "$test_signature"
    reconcile_once
    reconcile_once
    exit 0
    ;;
esac

(( EUID == 0 )) || {
  print -u2 "daemon must run as root"
  exit 77
}

/usr/bin/install -d -o root -g wheel -m 0755 "$STATE_ROOT" "$RUN_ROOT"
/usr/bin/touch "$LOG_FILE"
/usr/sbin/chown root:wheel "$LOG_FILE"
/bin/chmod 0644 "$LOG_FILE"
load_degraded_latch

while true; do
  rotate_log_if_needed
  process_pending_request
  reconcile_once || true
  /bin/sleep 5
done
