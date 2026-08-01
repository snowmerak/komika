# Komika

Local-first comic reader for CBZ/ZIP, CBR/RAR, CB7/7z archives, image/video/audio folders, and standalone PDF or Markdown. Built with [Wails v3](https://v3.wails.io/) (Go backend + TypeScript frontend).

**Languages:** [English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md)

## Features

- Open **CBZ/ZIP**, **CBR/RAR**, **CB7/7z** archives, media folders, or a single image/GIF/video/audio/**PDF**/**Markdown** file
- Natural page order for images (PNG, JPEG, WebP, GIF), playable video (WebM, MP4, MOV), audio (MP3, M4A, AAC, OGG, Opus, WAV), multi-page **PDF**, and **Markdown** (`.md` / `.markdown`)
- Drag-and-drop one file or folder onto the window to open
- Pages up to **32 MiB** use in-memory RPC; larger media uses same-origin streaming. CBZ/ZIP pages reuse one random-access index, while RAR/7z RPC pages are demand-extracted once into a per-open **1 GiB** disk read cache and reused. Archive members streamed for seeking retain both **2 GiB** per-entry and active-comic aggregate temp-cache limits. Temporary caches are removed when the work is closed. Deleting or moving an opened source makes uncached content unavailable.
- The reader preloads and retains a **±10 page** window around the active page (complete spreads in double-page modes); video, audio, and non-PDF stream pages remain visible-only.
- **PDF**: each page is a reader page (pdf.js canvas); unreadable PDFs inside multi-entry sources are skipped
- **Markdown**: rendered with Merak (`merak-protocol-design-system/markdown`) as a scrollable article page
- View modes:
  - Fit window / fit width / fit height / original 100%
  - Double page **LTR** / **RTL**
  - Continuous **webtoon** strip
- Stretch small images (fit modes only)
- Image scaling: **Smooth** (default), **High quality** (Lanczos-3), **NoHalo**, or **xBRZ** on the settled viewport tile after zoom/pan; **Pixelated** for stills; GIFs ignore canvas filters and stay animated.
- Manual zoom (25–800%, webtoon up to 200%) and pan (wheel / Alt+drag when content overflows)
- Double-click the reader title/toolbar chrome to maximize or restore the window
- Collapse the reader toolbar (floating toggle or `T`); remembered in `localStorage`
- Keyboard shortcuts for navigation and mode switching
- Per-work resume progress

### Library & privacy
- Recent works list (up to 20) with resume
- Optional saving of recents/progress
- Retention: keep forever, or 7 / 30 / 90 days
- Remove one, remove selected, or clear all
- Disable saving clears history after confirmation

Preferences for view mode/stretch/image scaling and toolbar collapse are stored in `localStorage`. Recent history lives in the host config dir:

`${os.UserConfigDir()}/komika/library.json`

## Requirements

- Go (see `go.mod`)
- Node.js + npm
- [Wails v3](https://v3.wails.io/) CLI (`wails3`)
- [Task](https://taskfile.dev/) is **not** required separately: use `wails3 task …`, which runs the repo `Taskfile.yml` graph

### Linux video codecs (H.264 / AAC)

VLC can play a file while Komika cannot: VLC uses its own codecs; Komika uses **WebKitGTK → GStreamer**.

| Runtime | Notes |
|---------|--------|
| `bin/komika` / native packages (`.deb` / `.rpm` / AUR) | Uses **host** GStreamer. Install the packages below for H.264/AAC. |
| AppImage | Bundles a minimal GStreamer plugin set + scanner (via `inject-gst-plugins.sh` after `wails3 generate appimage`). Rebuild with `task package` / `wails3 task package` so plugins are included. |

**Package names by distro** (runtime for unbundled / package installs; also needed on the **AppImage build host** so inject can copy plugins):

**Debian / Ubuntu**

```bash
# required for WebView H.264/AAC
sudo apt install gstreamer1.0-libav gstreamer1.0-plugins-good
# recommended
sudo apt install gstreamer1.0-plugins-base gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly gstreamer1.0-tools ffmpeg
```

**Fedora**

```bash
# required (WebView H.264/AAC via GStreamer)
sudo dnf install gstreamer1-plugin-libav gstreamer1-plugins-good
# recommended (default Fedora repos — limited ffmpeg build)
sudo dnf install gstreamer1-plugins-base gstreamer1-plugins-bad-free \
  gstreamer1-plugins-ugly-free gstreamer1-plugins-base-tools ffmpeg-free
```

For a fuller `ffmpeg` (and some extra codecs) enable [RPM Fusion](https://rpmfusion.org/Configuration), then **swap** (do not install alongside `ffmpeg-free`):

```bash
sudo dnf swap ffmpeg-free ffmpeg --allowerasing
```


**Arch Linux**

```bash
# required
sudo pacman -S gst-libav gst-plugins-good
# recommended
sudo pacman -S gst-plugins-base gst-plugins-bad gst-plugins-ugly \
  gstreamer ffmpeg
```

**Optional check** (any distro with `gst-launch-1.0` / `gst-inspect-1.0`):

```bash
gst-inspect-1.0 avdec_h264 >/dev/null && gst-inspect-1.0 avdec_aac >/dev/null && echo GST_CODECS_OK
gst-launch-1.0 -q playbin uri=file://$PWD/testdata/media-fixture/8-video.mp4 \
  video-sink=fakesink audio-sink=fakesink && echo GST_PLAY_OK
```

Native packages declare hard depends on the **required** set (`libav` + `plugins-good` / distro equivalents). `ffmpeg` is recommended for host transcoder fallback when WebView still cannot decode a clip.


## Supported platforms

- Windows (amd64, arm64)
- Linux (amd64, arm64)
- macOS Apple Silicon (arm64)

## Task workflow

Komika is driven through the root Taskfile. Prefer these entry points over ad-hoc `go`/`npm`/`wails3` one-offs.

```bash
# Dev app (frontend + backend hot reload)
wails3 task dev

# Production binary for the host OS → bin/komika
wails3 task build

# Package for the host OS
wails3 task package

# Run the last production build for the host OS
wails3 task run

# Backend race tests + frontend viewer tests
wails3 task test

# Regenerate TypeScript bindings only
wails3 task common:generate:bindings
```

Cross-compile / platform package examples:

```bash
wails3 task build GOOS=darwin
wails3 task build GOOS=windows
wails3 task build GOOS=linux
wails3 task package GOOS=darwin
```

### Docker packaging (Debian 13 images)

Full Linux AppImage/deb/rpm/aur and Windows NSIS packaging can run inside multi-arch
`komika-package` images (`debian:trixie`) so you do not need a matching host toolchain.
Binary-only cross builds still use `wails3 task setup:docker` → `wails-cross`.

```bash
# Build the packaging image for one arch (repeat for the other if needed)
wails3 task package:docker:setup ARCH=amd64
wails3 task package:docker:setup ARCH=arm64

# Linux packages (task uses komika-package:$ARCH + --platform linux/$ARCH;
# AppImage/GST inject also require container CPU arch == ARCH)
wails3 task package:docker GOOS=linux ARCH=amd64   # → bin/komika-x86_64.AppImage, .deb, …
wails3 task package:docker GOOS=linux ARCH=arm64   # → bin/komika-aarch64.AppImage, …

# Windows NSIS (pure Go + makensis; task still requires komika-package:$ARCH)
wails3 task package:docker GOOS=windows ARCH=amd64  # needs image :amd64 → installer
wails3 task package:docker GOOS=windows ARCH=arm64  # needs image :arm64 → installer
```

Artifacts land on the host under `bin/` via the repo bind mount. Non-host arch needs
qemu/binfmt (Docker Desktop or `tonistiigi/binfmt`). Under qemu, static-pie AppImage
tools are run via `run-appimage` / `qemu-user-static` inside the image.

Manual equivalent:

```bash
docker run --rm --platform linux/amd64 -v "$PWD:/src" -w /src \
  -e APPIMAGE_EXTRACT_AND_RUN=1 komika-package:amd64 \
  komika-package linux amd64
```

Optional server-mode helpers (no native GUI):

```bash
wails3 task build:server
wails3 task run:server
wails3 task build:docker
wails3 task run:docker
```

Frontend-only scripts still live under `frontend/` when you need them outside the full app task graph:

```bash
cd frontend
npm install
npm run dev          # Vite only
npm run build        # production frontend bundle
npm run test:viewer  # pure viewer math / mediaKind tests
```

## Tests

```bash
# Preferred: full test task (Go race suite + viewer unit tests)
wails3 task test
```

Bindings and the production frontend bundle are regenerated as part of `wails3 task build`.

Fixtures under `testdata/reader-fixture/` and `testdata/media-fixture/` cover still images, animated GIF, and short WebM/MP4/MOV samples as folder, CBZ, 7z, and CBR sources. `testdata/docs-fixture/` holds sample PDF and Markdown. Standalone media/document files open as one-page (or multi-page PDF) **Media** sources. Video/audio: host WebView codecs first (Linux WebKitGTK needs **GStreamer** libav + good/bad/ugly for H.264/AAC — installed as package **depends** on deb/rpm). Fallback: system **ffmpeg** transcoder (`PATH` / `$FFMPEG` / common paths; small clips ≤12 MiB may use bundled **ffmpeg.wasm**). If WebView fails while VLC works, install GStreamer libav/good (and ffmpeg); AppImage builds can still miss host plugins — then use host `ffmpeg` fallback or a native `.deb`. Encrypted and multi-volume archives are not supported. Dropping multiple files is rejected with a toast.

## Project layout

| Path | Role |
|------|------|
| `main.go` | App entry |
| `comic_service.go` | Wails bridge (open, pages, library) |
| `comic_source.go` | Archive/folder/media/document page sources |
| `archive_read_cache.go` | ZIP direct reads and demand-driven RAR/7z page cache |
| `media_stream.go` | Same-origin media streaming and temp extraction limits |
| `media_transcode.go` | ffmpeg fallback transcode cache for unsupported WebView codecs |
| `library_store.go` | Recent list, settings, TTL, atomic JSON |
| `frontend/src/main.ts` | Library UI + mode-aware reader |
| `frontend/src/viewer.ts` | Pure view math (scale, pan, spreads, cache, media kinds) |
| `frontend/src/pdf_render.ts` | pdf.js document cache and per-page canvas attach |
| `frontend/src/upscale.ts` | Viewport-tile pure filters: Lanczos-3, NoHalo, xBRZ |
| `frontend/src/style.css` | Reader/library styles (Merak tokens) |
| `frontend/bindings/` | Generated Wails TypeScript bindings |
| `testdata/` | Reader fixtures |

## Keyboard (reader)

| Key | Action |
|-----|--------|
| Arrows / WASD / Space / PageUp·Down | Page turn; in webtoon, scroll ~65% viewport (Shift: page jump) |
| Home / End | First / last page |
| `+` / `-` (Shift: fine) | Zoom |
| `0` | Original 100% |
| `1` / `9` | Fit window |
| `8` | Fit width |
| `H` | Fit height |
| `7` / `6` | Double LTR / RTL |
| `5` | Webtoon |
| `Z` | Toggle stretch small images |
| `T` | Toggle reader toolbar |

## License

No license file is included in this repository yet. Add one if you distribute the app.
