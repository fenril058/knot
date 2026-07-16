import { html } from 'hono/html';
import type { Project, Visit } from '../../storage/types.ts';
import { layout, type Html } from './layout.ts';

export function editorPage(
  project: Project,
  title: string,
  userName: string,
  previousVisit: Visit | null,
  styleNonce: string,
): Html {
  return layout(title, html`
<nav class="page-nav"><a href="/${encodeURIComponent(project.name)}">${project.displayName}</a></nav>
<main
  id="editor-root"
  data-project="${project.name}"
  data-title="${title}"
  data-user-name="${userName}"
  data-last-seen-version="${previousVisit?.lastSeenVersion ?? 0}"
  data-csp-nonce="${styleNonce}"
>
  <div id="save-status" aria-live="polite"></div>
</main>
<script type="module" src="/assets/build/editor.js"></script>`,
  );
}
