# HORIZON-STYLE RACER (original)

手続き生成だけで作る、オリジナルのオープンワールド風レーシングゲーム。
設計書 (`docs/DESIGN.md`) に沿って M0〜M9 を段階的に実装する。

- 外部アセットなし(形状・テクスチャ・音はすべてコードで生成)
- TypeScript + Three.js → esbuild で **単一のHTMLファイル** にバンドル
- 操作: PCキーボード / スマホタッチ / Xbox コントローラー / Switch Pro コントローラー

## 使い方

```bash
npm install
npm run dev     # 開発サーバ (http://localhost:5173)
npm run build   # dist/index.html に単一HTMLを出力
npm test        # 自己診断(物理・ジオメトリ・数学)
```

## 構成

- `src/game/core`      起動・数学・デバッグ・自己診断
- `src/game/car`       車体ジオメトリ(ロフト)・マテリアル・リグ
- `src/game/world`     地形・道路・植生・空・水・集落
- `src/game/physics`   剛体・タイヤ・ドライブトレイン・サスペンション
- `src/game/render`    パイプライン・ポストエフェクト・影・品質調整
- `src/game/input`     入力抽象化(キーボード/タッチ/ゲームパッド)
- `src/game/ai`        AIドライバー・交通
- `src/game/ui`        HUD・ガレージ・メニュー・マップ
- `src/game/audio`     WebAudio エンジン合成
- `docs/PROGRESS.md`   進捗と次の作業
