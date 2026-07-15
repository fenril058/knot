import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';

export function layout(title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>): HtmlEscapedString {
  return html`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/assets/app.css">
</head>
<body>${body}</body>
</html>` as unknown as HtmlEscapedString;
}
