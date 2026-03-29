# PhotoBlur — CLAUDE.md

## プロジェクト概要
大量の写真に対してぼかし・モザイク領域を手作業で指定し、一括保存する専用デスクトップアプリ。
Tauri v2（Rust バックエンド）+ React/TypeScript（フロントエンド）+ Python/OpenCV（画像処理）。

## 起動方法
```bash
cd D:\git\photoblur
npm run tauri dev
```
Vite dev server: `http://localhost:1421`（`vite.config.ts` で `strictPort: true`）

## 技術スタック
- **Tauri v2** — デスクトップアプリフレームワーク
- **React + TypeScript** — UI（Vite + Tailwind CSS）
- **Rust** — バックエンドコマンド（`src-tauri/src/lib.rs`）
- **Python + OpenCV** — 画像へのぼかし/モザイク適用（`photo_blur.py`）

## 主要ファイル

| ファイル | 役割 |
|---|---|
| `src/components/PhotoBlurEditor.tsx` | メイン UI コンポーネント（全機能） |
| `photo_blur.py` | 画像処理スクリプト（Python/OpenCV） |
| `src-tauri/src/lib.rs` | Rust バックエンド（`apply_photo_blur` コマンド） |
| `src-tauri/tauri.conf.json` | アプリ設定（identifier: `com.photoblur.app`） |
| `src-tauri/capabilities/default.json` | Tauri v2 パーミッション設定 |

## アーキテクチャ

```
[React UI] --invoke--> [Rust: apply_photo_blur] --spawn--> [Python: photo_blur.py]
                              ↑
                   regions JSON を引数で渡す
```

- Rust が `photo_blur.py` を子プロセスとして起動
- regions データは JSON 文字列としてコマンドライン引数で渡す
- Python が画像を読み書きして効果を適用

## エフェクト型

| 型 | キー | 内容 |
|---|---|---|
| `"blur"` | B キー | ガウシアンぼかし（顔用） |
| `"mosaic_face"` | M キー | ピクセル化モザイク（顔用） |
| `"mosaic_body"` | N キー | ピクセル化モザイク（局部用） |

## 強度計算式（重要）

強度はすべて **画像サイズ基準**（領域サイズ非依存）で計算する。
これにより、小さい領域も大きい領域も同じスライダー値で同じ視覚的強度になる。

```python
image_short = min(image_width, image_height)

# blur
sigma = max(1.0, intensity * image_short / 1000.0)
cv2.GaussianBlur(roi, (0, 0), sigma)

# mosaic
pixel_size = max(2, int(intensity * image_short / 1000))
```

フロントエンドプレビュー（canvas）も同じ式（`imageShort = Math.min(b.w, b.h)`）で統一。

## デフォルト強度

```typescript
blurIntensity: 7          // ぼかし（顔）
mosaicFaceIntensity: 20   // モザイク（顔）
mosaicBodyIntensity: 7    // モザイク（局部）
```

## 既知の問題と解決策

### Windows での日本語パス問題
OpenCV の `cv2.imread` / NumPy の `np.fromfile` / `buf.tofile` は Windows で
日本語（Unicode）パスを正しく扱えない場合がある。
→ **Python の `open(path, 'rb'/'wb')` を使うこと**（`photo_blur.py` 実装済み）。

```python
# 読み込み
with open(input_path, "rb") as f:
    data = f.read()
buf = np.frombuffer(data, dtype=np.uint8)
img = cv2.imdecode(buf, cv2.IMREAD_UNCHANGED)

# 書き込み
with open(output_path, "wb") as f:
    f.write(encoded.tobytes())
```

### React TDZ（Temporal Dead Zone）エラー
`canSave` などを `useEffect` の依存配列より後で宣言すると
`ReferenceError: Cannot access 'canSave' before initialization` で黒画面になる。
→ **`currentPhoto` の直後に `canSave` などを宣言すること**（順序が重要）。

### Tauri v2 capabilities（ダイアログが反応しない）
`src-tauri/capabilities/default.json` がないとダイアログプラグインが動かない。
→ `"dialog:default"` を含む capabilities ファイルが必須。

### HMR 後に React クラッシュした場合
HMR は React がクラッシュした後では機能しない。
→ フルページリロード（`window.location.reload()`）が必要。

## リージョンの永続化

写真を切り替えるとき、リージョンは `PhotoItem.regions` に保存・復元される。
`goTo()` は refs（`regionsRef`、`photosRef`、`currentIndexRef`）を使って
stable callback のまま最新 state にアクセスする。

## ドラッグ操作

`onMouseMove` / `onMouseUp` はキャンバスではなく `window` レベルで登録。
→ ドラッグ中にキャンバス外に出ても操作が継続される。
`isDrawing` が true のときのみリスナーをアタッチ（useEffect でクリーンアップ）。

## キーボードショートカット

| キー | 動作 |
|---|---|
| Enter / → | 保存して次へ |
| ← | 前の写真へ |
| S | スキップ |
| Ctrl+Z | 取り消し |
| Del / Backspace | 選択領域削除 |
| B | ぼかし（顔）モード |
| M | モザイク（顔）モード |
| N | モザイク（局部）モード |
| E | 楕円 ↔ 四角 切替 |
