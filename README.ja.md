# Komika

CBZ/ZIP、CBR/RAR、CB7/7z アーカイブ、画像/動画/音声: ホスト WebView コーデック優先（Linux WebKitGTK は **GStreamer** libav/good/bad/ugly — deb 依存）。フォールバック: システム **ffmpeg**（PATH/`$FFMPEG`、≤12 MiB は wasm 可）。VLC 可・WebView 不可なら GStreamer/WebKit 経路の可能性。`.deb` またはホスト `ffmpeg` フォールバックを検討。

**言語:** [English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md)

> **v0.3.0:** 高速なアーカイブ読み込み、応答性を保つ ±10 ページのプリロード、Go/Web Worker ハイブリッド高品質スケーリングを追加しました。詳細は[リリースノート](docs/releases/v0.3.0.md)を参照してください。

## 機能

### 閲覧
- **CBZ/ZIP**、**CBR/RAR**、**CB7/7z** アーカイブ、メディアフォルダ、または単一の画像/GIF/動画/音声/**PDF**/**Markdown** を開く
- 自然順のページ並び: 画像（PNG、JPEG、WebP、GIF）、再生可能な動画（WebM、MP4、MOV）、音声（MP3、M4A、AAC、OGG、Opus、WAV）、複数ページ **PDF**、**Markdown**（`.md` / `.markdown`）
- ファイル/フォルダを 1 つドラッグ＆ドロップして開く
- **32 MiB** 以下のページはメモリ RPC、それより大きいメディアは same-origin ストリーミング。CBZ/ZIP は単一のランダムアクセスインデックスから直接読み込み、RAR/7z の RPC ページは要求時に一度だけ展開して作品ごとの **1 GiB** 読み込みキャッシュで再利用します。シーク用ストリームの一時展開はエントリ単位・開いている作品の合計とも **2 GiB** 制限で、作品を閉じると一時キャッシュを削除します。開いたソースを削除/移動すると未キャッシュのコンテンツは利用できません。
- リーダーはアクティブページの前後 **±10 ページ**をプリロードして保持します。見開きモードでは完全なスプレッドを維持し、動画・音声・PDF 以外のストリームページは表示中の項目だけを保持します。
- **PDF**: 各ページがリーダーページ（pdf.js キャンバス）；複数エントリソース内の読めない PDF はスキップ
- **Markdown**: Merak（`merak-protocol-design-system/markdown`）でスクロール可能な記事ページとして描画
- 表示モード:
  - ウィンドウに合わせる / 幅に合わせる / 高さに合わせる / 原寸 100%
  - 見開き **LTR** / **RTL**
  - 連続 **ウェブトゥーン** ストリップ
- 小さい画像の引き伸ばし（フィット系モードのみ）
- 画像スケーリング: **Smooth**（既定）、**高品質**、**NoHalo**、**xBRZ**。±10 の読み込み範囲は Smooth ですぐ表示し、高コストなタイル処理はアクティブページの ±2 に制限します。高品質は並列数を制限した Go ワーカーと 5 ページのデコード LRU を使用し、NoHalo・xBRZ・ホスト失敗時のフォールバックは Web Worker で処理します。静止画には **Pixelated** も使用でき、GIF はキャンバスフィルタを回避してアニメーションを維持します。
- 手動ズーム（25–800%、ウェブトゥーンは最大 200%）とパン（ホイール / はみ出し時 Alt+ドラッグ）
- リーダーのタイトル/ツールバー余白をダブルクリックしてウィンドウ最大化/復元
- リーダーツールバーを折りたたむ（フローティングトグルまたは `T`）；`localStorage` に記憶
- 移動・モード切替のキーボードショートカット
- 作品ごとの続きから再開

### ライブラリとプライバシー
- 最近の作品リスト（最大 20）と再開
- 履歴・進捗の保存のオン/オフ
- 保持期間: 無期限、または 7 / 30 / 90 日
- 1件削除、選択削除、全削除
- 保存オフ時は確認後に履歴を消去

表示モード/引き伸ばし/画像スケーリング/ツールバー折りたたみ設定は `localStorage` に保存されます。履歴はホストの設定ディレクトリにあります:

`${os.UserConfigDir()}/komika/library.json`

## 必要条件

