#!/usr/bin/env bash
# Copyright (c) 2018-Present Lea Anthony
# SPDX-License-Identifier: MIT

# Fail script on any error
set -euxo pipefail

# Define variables
APP_DIR="${APP_NAME}.AppDir"

# Create AppDir structure
mkdir -p "${APP_DIR}/usr/bin"
cp -r "${APP_BINARY}" "${APP_DIR}/usr/bin/"
cp "${ICON_PATH}" "${APP_DIR}/"
cp "${DESKTOP_FILE}" "${APP_DIR}/"

# ---------------------------------------------------------------------------
# GStreamer plugins for WebKitGTK <video> (AppImage)
#
# Evidence (Debian host):
# - unbundled bin/komika + host gstreamer1.0-libav/good: H.264/AAC plays
# - stock AppImage: libgstreamer present, zero gstreamer-1.0/*.so → WebView fails
#   even when VLC works
#
# Do NOT point a bundled libgstreamer at host plugin dirs (ABI mismatch).
# Bundle scanner + selected plugin DSOs + transitive .so deps into AppDir, and
# set GST_* exclusively to AppDir paths.
# ---------------------------------------------------------------------------
host_arch_lib=""
for d in \
  /usr/lib/x86_64-linux-gnu \
  /usr/lib/aarch64-linux-gnu \
  /usr/lib64 \
  /usr/lib
do
  if [[ -d "${d}/gstreamer-1.0" ]]; then
    host_arch_lib="${d}"
    break
  fi
done

BUNDLE_GST_DIR="${APP_DIR}/usr/lib/gstreamer-1.0"
BUNDLE_LIB_DIR="${APP_DIR}/usr/lib"
BUNDLE_SCANNER_DIR="${APP_DIR}/usr/lib/gstreamer1.0/gstreamer-1.0"
mkdir -p "${BUNDLE_GST_DIR}" "${BUNDLE_LIB_DIR}" "${BUNDLE_SCANNER_DIR}"

copy_so_deps() {
  local so="$1"
  [[ -f "${so}" ]] || return 0
  # ldd resolves NEEDED; copy each real file into AppDir/usr/lib.
  while read -r lib; do
    [[ -n "${lib}" && -f "${lib}" ]] || continue
    local base
    base="$(basename "${lib}")"
    case "${base}" in
      libc.so.*|libm.so.*|libpthread.so.*|libdl.so.*|librt.so.*|ld-linux*.so.*|libresolv.so.*|libstdc++.so.*)
        continue
        ;;
    esac
    if [[ ! -e "${BUNDLE_LIB_DIR}/${base}" ]]; then
      cp -aL "${lib}" "${BUNDLE_LIB_DIR}/${base}" || true
    fi
  done < <(ldd "${so}" 2>/dev/null | awk '/=> \// {print $3} /^\// {print $1}')
}

if [[ -n "${host_arch_lib}" ]]; then
  HOST_GST_DIR="${host_arch_lib}/gstreamer-1.0"

  # Minimal plugin set for playbin + MP4/H.264/AAC + basic sinks.
  PLUGINS=(
    libgstcoreelements.so
    libgstcoretracers.so
    libgstplayback.so
    libgsttypefindfunctions.so
    libgstapp.so
    libgstlibav.so
    libgstisomp4.so
    libgstvideoparsersbad.so
    libgstaudioparsers.so
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

  for plug in "${PLUGINS[@]}"; do
    if [[ -f "${HOST_GST_DIR}/${plug}" ]]; then
      cp -aL "${HOST_GST_DIR}/${plug}" "${BUNDLE_GST_DIR}/${plug}"
    fi
  done

  # gst-plugin-scanner is required to register plugins at runtime.
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
  if [[ -n "${SCANNER_SRC}" ]]; then
    cp -aL "${SCANNER_SRC}" "${BUNDLE_SCANNER_DIR}/gst-plugin-scanner"
    chmod +x "${BUNDLE_SCANNER_DIR}/gst-plugin-scanner"
  fi

  # Transitive deps for plugins + scanner (repeat until stable).
  for _ in 1 2 3 4; do
    shopt -s nullglob
    for so in "${BUNDLE_GST_DIR}"/*.so "${BUNDLE_SCANNER_DIR}"/gst-plugin-scanner "${BUNDLE_LIB_DIR}"/*.so*; do
      copy_so_deps "${so}"
    done
    shopt -u nullglob
  done
fi

mkdir -p "${APP_DIR}/apprun-hooks"
cat > "${APP_DIR}/apprun-hooks/gst-plugins.sh" <<'EOF'
# Sourced by linuxdeploy AppRun. AppDir-only GStreamer plugin path (no host mix).
_gst_bundle="${APPDIR}/usr/lib/gstreamer-1.0"
_scanner="${APPDIR}/usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner"

if [ -d "${_gst_bundle}" ]; then
  export GST_PLUGIN_SYSTEM_PATH_1_0="${_gst_bundle}"
  export GST_PLUGIN_PATH="${_gst_bundle}"
  # Prevent accidental host registry / path bleed.
  unset GST_PLUGIN_SYSTEM_PATH || true
fi
if [ -x "${_scanner}" ]; then
  # Both names seen across GStreamer versions.
  export GST_PLUGIN_SCANNER="${_scanner}"
  export GST_PLUGIN_SCANNER_1_0="${_scanner}"
fi
# Per-user registry under XDG cache so rebuilds don't fight host registry.
if [ -n "${XDG_CACHE_HOME:-}" ]; then
  export GST_REGISTRY="${XDG_CACHE_HOME}/komika/gst-registry.bin"
else
  export GST_REGISTRY="${HOME}/.cache/komika/gst-registry.bin"
fi
mkdir -p "$(dirname "${GST_REGISTRY}")" 2>/dev/null || true
EOF

if [[ $(uname -m) == *x86_64* ]]; then
    # Download linuxdeploy and make it executable
    wget -q -4 -N https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-x86_64.AppImage
    chmod +x linuxdeploy-x86_64.AppImage

    # Run linuxdeploy to bundle the application
    ./linuxdeploy-x86_64.AppImage --appdir "${APP_DIR}" --output appimage
else
    # Download linuxdeploy and make it executable (arm64)
    wget -q -4 -N https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-aarch64.AppImage
    chmod +x linuxdeploy-aarch64.AppImage

    # Run linuxdeploy to bundle the application (arm64)
    ./linuxdeploy-aarch64.AppImage --appdir "${APP_DIR}" --output appimage
fi

# Rename the generated AppImage
mv ${APP_NAME}*.AppImage "${APP_NAME}.AppImage"
