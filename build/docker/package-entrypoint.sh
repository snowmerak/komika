#!/bin/sh
# Usage: komika-package <linux|windows> <amd64|arm64>
set -eu

usage() {
  echo "Usage: komika-package <linux|windows> <amd64|arm64>" >&2
  exit 1
}

if [ "$#" -ne 2 ]; then
  usage
fi

GOOS=$1
ARCH=$2

case "$GOOS" in
  linux|windows) ;;
  *) usage ;;
esac

case "$ARCH" in
  amd64|arm64) ;;
  *) usage ;;
esac

if [ "$GOOS" = "linux" ]; then
  host_m=$(uname -m)
  case "$ARCH" in
    amd64)
      case "$host_m" in
        x86_64|amd64) ;;
        *)
          echo "linux package requires container arch amd64 (uname -m=$host_m)." >&2
          echo "Rebuild/run with: docker run --platform linux/amd64 ... komika-package:amd64" >&2
          exit 2
          ;;
      esac
      ;;
    arm64)
      case "$host_m" in
        aarch64|arm64) ;;
        *)
          echo "linux package requires container arch arm64 (uname -m=$host_m)." >&2
          echo "Rebuild/run with: docker run --platform linux/arm64 ... komika-package:arm64" >&2
          exit 2
          ;;
      esac
      ;;
  esac
fi


# wails3 generate appimage execs linuxdeploy-*.AppImage from the build dir.
# Under qemu, static-pie AppImage runtimes often hit exec format error — seed
# shell wrappers that delegate to run-appimage / qemu-user-static.
if [ "$GOOS" = "linux" ]; then
  seed-linuxdeploy-wrappers /src/build/linux/appimage/build
fi
cd /src
export APPIMAGE_EXTRACT_AND_RUN="${APPIMAGE_EXTRACT_AND_RUN:-1}"

echo "komika-package: wails3 task package GOOS=$GOOS ARCH=$ARCH"
wails3 task package "GOOS=$GOOS" "ARCH=$ARCH"

# The platform Taskfiles intentionally use their conventional generic names
# while packaging. Preserve a target-qualified copy so package:docker:all does
# not let the later architecture overwrite the earlier raw executable.
case "$GOOS" in
  linux)
    cp -f "/src/bin/komika" "/src/bin/komika-linux-$ARCH"
    ;;
  windows)
    cp -f "/src/bin/komika.exe" "/src/bin/komika-windows-$ARCH.exe"
    ;;
esac

echo
echo "Expected primary artifacts under /src/bin (host ./bin):"
case "$GOOS-$ARCH" in
  linux-amd64)
    echo "  bin/komika"
    echo "  bin/komika-linux-amd64"
    echo "  bin/komika-x86_64.AppImage"
    echo "  bin/komika*.deb (and rpm/aur if nfpm succeeds)"
    ;;
  linux-arm64)
    echo "  bin/komika"
    echo "  bin/komika-linux-arm64"
    echo "  bin/komika-aarch64.AppImage"
    echo "  bin/komika*.deb (and rpm/aur if nfpm succeeds)"
    ;;
  windows-amd64)
    echo "  bin/komika.exe"
    echo "  bin/komika-windows-amd64.exe"
    echo "  bin/komika-amd64-installer.exe"
    ;;
  windows-arm64)
    echo "  bin/komika.exe"
    echo "  bin/komika-windows-arm64.exe"
    echo "  bin/komika-arm64-installer.exe"
    ;;
esac