- Go（`go.mod` を参照）
- Node.js + npm
- [Wails v3](https://v3.wails.io/) CLI（`wails3`）
- [Task](https://taskfile.dev/) は別途不要。`wails3 task …` でルート `Taskfile.yml` グラフを実行

## 対応プラットフォーム

- Windows (amd64, arm64)
- Linux (amd64, arm64)
- macOS Apple Silicon (arm64)

## Task ワークフロー

Komika はルート Taskfile 経由で動かします。単発の `go` / `npm` / `wails3` より次のエントリポイントを優先してください。

```bash
# 開発アプリ（フロント/バックのホットリロード）
wails3 task dev

# ホスト OS 向け本番バイナリ → bin/komika
wails3 task build

# ホスト OS 向けパッケージ
wails3 task package

# 直近の本番ビルドを実行
wails3 task run

# バックエンド race テスト + フロントビューアテスト
wails3 task test

# TypeScript バインディングのみ再生成
wails3 task common:generate:bindings
```

クロスコンパイル / プラットフォームパッケージの例:

```bash
wails3 task setup:docker ARCH=arm64
wails3 task build GOOS=darwin ARCH=arm64
wails3 task build GOOS=windows ARCH=arm64
wails3 task build GOOS=linux ARCH=arm64
wails3 task package GOOS=darwin
```

### Docker パッケージング（Debian 13 イメージ）

Linux の AppImage/deb/rpm/aur と Windows NSIS のフルパッケージは、multi-arch の
`komika-package` イメージ（`debian:trixie`）内で実行できます。ホストに対応ツールチェーンが
無くても構いません。バイナリのみのクロスビルドはアーキテクチャ別の
`wails-cross:$ARCH` イメージを使用します。`wails3 task setup:docker:all` で両方、
または `setup:docker ARCH=…` で片方だけを作成できます。

```bash
# アーキテクチャごとのパッケージ用イメージをビルド（必要なら両方）
wails3 task package:docker:setup ARCH=amd64
wails3 task package:docker:setup ARCH=arm64

# Linux パッケージ（task は komika-package:$ARCH + --platform linux/$ARCH を使用;
# AppImage/GST inject もコンテナ CPU arch == ARCH が必須）
wails3 task package:docker GOOS=linux ARCH=amd64   # → bin/komika-x86_64.AppImage, .deb, …
wails3 task package:docker GOOS=linux ARCH=arm64   # → bin/komika-aarch64.AppImage, …

# Windows NSIS（pure Go + makensis; task はやはり komika-package:$ARCH が必要）
wails3 task package:docker GOOS=windows ARCH=amd64  # イメージ :amd64 が必要 → installer
wails3 task package:docker GOOS=windows ARCH=arm64  # イメージ :arm64 が必要 → installer

# Linux/Windows × amd64/arm64 をすべてパッケージ
wails3 task package:docker:all
```

成果物はリポジトリのバインドマウント経由でホストの `bin/` に出ます。ホストと異なる arch には
qemu/binfmt（Docker Desktop または `tonistiigi/binfmt`）が必要です。qemu 環境ではイメージ内の
`run-appimage` / `qemu-user-static` で static-pie の AppImage ツールを実行します。
全アーキテクチャのワークフローでは、生の実行ファイルを `komika-linux-$ARCH` と
`komika-windows-$ARCH.exe` として個別に保存し、各パッケージも従来どおりアーキテクチャ別の名前を使用します。

手動実行例:

```bash
docker run --rm --platform linux/amd64 -v "$PWD:/src" -w /src \
  -e APPIMAGE_EXTRACT_AND_RUN=1 komika-package:amd64 \
  komika-package linux amd64
```

任意のサーバーモード（ネイティブ GUI なし）:

```bash
wails3 task build:server
wails3 task run:server
wails3 task build:docker
wails3 task run:docker
```

アプリ全体のタスク外でフロントだけ必要なとき（`frontend/`）:

```bash
cd frontend
npm install
npm run dev          # Vite のみ
npm run build        # 本番バンドル
npm run test:viewer  # ビューア純関数 / mediaKind テスト
```

## テスト

```bash
# 推奨: 全体テストタスク（Go race + ビューア単体テスト）
wails3 task test
```

バインディングと本番フロントバンドルは `wails3 task build` の過程で再生成されます。

`testdata/reader-fixture/` と `testdata/media-fixture/` は静止画、アニメ GIF、短い WebM/MP4/MOV サンプルをフォルダ・CBZ・7z・CBR ソースとして提供します。`testdata/docs-fixture/` にはサンプル PDF と Markdown があります。単独メディア/ドキュメントファイルは 1 ページ（または複数ページ PDF）の **Media** ソースとして開きます。動画/音声のフォールバック連鎖: (1) ホスト WebView コーデック、(2) システム **ffmpeg** → same-origin VP8/Opus WebM または Opus Ogg（デスクトップ PATH が短い場合は共通パス・`$FFMPEG` も探索）、(3) 同梱 **ffmpeg.wasm**（core 約 32 MiB・lazy・メディア ≤48 MiB）。Linux パッケージはネイティブ/ホスト経路用に GStreamer libav/プラグインと `ffmpeg` も *recommends* します。暗号化・マルチボリュームアーカイブは未対応です。複数ファイルのドロップはトーストで拒否されます。

## Linux の動画コーデック (H.264 / AAC)

VLC では再生できても Komika の WebView だけ失敗することがあります。VLC=独自コーデック、Komika=**WebKitGTK → GStreamer**。

| 実行 | 説明 |
|------|------|
| `bin/komika` / ネイティブパッケージ (`.deb` / `.rpm` / AUR) | **ホスト** GStreamer。下記パッケージを導入。 |
| AppImage | 最小 GStreamer プラグイン+scanner を同梱（`inject-gst-plugins.sh`）。`task package` で再ビルドが必要。 |

**ディストリ別パッケージ**（unbundled/パッケージ用。AppImage **ビルドホスト**にも同じものが必要で、inject がプラグインをコピーします）:

**Debian / Ubuntu**

```bash
# WebView H.264/AAC に必要
sudo apt install gstreamer1.0-libav gstreamer1.0-plugins-good
# 推奨
sudo apt install gstreamer1.0-plugins-base gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly gstreamer1.0-tools ffmpeg
```

**Fedora**

```bash
# 必要（WebView H.264/AAC / GStreamer）
sudo dnf install gstreamer1-plugin-libav gstreamer1-plugins-good
# 推奨（Fedora 公式リポジトリ — 制限付きビルド ffmpeg-free）
sudo dnf install gstreamer1-plugins-base gstreamer1-plugins-bad-free \
  gstreamer1-plugins-ugly-free gstreamer1-plugins-base-tools ffmpeg-free
```

フル機能の `ffmpeg`（追加コーデック）は [RPM Fusion](https://rpmfusion.org/Configuration) 有効化後に **入れ替え**（`ffmpeg-free` と併存させない）:

```bash
sudo dnf swap ffmpeg-free ffmpeg --allowerasing
```


**Arch Linux**

```bash
# 必要
sudo pacman -S gst-libav gst-plugins-good
# 推奨
sudo pacman -S gst-plugins-base gst-plugins-bad gst-plugins-ugly \
  gstreamer ffmpeg
```

**任意チェック**:

```bash
gst-inspect-1.0 avdec_h264 >/dev/null && gst-inspect-1.0 avdec_aac >/dev/null && echo GST_CODECS_OK
```

ネイティブパッケージは **必須** セット（`libav` + `plugins-good` 系）を hard depends にします。WebView で解けない場合の `ffmpeg` フォールバックは recommends です。


## プロジェクト構成

| パス | 役割 |
|------|------|
| `main.go` | アプリエントリ |
| `comic_service.go` | Wails ブリッジ（オープン、ページ、ライブラリ） |
| `comic_source.go` | アーカイブ/フォルダ/メディア/ドキュメントのページソース |
| `archive_read_cache.go` | ZIP の直接読み込みとオンデマンド RAR/7z ページキャッシュ |
| `media_stream.go` | same-origin メディアストリーミングと一時展開上限 |
| `media_transcode.go` | WebView 非対応コーデック向け ffmpeg フォールバック変換キャッシュ |
| `library_store.go` | 最近リスト、設定、TTL、原子的 JSON |
| `frontend/src/main.ts` | ライブラリ UI + モード別リーダー |
| `frontend/src/viewer.ts` | 純ビュー演算（スケール、パン、見開き、キャッシュ、メディア種別） |
| `frontend/src/pdf_render.ts` | pdf.js ドキュメントキャッシュとページキャンバス接続 |
| `image_upscale.go` | 高品質タイル向けの制限付き並列 Go ワーカーと 5 ページのデコード LRU |
| `frontend/src/upscale.ts` | Web Worker フォールバックと xBRZ 用の純タイルフィルタ |
| `frontend/src/upscale_worker.ts` | UI スレッド外で動く NoHalo・xBRZ・フォールバックスケーリング |
| `frontend/src/style.css` | リーダー/ライブラリ用スタイル（Merak トークン） |
| `frontend/bindings/` | 生成された Wails TypeScript バインディング |
| `testdata/` | リーダー用フィクスチャ |

## キーボード（リーダー）

| キー | 動作 |
|------|------|
| 矢印 / WASD / Space / PageUp·Down | ページ移動; ウェブトゥーンではビューポート約65%スクロール（Shift: ページジャンプ） |
| Home / End | 先頭 / 末尾ページ |
| `+` / `-`（Shift: 微調整） | ズーム |
| `0` | 原寸 100% |
| `1` / `9` | ウィンドウに合わせる |
| `8` | 幅に合わせる |
| `H` | 高さに合わせる |
| `7` / `6` | 見開き LTR / RTL |
| `5` | ウェブトゥーン |
| `Z` | 小さい画像の引き伸ばし切替 |
| `T` | ツールバー表示切替 |

## ライセンス

Komika は [Mozilla Public License 2.0](LICENSE) の下で配布されます。
