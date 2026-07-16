import { html } from 'hono/html';
import type { Project } from '../../storage/types.ts';
import { layout, type Html } from './layout.ts';

export function projectIndexPage(projects: Project[]): Html {
  return layout('プロジェクト一覧', html`
<main>
<h1>プロジェクト一覧</h1>
${projects.length === 0
    ? html`<p>プロジェクトがありません。</p>`
    : html`<ul>${projects.map((project) => html`<li><a href="/${project.name}">${project.displayName}</a></li>`)}</ul>`}
</main>`,
  );
}
