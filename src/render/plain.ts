import { parsePageSyntax, type SyntaxNode } from '../core/syntax.ts';

// oxlint-disable-next-line typescript/consistent-return -- union を網羅する switch。末尾の return を書かないことで、分岐漏れを型エラーにしている
function nodeText(node: SyntaxNode): string {
  switch (node.type) {
    case 'link':
      if (node.pathType === 'absolute') return node.content === '' ? node.href : node.content;
      return node.href;
    case 'hashTag':
      return `#${node.href}`;
    case 'icon':
    case 'strongIcon':
      return node.path;
    case 'code':
    case 'commandLine':
    case 'helpfeel':
      return node.text;
    case 'formula':
      return node.formula;
    case 'image':
    case 'strongImage':
      return node.src;
    case 'googleMap':
      return node.place;
    case 'numberList':
      return `${node.rawNumber}. ${node.nodes.map(nodeText).join('')}`;
    case 'strong':
    case 'decoration':
    case 'quote':
      return node.nodes.map(nodeText).join('');
    case 'plain':
    case 'blank':
      return node.text;
  }
}

/** 記法を剥がした 1 行の平文を返す（カードの冒頭行表示用）。解析できない行は原文のまま。 */
export function plainLineText(line: string): string {
  const block = parsePageSyntax(line, { hasTitle: false })[0];
  if (block === undefined || block.type !== 'line') return line;
  return ' '.repeat(block.indent) + block.nodes.map(nodeText).join('');
}
