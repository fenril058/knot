// 並び替えの menu（server/views/sortMenu.ts）を、Cosense の menu と同じく、Escape と menu の外を押したときに
// 閉じる。Escape で閉じたときは、展開ボタンへ focus を戻す。関連ページ（#281）とプロジェクトのトップ（#291）が使う。
export function closeSortMenuOnEscapeAndOutside(menu: HTMLDetailsElement, toggle: HTMLElement): void {
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !menu.open) return;
    menu.open = false;
    toggle.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (menu.open && !(event.target instanceof Node && menu.contains(event.target))) menu.open = false;
  });
}
