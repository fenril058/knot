# 0012: application service がページ変更の transaction 範囲を決める

- 状態: 承認済み
- 決定日: 2026-08-26

commit、delete、rename、import の規則と処理順は application service に置く。
application service はページ変更用のまとまった repository port に transaction callback を渡し、SQLite adapter は `BEGIN IMMEDIATE`、SQL、row mapping、constraint、FTS5 と index 更新を担当する。
HTTP API と CLI が利用する `Storage` は互換 facade として残すが、ページ変更メソッドは application service へ委譲する。

ページ version の検証から書き込みまでと、rename に伴う全ページの commit は同じ transaction callback 内で実行する。
import のページ保存と添付 claim の確定も同じ callback 内で実行する。
callback は現在の同期 SQLite 接続上で完結し、application 側へ `DatabaseSync`、SQL、SQLite error code を公開しない。

## 却下した案

**既存の `Storage` を用途ごとに多数の repository interface へ分割する案**。
単一の変更で page、commit、title history、link、search index を更新するため、細分化すると同じ transaction に参加させるための仕組みが責務分離そのものより大きくなるので採用しない。

**application service が transaction の外で変更計画を作り、adapter の一括メソッドへ渡す案**。
version 検証後や逆リンク列挙後に状態が変わる余地ができ、rename と逆リンク書き換えの atomicity を保つには adapter 側で業務規則を再実装する必要があるため採用しない。

**transaction の開始・commit・rollback を application service が個別に呼ぶ案**。
例外経路で rollback を漏らしやすく、SQLite の transaction 機構も露出するため callback 境界を採用する。

## 帰結

- application service は SQLite を使わない repository fake で検証できる。
- SQLite adapter は application service が決めた変更を永続化し、導出済みの link、代表画像、検索本文を index へ反映する。
- blob と SQLite metadata は同じ transaction に入らないため、添付ファイルは既存の claim と補償削除を維持する。
- D1 adapter と全面的な Clean Architecture はこの決定に含めない。

## 参照

- ADR 0001「TypeScript + Hono + SQLite の単一プロセスで作る」
- ADR 0002「行操作とページ version を書き込みの正規形式にする」
- ADR 0011「コンテンツ作者 Actor と認証 Account を分離する」
- GitHub issue [#83「Storageからapplication logicを分離し永続化境界を細分化する」](https://github.com/fenril058/knot/issues/83)
