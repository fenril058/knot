import { html } from 'hono/html';
import type { Project } from '../../storage/types.ts';
import { layout, type Html } from './layout.ts';

export function projectIndexPage(projects: Project[]): Html {
  return layout('プロジェクト一覧', html`
<main>
<h1>プロジェクト一覧</h1>
<section class="create-project" aria-labelledby="create-project-heading">
<h2 id="create-project-heading">新しいプロジェクト</h2>
<form id="create-project-form">
<label for="create-project-name">プロジェクト名</label>
<input
  id="create-project-name"
  name="name"
  required
  autocomplete="off"
  autocapitalize="none"
  spellcheck="false"
  enterkeyhint="done"
  aria-describedby="create-project-help create-project-error"
>
<p id="create-project-help">1〜64文字の小文字の英数字とハイフンを使用できます。</p>
<p id="create-project-error" class="error" role="alert" hidden></p>
<button type="submit">プロジェクトを作成</button>
</form>
</section>
${projects.length === 0
    ? html`<p>プロジェクトがありません。</p>`
    : html`<ul>${projects.map((project) => html`<li><a href="/${project.name}">${project.displayName}</a></li>`)}</ul>`}
</main>
<script type="module" src="/assets/build/project-index.js"></script>`,
  );
}
