import { ulid } from '../../core/id.ts';
import { encodeTitleForUrl, pageHref } from '../../core/title.ts';
import { duplicateOps } from './ops.ts';

type DialogElements = { dialog: HTMLDialogElement; form: HTMLFormElement; error: HTMLElement };

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`${selector} is missing`);
  return element;
}

function dialogElements(name: string): DialogElements {
  return {
    dialog: requireElement<HTMLDialogElement>(`#${name}-dialog`),
    form: requireElement<HTMLFormElement>(`#${name}-form`),
    error: requireElement<HTMLElement>(`#${name}-error`),
  };
}

async function errorMessage(response: Response): Promise<string> {
  const fallback = `操作に失敗しました（${response.status}）`;
  try {
    const body = await response.json() as { message?: unknown };
    return typeof body.message === 'string' ? body.message : fallback;
  } catch {
    return fallback;
  }
}

function showError(elements: DialogElements, message: string): void {
  elements.error.textContent = message;
  elements.error.hidden = false;
}

const root = requireElement<HTMLElement>('#page-menu-root');
const { project, title, version: versionText } = root.dataset;
if (project === undefined || title === undefined || versionText === undefined) {
  throw new Error('page menu data attributes are missing');
}
const version = Number(versionText);
if (!Number.isInteger(version)) throw new Error('page version is invalid');

const duplicate = dialogElements('duplicate');
const rename = dialogElements('rename');
const remove = dialogElements('delete');
const duplicateTitle = requireElement<HTMLInputElement>('#duplicate-title');
const renameTitle = requireElement<HTMLInputElement>('#rename-title');
const rewriteLinks = requireElement<HTMLInputElement>('#rename-rewrite-links');

requireElement<HTMLButtonElement>('#duplicate-button').addEventListener('click', () => duplicate.dialog.showModal());
requireElement<HTMLButtonElement>('#rename-button').addEventListener('click', () => rename.dialog.showModal());
requireElement<HTMLButtonElement>('#delete-button').addEventListener('click', () => remove.dialog.showModal());
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-dialog-close]')) {
  button.addEventListener('click', () => button.closest('dialog')?.close());
}

duplicate.form.addEventListener('submit', (event) => {
  event.preventDefault();
  duplicate.error.hidden = true;
  const newTitle = duplicateTitle.value.trim();
  void (async () => {
    try {
      const sourceResponse = await fetch(`/api/pages/${encodeURIComponent(project)}/${encodeTitleForUrl(title)}`, {
        headers: { 'X-Knot-Client': 'page-menu' },
      });
      if (!sourceResponse.ok) return showError(duplicate, await errorMessage(sourceResponse));
      const source = await sourceResponse.json() as { lines: { text: string }[] };
      const response = await fetch(`/api/knot/pages/${encodeURIComponent(project)}/${encodeTitleForUrl(newTitle)}/commits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Knot-Client': 'page-menu' },
        body: JSON.stringify({ commitId: ulid(), baseVersion: 0, ops: duplicateOps(source.lines, newTitle, ulid) }),
      });
      if (!response.ok) return showError(duplicate, await errorMessage(response));
      window.location.assign(pageHref(project, newTitle));
    } catch {
      showError(duplicate, '通信に失敗しました。もう一度お試しください');
    }
  })();
});

rename.form.addEventListener('submit', (event) => {
  event.preventDefault();
  rename.error.hidden = true;
  const newTitle = renameTitle.value.trim();
  void (async () => {
    try {
      const response = await fetch(`/api/knot/pages/${encodeURIComponent(project)}/${encodeTitleForUrl(title)}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Knot-Client': 'page-menu' },
        body: JSON.stringify({ newTitle, baseVersion: version, rewriteLinks: rewriteLinks.checked }),
      });
      if (!response.ok) {
        return showError(rename, response.status === 409
          ? '他の編集と競合しました。ページを再読み込みしてください'
          : await errorMessage(response));
      }
      window.location.assign(pageHref(project, newTitle));
    } catch {
      showError(rename, '通信に失敗しました。もう一度お試しください');
    }
  })();
});

remove.form.addEventListener('submit', (event) => {
  event.preventDefault();
  remove.error.hidden = true;
  void (async () => {
    try {
      const response = await fetch(`/api/knot/pages/${encodeURIComponent(project)}/${encodeTitleForUrl(title)}`, {
        method: 'DELETE',
        headers: { 'X-Knot-Client': 'page-menu' },
      });
      if (!response.ok) return showError(remove, await errorMessage(response));
      window.location.assign(`/${encodeURIComponent(project)}`);
    } catch {
      showError(remove, '通信に失敗しました。もう一度お試しください');
    }
  })();
});
