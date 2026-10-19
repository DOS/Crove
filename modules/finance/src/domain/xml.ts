// A minimal XML writer for the files Crove generates (the HTKK VAT return of issue #332): an element tree serialized
// with every text value escaped, so no input can open a tag, an entity or a CDATA section. Element names come from
// Crove's own code, never from data, and are checked anyway. Pure functions, no dependency.

export interface XmlElement {
  name: string;
  attributes?: ReadonlyArray<readonly [string, string]>;
  // Text content, or child elements; neither means an empty element (<name/>).
  text?: string;
  children?: ReadonlyArray<XmlElement>;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

// Characters XML 1.0 does not allow at all (C0 controls other than tab, newline and carriage return, lone surrogates,
// U+FFFE and U+FFFF). They are dropped rather than escaped: no character reference can express them.
// eslint-disable-next-line no-control-regex
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function escapeXml(value: string): string {
  return value
    .replace(NOT_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Carriage returns and tabs survive attribute-value normalization only as references.
    .replace(/\r/g, '&#13;')
    .replace(/\t/g, '&#9;');
}

function checkName(name: string): string {
  if (!NAME.test(name)) throw new Error(`not an XML name: ${JSON.stringify(name)}`);
  return name;
}

function write(element: XmlElement, depth: number, out: string[]): void {
  const pad = '  '.repeat(depth);
  const name = checkName(element.name);
  const attributes = (element.attributes ?? []).map(([key, value]) => ` ${checkName(key)}="${escapeXml(value)}"`).join('');
  if (element.children && element.children.length > 0) {
    out.push(`${pad}<${name}${attributes}>`);
    for (const child of element.children) write(child, depth + 1, out);
    out.push(`${pad}</${name}>`);
  } else if (element.text !== undefined && element.text !== '') {
    out.push(`${pad}<${name}${attributes}>${escapeXml(element.text)}</${name}>`);
  } else {
    out.push(`${pad}<${name}${attributes}/>`);
  }
}

// The document as UTF-8 text with the XML declaration, two-space indentation and a final newline.
export function serializeXml(root: XmlElement): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
  write(root, 0, out);
  return `${out.join('\n')}\n`;
}

export function el(name: string, content?: string | ReadonlyArray<XmlElement>, attributes: ReadonlyArray<readonly [string, string]> = []): XmlElement {
  if (content === undefined) return { name, attributes };
  return typeof content === 'string' ? { name, text: content, attributes } : { name, children: content, attributes };
}
