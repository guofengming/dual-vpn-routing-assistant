#!/bin/zsh
set -euo pipefail

readonly DMG_PATH="${1:-}"
[[ -f "$DMG_PATH" ]] || { print -u2 "usage: $0 <universal.dmg>"; exit 2; }

readonly WORK_DIR="$(/usr/bin/mktemp -d /tmp/dual-vpn-verify.XXXXXX)"
readonly MOUNT_DIR="${WORK_DIR}/mount"
/bin/mkdir -p "$MOUNT_DIR"

cleanup() {
  /usr/bin/hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1 || true
  [[ "$WORK_DIR" == /tmp/dual-vpn-verify.* ]] && /bin/rm -rf "$WORK_DIR"
}
trap cleanup EXIT

/usr/bin/hdiutil attach "$DMG_PATH" -nobrowse -readonly -mountpoint "$MOUNT_DIR" -quiet
readonly APP_PATH="${MOUNT_DIR}/双 VPN 分流助手.app"
readonly BINARY_PATH="${APP_PATH}/Contents/MacOS/双 VPN 分流助手"
readonly RESOURCES_DIR="${APP_PATH}/Contents/Resources/daemon"

[[ -x "$BINARY_PATH" ]] || { print -u2 "app executable missing"; exit 1; }
architectures="$(/usr/bin/lipo -archs "$BINARY_PATH")"
[[ "$architectures" == *arm64* && "$architectures" == *x86_64* ]] || {
  print -u2 "not universal: $architectures"
  exit 1
}

minimum_system="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "${APP_PATH}/Contents/Info.plist")"
[[ "$minimum_system" == 13.0 ]] || { print -u2 "unexpected minimum macOS: $minimum_system"; exit 1; }

for required in VERSION daemon.sh install-helper.sh uninstall-helper.sh migrate-legacy.sh com.guofengming.dual-vpn-routing-assistant.plist; do
  [[ -e "${RESOURCES_DIR}/${required}" ]] || { print -u2 "missing daemon resource: $required"; exit 1; }
done
/usr/bin/plutil -extract Label raw -o - "${RESOURCES_DIR}/com.guofengming.dual-vpn-routing-assistant.plist" | \
  /usr/bin/grep -qx com.guofengming.dual-vpn-routing-assistant

checksum_file="${DMG_PATH:h}/SHA256SUMS.txt"
(cd "${DMG_PATH:h}" && /usr/bin/shasum -a 256 "${DMG_PATH:t}") >| "$checksum_file"
print -r -- "verified universal app (${architectures}); checksum: ${checksum_file}"
