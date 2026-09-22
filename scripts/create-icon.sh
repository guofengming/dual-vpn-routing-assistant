#!/bin/zsh
set -euo pipefail

readonly SCRIPT_PATH="${0:A}"
readonly PROJECT_ROOT="${SCRIPT_PATH:h:h}"
readonly SOURCE_SVG="${PROJECT_ROOT}/build/icon.svg"
readonly ICONSET_DIR="${PROJECT_ROOT}/build/AppIcon.iconset"
readonly BASE_PNG="${PROJECT_ROOT}/build/icon-1024.png"
readonly OUTPUT_ICNS="${PROJECT_ROOT}/build/icon.icns"

[[ -r "$SOURCE_SVG" ]] || { print -u2 "missing $SOURCE_SVG"; exit 1; }
/bin/rm -rf "$ICONSET_DIR"
/bin/mkdir -p "$ICONSET_DIR"

if ! /usr/bin/sips -s format png "$SOURCE_SVG" --out "$BASE_PNG" >/dev/null 2>&1; then
  readonly PREVIEW_DIR="$(/usr/bin/mktemp -d /tmp/dual-vpn-icon.XXXXXX)"
  trap '/bin/rm -rf "$PREVIEW_DIR"' EXIT
  /usr/bin/qlmanage -t -s 1024 -o "$PREVIEW_DIR" "$SOURCE_SVG" >/dev/null 2>&1
  /bin/cp "${PREVIEW_DIR}/icon.svg.png" "$BASE_PNG"
fi

for size in 16 32 128 256 512; do
  /usr/bin/sips -z "$size" "$size" "$BASE_PNG" --out "${ICONSET_DIR}/icon_${size}x${size}.png" >/dev/null
  double=$(( size * 2 ))
  /usr/bin/sips -z "$double" "$double" "$BASE_PNG" --out "${ICONSET_DIR}/icon_${size}x${size}@2x.png" >/dev/null
done

/usr/bin/iconutil -c icns "$ICONSET_DIR" -o "$OUTPUT_ICNS"
/bin/rm -rf "$ICONSET_DIR"
/bin/rm -f "$BASE_PNG"
print -r -- "$OUTPUT_ICNS"
