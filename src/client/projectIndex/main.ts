const form = document.querySelector<HTMLFormElement>('#create-project-form');
const nameInput = document.querySelector<HTMLInputElement>('#create-project-name');
const error = document.querySelector<HTMLElement>('#create-project-error');
const submitButton = form?.querySelector<HTMLButtonElement>('button[type="submit"]') ?? null;

if (form === null || nameInput === null || error === null || submitButton === null) {
  throw new Error('create project controls are missing');
}
const createForm = form;
const projectName = nameInput;
const errorMessage = error;
const createButton = submitButton;
let inputVersion = 0;
let activeRequest: AbortController | null = null;

function showError(message: string): void {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
  projectName.setAttribute('aria-invalid', 'true');
  projectName.focus();
}

function clearError(): void {
  errorMessage.textContent = '';
  errorMessage.hidden = true;
  projectName.removeAttribute('aria-invalid');
}

createForm.addEventListener('submit', (event) => {
  event.preventDefault();
  clearError();
  activeRequest?.abort();
  const request = new AbortController();
  activeRequest = request;
  createButton.disabled = true;
  const submittedInputVersion = inputVersion;
  const submittedName = projectName.value;

  void (async () => {
    try {
      const response = await fetch(`/api/knot/projects/${encodeURIComponent(submittedName)}`, {
        method: 'POST',
        headers: { 'X-Knot-Client': 'browser' },
        signal: request.signal,
      });
      if (submittedInputVersion !== inputVersion) return;
      if (response.status === 409) {
        showError('同じ名前のプロジェクトがすでに存在します。別の名前を入力してください。');
        return;
      }
      if (response.status === 400 || response.status === 404) {
        showError(
          'そのプロジェクト名は使用できません。1〜64文字の小文字の英数字とハイフンを使い、予約済みの名前を避けてください。',
        );
        return;
      }
      if (!response.ok) {
        showError('プロジェクトを作成できませんでした。再読み込みして、もう一度お試しください。');
        return;
      }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const project = await response.json() as { name: string; created?: boolean };
      if (submittedInputVersion !== inputVersion) return;
      if (project.created === false) {
        showError('同じ名前のプロジェクトがすでに存在します。別の名前を入力してください。');
        return;
      }
      window.location.assign(`/${encodeURIComponent(project.name)}`);
    } catch {
      if (request.signal.aborted) return;
      if (submittedInputVersion !== inputVersion) return;
      showError('通信に失敗しました。接続を確認して、もう一度お試しください。');
    } finally {
      if (activeRequest === request) {
        activeRequest = null;
        createButton.disabled = false;
      }
    }
  })();
});

projectName.addEventListener('input', () => {
  inputVersion += 1;
  clearError();
  if (activeRequest !== null) {
    const request = activeRequest;
    activeRequest = null;
    request.abort();
    createButton.disabled = false;
  }
});
