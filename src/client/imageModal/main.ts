// 本文の画像を押したときの dialog（Cosense の .full-content-modal、#319）。Cosense と同じく、画像を画面の中央に
// 大きく出す。dialog の中の画像は新しいタブで画像を開くリンクで、押すと dialog を閉じる。Escape と背景を
// 押しても閉じる。ctrl / cmd / shift / alt を押しながらの click と中ボタンは、リンクのまま新しいタブで開く。
// 閲覧表示の行と、編集表示の整形表示の行の画像のリンク（a.image-link）が対象。

const dialog = document.createElement('dialog');
dialog.className = 'image-modal';
dialog.setAttribute('aria-label', '画像');
const link = document.createElement('a');
link.className = 'image-modal-link';
link.target = '_blank';
link.rel = 'noopener noreferrer';
const image = document.createElement('img');
image.className = 'image-modal-image';
image.alt = '画像';
link.append(image);
dialog.append(link);
document.body.append(dialog);

link.addEventListener('click', () => dialog.close());
// 画像の外（dialog の余白と背景）を押したとき、click の対象は dialog そのものになる。
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});

document.addEventListener('click', (event) => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  if (!(event.target instanceof Element)) return;
  const anchor = event.target.closest<HTMLAnchorElement>('#editor-root a.image-link');
  const source = anchor?.querySelector('img');
  if (anchor === null || anchor === undefined || source === null || source === undefined) return;
  event.preventDefault();
  link.href = anchor.href;
  image.src = source.currentSrc === '' ? source.src : source.currentSrc;
  dialog.showModal();
});
