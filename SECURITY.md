# セキュリティポリシー

## 対象バージョン

knot はまだリリースを行っていません。
セキュリティ修正の対象は `main` の最新コミットだけです。

過去のコミットや、それを取り込んだ配布物に対する個別の修正は提供しません。

## 脆弱性の報告

**公開 issue に脆弱性を書かないでください。**

報告には GitHub の非公開報告を使ってください。
このリポジトリの [Security タブ](https://github.com/fenril058/knot/security) から "Report a vulnerability" を選ぶと、非公開のやり取りが始まります。

報告に次の内容が含まれていると助かります。

- 影響する挙動と、想定される被害
- 再現手順（可能なら最小の再現ケース）
- 確認したコミット

このプロジェクトは個人が余暇で開発しています。
初回の応答までに数日かかることがあります。
報奨金の制度はありません。

## 対象範囲

knot はセルフホストの wiki です。
利用者自身が用意したサーバとリバースプロキシの上で動くため、報告を受け付ける範囲を次のように分けています。

**対象**

- 認証・認可の回避（未認証での読み書き、他人のセッションの奪取）
- 保存された内容による script 実行（XSS）、CSRF、添付ファイルを介した任意コード実行
- 秘密情報（パスワードハッシュ、personal access token、セッション ID）の漏洩や、その保管方式の弱点

**対象外**

- ログイン済み利用者が、仕様どおりに他のプロジェクトを読み書きできること。
  knot v1 はログインした利用者全員が全プロジェクトを読み書きできる設計です。
  この境界の理由は [ADR 0005](docs/adr/0005-closed-wiki-access-boundary.md) にあります。

  ただし対象外なのは**この設計どおりのアクセスだけ**です。
  ログイン済み利用者が保存した内容による XSS、他人のセッションの奪取、サーバ上の任意コード実行、設計を超えた権限の取得は、きっかけがログイン後の操作であっても対象です。
- 運用側の設定に起因する問題（TLS を終端しない、`secureCookie` の設定誤り、リバースプロキシの設定誤りなど）。
  設定方法は [docs/ops.md](docs/ops.md) を参照してください。
- 依存パッケージの脆弱性そのもの。
  Dependabot が追跡しています。
  knot 側の使い方に問題がある場合は対象です。

---

実装側で維持している安全要件は [docs/security-requirements.md](docs/security-requirements.md) にあります。
こちらは報告者向けではなく、knot を変更する開発者向けの文書です。

## English

Please do not open a public issue for security vulnerabilities.
Report them privately through the [Security tab](https://github.com/fenril058/knot/security) using "Report a vulnerability".

knot has no releases yet; only the latest commit on `main` receives security fixes.
This is a spare-time project, so the first response may take a few days.

A logged-in user's expected ability to read and write every project is out of scope: knot v1 is a closed wiki where that access is by design.
Stored XSS, session theft, arbitrary code execution, and any privilege beyond that documented access remain in scope, even when the initial action requires authentication.
