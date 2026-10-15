// テロメアの線の太さ（px）。行の更新からの経過時間が長いほど細くなる。
// Cosense の公開ページで、各行の更新時刻と線の太さを突き合わせた観測（#239）への当てはめで、
// 経過時間 + 約 2.2 時間が e 倍になるごとに 1px 細くなる。Cosense の実装の式そのものではない。
// 閲覧表示と編集表示がこの 1 つの規則を使う。
export function telomereWidth(elapsedSeconds: number): number {
  const width = Math.round(18.706 - Math.log(Math.max(0, elapsedSeconds) + 8072));
  return Math.min(10, Math.max(1, width));
}
