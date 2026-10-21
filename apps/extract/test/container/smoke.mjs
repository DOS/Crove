// Container smoke test of the crove-extract image (External-tenant gate T12), run by the `extract-image` CI job.
// It runs in a client container on the same internal network as the service and sends real files, so each parse
// goes through the image's pnpm layout under the parser process's permission model. Usage:
//   node smoke.mjs <base url> <fixture directory>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Node built-ins only, run as TypeScript by type stripping.
import { buildLimitArchive } from '../zip-fixture.ts';

const [base = 'http://crove-extract:8090', fixtures = '/t/fixtures'] = process.argv.slice(2);
const encode = (text) => new TextEncoder().encode(text);
const xml = readFileSync(join(fixtures, 'einvoice-basic.xml'));

// A one-page PDF with a text layer.
function pdf(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encode(out);
}

function email(attachment) {
  const base64 = Buffer.from(attachment).toString('base64').replace(/(.{76})/g, '$1\r\n');
  return encode(
    [
      'From: Vendor <billing@vendor.example>',
      'To: abc@in.test',
      'Subject: Hoa don',
      'Message-ID: <hd-1@vendor.example>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: application/octet-stream',
      'Content-Disposition: attachment; filename="hd.xml"',
      'Content-Transfer-Encoding: base64',
      '',
      base64,
      '--b1--',
      '',
    ].join('\r\n'),
  );
}

async function extract(kind, body) {
  const response = await fetch(`${base}/extract?kind=${kind}`, { method: 'POST', body, headers: { 'content-type': 'application/octet-stream' } });
  return { status: response.status, json: await response.json() };
}

const failures = [];
function check(name, condition, detail) {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}`);
  if (!condition) failures.push(`${name}: ${JSON.stringify(detail).slice(0, 500)}`);
}

const invoice = await extract('einvoice_xml', xml);
check('e-invoice XML is parsed', invoice.status === 200 && invoice.json.ok && invoice.json.invoice.number === '1234' && invoice.json.invoice.total === '1980000', invoice);

// #674: a TEST ONLY signed invoice. untrusted_certificate comes only after xml-crypto checked its references and
// signature value and the chain was built from the shipped trust files, inside the image's parser process.
const signedXml = readFileSync(join(fixtures, 'einvoice-signed-test-only.xml'), 'utf8').replaceAll('\r\n', '\n');
const signed = await extract('einvoice_xml', encode(signedXml));
check(
  'e-invoice signature is verified in the container',
  signed.status === 200 && signed.json.ok && signed.json.invoice.signature?.status === 'unverified' && signed.json.invoice.signature?.reason === 'untrusted_certificate',
  signed,
);
const tampered = await extract('einvoice_xml', encode(signedXml.replace('<TgTTTBSo>1980000</TgTTTBSo>', '<TgTTTBSo>1980001</TgTTTBSo>')));
check('an edited signed e-invoice is reported as not matching its signature', tampered.json.ok && tampered.json.invoice.signature?.reason === 'digest_mismatch', tampered);

const text = await extract('pdf_text', pdf('Hoa don GTGT so 1234'));
check('PDF text layer is extracted', text.status === 200 && text.json.ok && text.json.text === 'Hoa don GTGT so 1234' && text.json.pages === 1, text);

const mime = await extract('mime', email(xml));
const attachment = mime.json.ok ? Buffer.from(mime.json.email.attachments[0]?.content ?? '', 'base64') : null;
check('MIME message is parsed with its attachment', mime.status === 200 && mime.json.email.from === 'billing@vendor.example' && attachment?.equals(xml), mime);

const laughs = await extract('einvoice_xml', encode('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><HDon>&a;</HDon>'));
check('DOCTYPE and entities are refused', laughs.status === 422 && laughs.json.code === 'invalid', laughs);

const broken = await extract('pdf_text', encode('%PDF-1.4 not really a pdf'));
check('a malformed PDF gives a typed error', broken.status === 422 && broken.json.code === 'invalid', broken);

// #432: an archive at every limit at once (EXTRACT_LIMITS: 500 entries, 40 MiB decompressed, an upload just under the
// 25 MiB file limit) opens in the real container, whose 1 GiB holds the service and the parser process together, and
// the service is still up afterwards. The values are the contract's; this script runs outside the workspace.
const MiB = 1024 * 1024;
const limits = buildLimitArchive({ entries: 500, totalBytes: 40 * MiB, randomBytesPerEntry: 50_000 });
const opened = await extract('zip', limits);
const entries = opened.json.ok ? opened.json.archive.entries : [];
check(
  'an archive at the entry and size limits opens in the 1 GiB container',
  limits.byteLength <= 25 * MiB &&
    opened.status === 200 &&
    entries.length === 500 &&
    entries.every((e) => e.rejected === null && e.content !== null) &&
    entries.reduce((sum, e) => sum + e.sizeBytes, 0) === 40 * MiB,
  { status: opened.status, code: opened.json.code, message: opened.json.message, entries: entries.length, zipBytes: limits.byteLength },
);
const health = await fetch(`${base}/healthz`).then((r) => r.status).catch(() => 0);
check('the service is still up after the archive at the limits', health === 200, { health });

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
