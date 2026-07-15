import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { layout } from './layout.ts';

export function loginPage(): HtmlEscapedString {
  return layout(
    'ログイン',
    html`
<form id="login-form">
  <label>ユーザー名 <input type="text" name="name" required></label>
  <label>パスワード <input type="password" name="password" required></label>
  <button type="submit">ログイン</button>
</form>
<script src="/assets/login.js" defer></script>`,
  ) as unknown as HtmlEscapedString;
}
