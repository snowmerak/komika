# Komika

CBZ/ZIP, CBR/RAR, CB7/7z 아카이브, 이미지/동영상/오디오: 호스트 WebView 코덱 우선(Linux WebKitGTK는 **GStreamer** libav/good/bad/ugly 필요 — deb 의존성). 폴백: 시스템 **ffmpeg**(PATH/`$FFMPEG`; ≤12 MiB는 wasm 가능). VLC는 되고 WebView만 안 되면 GStreamer/WebKit 경로 문제일 수 있습니다. `.deb` 또는 호스트 `ffmpeg` 폴백을 검토하세요.

**언어:** [English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md)

## 기능

### 읽기
- **CBZ/ZIP**, **CBR/RAR**, **CB7/7z** 아카이브, 미디어 폴더, 또는 단일 이미지/GIF/동영상/오디오/**PDF**/**Markdown** 열기
- 자연 정렬 페이지 순서: 이미지(PNG, JPEG, WebP, GIF), 재생 가능한 동영상(WebM, MP4, MOV), 오디오(MP3, M4A, AAC, OGG, Opus, WAV), 다중 페이지 **PDF**, **Markdown**(`.md` / `.markdown`)
- 파일/폴더 하나 드래그 앤 드롭으로 열기
- **32 MiB** 이하 페이지는 메모리 RPC, 더 큰 미디어는 same-origin 스트리밍. 아카이브 멤버는 시크를 위해 임시 추출되며 항목당·활성 작품 합산 임시 캐시 모두 **2 GiB** 제한. 연 소스를 삭제/이동하면 스트림을 사용할 수 없음.
- **PDF**: 각 페이지가 리더 페이지(pdf.js 캔버스); 다중 엔트리 소스 안 읽을 수 없는 PDF는 건너뜀
- **Markdown**: Merak(`merak-protocol-design-system/markdown`)로 스크롤 가능한 아티클 페이지 렌더
- 보기 모드:
  - 창에 맞춤 / 너비 맞춤 / 높이 맞춤 / 원본 100%
  - 양면 **LTR** / **RTL**
  - 연속 **웹툰** 스트립
- 작은 이미지 늘리기 (맞춤 모드 전용)
- 이미지 스케일링: **Smooth**(기본), **고품질**, **NoHalo**, **xBRZ**. ±10 읽기 창은 Smooth로 즉시 표시하고, 고비용 타일은 활성 페이지 ±2로 제한합니다. 고품질은 병렬 수가 제한된 Go 워커와 5페이지 디코드 LRU를 사용하며, NoHalo·xBRZ·호스트 실패 폴백은 Web Worker에서 처리합니다. **Pixelated**는 정지 이미지에 사용할 수 있고 GIF 애니메이션은 캔버스 필터를 우회합니다.
- 수동 확대 (25–800%, 웹툰은 최대 200%) 및 패닝 (휠 / 넘치는 경우 Alt+드래그)
- 리더 제목/툴바 빈 영역 더블클릭으로 창 최대화/복원
- 리더 툴바 접기 (플로팅 토글 또는 `T`); `localStorage`에 기억
- 이동·모드 전환 키보드 단축키
- 작품별 이어보기 진행도

### 라이브러리 & 프라이버시
- 최근 작품 목록 (최대 20) 및 이어보기
- 최근 목록/진행도 저장 on/off
- 보관 기간: 영구, 또는 7 / 30 / 90일
- 단일 삭제, 선택 삭제, 전체 삭제
- 저장 끄기 시 확인 후 기록 삭제

보기 모드·늘리기·이미지 스케일링·툴바 접기 설정은 `localStorage`에 저장됩니다. 최근 기록은 호스트 설정 디렉터리에 있습니다:

`${os.UserConfigDir()}/komika/library.json`

## 요구 사항

