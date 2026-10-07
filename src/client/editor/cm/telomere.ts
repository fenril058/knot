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

type Built = { markers: RangeSet<GutterMarker>; decorations: DecorationSet };

function build(view: EditorView, config: TelomereConfig): Built {
  const now = config.now?.() ?? Math.floor(Date.now() / 1000);
  const texts = view.state.doc.toString().split('\n');
  const metadata = lineMeta(config.confirmedLines(), texts, { userId: config.userId, now });
  const linkedIds = linkedLineIds(location.hash);
  const linkedId = linkedIds.find((id) => metadata.some((meta) => meta.id === id));
  const markers = new RangeSetBuilder<GutterMarker>();
  const decorations = new RangeSetBuilder<Decoration>();
  for (let index = 0; index < metadata.length; index += 1) {
    const meta = metadata[index]!;
    const line = view.state.doc.line(index + 1);
    const unread = meta.updatedVersion !== Number.MAX_SAFE_INTEGER
      && meta.updatedVersion > config.lastSeenVersion;
    // 閲覧表示と同じ規則で、経過時間から線の太さを決める。
    const classes = ['telomere', `w-${telomereWidth(now - meta.updated)}`];
    if (unread) classes.push('unread');
    markers.add(line.from, line.from, new TelomereMarker(classes.join(' '), meta.updated, meta.id, config.title));
    // 閲覧表示と同じく、行へのリンクが指す行を強調する。編集を始めても強調は消えない。
    if (linkedId !== undefined && meta.id === linkedId) decorations.add(line.from, line.from, linkedLine);
  }
  return { markers: markers.finish(), decorations: decorations.finish() };
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
    readonly onHashChange: () => void;

    constructor(view: EditorView) {
      ({ markers: this.markers, decorations: this.decorations } = build(view, config));
      this.onHashChange = () => view.dispatch({ effects: refreshLinkedLine.of() });
      window.addEventListener('hashchange', this.onHashChange);
    }

    update(update: ViewUpdate): void {
      if (rebuilds(update)) ({ markers: this.markers, decorations: this.decorations } = build(update.view, config));
    }

    destroy(): void {
      window.removeEventListener('hashchange', this.onHashChange);
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
