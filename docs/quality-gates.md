# 品質検査

## 方針

CI は、具体的な不具合または不要コードを検出できる検査に絞る。

設定値やコマンドを固定する独自のラチェットは設けない。

品質検査の変更は通常のコードレビューで理由と影響を確認する。

複雑度、関数行数、ネスト、引数数、コード重複率は設計上の参考にはなるが、それ自体は不具合を示さないため CI の合否条件にしない。

## 実行する検査

| 検査 | コマンド | 主な検出対象 |
| --- | --- | --- |
| 型検査 | `npm run typecheck` | TypeScript の型エラー |
| lint | `npm run lint` | 正しさに関わる問題、不審なコード、型安全性の問題 |
| 未使用コード | `npm run lint:dead-code` | 未使用のファイル、依存関係、export |
| 単体・統合テスト | `npm test` | 実装の振る舞いの退行 |
| E2E | `npm run test:e2e` | ブラウザ上の主要操作の退行 |
| Docker smoke | `bash scripts/docker-smoke.sh` | コンテナのビルドと起動の失敗 |

GitHub Actions の構文は `actionlint` で検査する。

GitHub Actions のセキュリティ上の問題は `zizmor` で検査する。

## TypeScript と lint

`tsconfig.json` は `strict` と `noUncheckedIndexedAccess` を有効にする。

`noUncheckedIndexedAccess` により、添字アクセスで範囲外の可能性を型として扱う。

範囲内であることが入力検査やループ条件から保証される箇所だけ `!` を使用する。

`.oxlintrc.json` は `correctness` と `suspicious` category を error として扱う。

型情報を使う次のルールも有効にする。

- `typescript/no-explicit-any`
- `typescript/no-unsafe-type-assertion`
- `typescript/switch-exhaustiveness-check`
- `typescript/no-unnecessary-type-assertion`

外部入力やライブラリ境界で型アサーションが避けられない場合は、対象行だけを抑制する。

`reportUnusedDisableDirectives` により、不要になった抑制コメントをエラーにする。

## 変更するとき

検査を追加または変更するときは、検出したい具体的な失敗例を示す。

誤検知への対処として例外設定や専用の検査コードが増え続ける場合は、その検査を CI の合否条件から外すことも検討する。
