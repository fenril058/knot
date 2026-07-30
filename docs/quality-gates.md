# 品質ゲート

## 何を守っているか

| 検査 | 設定 | 落ちる条件 |
| --- | --- | --- |
| 型 | `tsconfig.json` | `tsc --noEmit` のエラー |
| lint・複雑度 | `.oxlintrc.json` | ルール違反、複雑度・行数・ネスト・引数の上限超過 |
| 重複 | `.jscpd.json` | クローンが 1 件でもある（閾値 0%） |
| dead code | `knip.json` | 未使用のファイル・依存・export（entry の export を含む） |
| ラチェット | `scripts/quality-ratchet.ts` | 上記の設定が緩められている |

`.oxlintrc.json` の `overrides` は、既存コードの超過値をファイル単位で固定した移行用の上限。
関数単位の厳密な増加防止ではないため、その領域を改修するときに実測値まで縮小する。

## ラチェット

上限を超えれば CI が落ちるが、それだけでは「上限そのものを引き上げる」変更が素通りする。
`quality-ratchet` ジョブが base ref と HEAD の設定を比べ、緩和方向の変更を落とす。

検出する緩和は次のとおり。

- 数値上限の引き上げ（`.oxlintrc.json` の root と override、`.jscpd.json` の `threshold` / `minLines` / `minTokens`）
- severity の格下げ・無効化（`warn`、`off`、`categories` の格下げ、ルール定義の削除）
- 緩い `overrides` の新設（既存 override の削除は root の値へ戻るので許可する）
- 検査対象の縮小（`ignorePatterns` の追加、`jscpd` の `pattern` 縮小・`ignore` 追加、`knip` の `entry` / `project` 縮小、`npm run lint` の対象ディレクトリ削減）
- 検査そのものの取り外し（`sonarjs` プラグイン、`knip` の `includeEntryExports`、`quality` スクリプトの構成、CI の `run` ステップ）

base ref が解決できない、設定が壊れている、設定ファイルが消えている場合は、
検査を飛ばさず失敗させる（fail closed）。

## 緩和したいとき

やむを得ず緩めるときは、この節に**対象名と新しい値の両方を含む行**を追加する。
ラチェットはこの文書に追加された行だけを承認として読むため、既存行の再利用や、
ルール名だけ・数値だけの記述では通らない。

### 承認済みの緩和

（まだ無し）
