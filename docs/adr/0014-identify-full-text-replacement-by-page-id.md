# 0014: 全文置換の対象をページ ID で識別する

- 状態: 承認済み
- 決定日: 2026-09-04
- 置換対象: ADR 0013 の全文置換 API を対象外とした決定

`PUT /api/knot/pages/:project/:title/text` による既存ページの全文置換では、caller が指定した `pageId` と `baseVersion` を必須にする。
タイトル変更やタイトル再利用をまたいでも変わらないページ ID を、変更対象の識別子とする。

## 決定

既存ページの全文置換は、一つの application transaction 内で次の順序を満たす。

1. `pageId` で対象ページを取得する。
2. 対象ページが request のプロジェクトに属することを検査する。
3. caller が指定した `baseVersion` と対象ページの現在の version を照合する。
4. version が一致した後で、対象ページが削除済みでないことを検査する。
5. 現在の行と request の本文から行操作を作り、同じ transaction 内で適用する。

URL のタイトルは routing と percent-encoding の検証に残すが、既存ページの対象を決める情報には使わない。
URL のタイトルと `pageId` で取得したページの現在のタイトルが一致することも要求しない。

新規作成ではまだページ ID が存在しないため、`baseVersion: 0` に限って `pageId` の省略を許可する。
この経路では URL のタイトルと本文の先頭行を照合し、タイトルの占有検査と保存を同じ application transaction 内で行う。

## 却下した案

**PUT の直前に title lookup の結果と `pageId` を client で比較する案**。
検査後かつ PUT 前に rename とタイトル再利用が起きる余地が残るため採用しない。

**title lookup を transaction 内へ移すだけの案**。
旧タイトルを再利用した別ページを正しく取得してしまい、`baseVersion` が一致すればそのページを変更できるため採用しない。

**新規作成でも `pageId` を必須にする案**。
作成前には server が割り当てるページ ID が存在しないため採用しない。

## 帰結

- knot の sync client は、既存ページの push と `--force` retry の PUT に state が保持する `pageId` を送る。
- `--force` retry の事前 GET にあるページ ID 比較は、別ページの version を対象ページの lease に使わないため維持する。
- 事前 GET 後の rename とタイトル再利用に対する書き込み対象の固定は、PUT の `pageId` 検査が担う。
- title-only の既存ページ全文置換を行う client との互換性は失われる。
- 新規作成の request と response、および行操作を正規形式とするコミットログは変更しない。

## 参照

- ADR 0002「行操作とページ version を書き込みの正規形式にする」
- ADR 0010「ブラウザ編集コミットの対象をページ ID で識別する」
- ADR 0012「application service がページ変更の transaction 範囲を決める」
- ADR 0013「delete と rename の対象をページ ID で識別する」
