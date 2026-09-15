# 0015: D1 のページ変更を guard 付き batch で適用する

- 状態: 承認済み
- 決定日: 2026-09-15

D1 では transaction callback を application service に公開せず、commit と delete の read、mutation plan 作成、guard 付き atomic batch を分けて実行する。
application service は既存のページ変更規則から mutation plan を作り、D1 adapter は page version、commit ID、title 占有を batch 内で再検査してから plan を適用する。

## 決定

page と lines は一つの statement で読み、同じ snapshot から mutation plan を作る。
D1 adapter は `page_mutation_guard` の `CHECK` constraint を利用し、guard が不成立なら batch 全体を rollback させる。
guard mismatch 後は最新状態を読み直し、version conflict、同一 commit ID の冪等 retry、異内容の commit ID 再利用を application service の結果へ変換する。

batch の成否が transport error から判別できない場合は、commit ID を読み直す。
同じ操作ハッシュの commit が存在すれば適用済みとして元の version を返し、存在しなければ error を呼び出し元へ返す。

lines と links は JSON parameter で渡し、ページサイズに応じて statement 数と placeholder 数を増やさない。
通常の D1 binding を使い Sessions API を使わないため、今回の read は primary に対して行う。
将来 Sessions API を導入する場合は、最初の query を primary に制約するか bookmark を引き継ぐ必要がある。

## 却下した案

**Durable Object ごとにページ変更を直列化する案**。
D1 の conditional atomic batch で同じ snapshot に対する競合を一方だけ適用でき、remote D1 でも成立したため、fallback は採用しない。

**guard mismatch をそのまま storage error にする案**。
正常な同時編集を HTTP 409 と最新 snapshot に変換できず、client の rebase 経路を壊すため採用しない。

## 帰結

- mutation plan の業務規則は application service が所有し、D1 adapter に置く SQL guard は plan の前提を atomic batch 内で再検査する責務だけを持つ。
- commit と delete は D1 上で利用できるが、rename、全文置換、import はこの決定に含めない。
- guard の再試行は競合を分類するための bounded retry であり、同じ mutation を無制限に再適用しない。

## 参照

- ADR 0002「行操作とページ version を書き込みの正規形式にする」
- ADR 0012「application service がページ変更の transaction 範囲を決める」
- GitHub issue [#138「D1 を使った Cloudflare Workers 配備を dogfood 可能にする」](https://github.com/fenril058/knot/issues/138)
- GitHub issue [#141「D1 adapter でページ commit と delete を原子的に適用する」](https://github.com/fenril058/knot/issues/141)
- Cloudflare Docs [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
