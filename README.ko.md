# Komika

CBZ/ZIP, CBR/RAR, CB7/7z 아카이브와 이미지/동영상 폴더를 읽는 로컬 우선 만화 뷰어입니다. [Wails v3](https://v3.wails.io/) (Go 백엔드 + TypeScript 프론트엔드)로 구성됩니다.

**언어:** [English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md)

## 기능

### 읽기
- **CBZ/ZIP**, **CBR/RAR**, **CB7/7z** 아카이브, 미디어 폴더, 또는 단일 이미지/GIF/동영상 열기
- 자연 정렬 페이지 순서: 이미지(PNG, JPEG, WebP, GIF) 및 재생 가능한 동영상(WebM, MP4, MOV)
- 파일/폴더 하나 드래그 앤 드롭으로 열기
- **32 MiB** 이하 페이지는 메모리 RPC, 더 큰 미디어는 same-origin 스트리밍. 아카이브 멤버는 시크를 위해 임시 추출되며 항목당·활성 작품 합산 임시 캐시 모두 **2 GiB** 제한. 연 소스를 삭제/이동하면 스트림을 사용할 수 없음.
- BandiView 스타일 보기 모드:
  - 창에 맞춤 / 너비 맞춤 / 높이 맞춤 / 원본 100%
  - 양면 **LTR** / **RTL**
  - 연속 **웹툰** 스트립
- 작은 이미지 늘리기 (맞춤 모드 전용)
- 이미지 스케일링: **Smooth**(기본) 또는 **Pixelated**(정지 이미지/GIF)
- 수동 확대 (25–800%, 웹툰은 최대 200%) 및 패닝 (휠 / 넘치는 경우 Alt+드래그)
- 리더 제목/툴바 빈 영역 더블클릭으로 창 최대화/복원
- 이동·모드 전환 키보드 단축키
- 작품별 이어보기 진행도

### 라이브러리 & 프라이버시
- 최근 작품 목록 (최대 20) 및 이어보기
- 최근 목록/진행도 저장 on/off
- 보관 기간: 영구, 또는 7 / 30 / 90일
- 단일 삭제, 선택 삭제, 전체 삭제
- 저장 끄기 시 확인 후 기록 삭제

보기 모드·늘리기·이미지 스케일링 설정은 `localStorage`에 저장됩니다. 최근 기록은 호스트 설정 디렉터리에 있습니다:

`${os.UserConfigDir()}/komika/library.json`

## 요구 사항

- Go (`go.mod` 참고)
- Node.js + npm
- [Wails v3](https://v3.wails.io/) CLI (`wails3`)
- [Task](https://taskfile.dev/)는 별도 설치 없이 `wails3 task …`로 루트 `Taskfile.yml` 그래프를 실행

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

`testdata/reader-fixture/`와 `testdata/media-fixture/`는 정지 이미지, 애니메이션 GIF, 짧은 WebM/MP4/MOV 샘플을 폴더·CBZ·7z·CBR 소스로 제공합니다. 단독 미디어 파일은 1페이지 **Media** 소스로 열립니다. 동영상 재생은 호스트 WebView 코덱 스택(예: H.264/AAC, VP9/Vorbis)에 의존하며, 미지원 코덱은 리더 내 오류 카드를 표시합니다. 암호화·멀티볼륨 아카이브는 지원하지 않습니다. 여러 파일을 드롭하면 토스트로 거부됩니다.

## 프로젝트 구조

| 경로 | 역할 |
|------|------|
| `main.go` | 앱 진입점 |
| `comic_service.go` | Wails 브리지 (열기, 페이지, 라이브러리) |
| `comic_source.go` | 아카이브/폴더 페이지 소스 |
| `library_store.go` | 최근 목록, 설정, TTL, 원자적 JSON |
| `frontend/src/main.ts` | 라이브러리 UI + 모드별 리더 |
| `frontend/src/viewer.ts` | 순수 뷰 연산 (스케일, 팬, 스프레드, 캐시) |
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

## 라이선스

이 저장소에는 아직 라이선스 파일이 없습니다. 배포 시 추가하세요.
