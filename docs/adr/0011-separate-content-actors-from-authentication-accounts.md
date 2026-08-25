# 0011: コンテンツ作者 Actor と認証 Account を分離する

- 状態: 承認済み
- 決定日: 2026-08-25

コンテンツの作者 identity を Actor、ログインできる identity を Account とし、別のテーブルと別の ID 型として扱う。
Account は通常の web 編集に使用する 1 つの Actor を明示的に参照するが、Actor は Account がなくても存続する。
Account の名前変更や将来の削除では Actor を変更または削除しないため、過去の作者表示は維持される。

既存の `users` は、`password_hash` がある行を Actor と Account の双方へ、`password_hash = null` の行を Actor のみへ移行する。
認証可能な既存行では互換性のため Actor ID と Account ID に同じ文字列を保持するが、同一であることを新しいコードの前提にはしない。
session、API token、ページ訪問は Account を参照し、line、commit、attachment は Actor を参照する。

新規 Account には、Account ID とは異なる ID の新規 Actor を作成する。
同名の imported Actor が存在しても関連づけず、従来の `claimed` による暗黙の昇格は廃止する。
既存 Actor との関連変更は、由来を確認できる明示操作として別途設計するまで提供しない。

## 却下した案

**同名の imported Actor を新規 Account に自動的に関連づける案**。
現行データには import 元や import 元での identity を一意に確認できる情報がなく、別の import 元にいる同名作者を取得するおそれがあるため採用しない。

**Actor と Account で常に同じ ID を発行する案**。
別概念であることを型とデータから区別できず、将来の名前変更や認証方式の変更で再び identity を結合するため採用しない。

**この変更と同時に既存 Actor を Account へ関連づける操作を追加する案**。
安全な本人確認条件と操作権限の設計が必要であり、Actor と Account の分離だけを扱う GitHub issue #84 の範囲を超えるため採用しない。

## 帰結

- Cosense の import / export で使う `users` と line の `userId` は互換形式の名前として維持するが、内部では Actor として扱う。
- Actor の名前は Account の login name とは独立し、同名 Actor の存在を許す。
- Account 削除機能、ACL、SSO、複数 Actor の切り替えはこの決定だけでは導入しない。
- Storage 境界の分割と application logic の切り出しは GitHub issue #83 で扱う。

## 参照

- ADR 0005「v1 はログイン利用者だけが全プロジェクトを読み書きする」
- ADR 0007「直接編集でもログイン必須の境界を維持する」
- GitHub issue [#84「identity: コンテンツ作者Actorと認証Account/Principalを分離する」](https://github.com/fenril058/knot/issues/84)
