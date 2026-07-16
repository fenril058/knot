// Task 8 で本実装に置き換える一時スタブ。core がブラウザ向けバンドルに解決されることを確認する。
import { ulid } from '../../core/id.ts';
import { pageHref } from '../../core/title.ts';

console.debug('knot editor stub', ulid(), pageHref('project', 'title'));
