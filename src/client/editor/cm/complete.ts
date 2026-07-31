import {
  autocompletion,
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionSource,
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import { rankTitles } from '../../../core/match.ts';
import { completionContext } from '../completeContext.ts';
import { highlightSpans } from '../highlight.ts';

type TitleEntry = { title: string };

const titleRequests = new Map<string, Promise<TitleEntry[]>>();

function fetchTitles(project: string): Promise<TitleEntry[]> {
  const cached = titleRequests.get(project);
  if (cached !== undefined) return cached;

  const request = fetch(`/api/pages/${encodeURIComponent(project)}/search/titles`)
    .then(async (response) => {
      if (!response.ok) throw new Error(`failed to fetch titles: ${response.status}`);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return await response.json() as TitleEntry[];
    })
    .catch((error: unknown) => {
      // 失敗をキャッシュしない（次の補完トリガで再取得できるように）
      titleRequests.delete(project);
      throw error;
    });
  titleRequests.set(project, request);
  return request;
}

function inCodeBlock(context: CompletionContext): boolean {
  const docText = context.state.doc.toString();
  return highlightSpans(docText).some(
    (span) => span.kind === 'code-block' && context.pos >= span.from && context.pos <= span.to,
  );
}

function bracketCompletion(title: string): Completion {
  return {
    label: title,
    apply(view, completion, from, to) {
      const closingBracket = view.state.sliceDoc(to, to + 1) === ']' ? '' : ']';
      const insert = `${title}${closingBracket}`;
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        annotations: pickedCompletion.of(completion),
      });
    },
  };
}

function hashCompletion(title: string): Completion {
  return {
    label: title,
    apply(view, completion, from, to) {
      const insert = /\s/u.test(title) ? `[${title}]` : `#${title}`;
      const replaceFrom = from - 1;
      view.dispatch({
        changes: { from: replaceFrom, to, insert },
        selection: { anchor: replaceFrom + insert.length },
        annotations: pickedCompletion.of(completion),
      });
    },
  };
}

function titleCompletionSource(project: string): CompletionSource {
  return async (context) => {
    if (inCodeBlock(context)) return null;
    const line = context.state.doc.lineAt(context.pos);
    const current = completionContext(context.state.sliceDoc(line.from, context.pos));
    if (current === null) return null;

    let titles: TitleEntry[];
    try {
      titles = await fetchTitles(project);
    } catch {
      return null;
    }
    if (context.aborted) return null;

    const ranked = rankTitles(current.query, titles, (entry) => entry.title, 20);
    return {
      from: line.from + current.tokenFrom,
      options: ranked.map((entry) => current.kind === 'bracket'
        ? bracketCompletion(entry.title)
        : hashCompletion(entry.title)),
      filter: false,
    };
  };
}

export function titleAutocompletion(project: string): Extension {
  return autocompletion({ override: [titleCompletionSource(project)] });
}
