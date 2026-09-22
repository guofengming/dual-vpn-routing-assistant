#!/bin/zsh
set -u

typeset -gr REQUESTS_SCRIPT_PATH="${(%):-%N}"
typeset -gr REQUESTS_SCRIPT_DIR="${REQUESTS_SCRIPT_PATH:A:h}"
source "${REQUESTS_SCRIPT_DIR}/common.sh"

typeset -gr REQUEST_INBOX_DIR="${STATE_ROOT}/request-inbox"
typeset -gr PROCESSED_REQUEST_DIR="${STATE_ROOT}/processed-requests"
typeset -g REQUEST_TYPE=""
typeset -g REQUEST_VALUE=""
typeset -g REQUEST_ID=""
typeset -g REQUEST_STAGED_PATH=""
typeset -g REQUEST_CANONICAL_PATH=""
typeset -g REQUEST_TEST_SCENARIO=""

request_file_uid() {
  fixture_mode_enabled && {
    [[ "$REQUEST_TEST_SCENARIO" == wrong-owner ]] && print 502 || print 501
    return
  }
  /usr/bin/stat -f '%u' "$1" 2>/dev/null
}

request_directory_uid() {
  fixture_mode_enabled && { print 501; return; }
  /usr/bin/stat -f '%u' "$1" 2>/dev/null
}

request_directory_mode() {
  fixture_mode_enabled && {
    [[ "$REQUEST_TEST_SCENARIO" == loose-directory ]] && print 777 || print 700
    return
  }
  /usr/bin/stat -f '%OLp' "$1" 2>/dev/null
}

request_directory_is_symlink() {
  fixture_mode_enabled && [[ "$REQUEST_TEST_SCENARIO" == symlink-directory ]] && return 0
  [[ -L "$1" ]]
}

request_file_mode() {
  fixture_mode_enabled && { print 600; return; }
  /usr/bin/stat -f '%OLp' "$1" 2>/dev/null
}

request_is_symlink() {
  fixture_mode_enabled && [[ "$REQUEST_TEST_SCENARIO" == symlink ]] && return 0
  [[ -L "$1" ]]
}

request_was_processed() {
  local request_id="$1"
  if fixture_mode_enabled; then
    [[ "$REQUEST_TEST_SCENARIO" == reused || "$REQUEST_TEST_SCENARIO" == older-replay ]] && return 0
    return 1
  fi
  [[ -e "${PROCESSED_REQUEST_DIR}/${request_id}" ]]
}

plist_value() {
  /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null
}

request_key_count() {
  /usr/bin/plutil -convert xml1 -o - "$1" 2>/dev/null | /usr/bin/grep -c '<key>'
}

validate_request_directory() {
  local console_uid="$1" request_path="$2" request_dir
  request_dir="${request_path:A:h}"
  [[ "$console_uid" == <-> ]] || return 1
  if ! fixture_mode_enabled; then
    [[ "$request_path" == "${SYSTEM_ROOT}/ipc/${console_uid}/request.json" ]] || return 1
    [[ ! -L "${SYSTEM_ROOT}/ipc" ]] || return 1
    [[ "$(/usr/bin/stat -f '%u' "${SYSTEM_ROOT}/ipc" 2>/dev/null)" == 0 ]] || return 1
    [[ "$(/usr/bin/stat -f '%OLp' "${SYSTEM_ROOT}/ipc" 2>/dev/null)" == 755 ]] || return 1
  fi
  request_directory_is_symlink "$request_dir" && return 1
  [[ -d "$request_dir" ]] || return 1
  [[ "$(request_directory_uid "$request_dir")" == "$console_uid" ]] || return 1
  [[ "$(request_directory_mode "$request_dir")" == 700 ]] || return 1
}

stage_request_file() {
  local request_path="$1"
  if fixture_mode_enabled; then
    print -r -- "operation=stage-request"
    REQUEST_STAGED_PATH="$request_path"
    return 0
  fi
  /usr/bin/install -d -o root -g wheel -m 0700 "$REQUEST_INBOX_DIR" || return 1
  REQUEST_STAGED_PATH="${REQUEST_INBOX_DIR}/candidate-$$-${RANDOM}"
  [[ ! -e "$REQUEST_STAGED_PATH" && ! -L "$REQUEST_STAGED_PATH" ]] || return 1
  /bin/mv "$request_path" "$REQUEST_STAGED_PATH" || return 1
}

validate_staged_request_security() {
  local console_uid="$1" staged_path="$2"
  fixture_mode_enabled && print -r -- "operation=validate-staged-request"
  request_is_symlink "$staged_path" && return 1
  [[ -f "$staged_path" ]] || return 1
  [[ "$(request_file_uid "$staged_path")" == "$console_uid" ]] || return 1
  [[ "$(request_file_mode "$staged_path")" == 600 ]] || return 1
}

