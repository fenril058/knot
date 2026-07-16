export function titleLc(title: string): string {
  return title.normalize('NFC').toLowerCase().replaceAll(' ', '_');
}

export function encodeTitleForUrl(title: string): string {
  return encodeURIComponent(title.replaceAll(' ', '_'));
}

export function pageHref(projectName: string, title: string): string {
  return `/${encodeURIComponent(projectName)}/${encodeTitleForUrl(title)}`;
}

export function decodeTitleSegment(segment: string): string {
  return decodeURIComponent(segment);
}
