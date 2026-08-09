import { parse, type Node as ParserNode } from '@progfay/scrapbox-parser';

export type SourceRange = { from: number; to: number };

type NodeBase = { raw: string; range: SourceRange };

export type SyntaxNode =
  | (NodeBase & { type: 'quote'; nodes: SyntaxNode[] })
  | (NodeBase & { type: 'helpfeel'; text: string })
  | (NodeBase & { type: 'strongImage'; src: string })
  | (NodeBase & { type: 'strongIcon'; pathType: 'root' | 'relative'; path: string })
  | (NodeBase & { type: 'strong'; nodes: SyntaxNode[] })
  | (NodeBase & { type: 'formula'; formula: string })
  | (NodeBase & { type: 'decoration'; rawDecos: string; decos: string[]; nodes: SyntaxNode[] })
  | (NodeBase & { type: 'code'; text: string })
  | (NodeBase & { type: 'commandLine'; symbol: string; text: string })
  | (NodeBase & { type: 'blank'; text: string })
  | (NodeBase & { type: 'image'; src: string; link: string })
  | (NodeBase & { type: 'link'; pathType: 'absolute' | 'root' | 'relative'; href: string; content: string })
  | (NodeBase & {
    type: 'googleMap';
    latitude: number;
    longitude: number;
    zoom: number;
    place: string;
    url: string;
  })
  | (NodeBase & { type: 'icon'; pathType: 'root' | 'relative'; path: string })
  | (NodeBase & { type: 'hashTag'; href: string })
  | (NodeBase & { type: 'numberList'; rawNumber: string; number: number; nodes: SyntaxNode[] })
  | (NodeBase & { type: 'plain'; text: string });

type BlockBase = { range: SourceRange; lineRanges: SourceRange[] };

export type SyntaxBlock =
  | (BlockBase & { type: 'title'; text: string })
  | (BlockBase & { type: 'line'; indent: number; nodes: SyntaxNode[] })
  | (BlockBase & { type: 'codeBlock'; indent: number; fileName: string; content: string })
  | (BlockBase & { type: 'table'; indent: number; fileName: string; cells: SyntaxNode[][][] });

type SourceLine = { text: string; range: SourceRange };

export class SyntaxMappingError extends Error {
  override name = 'SyntaxMappingError';
}

function sourceLines(source: string): SourceLine[] {
  let from = 0;
  return source.split('\n').map((text) => {
    const range = { from, to: from + text.length };
    from = range.to + 1;
    return { text, range };
  });
}

function leadingWhitespaceLength(text: string): number {
  return /^\s*/.exec(text)?.[0].length ?? 0;
}

function bodyLineCount(lines: SourceLine[], headerIndex: number, headerIndent: number): number {
  let count = 0;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (leadingWhitespaceLength(lines[index]!.text) <= headerIndent) break;
    count += 1;
  }
  return count;
}

function blockRange(lineRanges: SourceRange[]): SourceRange {
  const first = lineRanges[0];
  const last = lineRanges.at(-1);
  if (first === undefined || last === undefined) throw new SyntaxMappingError('block has no source line');
  return { from: first.from, to: last.to };
}

// oxlint-disable-next-line typescript/consistent-return -- 外部 parser の union を網羅する switch。分岐漏れを型エラーにする
function mapNode(node: ParserNode, source: string, range: SourceRange): SyntaxNode {
  const nested = (nodes: ParserNode[]): SyntaxNode[] => locateNodes(nodes, source, range.from, range.to).nodes;
  switch (node.type) {
    case 'quote':
      return { type: node.type, raw: node.raw, range, nodes: nested(node.nodes) };
    case 'helpfeel':
      return { type: node.type, raw: node.raw, range, text: node.text };
    case 'strongImage':
      return { type: node.type, raw: node.raw, range, src: node.src };
    case 'strongIcon':
      return { type: node.type, raw: node.raw, range, pathType: node.pathType, path: node.path };
    case 'strong':
      return { type: node.type, raw: node.raw, range, nodes: nested(node.nodes) };
    case 'formula':
      return { type: node.type, raw: node.raw, range, formula: node.formula };
    case 'decoration':
      return {
        type: node.type,
        raw: node.raw,
        range,
        rawDecos: node.rawDecos,
        decos: node.decos,
        nodes: nested(node.nodes),
      };
    case 'code':
      return { type: node.type, raw: node.raw, range, text: node.text };
    case 'commandLine':
      return { type: node.type, raw: node.raw, range, symbol: node.symbol, text: node.text };
    case 'blank':
      return { type: node.type, raw: node.raw, range, text: node.text };
    case 'image':
      return { type: node.type, raw: node.raw, range, src: node.src, link: node.link };
    case 'link':
      return {
        type: node.type,
        raw: node.raw,
        range,
        pathType: node.pathType,
        href: node.href,
        content: node.content,
      };
    case 'googleMap':
      return {
        type: node.type,
        raw: node.raw,
        range,
        latitude: node.latitude,
        longitude: node.longitude,
        zoom: node.zoom,
        place: node.place,
        url: node.url,
      };
    case 'icon':
      return { type: node.type, raw: node.raw, range, pathType: node.pathType, path: node.path };
    case 'hashTag':
      return { type: node.type, raw: node.raw, range, href: node.href };
    case 'numberList':
      return {
        type: node.type,
        raw: node.raw,
        range,
        rawNumber: node.rawNumber,
        number: node.number,
        nodes: nested(node.nodes),
      };
    case 'plain':
      return { type: node.type, raw: node.raw, range, text: node.text };
  }
}

