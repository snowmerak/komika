#!/usr/bin/env bash
# Inject GStreamer codec plugins + scanner into a finished Komika AppImage.
# wails3 generate appimage ships libgstreamer without codec plugins.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
APPIMAGE="${1:-${ROOT_DIR}/bin/komika-x86_64.AppImage}"
WORK="$(mktemp -d /tmp/komika-ai-gst-XXXXXX)"
cleanup() { rm -rf "${WORK}"; }
trap cleanup EXIT

# Prefer run-appimage when present (Docker packaging under qemu). Falls back to
# direct exec on native hosts.
run_ai() {
  if command -v run-appimage >/dev/null 2>&1; then
    run-appimage "$@"
  else
    "$@"
  fi
}

if [[ ! -f "${APPIMAGE}" ]]; then
  echo "AppImage not found: ${APPIMAGE}" >&2
  exit 1
fi

echo "Injecting GStreamer plugins into ${APPIMAGE}"

cd "${WORK}"
chmod +x "${APPIMAGE}"
run_ai "${APPIMAGE}" --appimage-extract >/dev/null
APPDIR="${WORK}/squashfs-root"
if [[ ! -d "${APPDIR}" ]]; then
  echo "extract failed" >&2
  exit 1
fi

host_arch_lib=""
for d in /usr/lib/x86_64-linux-gnu /usr/lib/aarch64-linux-gnu /usr/lib64 /usr/lib; do
  if [[ -d "${d}/gstreamer-1.0" ]]; then
    host_arch_lib="${d}"
    break
  fi
done
if [[ -z "${host_arch_lib}" ]]; then
  echo "No host gstreamer-1.0 directory found" >&2
  exit 1
fi

BUNDLE_GST_DIR="${APPDIR}/usr/lib/gstreamer-1.0"
BUNDLE_LIB_DIR="${APPDIR}/usr/lib"
BUNDLE_SCANNER_DIR="${APPDIR}/usr/lib/gstreamer1.0/gstreamer-1.0"
mkdir -p "${BUNDLE_GST_DIR}" "${BUNDLE_LIB_DIR}" "${BUNDLE_SCANNER_DIR}"
HOST_GST_DIR="${host_arch_lib}/gstreamer-1.0"

REQUIRED_PLUGINS=(
  libgstcoreelements.so
  libgstplayback.so
  libgsttypefindfunctions.so
  libgstapp.so
  libgstlibav.so
  libgstisomp4.so
  libgstvideoparsersbad.so
  libgstaudioparsers.so
)
OPTIONAL_PLUGINS=(
  libgstcoretracers.so
  libgstvideoconvertscale.so
  libgstvideofilter.so
  libgstvideoscale.so
  libgstvideoconvert.so
  libgstaudioconvert.so
  libgstaudioresample.so
  libgstvolume.so
  libgstautodetect.so
  libgstpulseaudio.so
  libgstalsa.so
  libgstavi.so
  libgstmatroska.so
  libgstogg.so
  libgstopus.so
  libgstvorbis.so
  libgstvpx.so
  libgstsoup.so
  libgsttcp.so
  libgstid3demux.so
  libgsticydemux.so
)

for plug in "${REQUIRED_PLUGINS[@]}"; do
  if [[ ! -f "${HOST_GST_DIR}/${plug}" ]]; then
    echo "Required GStreamer plugin missing on build host: ${plug}" >&2
    echo "Install: gstreamer1.0-libav gstreamer1.0-plugins-good gstreamer1.0-plugins-base gstreamer1.0-plugins-bad" >&2
    exit 1
  fi
  cp -aL "${HOST_GST_DIR}/${plug}" "${BUNDLE_GST_DIR}/${plug}"
done
for plug in "${OPTIONAL_PLUGINS[@]}"; do
  if [[ -f "${HOST_GST_DIR}/${plug}" ]]; then
    cp -aL "${HOST_GST_DIR}/${plug}" "${BUNDLE_GST_DIR}/${plug}"
  fi
done

