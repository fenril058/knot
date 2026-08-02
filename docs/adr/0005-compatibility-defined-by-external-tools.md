# 0005: Cosense 互換性を、動作保証する外部ツールの列挙で定義する

- 状態: 承認済み
- 決定日: 2026-07-17（記録日: 2026-08-02）

「Cosense 互換」を仕様準拠として定義せず、**動作を保証する周辺ツールの列挙**として定義する。
Cosense の API に公開仕様が無い以上、準拠先が存在しないためである。

現在の対象は次の 2 つで、実体は `test/acceptance/` の受け入れテストである。

- `scrapbox-cosense-mcp` — 接続先は env `API_DOMAIN`、認証は `COSENSE_SID` を `Cookie: connect.sid=<sid>` として送る。knot のセッション cookie と同名・同形式なのでそのまま通る。
- `@helpfeel/cosense-cli` — Cosense 運営元の公式 CLI。任意の origin を受け付け、認証は `x-personal-access-token` ヘッダ。

## 帰結

- **後追いで API を足した。** `@helpfeel/cosense-cli` を対象に含めた結果、PAT 認証と `/api/pages/v2/:project/:title`、`/api/projects/:project/users` の 2 エンドポイントが必要になった。
  `/api/projects/:project/users` が 404 だと CLI の `listPages` と `readPage` が両方失敗する。ユーザー解決が必須経路にあるためで、これは互換契約の一部である。
- **契約の範囲を超えて応答を豪華にしない。** 対象ツールが実際に読むフィールドだけを契約とする。
  受け入れテストが失敗しても、契約の範囲外の形状変更で通そうとしない。
- **対象ツールを増やすことは互換性の定義を変えることである。** 追加は受け入れテストの追加を伴い、この ADR の更新に値する。

## 参照

蒸留元は plan-06（ops-compat）の互換性方針とツール調査結果。
原文は `git show 99e8189^:docs/superpowers/plans/2026-07-17-knot-06-ops-compat.md` で読める。
