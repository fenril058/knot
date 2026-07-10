# Cosense Clone 設計計画書 (Draft 0.1)

## 目的

Cosense (旧 Scrapbox) の思想を受け継ぎつつ、

- ローカルファースト
- セルフホスト可能
- 単一バイナリで動作
- Gitで管理可能
- オフライン動作
- Web UI
- 将来的な共同編集対応

を実現する。

目標は「Cosense互換」ではなく、

> **Cosenseの設計思想を引き継いだOSS Wiki**

である。

---

# 基本思想

## Source of Truth

データベースではない。

```
*.page
```

ファイル群が唯一の正本である。

```
pages/

    AI.page

    Linux.page

    Rust.page
```

DBはすべて再生成可能。

---

## Index First

SQLite(D1)はキャッシュである。

保持するもの

- Page一覧
- Backlink
- Link
- Search Index
- 更新時刻
- タグ
- メタデータ

保持しないもの

- 本文

本文は必ず .page にある。

---

# システム構成

```
                 Browser

                    │

          Cloudflare Pages

                    │

              Cloudflare Worker

          ┌──────────────┐
          │              │
          │              │
         D1             R2
          │
          │
     Search Index

```

ローカル版

```
Browser

↓

Local Server

↓

SQLite

↓

.page files
```

Parserは完全共通。

---

# コンポーネント

## parser

責務

```
.page

↓

AST
```

のみ。

UI依存禁止。

Storage依存禁止。

---

## model

```
Page

Line

Token

Link

Code

Image

URL
```

Cosenseの記法を表現する。

---

## indexer

責務

```
AST

↓

SQLite
```

更新する。

---

## storage

責務

```
AI.page

↓

Read

↓

Write
```

だけ。

---

## search

SQLite FTS5を利用。

検索対象

- 本文
- タイトル

---

## server

HTTP API

例

```
GET /page/AI

POST /page/AI

GET /search

GET /backlinks/AI
```

---

# ディレクトリ構成

```
project/

    pages/

    assets/

    .wiki/

        index.db

        cache/

        thumbnails/

```

.gitignore

```
.wiki/
```

のみ。

---

# ページフォーマット

UTF-8

改行のみ意味を持つ。

例

```
今日は [AI] を勉強した

 AIとは...

 関連

  [LLM]

  [Transformer]
```

Parserは

```
Line

↓

Token
```

程度まで解析する。

---

# データベース

pages

```
id

title

mtime

hash
```

links

```
from_page

to_page

line
```

backlinks

生成しない。

linksから取得。

fts

SQLite FTS5

---

# インデックス更新

保存時

```
.page

↓

hash比較

↓

変更あり

↓

Parser

↓

Index更新
```

将来的には差分更新。

---

# API

## GET /page/:title

```
.page

↓

JSON
```

## POST /page/:title

保存

Index更新

---

## GET /search

全文検索

---

## GET /links

Forward Link

---

## GET /backlinks

Back Link

---

# Frontend

候補

- CodeMirror
- React

Tauriでも動く。

Cloudflare Pagesでも動く。

---

# UI

最初に作るもの

- 編集
- 保存
- 検索
- Backlink
- ページ一覧

作らない

- Graph
- Plugin
- Notification
- Comment
- Presentation

---

# 添付ファイル

```
assets/

    image.png

    pdf.pdf
```

Cloud

```
R2
```

Local

```
assets/
```

---

# Git

コミット対象

```
pages/

assets/
```

コミットしない

```
.wiki/
```

これにより

```
git clone

↓

reindex

↓

完成
```

となる。

---

# Cloudflare構成

Pages

- Frontend

Worker

- API

D1

- Index

R2

- Asset

KV

将来的にSession保持程度。

---

# 将来のDurable Objects

共同編集導入時のみ。

```
Editor

↓

Durable Object

↓

Broadcast

↓

Client
```

現段階では不要。

---

# Rust Crates

parser

```
nom
```

または自前。

DB

```
rusqlite
```

HTTP

```
axum
```

JSON

```
serde
```

Watcher

```
notify
```

Hash

```
blake3
```

---

# MVP

- 編集
- 保存
- ページ作成
- Link
- Backlink
- Search
- 添付画像
- Git管理

これだけで十分実用になる。

---

# Version Roadmap

## v0.1

- Parser
- Storage
- SQLite
- Search
- Web UI

---

## v0.2

- タグ
- ページ一覧
- 最近更新
- Rename

---

## v0.3

- Plugin API
- Export
- Import
- Backup

---

## v0.4

- Cloudflare Deploy
- D1
- R2

---

## v0.5

- Login
- Project

---

## v0.6

- Realtime Sync
- Durable Objects

---

## v1.0

セルフホスト可能な
ローカルファーストWiki完成

---

## Remarks

1. SQLiteはキャッシュであり、唯一の真実ではない

これを徹底すると、SQLite→PostgreSQLやD1への移行も容易になりますし、「インデックスが壊れたら再構築」がいつでもできます。

2. Cloudflareは「デプロイ先」であって「設計の前提」ではない

コアライブラリ（Parser・Model・Indexer）はCloudflareに依存させません。Cloudflare向けの実装はAdapter層として切り離します。

```text
          Core
 ┌─────────────────────┐
 │ Parser              │
 │ Model               │
 │ Indexer             │
 │ Search              │
 └─────────────────────┘
          ▲
          │
   ┌──────┴─────────┐
   │                │
Local Adapter   Cloudflare Adapter
(SQLite)           (D1)
(FileSystem)       (R2)
(axum)             (Worker)
```