validate_request_payload() {
  local request_path="$1" key_count expected_keys schema_version created_at
  schema_version="$(plist_value "$request_path" schemaVersion || true)"
  REQUEST_TYPE="$(plist_value "$request_path" type || true)"
  REQUEST_ID="$(plist_value "$request_path" requestId || true)"
  created_at="$(plist_value "$request_path" createdAt || true)"
  REQUEST_VALUE=""

  [[ "$schema_version" == 1 ]] || return 1
  print -r -- "$REQUEST_ID" | /usr/bin/grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' || return 1
  print -r -- "$created_at" | /usr/bin/grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$' || return 1
  if ! fixture_mode_enabled; then
    local created_base created_seconds now_seconds
    created_base="${created_at%%.*}"
    created_base="${created_base%Z}Z"
    created_seconds="$(/bin/date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$created_base" '+%s' 2>/dev/null || true)"
    now_seconds="$(/bin/date +%s)"
    [[ -n "$created_seconds" ]] || return 1
    (( created_seconds <= now_seconds + 30 && created_seconds >= now_seconds - 300 )) || return 1
  fi

  case "$REQUEST_TYPE" in
    repairNow)
      expected_keys=4
      ;;
    setPaused|setAutoEnableAtBoot)
      expected_keys=5
      REQUEST_VALUE="$(plist_value "$request_path" value || true)"
      [[ "$REQUEST_VALUE" == true || "$REQUEST_VALUE" == false ]] || return 1
      ;;
    setLogLevel)
      expected_keys=5
      REQUEST_VALUE="$(plist_value "$request_path" value || true)"
      [[ "$REQUEST_VALUE" == standard || "$REQUEST_VALUE" == detailed ]] || return 1
      ;;
    *) return 1 ;;
  esac

  key_count="$(request_key_count "$request_path")"
  [[ "$key_count" == "$expected_keys" ]] || return 1
  request_was_processed "$REQUEST_ID" && return 1
  return 0
}

accept_request_file() {
  local request_path="$1"
  fixture_mode_enabled && {
    print -r -- "accepted=${REQUEST_TYPE}"
    return 0
  }

  REQUEST_CANONICAL_PATH="$(/usr/bin/mktemp "${REQUEST_INBOX_DIR}/accepted.XXXXXX")" || return 1
  /usr/bin/printf '%s\n' "{\"schemaVersion\":1,\"type\":\"${REQUEST_TYPE}\",\"requestId\":\"${REQUEST_ID}\",\"value\":\"${REQUEST_VALUE}\"}" >| "$REQUEST_CANONICAL_PATH" || return 1
  /usr/sbin/chown root:wheel "$REQUEST_CANONICAL_PATH" || return 1
  /bin/chmod 0600 "$REQUEST_CANONICAL_PATH" || return 1
  /bin/rm -f "$request_path"
}

mark_request_processed() {
  fixture_mode_enabled && return 0
  /usr/bin/install -d -o root -g wheel -m 0700 "$PROCESSED_REQUEST_DIR" || return 1
  local marker="${PROCESSED_REQUEST_DIR}/${REQUEST_ID}"
  ( set -C; : > "$marker" ) 2>/dev/null || return 1
  /usr/sbin/chown root:wheel "$marker" || return 1
  /bin/chmod 0600 "$marker" || return 1
  [[ -z "$REQUEST_CANONICAL_PATH" ]] || /bin/rm -f "$REQUEST_CANONICAL_PATH"
  REQUEST_CANONICAL_PATH=""
}

discard_staged_request() {
  [[ -z "$REQUEST_STAGED_PATH" ]] || /bin/rm -f "$REQUEST_STAGED_PATH"
  [[ -z "$REQUEST_CANONICAL_PATH" ]] || /bin/rm -f "$REQUEST_CANONICAL_PATH"
  REQUEST_STAGED_PATH=""
  REQUEST_CANONICAL_PATH=""
}

consume_request() {
  local console_uid="$1" request_path="$2"
  REQUEST_STAGED_PATH=""
  REQUEST_CANONICAL_PATH=""
  validate_request_directory "$console_uid" "$request_path" || return 1
  stage_request_file "$request_path" || return 1
  validate_staged_request_security "$console_uid" "$REQUEST_STAGED_PATH" || return 1
  validate_request_payload "$REQUEST_STAGED_PATH" || return 1
  accept_request_file "$REQUEST_STAGED_PATH"
}

run_request_test_scenario() {
  REQUEST_TEST_SCENARIO="$1"
  local fixture_file scenario_file expected_uid=501
  case "$REQUEST_TEST_SCENARIO" in
    unknown-field|unknown-type|reused) scenario_file="${REQUEST_TEST_SCENARIO}.json" ;;
    older-replay) scenario_file=reused.json ;;
    *) scenario_file=valid-repair.json ;;
  esac
  case "$REQUEST_TEST_SCENARIO" in
    valid-pause) scenario_file=valid-pause.json ;;
    valid-auto) scenario_file=valid-auto.json ;;
    valid-log) scenario_file=valid-log.json ;;
    valid-repair) scenario_file=valid-repair.json ;;
    non-console-user) expected_uid=503 ;;
  esac
  fixture_file="$(fixture_path "$scenario_file")"
  consume_request "$expected_uid" "$fixture_file"
}

if [[ "${1:-}" == --test-consume ]]; then
  run_request_test_scenario "${2:-}"
fi
