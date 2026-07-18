# Komika

Local-first comic reader for CBZ/ZIP, CBR/RAR, CB7/7z archives, image/video/audio folders, and standalone PDF or Markdown. Built with [Wails v3](https://v3.wails.io/) (Go backend + TypeScript frontend).

**Languages:** [English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md)

## Features

- Open **CBZ/ZIP**, **CBR/RAR**, **CB7/7z** archives, media folders, or a single image/GIF/video/audio/**PDF**/**Markdown** file
- Natural page order for images (PNG, JPEG, WebP, GIF), playable video (WebM, MP4, MOV), audio (MP3, M4A, AAC, OGG, Opus, WAV), multi-page **PDF**, and **Markdown** (`.md` / `.markdown`)
- Drag-and-drop one file or folder onto the window to open
- Pages up to **32 MiB** use in-memory RPC; larger media uses same-origin streaming. Archive members are temporarily extracted for seeking with both **2 GiB** per-entry and active-comic aggregate temp-cache limits. Deleting or moving an opened source makes its stream unavailable.
- **PDF**: each page is a reader page (pdf.js canvas); unreadable PDFs inside multi-entry sources are skipped
- **Markdown**: rendered with Merak (`merak-protocol-design-system/markdown`) as a scrollable article page
- View modes inspired by BandiView-style reading:
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

Fixtures under `testdata/reader-fixture/` and `testdata/media-fixture/` cover still images, animated GIF, and short WebM/MP4/MOV samples as folder, CBZ, 7z, and CBR sources. `testdata/docs-fixture/` holds sample PDF and Markdown. Standalone media/document files open as one-page (or multi-page PDF) **Media** sources. Video/audio playback depends on the host WebView codec stack (for example H.264/AAC and VP9/Vorbis); unsupported codecs show an in-reader error card. Encrypted and multi-volume archives are not supported. Dropping multiple files is rejected with a toast.

## Project layout

| Path | Role |
|------|------|
| `main.go` | App entry |
| `comic_service.go` | Wails bridge (open, pages, library) |
| `comic_source.go` | Archive/folder/media/document page sources |
| `media_stream.go` | Same-origin media streaming and temp extraction limits |
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
