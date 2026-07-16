import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';

/** hono の html`` の実際の戻り型。views 各所で共有する。 */
export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export function layout(title: string, body: Html): Html {
  return html`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/assets/app.css">
</head>
<body>${body}</body>
</html>`;
}
