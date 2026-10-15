import { RangeSet, RangeSetBuilder, StateEffect, type Extension } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  gutter,
  type ViewUpdate,
  ViewPlugin,
} from '@codemirror/view';
import type { Line } from '../../../core/ops.ts';
import { telomereWidth } from '../../../render/telomere.ts';
import {
  leaveTelomere,
  linkedLineIds,
  openTelomereMenu,
  showTelomereUpdated,
  updatedLabel,
  type TelomereTarget,
} from '../../telomereInfo.ts';
import { lineMeta } from '../sync.ts';

export const refreshTelomereGutter = StateEffect.define<void>();
// URL の fragment が変わり、行へのリンクが指す行が変わった。
const refreshLinkedLine = StateEffect.define<void>();

type TelomereConfig = {
  confirmedLines: () => readonly Line[];
  userId: string;
  lastSeenVersion: number;
  title: () => string;
  now?: () => number;
};

const canHover = window.matchMedia('(hover: hover)');
const linkedLine = Decoration.line({ class: 'highlight' });

// 編集表示の gutter のテロメア。閲覧表示のテロメアと同じく、hover で更新日時の帯を出し、押すと
// 行を強調して更新日時と行へのリンクのメニューを出す（#195）。touch でも押せば情報に届く。
class TelomereMarker extends GutterMarker {
  readonly className: string;
  readonly updated: number;
  readonly lineId: string | undefined;
  readonly title: () => string;

  constructor(className: string, updated: number, lineId: string | undefined, title: () => string) {
    super();
    this.className = className;
    this.updated = updated;
    this.lineId = lineId;
    this.title = title;
  }

  eq(other: TelomereMarker): boolean {
    return this.className === other.className && this.updated === other.updated && this.lineId === other.lineId;
  }

  toDOM(view: EditorView): Node {
    const marker = document.createElement('span');
    marker.className = this.className;
    const target: TelomereTarget = { anchor: marker, updated: this.updated, lineId: this.lineId, title: this.title };
    marker.addEventListener('mouseenter', () => {
      if (canHover.matches) showTelomereUpdated(target);
    });
    marker.addEventListener('mouseleave', leaveTelomere);
    marker.addEventListener('click', () => {
      if (this.lineId !== undefined) {
        history.replaceState(history.state, '', `#${this.lineId}`);
        view.dispatch({ effects: refreshLinkedLine.of() });
      }
      openTelomereMenu(target, false);
    });
    return marker;
  }
}

// 行ごとの更新日時と、行へのリンクに使う行の ID（行番号 - 1 の位置）。
type TelomereLine = { updated: number; lineId: string | undefined };

type Built = { markers: RangeSet<GutterMarker>; decorations: DecorationSet; lines: TelomereLine[] };

function build(view: EditorView, config: TelomereConfig): Built {
  const now = config.now?.() ?? Math.floor(Date.now() / 1000);
  const texts = view.state.doc.toString().split('\n');
  const metadata = lineMeta(config.confirmedLines(), texts, { userId: config.userId, now });
  const linkedIds = linkedLineIds(location.hash);
  const linkedId = linkedIds.find((id) => metadata.some((meta) => meta.id === id));
  const markers = new RangeSetBuilder<GutterMarker>();
  const decorations = new RangeSetBuilder<Decoration>();
  const lines: TelomereLine[] = [];
  for (let index = 0; index < metadata.length; index += 1) {
    const meta = metadata[index]!;
    const line = view.state.doc.line(index + 1);
    const unread = meta.updatedVersion !== Number.MAX_SAFE_INTEGER
      && meta.updatedVersion > config.lastSeenVersion;
    // 閲覧表示と同じ規則で、経過時間から線の太さを決める。
    const classes = ['telomere', `w-${telomereWidth(now - meta.updated)}`];
    if (unread) classes.push('unread');
    markers.add(line.from, line.from, new TelomereMarker(classes.join(' '), meta.updated, meta.id, config.title));
    lines.push({ updated: meta.updated, lineId: meta.id });
    // 閲覧表示と同じく、行へのリンクが指す行を強調する。編集を始めても強調は消えない。
    if (linkedId !== undefined && meta.id === linkedId) decorations.add(line.from, line.from, linkedLine);
  }
  return { markers: markers.finish(), decorations: decorations.finish(), lines };
}

