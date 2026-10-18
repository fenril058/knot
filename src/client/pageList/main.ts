import { pageHref } from '../../core/title.ts';
import { closeSortMenuOnEscapeAndOutside } from '../sortMenu.ts';

// プロジェクトのトップの「新規作成」。タイトルを入れると、そのタイトルのページを開いて作り始める。
const root = document.querySelector<HTMLElement>('#page-list-root');
const createButton = document.querySelector<HTMLButtonElement>('#create-page-button');
const createDialog = document.querySelector<HTMLDialogElement>('#create-page-dialog');
const createForm = document.querySelector<HTMLFormElement>('#create-page-form');
const createTitle = document.querySelector<HTMLInputElement>('#create-page-title');
if (root === null || createButton === null || createDialog === null || createForm === null || createTitle === null) {
  throw new Error('create page controls are missing');
}
const project = root.dataset.project;
if (project === undefined) throw new Error('page list data attributes are missing');

createButton.addEventListener('click', () => createDialog.showModal());
createForm.addEventListener('submit', (event) => {
  event.preventDefault();
  window.location.assign(pageHref(project, createTitle.value.trim()));
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-dialog-close]')) {
  button.addEventListener('click', () => button.closest('dialog')?.close());
}

// 並び替えの menu（#291）。項目はその並び替えで描き直すリンクなので、ここでは閉じ方だけを付ける。
const sortMenu = root.querySelector('.page-sort-menu');
const sortToggle = sortMenu?.querySelector('summary');
if (sortMenu instanceof HTMLDetailsElement && sortToggle instanceof HTMLElement) {
  closeSortMenuOnEscapeAndOutside(sortMenu, sortToggle);
}