SCANNER_SRC=""
for scanner in \
  "${host_arch_lib}/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner" \
  /usr/libexec/gstreamer-1.0/gst-plugin-scanner
do
  if [[ -x "${scanner}" ]]; then
    SCANNER_SRC="${scanner}"
    break
  fi
done
if [[ -z "${SCANNER_SRC}" ]]; then
  echo "gst-plugin-scanner not found on build host" >&2
  exit 1
fi
cp -aL "${SCANNER_SRC}" "${BUNDLE_SCANNER_DIR}/gst-plugin-scanner"
chmod +x "${BUNDLE_SCANNER_DIR}/gst-plugin-scanner"
# WebKit/GStreamer probes multiarch helper paths relative to libgstreamer.
# Copy the real binary (no fragile relative symlinks).
# Canonical multiarch locations (real files, not symlinks).
for multi in \
  "${APPDIR}/usr/lib/x86_64-linux-gnu/gstreamer1.0/gstreamer-1.0" \
  "${APPDIR}/usr/lib/aarch64-linux-gnu/gstreamer1.0/gstreamer-1.0" \
  "${APPDIR}/lib/x86_64-linux-gnu/gstreamer1.0/gstreamer-1.0" \
  "${APPDIR}/lib/aarch64-linux-gnu/gstreamer1.0/gstreamer-1.0"
do
  mkdir -p "${multi}"
  rm -f "${multi}/gst-plugin-scanner"
  cp -aL "${BUNDLE_SCANNER_DIR}/gst-plugin-scanner" "${multi}/gst-plugin-scanner"
  chmod +x "${multi}/gst-plugin-scanner"
done
# Assert the exact path seen in WebKit error logs resolves.
for probe in \
  "${APPDIR}/lib/x86_64-linux-gnu/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner" \
  "${APPDIR}/usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner"
do
  if [[ ! -x "${probe}" ]]; then
    echo "scanner missing at ${probe}" >&2
    exit 1
  fi
done

copy_so_deps() {
  local so="$1"
  [[ -f "${so}" ]] || return 0
  while read -r lib; do
    [[ -n "${lib}" && -f "${lib}" ]] || continue
    local base
    base="$(basename "${lib}")"
    case "${base}" in
      libc.so.*|libm.so.*|libpthread.so.*|libdl.so.*|librt.so.*|ld-linux*.so.*|libresolv.so.*|libstdc++.so.*)
        continue ;;
    esac
    if [[ ! -e "${BUNDLE_LIB_DIR}/${base}" ]]; then
      cp -aL "${lib}" "${BUNDLE_LIB_DIR}/${base}" || true
    fi
  done < <(ldd "${so}" 2>/dev/null | awk '/=> \// {print $3} /^\// {print $1}')
}

