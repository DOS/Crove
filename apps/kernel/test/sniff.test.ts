import { describe, expect, it } from 'vitest';
import { safeFilename, sniffType } from '../src/sniff.ts';

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

describe('upload type detection', () => {
  it('recognises the accepted formats by content', () => {
    expect(sniffType(text('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png');
    expect(sniffType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffType(text('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffType(new Uint8Array([0xef, 0xbb, 0xbf, ...text('\n  <?xml version="1.0"?><HDon/>')]))).toBe('application/xml');
  });

  it('refuses anything else, whatever its name or declared type', () => {
    expect(sniffType(text('MZ\x90\0'))).toBeNull();
    expect(sniffType(text('PK\x03\x04'))).toBeNull();
    expect(sniffType(new Uint8Array())).toBeNull();
  });

  it('forces the extension of the detected type', () => {
    expect(safeFilename('hoa-don.exe', 'application/pdf')).toBe('hoa-don.pdf');
    expect(safeFilename('../../etc/passwd', 'application/xml')).toBe('.._.._etc_passwd.xml');
    expect(safeFilename('', 'image/png')).toBe('tep.png');
  });
});
