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

## 型情報つきルール

`options.typeAware` を立てると、型情報を要するルールが使える（`oxlint-tsgolint` が必要。
`package.json` の devDependency にあるので `npm ci` で入る）。

現在有効なのは 2 つ。

| ルール | 目的 |
| --- | --- |
| `typescript/no-unsafe-type-assertion` | union を部分型へ絞る `as` を落とす。型の絞り込みを黙らせる変更を検出する |
| `typescript/switch-exhaustiveness-check` | union に対する `switch` の網羅漏れを落とす |

union の分岐は `as` ではなく網羅 `switch` で書く。網羅していない分岐は戻り値が
`undefined` になり、`strict` 下では TS2366 になるので、コンパイラが漏れを教える。

`typeAware` は categories 内の型情報つきルールを**すべて**有効にするため、既存違反の
多いルールは `.oxlintrc.json` で個別に `off` にしてある（見送った理由と件数はそこにコメントで残す）。

`no-unsafe-type-assertion` の既存違反は `overrides` の柵でファイル単位に封じてある。
**柵の中のファイルはこのルールで守られない。** 該当ファイルを改修するときは違反を直して
柵から外す。柵にファイルを足す変更はラチェットが落とす。

## ラチェット

上限を超えれば CI が落ちるが、それだけでは「上限そのものを引き上げる」変更が素通りする。
`quality-ratchet` ジョブが base ref と HEAD の設定を比べ、緩和方向の変更を落とす。

検出する緩和は次のとおり。

- 数値上限の引き上げ（`.oxlintrc.json` の root と override、`.jscpd.json` の `threshold` / `minLines` / `minTokens`）
- severity の格下げ・無効化（`warn`、`off`、`categories` の格下げ、ルール定義の削除）
- 緩い `overrides` の新設（既存 override の削除は root の値へ戻るので許可する）
- 検査対象の縮小（`ignorePatterns` の追加、`jscpd` の `pattern` 縮小・`ignore` 追加、`knip` の `entry` / `project` 縮小、`npm run lint` の対象ディレクトリ削減）
- 検査そのものの取り外し（`sonarjs` プラグイン、`options.typeAware`、`knip` の `includeEntryExports`、`quality` スクリプトの構成、CI の `run` ステップ）

base ref が解決できない、設定が壊れている、設定ファイルが消えている場合は、
検査を飛ばさず失敗させる（fail closed）。

## 緩和したいとき

やむを得ず緩めるときは、この節に**対象名と新しい値の両方を含む行**を追加する。
ラチェットはこの文書に追加された行だけを承認として読むため、既存行の再利用や、
ルール名だけ・数値だけの記述では通らない。

### 承認済みの緩和

（まだ無し）
