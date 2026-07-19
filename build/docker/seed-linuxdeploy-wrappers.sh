#!/bin/sh
# Seed shell wrappers at build/linux/appimage/build/linuxdeploy-*.AppImage so
# `wails3 generate appimage` (which skips download when the path exists) runs
# through run-appimage / qemu-user-static instead of a bare static-pie AppImage.
set -eu

build_dir=${1:-/src/build/linux/appimage/build}
mkdir -p "$build_dir"

seed_one() {
	arch=$1
	wrap="$build_dir/linuxdeploy-${arch}.AppImage"
	real="$build_dir/linuxdeploy-${arch}.AppImage.real"

	# Preserve a previously downloaded real AppImage.
	if [ -f "$wrap" ] && ! head -c 2 "$wrap" | grep -q '#!'; then
		mv -f "$wrap" "$real"
	fi

	cat >"$wrap" <<EOF
#!/bin/sh
set -eu
DIR=\$(CDPATH= cd -- "\$(dirname "\$0")" && pwd)
REAL="\$DIR/linuxdeploy-${arch}.AppImage.real"
URL="https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-${arch}.AppImage"
if [ ! -f "\$REAL" ]; then
	echo "seed-linuxdeploy: downloading linuxdeploy-${arch}.AppImage" >&2
	wget -q -O "\$REAL" "\$URL"
	chmod +x "\$REAL"
fi
if command -v run-appimage >/dev/null 2>&1; then
	exec run-appimage "\$REAL" "\$@"
fi
exec "\$REAL" "\$@"
EOF
	chmod +x "$wrap"
}

seed_one x86_64
seed_one aarch64
