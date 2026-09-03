import { ulid } from '../../core/id.ts';
import { encodeTitleForUrl, pageHref } from '../../core/title.ts';
import { duplicateOps } from './ops.ts';

type DialogElements = { dialog: HTMLDialogElement; form: HTMLFormElement; error: HTMLElement };

// 呼び出し側が指定した型へ無検査で化けないよう、コンストラクタを受け取って実際に検証する。
function requireElement<T extends Element>(selector: string, ctor: new () => T): T {
  const element = document.querySelector(selector);
  if (element === null) throw new Error(`${selector} is missing`);
  if (!(element instanceof ctor)) throw new Error(`${selector} is not a ${ctor.name}`);
  return element;
}

function dialogElements(name: string): DialogElements {
  return {
    dialog: requireElement(`#${name}-dialog`, HTMLDialogElement),
    form: requireElement(`#${name}-form`, HTMLFormElement),
    error: requireElement(`#${name}-error`, HTMLElement),
  };
}

async function errorMessage(response: Response): Promise<string> {
  const fallback = `操作に失敗しました（${response.status}）`;
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
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

const root = requireElement('#page-menu-root', HTMLElement);
const { project, title, pageId, version: versionText } = root.dataset;
if (project === undefined || title === undefined || pageId === undefined || pageId === '' || versionText === undefined) {
  throw new Error('page menu data attributes are missing');
}
const version = Number(versionText);
if (!Number.isInteger(version)) throw new Error('page version is invalid');

const duplicate = dialogElements('duplicate');
const rename = dialogElements('rename');
const remove = dialogElements('delete');
const duplicateTitle = requireElement('#duplicate-title', HTMLInputElement);
const renameTitle = requireElement('#rename-title', HTMLInputElement);
const rewriteLinks = requireElement('#rename-rewrite-links', HTMLInputElement);

requireElement('#duplicate-button', HTMLButtonElement).addEventListener('click', () => duplicate.dialog.showModal());
requireElement('#rename-button', HTMLButtonElement).addEventListener('click', () => rename.dialog.showModal());
requireElement('#delete-button', HTMLButtonElement).addEventListener('click', () => remove.dialog.showModal());
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
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
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
        body: JSON.stringify({ pageId, newTitle, baseVersion: version, rewriteLinks: rewriteLinks.checked }),
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
        headers: { 'Content-Type': 'application/json', 'X-Knot-Client': 'page-menu' },
        body: JSON.stringify({ pageId, baseVersion: version }),
      });
      if (!response.ok) {
        return showError(remove, response.status === 409
          ? '他の編集と競合しました。ページを再読み込みしてください'
          : await errorMessage(response));
      }
      window.location.assign(`/${encodeURIComponent(project)}`);
    } catch {
      showError(remove, '通信に失敗しました。もう一度お試しください');
    }
  })();
});
