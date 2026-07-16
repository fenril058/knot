import { RangeSet, RangeSetBuilder, StateEffect, type Extension } from '@codemirror/state';
import {
  EditorView,
  GutterMarker,
  gutter,
  type ViewUpdate,
  ViewPlugin,
} from '@codemirror/view';
import type { Line } from '../../../core/ops.ts';
import { lineMeta } from '../sync.ts';

const DAY_SECONDS = 86400;
const TELOMERE_AGE_BUCKETS = [DAY_SECONDS, 7 * DAY_SECONDS];
const relativeTimeFormatter = new Intl.RelativeTimeFormat('ja', { numeric: 'auto' });

export const refreshTelomereGutter = StateEffect.define<void>();

type TelomereConfig = {
  confirmedLines: () => readonly Line[];
  userId: string;
  lastSeenVersion: number;
  now?: () => number;
};

function relativeTime(unixSeconds: number, now: number): string {
  const difference = unixSeconds - now;
  const absoluteDifference = Math.abs(difference);
  if (absoluteDifference < 3600) return relativeTimeFormatter.format(Math.round(difference / 60), 'minute');
  if (absoluteDifference < DAY_SECONDS) return relativeTimeFormatter.format(Math.round(difference / 3600), 'hour');
  return relativeTimeFormatter.format(Math.round(difference / DAY_SECONDS), 'day');
}

function ageClass(newestUpdated: number, updated: number): string {
  const age = newestUpdated - updated;
  if (age < TELOMERE_AGE_BUCKETS[0]!) return 'age-1';
  if (age < TELOMERE_AGE_BUCKETS[1]!) return 'age-2';
  return 'age-3';
}

class TelomereMarker extends GutterMarker {
  readonly className: string;
  readonly label: string;

  constructor(
    className: string,
    label: string,
  ) {
    super();
    this.className = className;
    this.label = label;
  }

  eq(other: TelomereMarker): boolean {
    return this.className === other.className && this.label === other.label;
  }

  toDOM(): Node {
    const marker = document.createElement('span');
    marker.className = this.className;
    marker.title = this.label;
    return marker;
  }
}

function buildMarkers(view: EditorView, config: TelomereConfig): RangeSet<GutterMarker> {
  const now = config.now?.() ?? Math.floor(Date.now() / 1000);
  const texts = view.state.doc.toString().split('\n');
  const metadata = lineMeta(config.confirmedLines(), texts, { userId: config.userId, now });
  const newestUpdated = metadata.reduce((newest, meta) => Math.max(newest, meta.updated), 0);
  const builder = new RangeSetBuilder<GutterMarker>();
  for (let index = 0; index < metadata.length; index += 1) {
    const meta = metadata[index]!;
    const line = view.state.doc.line(index + 1);
    const unread = meta.updatedVersion !== Number.MAX_SAFE_INTEGER
      && meta.updatedVersion > config.lastSeenVersion;
    const classes = ['telomere', ageClass(newestUpdated, meta.updated)];
    if (unread) classes.push('unread');
    builder.add(
      line.from,
      line.from,
      new TelomereMarker(classes.join(' '), `${relativeTime(meta.updated, now)} / ${meta.userId}`),
    );
  }
  return builder.finish();
}

export function telomereGutter(config: TelomereConfig): Extension {
  const plugin = ViewPlugin.fromClass(class {
    markers: RangeSet<GutterMarker>;

    constructor(view: EditorView) {
      this.markers = buildMarkers(view, config);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.transactions.some((transaction) => (
        transaction.effects.some((effect) => effect.is(refreshTelomereGutter))
      ))) {
        this.markers = buildMarkers(update.view, config);
      }
    }
  });

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