for _ in 1 2 3 4; do
  shopt -s nullglob
  for so in "${BUNDLE_GST_DIR}"/*.so "${BUNDLE_SCANNER_DIR}"/gst-plugin-scanner "${BUNDLE_LIB_DIR}"/*.so*; do
    copy_so_deps "${so}"
  done
  shopt -u nullglob
done

test -f "${BUNDLE_GST_DIR}/libgstlibav.so"
test -f "${BUNDLE_GST_DIR}/libgstisomp4.so"
test -x "${BUNDLE_SCANNER_DIR}/gst-plugin-scanner"
plugin_count="$(find "${BUNDLE_GST_DIR}" -name '*.so' | wc -l)"
echo "Bundled ${plugin_count} GStreamer plugins"
if [[ "${plugin_count}" -lt 8 ]]; then
  echo "Too few plugins bundled: ${plugin_count}" >&2
  exit 1
fi

mkdir -p "${APPDIR}/apprun-hooks"
cat > "${APPDIR}/apprun-hooks/gst-plugins.sh" <<'EOF'
# AppDir-only GStreamer plugins (no host mix — avoids ABI mismatch).
_gst_bundle="${APPDIR}/usr/lib/gstreamer-1.0"
_scanner="${APPDIR}/usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner"
if [ -d "${_gst_bundle}" ]; then
  export GST_PLUGIN_SYSTEM_PATH_1_0="${_gst_bundle}"
  export GST_PLUGIN_PATH="${_gst_bundle}"
  unset GST_PLUGIN_SYSTEM_PATH 2>/dev/null || true
fi
if [ -x "${_scanner}" ]; then
  export GST_PLUGIN_SCANNER="${_scanner}"
  export GST_PLUGIN_SCANNER_1_0="${_scanner}"
fi
if [ -n "${XDG_CACHE_HOME:-}" ]; then
  export GST_REGISTRY="${XDG_CACHE_HOME}/komika/gst-registry.bin"
else
  export GST_REGISTRY="${HOME}/.cache/komika/gst-registry.bin"
fi
mkdir -p "$(dirname "${GST_REGISTRY}")" 2>/dev/null || true
EOF

# Shell AppRun: ensure hooks are sourced.
APPRUN="${APPDIR}/AppRun"
if [[ -f "${APPRUN}" ]] && head -c 64 "${APPRUN}" | grep -q '^#!'; then
  if ! grep -q 'apprun-hooks' "${APPRUN}"; then
    tmp="$(mktemp)"
    {
      head -n 1 "${APPRUN}"
      cat <<'HOOK'
# Load AppRun hooks (GStreamer plugins, etc.)
if [ -d "${APPDIR}/apprun-hooks" ]; then
  for _hook in "${APPDIR}/apprun-hooks"/*.sh; do
    [ -f "${_hook}" ] && . "${_hook}"
  done
fi
HOOK
      tail -n +2 "${APPRUN}"
    } > "${tmp}"
    mv "${tmp}" "${APPRUN}"
    chmod +x "${APPRUN}"
  fi
fi

# Pre-repack self-check against bundled plugins only.
export LD_LIBRARY_PATH="${BUNDLE_LIB_DIR}${LD_LIBRARY_PATH:+:}${LD_LIBRARY_PATH:-}"
export GST_PLUGIN_PATH="${BUNDLE_GST_DIR}"
export GST_PLUGIN_SYSTEM_PATH_1_0="${BUNDLE_GST_DIR}"
export GST_PLUGIN_SCANNER="${BUNDLE_SCANNER_DIR}/gst-plugin-scanner"
export GST_PLUGIN_SCANNER_1_0="${BUNDLE_SCANNER_DIR}/gst-plugin-scanner"
export GST_REGISTRY="${WORK}/check-registry.bin"
rm -f "${GST_REGISTRY}"
if ! command -v gst-inspect-1.0 >/dev/null; then
  echo "gst-inspect-1.0 required on build host (apt install gstreamer1.0-tools)" >&2
  exit 1
fi
gst-inspect-1.0 avdec_h264 >/dev/null
gst-inspect-1.0 qtdemux >/dev/null
echo "gst-inspect OK (avdec_h264, qtdemux) against bundled plugins"

OUT_TMP="${WORK}/komika-gst.AppImage"
arch="$(uname -m)"
case "${arch}" in
  x86_64|amd64) at_arch=x86_64 ;;
  aarch64|arm64) at_arch=aarch64 ;;
  *) echo "unsupported arch ${arch}" >&2; exit 1 ;;
esac

if command -v appimagetool >/dev/null; then
  ARCH="${at_arch}" appimagetool "${APPDIR}" "${OUT_TMP}"
else
  AT="${WORK}/appimagetool.AppImage"
  wget -q -O "${AT}" "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-${at_arch}.AppImage"
  chmod +x "${AT}"
  ARCH="${at_arch}" run_ai "${AT}" --appimage-extract-and-run "${APPDIR}" "${OUT_TMP}"
fi

test -f "${OUT_TMP}"
chmod +x "${OUT_TMP}"
cp -a "${OUT_TMP}" "${APPIMAGE}"
echo "Wrote ${APPIMAGE} ($(du -h "${APPIMAGE}" | awk '{print $1}'))"
