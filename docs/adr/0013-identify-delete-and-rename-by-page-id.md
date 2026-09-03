# 0013: delete と rename の対象をページ ID で識別する

- 状態: 承認済み
- 決定日: 2026-09-03

ページの URL と routing にはタイトルを使っている。
タイトルは rename で変わり、rename 後の旧タイトルを別のページに再利用できる。

ADR 0010 は、ブラウザの編集コミットとページ取得でページ ID を優先し、タイトル変更後も同じページを追跡できるようにした。
同 ADR は新規ページと既存クライアントとの互換性のため、ページ ID を送らないタイトル経路も維持した。
rename と delete は ADR 0010 の直接の対象ではなかった。

PR #144 と PR #146 では、旧タイトルの再利用によって stale な delete と rename が別ページを対象にできる不具合を確認した。
本 ADR の対象は、両 PR で契約を変更した delete と rename に限る。
title-only の全文置換 API（`PUT /api/knot/pages/:project/:title/text`）を含む他の変更契約は、本 ADR の対象にしない。
利用者が `Old` というタイトルのページ A の version 1 を表示した後、別の client が A を rename し、version 1 のページ B が `Old` を再利用したとする。
stale な client が URL の `Old` を対象に変更を要求すると、タイトル lookup はページ B を解決する。
このとき `baseVersion: 1` は B の version とも一致するため、version の検査だけでは誤った対象を拒否できない。

`baseVersion` は caller が変更の基準にしたページ version を表すが、そのページの identity は表さない。
したがって、タイトル lookup で対象を決めた後に `baseVersion` を検査すると、stale delete は B を削除でき、stale rename は B を rename できる。
rename で逆リンクを書き換える場合は、利用者が確認していない B の旧タイトルへのリンクまで書き換えられる。
タイトル lookup を transaction 内へ移しても B を解決する点は変わらないため、この問題は transaction の位置だけでは解決しない。

## 決定

delete と rename では、caller が指定した `pageId` と `baseVersion` を必須にする。
タイトル変更やタイトル再利用をまたいでも変わらないページ ID を、変更対象の識別子とする。

現在の delete と rename は、一つの application transaction 内で対象ページに関する次の相対順序を満たす。

1. `pageId` で対象ページを取得する。
2. 対象ページが request のプロジェクトに属することを検査する。
3. caller が指定した `baseVersion` と対象ページの現在の version を照合する。
4. version が一致した後で、対象ページが削除済みでないことを検査する。
5. 検査に成功した後で delete または rename を実行する。

rename の逆リンク書き換えも、対象ページの rename と同じ transaction 内で実行する。
D1 を含む後続の storage implementation も、この識別と検査を delete または rename と原子的に扱う。

URL のタイトルは routing、表示、percent-encoding の検証に残してよい。
ただし、URL のタイトルを delete または rename の対象を決める情報として使わず、caller が `pageId` を送らない title-only compatibility path は維持しない。
現在の delete と rename は、URL のタイトルと `pageId` で取得したページの現在のタイトルが一致することも検査しない。
したがって、正しい `pageId` を指定すれば、URL のタイトルが古い場合や別のタイトルである場合も、同じページを対象にできる。

## ADR 0010 との関係

この決定は ADR 0010 全体を置換しない。
ADR 0010 が導入した、ページ ID で同じページを追跡する考え方を delete と rename へ拡張する。

ADR 0010 の「`pageId` を送らない既存クライアントのタイトル経路は維持する」という帰結は、同 ADR が対象とするページ取得と編集コミットには残る。
その帰結を delete と rename にも適用する解釈は、本 ADR が置き換える。

ADR 0012 が定めた、application service がページ変更の規則と transaction 範囲を所有する責務は維持する。
本 ADR は、その transaction で守る変更対象の識別に関する不変条件を追加する。
ADR 0012 は D1 adapter を決定の対象に含めておらず、D1 で使う transaction mechanism は issue #141 と issue #143 で決める。

title-only client との互換性を失うのは delete と rename に限られる。
ADR 0004 が互換性の対象とする外部ツールは両 endpoint を利用していないため、本 ADR は ADR 0004 を置換しない。

## 却下した案

**title-only compatibility path を残す案**。
既存 client との互換性は高いが、旧タイトルを別ページが再利用したときの識別の曖昧さが残り、`baseVersion` が偶然一致する別ページへの delete または rename を防げないため採用しない。

**ページ ID 専用の URL または endpoint を追加し、従来の endpoint も残す案**。
段階的な移行経路は作れるが、title-only の delete と rename が残り続け、初期段階の Knot で二つの request contract を維持する価値が低いため採用しない。

**delete と rename をページ ID 専用の URL へ移し、従来の endpoint を廃止する案**。
ADR 0010 がページ ID 専用の書き込み URL を却下した理由のうち、「新規ページにはまだページ ID がない」は、既存ページだけを対象にする delete と rename には当てはまらない。
ページ ID 専用の URL なら、URL と変更対象の識別子を一致させられる。
しかし、PR #144 と PR #146 で従来の URL を保ったまま `pageId` を必須にして識別の不具合を解消しており、別の routing contract への移行は同じ不変条件を強めないため採用しない。

## 帰結

### 利点

- タイトルの rename と再利用を、delete と rename の対象の識別から分離できる。
- stale な client は、旧タイトルを再利用した同名の別ページを削除または rename できず、そのページの逆リンクも書き換えられない。
- D1 などの後続の storage implementation が delete と rename で再現すべき識別の不変条件が明確になる。

### 欠点と互換性

- delete と rename の client は、表示時に取得した `pageId` を `baseVersion` とともに送る必要がある。
- title-only の delete または rename を行う client との互換性は失われる。
- routing の URL と変更対象の識別子が異なるため、実装では両者を混同しない必要がある。

### この決定に含まれないこと

- すべての API を直ちに page ID だけを受け付ける契約へ変える決定ではない。
- `PUT /api/knot/pages/:project/:title/text` を page ID 必須へ変える決定ではない。
- ページ URL を ID-based URL へ変える決定ではない。
- Node と SQLite の implementation を廃止する決定ではない。
- D1 の implementation strategy を決める ADR ではない。

## 参照

- ADR 0004「Cosense 互換性を、動作保証する外部ツールで定義する」
- ADR 0010「ブラウザ編集コミットの対象をページ ID で識別する」
- ADR 0012「application service がページ変更の transaction 範囲を決める」
- GitHub issue [#138「Cloudflare FreeでWeb dogfoodを成立させる」](https://github.com/fenril058/knot/issues/138)
- GitHub issue [#128「page 削除にも baseVersion を要求して並行編集を保護する」](https://github.com/fenril058/knot/issues/128) と pull request [#144「page 削除の stale client を拒否する」](https://github.com/fenril058/knot/pull/144)
- GitHub issue [#145「rename 対象を pageId で固定して stale client を拒否する」](https://github.com/fenril058/knot/issues/145) と pull request [#146「rename の stale client を拒否する」](https://github.com/fenril058/knot/pull/146)
- GitHub issue [#150「破壊的 mutation を pageId 識別にする決定を ADR にする」](https://github.com/fenril058/knot/issues/150)
- GitHub issue [#141「D1でpage commit/deleteの競合・冪等性を守る」](https://github.com/fenril058/knot/issues/141)
- GitHub issue [#143「D1でrenameと逆リンク書き換えを原子的にする」](https://github.com/fenril058/knot/issues/143)
