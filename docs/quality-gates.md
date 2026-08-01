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

現在有効なのは 3 つ。

| ルール | 目的 |
| --- | --- |
| `typescript/no-unsafe-type-assertion` | union を部分型へ絞る `as` を落とす。型の絞り込みを黙らせる変更を検出する |
| `typescript/switch-exhaustiveness-check` | union に対する `switch` の網羅漏れを落とす |
| `typescript/no-unnecessary-type-assertion` | 型を変えない `as` と `!` を落とす。効いていない表明が残るのを防ぐ |

union の分岐は `as` ではなく網羅 `switch` で書く。網羅していない分岐は戻り値が
`undefined` になり、`strict` 下では TS2366 になるので、コンパイラが漏れを教える。

`typeAware` は categories 内の型情報つきルールを**すべて**有効にする。
既存違反が多くて見送るルールは `.oxlintrc.json` で個別に `off` にし、見送った理由をそこに書く
（件数はコメントに書かず issue に置く。実態から乖離するため）。
現在 `off` にしているものは無い。

`no-unsafe-type-assertion` の既存違反は、ファイル単位の `overrides` ではなく違反行の
インライン抑制（`oxlint-disable-next-line`）で示す。抑制の範囲が 1 行に閉じ、
理由をその場に書けるため。`options.reportUnusedDisableDirectives` が `deny` なので、
違反を直したあとに抑制コメントを消し忘れると CI が落ちる。

## 添字アクセス

`tsconfig.json` の `noUncheckedIndexedAccess` により `a[i]` の型は `T | undefined` になる。
これが無いと `a[i]!` の `!` が型上は無意味になり、`no-unnecessary-type-assertion` と衝突する
（ルールが `!` を一斉に外せと言い出し、範囲内であることの根拠が消える）。
2 つはセットで有効にしてあり、どちらもラチェットの監視対象。

範囲内であることがループ不変条件などから明らかな箇所は `!` を付け、なぜ範囲内なのかを
コメントに書く。根拠が書けない箇所は `!` ではなく `?? 既定値` か明示的な検査で扱う。

`!` は「範囲内である」という主張なので、主張が偽になりうる入力を関数が受け付けるなら
`!` を付ける前に入力側で弾く。`ulid()` は時刻部分が 48 bit に収まらない `now` を
`RangeError` で落とす（以前は添字が外れて `'undefined'` を含む ID を黙って返していた）。

## ラチェット

上限を超えれば CI が落ちるが、それだけでは「上限そのものを引き上げる」変更が素通りする。
`quality-ratchet` ジョブが base ref と HEAD の設定を比べ、緩和方向の変更を落とす。

検出する緩和は次のとおり。

- 数値上限の引き上げ（`.oxlintrc.json` の root と override、`.jscpd.json` の `threshold` / `minLines` / `minTokens`）
- severity の格下げ・無効化（`warn`、`off`、`categories` の格下げ、ルール定義の削除）
- 緩い `overrides` の新設（既存 override の削除は root の値へ戻るので許可する）
- 検査対象の縮小（`ignorePatterns` の追加、`jscpd` の `pattern` 縮小・`ignore` 追加、`knip` の `entry` / `project` 縮小、`tsconfig.json` の `include` 縮小・`exclude` 追加・`outDir` / `declarationDir` の新設、`npm run lint` の対象ディレクトリ削減）
- 検査そのものの取り外し（`sonarjs` プラグイン、`options.typeAware`、`tsconfig.json` の `strict` / `noUncheckedIndexedAccess` / `erasableSyntaxOnly` / `noCheck`、`knip` の `includeEntryExports`、`quality` スクリプトの構成、CI の `run` ステップ）

### tsconfig の緩和経路

型検査は 1 つのフラグでは守れない。ガードは `scripts/quality-ratchet.ts` の 4 つの
一覧に集約してあり、**緩和経路が見つかったら対応する一覧に足す**。

| 一覧 | 求めること | 現在の対象 |
| --- | --- | --- |
| `STRICT_SUBFLAGS` | 実効値が `true` | `strict` が束ねる個別フラグ |
| `REQUIRED_TRUE_OPTIONS` | `true` の維持 | `noUncheckedIndexedAccess`、`erasableSyntaxOnly` |
| `FORBIDDEN_OPTIONS` | 不在または `false` | `noCheck`、`outDir`、`declarationDir` |
| （個別） | — | `extends`、`include`、`exclude` |

`strict` は個別フラグの束なので、`strict: true` のまま `strictNullChecks: false` を
明示すれば検査を外せる。そのためラチェットは `strict` の値ではなく、
個別フラグの**実効値**（明示があればそれ、無ければ `strict` を継ぐ）を見る。
TypeScript の更新で strict 系が増えると取りこぼすため、`tsc --help --all` の出力と
`STRICT_SUBFLAGS` を突き合わせるテストを置いてある。

`noCheck: true` は strict 系とは独立に型検査そのものを黙らせ、`tsc` を exit 0 にする。

`outDir` と `declarationDir` は、その配下が既定の `exclude` に足される。
`include` を書き換えずに `"outDir": "test"` と足すだけで `test/` 配下が検査から外れる。
このリポジトリは `noEmit` なのでどちらも用途が無く、新設自体を違反にしている。

`extends` は**解決していない**。継承元に `noCheck` を置けばルート側は無変更に見えるため、
実効設定を判定できない。そのため `extends` の新設自体を違反として落とす。
tsconfig を分割したくなった場合は、この文書に記録して通したうえで、
継承元を読むようにガードを設計し直すこと。

この一覧が緩和経路を尽くしている保証は無い。実際、`noCheck` / `outDir` /
`erasableSyntaxOnly` はいずれも後から見つかって足したものである。

base ref は、PR では対象ブランチ、push では直前の tip（`event.before`）を使う。
force-push とブランチの初回 push では `event.before` を解決できないため、既定ブランチとの
分岐点へ落とす。

既定ブランチ自体の履歴が書き換えられた場合は、書き換え前の commit が到達不能で分岐点も
HEAD に一致するため、**base を決められない。この場合はジョブを失敗させる。**
`HEAD~1` で代用すると、書き換えられた古い commit に含まれる緩和を見逃すため。

検査をスキップするのはリポジトリ最初の commit（HEAD に親が無い）のときだけで、
これは比較対象の設定がそもそも存在しない場合にあたる。

設定が壊れている、設定ファイルが消えている、渡された base ref を解決できない場合は、
検査を飛ばさず失敗させる（fail closed）。

## 緩和したいとき

やむを得ず緩めるときは、この節に**対象名と新しい値の両方を含む行**を追加する。
ラチェットはこの文書に追加された行だけを承認として読むため、既存行の再利用や、
ルール名だけ・数値だけの記述では通らない。

### 承認済みの緩和

（まだ無し）
