# 0016: D1 rename をプロジェクト単位の revision で guard する

- 状態: 承認済み
- 決定日: 2026-09-15

D1 の `rewriteLinks=true` rename では、対象ページと逆リンク元を読み、application service が全ページの mutation plan を作り、D1 adapter が一つの atomic batch で適用する。
逆リンク列挙後に新しい逆リンクが追加される race を検出するため、プロジェクトごとに page mutation revision を保持し、ページ本文を変える commit、delete、rename の成功ごとに進める。
`rewriteLinks=true` の rename は計画作成前に読んだ revision を batch 内で再検査し、一致しなければ全 mutation を rollback して、回数上限のある再計画を行う。

## 決定

対象ページの version、各逆リンク元の version、title 占有、commit ID、プロジェクトの page mutation revision を同じ guard で再検査する。
いずれかが変わっていれば batch を適用しない。

application service は逆リンクの列挙、`rewritePageLinks`、各ページの行操作、mutation の処理順を所有する。
D1 adapter は snapshot read、revision と各 mutation 前提の SQL guard、mutation plan の atomic apply を所有する。
単一ページの commit と delete は revision を進めるが照合せず、同じプロジェクトの無関係なページ変更を競合させない。
逆リンク snapshot を作らない `rewriteLinks=false` の rename も単一ページの mutation として revision を進めるが照合しない。

複数ページ分の pages、lines、commits、title history、links、FTS を JSON parameter から集合として更新し、逆リンク数に応じて query 数、statement 数、placeholder 数を増やさない。
JSON plan は guard table に一度だけ bind し、同じ batch の後続 statement はその値を参照する。
JSON plan は guard metadata と同じ table row に保持するため、D1 の 2 MB row 上限から 4 KiB の余白を引いた値を payload 上限とし、それを超える rename は batch を分割せず明示的に拒否する。
この payload は変更後の全文、行操作、検索用本文を含むため、2 MB はページ本文量の上限ではなく、実際に扱える本文量はそれより小さい。
本文が短くても page ごとの snapshot、commit、導出データが payload に入るため、逆リンク件数だけでも上限へ達し得る。
事前検査は本文 byte 数だけを対象とし、page 件数を含む正確な payload size は snapshot から plan を構築した後に検査する。
逆リンク本文の総量が 2 MB を超える場合は、全 snapshot を Worker へ読み出す前に拒否する。

## 却下した案

**列挙した各逆リンク元の page version だけを guard する案**。
snapshot に存在しなかった新規逆リンク元を検出できず、rename より前に成功した逆リンクを旧タイトルのまま残し得るため採用しない。

**rename 中だけ別の lock service でプロジェクトを直列化する案**。
D1 の conditional atomic batch と page mutation revision で race を検出して再計画できるため、Durable Objects などの別 backend は導入しない。

**逆リンク数に応じて D1 statement を追加する案**。
Workers Free の一 invocation あたり query 上限へ達し、同じ rename semantics をページ規模によって維持できなくなるため採用しない。

## 帰結

- 無関係なページ変更も同じプロジェクトの rename を再計画させるが、一人利用を前提とする初期 dogfood では単純な correctness を優先する。
- `rewriteLinks=false` も通常の page mutation として revision を進める。
- `rewriteLinks=true` の rename が revision 競合で再計画上限に達した場合は部分適用せず `StorageError` になり、専用の HTTP 契約を設けない現状では 500 応答になる。
- `setPinned` はページ本文と逆リンク snapshot を変えないため revision を進めず、commit と rename も snapshot の `pinned` を書き戻さない。
- `reindex` は既存の保守操作として revision guard の対象外であり、D1 のページ書き込みと同時には実行しない。
- SQLite adapter は ADR 0012 の transaction callback を維持し、この revision を導入しない。
- 全文置換と import の D1 対応はこの決定に含めない。

## 参照

- ADR 0012「application service がページ変更の transaction 範囲を決める」
- ADR 0013「delete と rename の対象をページ ID で識別する」
- ADR 0015「D1 のページ変更を guard 付き batch で適用する」
- GitHub issue [#143「D1 で rename と逆リンク書き換えを原子的にする」](https://github.com/fenril058/knot/issues/143)
- Cloudflare Docs [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- Cloudflare Docs [D1 Database `batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
