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
- 検査対象の縮小（`ignorePatterns` の追加、`jscpd` の `pattern` 縮小・`ignore` 追加、`knip` の `entry` / `project` 縮小、`tsconfig.json` の `include` 縮小・`exclude` 追加）
- 検査そのものの取り外し（`sonarjs` プラグイン、`options.typeAware`、`knip` の `includeEntryExports`、CI の `run` ステップ）
- `tsconfig.json` の `compilerOptions` の変更（内容を問わず。下記の凍結）
- 検査スクリプト本文の書き換え（`package.json` の `typecheck` / `lint` / `lint:duplicates` / `lint:dead-code` / `quality`）

### tsconfig の凍結

型検査は 1 つのフラグでは守れない。`strict: true` のまま `strictNullChecks: false` を
明示する、`noCheck: true` を足す、`outDir` で対象を暗黙に縮める、といった経路が
いくらでもある。危険なオプションを列挙する方式では取りこぼす（実際
`noCheck` / `outDir` / `erasableSyntaxOnly` / `noUncheckedSideEffectImports` /
`allowUmdGlobalAccess` はいずれもレビューで後から見つかった）。

そのため `compilerOptions` は**凍結**してある。緩和はどれも「既定値に頼っていた
オプションを明示して倒す」か「既存の値を書き換える」形になるので、次の 2 つで足りる。

- 値の変更・削除（`supersets`）
- オプション名の追加（`subsets`）

**`compilerOptions` を触る変更は、内容を問わずこの文書への記録を要する。**

`paths` のようにキー順へ意味が無い値は、キーを揃えてから比較する。
並べ替えただけでは落ちない。配列の順序は意味を持つので保つ。

`extends` は**解決していない**。継承元に `noCheck` を置けばルート側は無変更に見えるため、
実効設定を判定できない。そのため `extends` の新設自体を違反として落とす。
tsconfig を分割したくなった場合は、この文書に記録して通したうえで、
継承元を読むようにガードを設計し直すこと。

### 検査スクリプトの凍結

設定ファイルを凍結しても、それを読むコマンドが自由なら意味がない。
`tsc --noEmit --noCheck` と足せば tsconfig を一切触らずに型検査が全部消えるし、
`oxlint ... --config .oxlintrc-loose.json` で別の設定に差し替えられる。

引数の意味を解釈しようとすると必ず取りこぼすため、`package.json` の
`typecheck` / `lint` / `lint:duplicates` / `lint:dead-code` / `quality` は
**本文を逐語で凍結**してある。これらを書き換える変更も記録を要する。

### 守れていないこと

ラチェットは事故を止めるためのもので、書き手が意図的に外しにくるのは止められない。
既知の限界は次のとおり。

- CI ワークフローは `run:` の文字列だけを見る。`working-directory` や `defaults` を
  足して別ディレクトリの `package.json` へ向けられると検出できない。
- `extends` を承認して導入した後、継承元ファイルの中身は監視できない。
- `scripts/quality-ratchet.ts` 自身の書き換えは、ラチェット自身では止められない。

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

対象名は**トークン境界で照合する**。`strictNullChecks` を名指しした行が
`strict` まで承認してしまわないようにするため。

値を書き換える場合は**新しい値**を書く。オプションを新設する場合は名前だけでよい。

### 承認済みの緩和

- `compilerOptions` に `noUncheckedIndexedAccess` を足す（添字アクセスを `T | undefined` にするため）