function cursorLine(view: EditorView, lines: readonly TelomereLine[]): TelomereLine | undefined {
  return lines[view.state.doc.lineAt(view.state.selection.main.head).number - 1];
}

// 編集表示のテロメアへの、キーボードと読み上げの経路（#327）。CodeMirror は gutter を aria-hidden にするので、
// gutter のテロメアには Tab でも読み上げでも届かない。gutter の外の本文の前に、カーソル行のテロメアを指す
// button を 1 つ置く。閲覧表示のテロメアと同じく、名前は「<日時>に更新」で、Enter と Space で行を強調して
// メニューを開き、その最初の項目へ移る。メニューを閉じると、この button へ戻る。button はカーソル行の
// gutter のテロメアに重ね、focus したときだけ枠を描く。mouse と touch は、これまでどおり gutter のテロメアが
// 受ける（CSS の pointer-events: none）。
function cursorLineButton(view: EditorView, config: TelomereConfig, lines: () => readonly TelomereLine[]): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'telomere-keyboard';
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', (event) => {
    const line = cursorLine(view, lines());
    if (line === undefined) return;
    if (line.lineId !== undefined) {
      history.replaceState(history.state, '', `#${line.lineId}`);
      view.dispatch({ effects: refreshLinkedLine.of() });
    }
    openTelomereMenu({ anchor: button, updated: line.updated, lineId: line.lineId, title: config.title }, event.detail === 0);
  });
  view.dom.prepend(button);
  return button;
}

// button の名前をカーソル行の更新日時にし、カーソル行の gutter のテロメアの位置へ動かす。
function syncCursorLineButton(view: EditorView, button: HTMLButtonElement, lines: readonly TelomereLine[]): void {
  const line = cursorLine(view, lines);
  button.setAttribute('aria-label', line === undefined ? '' : updatedLabel(line.updated));
  view.requestMeasure({
    key: button,
    read: (current) => {
      const block = current.lineBlockAt(current.state.selection.main.head);
      const editor = current.dom.getBoundingClientRect();
      const column = current.dom.querySelector('.cm-telomere-gutter')?.getBoundingClientRect();
      return { top: current.documentTop + block.top - editor.top, height: block.height, left: (column?.left ?? editor.left) - editor.left };
    },
    write: ({ top, height, left }) => {
      button.style.top = `${top}px`;
      button.style.left = `${left}px`;
      button.style.height = `${height}px`;
    },
  });
}

function rebuilds(update: ViewUpdate): boolean {
  return update.docChanged || update.transactions.some((transaction) => (
    transaction.effects.some((effect) => effect.is(refreshTelomereGutter) || effect.is(refreshLinkedLine))
  ));
}

export function telomereGutter(config: TelomereConfig): Extension {
  const plugin = ViewPlugin.fromClass(class {
    markers: RangeSet<GutterMarker>;
    decorations: DecorationSet;
    lines: TelomereLine[];
    readonly button: HTMLButtonElement;
    readonly onHashChange: () => void;

    constructor(view: EditorView) {
      ({ markers: this.markers, decorations: this.decorations, lines: this.lines } = build(view, config));
      this.button = cursorLineButton(view, config, () => this.lines);
      syncCursorLineButton(view, this.button, this.lines);
      this.onHashChange = () => view.dispatch({ effects: refreshLinkedLine.of() });
      window.addEventListener('hashchange', this.onHashChange);
    }

    update(update: ViewUpdate): void {
      const rebuilt = rebuilds(update);
      if (rebuilt) ({ markers: this.markers, decorations: this.decorations, lines: this.lines } = build(update.view, config));
      if (rebuilt || update.selectionSet || update.geometryChanged || update.viewportChanged) {
        syncCursorLineButton(update.view, this.button, this.lines);
      }
    }

    destroy(): void {
      window.removeEventListener('hashchange', this.onHashChange);
      this.button.remove();
    }
  }, { decorations: (value) => value.decorations });

  return [
    plugin,
    gutter({
      class: 'cm-telomere-gutter',
      renderEmptyElements: true,
      markers: (view) => view.plugin(plugin)?.markers ?? RangeSet.empty,
      lineMarkerChange: (update) => update.docChanged || update.transactions.some((transaction) => (
        transaction.effects.some((effect) => effect.is(refreshTelomereGutter))
      )),
    }),
  ];
}
