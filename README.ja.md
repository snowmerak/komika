# Komika

CBZ/ZIP、CBR/RAR、CB7/7z アーカイブと画像/動画フォルダ向けのローカル優先コミックリーダーです。[Wails v3](https://v3.wails.io/)（Go バックエンド + TypeScript フロントエンド）で構築されています。

**言語:** [English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md)

## 機能

### 閲覧
- **CBZ/ZIP**、**CBR/RAR**、**CB7/7z** アーカイブ、メディアフォルダ、または単一の画像/GIF/動画を開く
- 自然順のページ並び: 画像（PNG、JPEG、WebP、GIF）と再生可能な動画（WebM、MP4、MOV）
- ファイル/フォルダを 1 つドラッグ＆ドロップして開く
- **32 MiB** 以下のページはメモリ RPC、それより大きいメディアは same-origin ストリーミング。アーカイブ内メンバーはシーク用に一時展開し、エントリ単位・開いている作品の合計一時キャッシュとも **2 GiB** 制限。開いたソースを削除/移動するとストリームは利用不可。
- BandiView 風の表示モード:
  - ウィンドウに合わせる / 幅に合わせる / 高さに合わせる / 原寸 100%
  - 見開き **LTR** / **RTL**
  - 連続 **ウェブトゥーン** ストリップ
- 小さい画像の引き伸ばし（フィット系モードのみ）
- 画像スケーリング: **Smooth**（既定）または **Pixelated**（静止画/GIF）
- 手動ズーム（25–800%、ウェブトゥーンは最大 200%）とパン（ホイール / はみ出し時 Alt+ドラッグ）
- リーダーのタイトル/ツールバー余白をダブルクリックしてウィンドウ最大化/復元
- 移動・モード切替のキーボードショートカット
- 作品ごとの続きから再開

### ライブラリとプライバシー
- 最近の作品リスト（最大 20）と再開
- 履歴・進捗の保存のオン/オフ
- 保持期間: 無期限、または 7 / 30 / 90 日
- 1件削除、選択削除、全削除
- 保存オフ時は確認後に履歴を消去

表示モード/引き伸ばし/画像スケーリング設定は `localStorage` に保存されます。履歴はホストの設定ディレクトリにあります:

`${os.UserConfigDir()}/komika/library.json`

## 必要条件

- Go（`go.mod` を参照）
- Node.js + npm
- [Wails v3](https://v3.wails.io/) CLI（`wails3`）
- [Task](https://taskfile.dev/) は別途不要。`wails3 task …` でルート `Taskfile.yml` グラフを実行

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
wails3 task build GOOS=darwin
wails3 task build GOOS=windows
wails3 task build GOOS=linux
wails3 task package GOOS=darwin
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

`testdata/reader-fixture/` と `testdata/media-fixture/` は静止画、アニメ GIF、短い WebM/MP4/MOV サンプルをフォルダ・CBZ・7z・CBR ソースとして提供します。単独メディアファイルは 1 ページの **Media** ソースとして開きます。動画再生はホスト WebView のコーデックスタック（例: H.264/AAC、VP9/Vorbis）に依存し、非対応コーデックはリーダー内のエラーカードを表示します。暗号化・マルチボリュームアーカイブは未対応です。複数ファイルのドロップはトーストで拒否されます。

## プロジェクト構成

| パス | 役割 |
|------|------|
| `main.go` | アプリエントリ |
| `comic_service.go` | Wails ブリッジ（オープン、ページ、ライブラリ） |
| `comic_source.go` | アーカイブ/フォルダのページソース |
| `library_store.go` | 最近リスト、設定、TTL、原子的 JSON |
| `frontend/src/main.ts` | ライブラリ UI + モード別リーダー |
| `frontend/src/viewer.ts` | 純ビュー演算（スケール、パン、見開き、キャッシュ） |
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

## ライセンス

このリポジトリにはまだライセンスファイルがありません。配布する場合は追加してください。
