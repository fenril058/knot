import { extractRefs } from '../core/links.ts';

export type DerivedPageData = {
  links: { title: string; titleLc: string }[];
  image: string | null;
  searchText: string | null;
};

export function derivePageData(lines: readonly { text: string }[], deleted: boolean): DerivedPageData {
  if (deleted) return { links: [], image: null, searchText: null };
  const searchText = lines.map((line) => line.text).join('\n');
  const refs = extractRefs(searchText);
  return { links: refs.linkTargets, image: refs.image, searchText };
}