- Go (`go.mod` 참고)
- Node.js + npm
- [Wails v3](https://v3.wails.io/) CLI (`wails3`)
- [Task](https://taskfile.dev/)는 별도 설치 없이 `wails3 task …`로 루트 `Taskfile.yml` 그래프를 실행

## 지원 플랫폼

- Windows (amd64, arm64)
- Linux (amd64, arm64)
- macOS Apple Silicon (arm64)

## Task 워크플로

Komika는 루트 Taskfile을 통해 구동합니다. 단발성 `go`/`npm`/`wails3` 명령보다 아래 엔트리 포인트를 우선하세요.

```bash
# 개발 앱 (프론트/백엔드 핫 리로드)
wails3 task dev

# 호스트 OS용 프로덕션 바이너리 → bin/komika
wails3 task build

# 호스트 OS용 패키징
wails3 task package

# 마지막 프로덕션 빌드 실행
wails3 task run

# 백엔드 race 테스트 + 프론트 뷰어 테스트
wails3 task test

# TypeScript 바인딩만 재생성
wails3 task common:generate:bindings
```

크로스 컴파일 / 플랫폼 패키지 예:

```bash
wails3 task build GOOS=darwin
wails3 task build GOOS=windows
wails3 task build GOOS=linux
wails3 task package GOOS=darwin
```

### Docker 패키징 (Debian 13 이미지)

Linux AppImage/deb/rpm/aur 및 Windows NSIS 전체 패키징은 multi-arch `komika-package`
이미지(`debian:trixie`) 안에서 돌릴 수 있습니다. 호스트에 맞는 툴체인이 없어도 됩니다.
바이너리만 크로스 빌드할 때는 기존 `wails3 task setup:docker` → `wails-cross` 경로를 씁니다.

```bash
# 아키텍처별 패키징 이미지 빌드 (필요 시 둘 다)
wails3 task package:docker:setup ARCH=amd64
wails3 task package:docker:setup ARCH=arm64

# Linux 패키지 (task는 komika-package:$ARCH + --platform linux/$ARCH 사용;
# AppImage/GST inject도 컨테이너 CPU arch == ARCH 필요)
wails3 task package:docker GOOS=linux ARCH=amd64   # → bin/komika-x86_64.AppImage, .deb, …
wails3 task package:docker GOOS=linux ARCH=arm64   # → bin/komika-aarch64.AppImage, …

# Windows NSIS (pure Go + makensis; task는 여전히 komika-package:$ARCH 필요)
wails3 task package:docker GOOS=windows ARCH=amd64  # 이미지 :amd64 필요 → installer
wails3 task package:docker GOOS=windows ARCH=arm64  # 이미지 :arm64 필요 → installer
```

결과물은 리포 바인드 마운트로 호스트 `bin/`에 남습니다. 호스트와 다른 arch는
qemu/binfmt(Docker Desktop 또는 `tonistiigi/binfmt`)가 필요합니다. qemu 환경에서는
이미지 안의 `run-appimage` / `qemu-user-static`으로 static-pie AppImage 도구를 실행합니다.

수동 실행 예:

```bash
docker run --rm --platform linux/amd64 -v "$PWD:/src" -w /src \
  -e APPIMAGE_EXTRACT_AND_RUN=1 komika-package:amd64 \
  komika-package linux amd64
```

선택적 서버 모드 (네이티브 GUI 없음):

```bash
wails3 task build:server
wails3 task run:server
wails3 task build:docker
wails3 task run:docker
```

앱 전체 태스크 밖에서 프론트만 필요할 때 (`frontend/`):

```bash
cd frontend
npm install
npm run dev          # Vite만
npm run build        # 프로덕션 번들
npm run test:viewer  # 뷰어 순수 함수 / mediaKind 테스트
```

## 테스트

```bash
# 권장: 전체 테스트 태스크 (Go race + 뷰어 단위 테스트)
wails3 task test
```

바인딩과 프로덕션 프론트 번들은 `wails3 task build` 과정에서 재생성됩니다.

`testdata/reader-fixture/`와 `testdata/media-fixture/`는 정지 이미지, 애니메이션 GIF, 짧은 WebM/MP4/MOV 샘플을 폴더·CBZ·7z·CBR 소스로 제공합니다. `testdata/docs-fixture/`에는 샘플 PDF와 Markdown이 있습니다. 단독 미디어/문서 파일은 1페이지(또는 다중 페이지 PDF) **Media** 소스로 열립니다. 동영상/오디오 폴백 체인: (1) 호스트 WebView 코덱, (2) 시스템 **ffmpeg** → same-origin VP8/Opus WebM 또는 Opus Ogg(데스크톱 PATH가 짧을 때 공통 경로·`$FFMPEG`도 탐색), (3) 번들 **ffmpeg.wasm**(core ~32 MiB, lazy, 미디어 ≤48 MiB). 리눅스 패키지는 네이티브/호스트 경로용 GStreamer libav/플러그인·`ffmpeg`를 *recommends* 합니다. 암호화·멀티볼륨 아카이브는 지원하지 않습니다. 여러 파일을 드롭하면 토스트로 거부됩니다.

## Linux 동영상 코덱 (H.264 / AAC)

VLC는 되고 Komika WebView만 안 되는 경우가 흔함. VLC=자체 코덱, Komika=**WebKitGTK → GStreamer**.

| 실행 | 설명 |
|------|------|
| `bin/komika` / 네이티브 패키지 (`.deb` / `.rpm` / AUR) | **호스트** GStreamer 사용. 아래 패키지 설치. |
| AppImage | 최소 GStreamer 플러그인+scanner를 번들(`inject-gst-plugins.sh`). `task package`로 재빌드 필요. |

**배포판별 패키지** (unbundled/패키지 설치용; AppImage **빌드 호스트**에도 동일 패키지가 있어야 inject가 플러그인을 복사함):

**Debian / Ubuntu**

```bash
# WebView H.264/AAC에 필요
sudo apt install gstreamer1.0-libav gstreamer1.0-plugins-good
# 권장
sudo apt install gstreamer1.0-plugins-base gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly gstreamer1.0-tools ffmpeg
```

**Fedora**

```bash
# 필요 (WebView H.264/AAC / GStreamer)
sudo dnf install gstreamer1-plugin-libav gstreamer1-plugins-good
# 권장 (Fedora 기본 저장소 — 제한 코덱 빌드 ffmpeg-free)
sudo dnf install gstreamer1-plugins-base gstreamer1-plugins-bad-free \
  gstreamer1-plugins-ugly-free gstreamer1-plugins-base-tools ffmpeg-free
```

완전한 `ffmpeg`(추가 코덱)는 [RPM Fusion](https://rpmfusion.org/Configuration) 활성화 후 **교체** 설치 (`ffmpeg-free`와 동시 설치 금지):

```bash
sudo dnf swap ffmpeg-free ffmpeg --allowerasing
```


**Arch Linux**

```bash
# 필요
sudo pacman -S gst-libav gst-plugins-good
# 권장
sudo pacman -S gst-plugins-base gst-plugins-bad gst-plugins-ugly \
  gstreamer ffmpeg
```

**선택 확인**:

```bash
gst-inspect-1.0 avdec_h264 >/dev/null && gst-inspect-1.0 avdec_aac >/dev/null && echo GST_CODECS_OK
```

네이티브 패키지는 **필요** 세트(`libav` + `plugins-good` 계열)를 hard depends로 넣습니다. WebView가 여전히 못 풀 때를 위해 `ffmpeg` 폴백을 recommends로 둡니다.


## 프로젝트 구조

| 경로 | 역할 |
|------|------|
| `main.go` | 앱 진입점 |
| `comic_service.go` | Wails 브리지 (열기, 페이지, 라이브러리) |
| `comic_source.go` | 아카이브/폴더/미디어/문서 페이지 소스 |
| `media_stream.go` | same-origin 미디어 스트리밍 및 임시 추출 한도 |
| `media_transcode.go` | WebView 미지원 코덱용 ffmpeg 폴백 트랜스코드 캐시 |
| `library_store.go` | 최근 목록, 설정, TTL, 원자적 JSON |
| `frontend/src/main.ts` | 라이브러리 UI + 모드별 리더 |
| `frontend/src/viewer.ts` | 순수 뷰 연산 (스케일, 팬, 스프레드, 캐시, 미디어 종류) |
| `frontend/src/pdf_render.ts` | pdf.js 문서 캐시 및 페이지 캔버스 부착 |
| `image_upscale.go` | 고품질 타일용 제한 병렬 Go 워커와 5페이지 디코드 LRU |
| `frontend/src/upscale.ts` | Web Worker 폴백 및 xBRZ용 pure 타일 필터 |
| `frontend/src/upscale_worker.ts` | UI 스레드 밖에서 수행하는 NoHalo·xBRZ·폴백 스케일링 |
| `frontend/src/style.css` | 리더/라이브러리 스타일 (Merak 토큰) |
| `frontend/bindings/` | 생성된 Wails TypeScript 바인딩 |
| `testdata/` | 리더 픽스처 |

## 키보드 (리더)

| 키 | 동작 |
|----|------|
| 방향키 / WASD / Space / PageUp·Down | 페이지 이동; 웹툰에서는 뷰포트 ~65% 스크롤 (Shift: 페이지 점프) |
| Home / End | 첫 / 마지막 페이지 |
| `+` / `-` (Shift: 미세) | 확대/축소 |
| `0` | 원본 100% |
| `1` / `9` | 창에 맞춤 |
| `8` | 너비 맞춤 |
| `H` | 높이 맞춤 |
| `7` / `6` | 양면 LTR / RTL |
| `5` | 웹툰 |
| `Z` | 작은 이미지 늘리기 토글 |
| `T` | 툴바 접기/펼치기 |

## 라이선스

이 저장소에는 아직 라이선스 파일이 없습니다. 배포 시 추가하세요.
