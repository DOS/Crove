// Tells whether bytes look like a Vietnamese e-invoice XML (Decree 123/2020/ND-CP). A look at the first bytes
// only: nothing is parsed here. The parser itself runs in crove-extract (apps/extract, plan §7.6, T12).
export function looksLikeEInvoiceXml(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4096));
  return /<\s*(\w+:)?HDon[\s>]/.test(head) || /<\s*(\w+:)?TDiep[\s>]/.test(head);
}