function locateNodes(
  parserNodes: ParserNode[],
  source: string,
  from: number,
  to: number,
): { nodes: SyntaxNode[]; cursor: number } {
  const nodes: SyntaxNode[] = [];
  let cursor = from;
  for (const node of parserNodes) {
    const nodeFrom = source.indexOf(node.raw, cursor);
    const nodeTo = nodeFrom + node.raw.length;
    if (nodeFrom < cursor || nodeTo > to) {
      throw new SyntaxMappingError(`cannot locate ${node.type} node after offset ${cursor}`);
    }
    const range = { from: nodeFrom, to: nodeTo };
    nodes.push(mapNode(node, source, range));
    cursor = nodeTo;
  }
  return { nodes, cursor };
}

export function parsePageSyntax(source: string, options: { hasTitle: boolean }): SyntaxBlock[] {
  const parserBlocks = parse(source, options);
  const lines = sourceLines(source);
  const blocks: SyntaxBlock[] = [];
  let lineIndex = 0;

  for (const block of parserBlocks) {
    const line = lines[lineIndex];
    if (line === undefined) throw new SyntaxMappingError(`block ${block.type} has no source line`);

    if (block.type === 'title') {
      if (block.text !== line.text) throw new SyntaxMappingError('title does not match its source line');
      blocks.push({ type: block.type, text: block.text, range: line.range, lineRanges: [line.range] });
      lineIndex += 1;
      continue;
    }

    if (block.type === 'line') {
      const contentFrom = line.range.from + block.indent;
      if (contentFrom > line.range.to) throw new SyntaxMappingError('line indent exceeds its source line');
      const located = locateNodes(block.nodes, source, contentFrom, line.range.to);
      if (located.cursor !== line.range.to) throw new SyntaxMappingError('line nodes do not cover their source line');
      blocks.push({
        type: block.type,
        indent: block.indent,
        nodes: located.nodes,
        range: line.range,
        lineRanges: [line.range],
      });
      lineIndex += 1;
      continue;
    }

    const consumed = 1 + bodyLineCount(lines, lineIndex, block.indent);
    const consumedLines = lines.slice(lineIndex, lineIndex + consumed);
    if (consumedLines.length !== consumed) throw new SyntaxMappingError(`${block.type} exceeds its source lines`);
    const lineRanges = consumedLines.map(({ range }) => range);

    if (block.type === 'codeBlock') {
      blocks.push({
        type: block.type,
        indent: block.indent,
        fileName: block.fileName,
        content: block.content,
        range: blockRange(lineRanges),
        lineRanges,
      });
    } else {
      if (block.cells.length !== consumed - 1) throw new SyntaxMappingError('table rows do not match source lines');
      const cells = block.cells.map((row, rowIndex) => {
        const rowRange = lineRanges[rowIndex + 1];
        if (rowRange === undefined) throw new SyntaxMappingError('table row has no source line');
        let cursor = rowRange.from;
        return row.map((cell) => {
          const located = locateNodes(cell, source, cursor, rowRange.to);
          cursor = located.cursor;
          return located.nodes;
        });
      });
      blocks.push({
        type: block.type,
        indent: block.indent,
        fileName: block.fileName,
        cells,
        range: blockRange(lineRanges),
        lineRanges,
      });
    }
    lineIndex += consumed;
  }

  if (lineIndex !== lines.length) throw new SyntaxMappingError('parser blocks do not cover all source lines');
  return blocks;
}
