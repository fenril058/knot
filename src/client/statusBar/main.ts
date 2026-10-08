// 画面の左下のページのタイトル（Cosense の .status-bar .page-title、#307）。Cosense と同じく、200px を超えて
// scroll したときだけ出す。
const SCROLL_THRESHOLD = 200;

const title = document.querySelector<HTMLElement>('.status-page-title');
if (title !== null) {
  const update = (): void => {
    title.hidden = window.scrollY <= SCROLL_THRESHOLD;
  };
  window.addEventListener('scroll', update, { passive: true });
  update();
}
