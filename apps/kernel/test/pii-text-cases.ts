// One case table for the free-text matcher (notes step N9, #1678, shared with #1948), run against the database functions
// crove_kernel.text_mentions and text_redact through the finder's probe (personal-data.db.test.ts): a text, the value
// a person gave, and the text after redaction, the same as the text when the value does not match. A value that is not
// an email, a phone or an ID gives no probe, so nothing matches.
export interface PiiTextCase {
  name: string;
  text: string;
  value: string;
  redacted: string;
}

const R = '[đã xóa]';

export const PII_TEXT_CASES: readonly PiiTextCase[] = [
  // Emails: case aside on either side, never inside a longer address.
  { name: 'an email in a sentence', text: 'Đã gửi cho ab@x.example hôm nay', value: 'ab@x.example', redacted: `Đã gửi cho ${R} hôm nay` },
  { name: 'an email in capitals', text: 'Liên hệ AB@X.EXAMPLE.', value: 'ab@x.example', redacted: `Liên hệ ${R}.` },
  { name: 'a value in capitals, with spaces around', text: 'ab@x.example', value: '  AB@x.Example ', redacted: R },
  { name: 'every mention', text: 'ab@x.example, AB@x.example; <ab@x.example>', value: 'ab@x.example', redacted: `${R}, ${R}; <${R}>` },
  { name: 'not inside a longer local part', text: 'cab@x.example', value: 'ab@x.example', redacted: 'cab@x.example' },
  { name: 'not when the domain goes on', text: 'ab@x.example.test', value: 'ab@x.example', redacted: 'ab@x.example.test' },
  { name: 'not when the last label goes on', text: 'ab@x.examples.test', value: 'ab@x.example', redacted: 'ab@x.examples.test' },
  { name: 'the address and not its neighbour', text: 'xab@x.example và ab@x.example', value: 'ab@x.example', redacted: `xab@x.example và ${R}` },
  { name: 'dots and a plus taken literally', text: 'a.b+tag@x.example và aXb+tag@x.example', value: 'a.b+tag@x.example', redacted: `${R} và aXb+tag@x.example` },
  // Phones and codes: any separators, +84 or 0, never inside a longer number.
  { name: 'a phone with spaces', text: 'Gọi 0912 345 678 nhé', value: '0912345678', redacted: `Gọi ${R} nhé` },
  { name: 'a phone with dots', text: 'SĐT: 0912.345.678', value: '0912345678', redacted: `SĐT: ${R}` },
  { name: 'a phone with dashes', text: '091-234-5678', value: '0912345678', redacted: R },
  // The opening bracket is part of the number, so the edit leaves none behind.
  { name: 'a phone with brackets', text: 'Số (091) 234 5678', value: '0912345678', redacted: `Số ${R}` },
  { name: 'a +84 phone for a 0 value', text: 'Zalo +84 912 345 678.', value: '0912345678', redacted: `Zalo ${R}.` },
  { name: 'an 84 phone for a 0 value', text: '84912345678', value: '0912345678', redacted: R },
  { name: 'a 0 phone for a +84 value', text: 'Gọi 0912345678 nhé', value: '+84 912 345 678', redacted: `Gọi ${R} nhé` },
  { name: 'not inside a longer number', text: 'Mã 09123456789 và 10912345678', value: '0912345678', redacted: 'Mã 09123456789 và 10912345678' },
  { name: 'a tax code', text: 'MST 0101234564.', value: '0101234564', redacted: `MST ${R}.` },
  { name: 'a national ID', text: 'CCCD số 079091001234 cấp 2021', value: '0790 9100 1234', redacted: `CCCD số ${R} cấp 2021` },
  { name: 'an email at the end of a sentence', text: 'Gửi a.b@x.example.', value: 'a.b@x.example', redacted: `Gửi ${R}.` },
  { name: 'a branch tax code', text: 'MST 0101234567-001', value: '0101234567001', redacted: `MST ${R}` },
  { name: 'a phone written both ways', text: '(028) 3829.1234 hoặc +84 28 3829 1234', value: '02838291234', redacted: `${R} hoặc ${R}` },
  // Not inside a longer address or number, however it is written (#1678 review).
  { name: 'not after an apostrophe of a longer local part', text: "o'brien@example.com", value: 'brien@example.com', redacted: "o'brien@example.com" },
  { name: 'not after a # of a longer local part', text: 'tag#alice@example.com', value: 'alice@example.com', redacted: 'tag#alice@example.com' },
  { name: 'not inside a longer number in groups', text: 'CCCD 000 091 777 665', value: '091777665', redacted: 'CCCD 000 091 777 665' },
  { name: 'a national ID is not a phone', text: 'Mã 8400091777665', value: '000091777665', redacted: 'Mã 8400091777665' },
  { name: 'a short value is not a phone', text: 'Mã 0123456', value: '84123456', redacted: 'Mã 0123456' },
  // A bank account written in groups is not a phone inside it: one space between groups keeps it one number (#1678
  // review), so the erasure never cuts a fragment out of it.
  { name: 'not the start of a longer number in groups', text: 'STK 0912 3456 78 90', value: '0912345678', redacted: 'STK 0912 3456 78 90' },
  { name: 'a 10-digit code from 84 is not a phone', text: 'MST 0401234567 và 8401234567', value: '8401234567', redacted: `MST 0401234567 và ${R}` },
  // No-break spaces, as a pasted number often carries them.
  { name: 'a phone with no-break spaces', text: 'Gọi 0912 345 678 nhé', value: '0912345678', redacted: `Gọi ${R} nhé` },
  // Every regex character in an address is taken literally, and a letter outside ASCII as itself.
  { name: 'regex characters in an address', text: 'Gửi a(b)[c]{1}|d^e$f*g?h\\i@x.example.', value: 'a(b)[c]{1}|d^e$f*g?h\\i@x.example', redacted: `Gửi ${R}.` },
  { name: 'an address outside ASCII', text: 'Gửi đặng@x.example hôm nay', value: 'đặng@x.example', redacted: `Gửi ${R} hôm nay` },
  // But a list still finds each number.
  { name: 'a numbered list', text: '1. 0912 345 678', value: '0912345678', redacted: `1. ${R}` },
  { name: 'one number a line', text: '0912345678\n0987654321', value: '0912345678', redacted: `${R}\n0987654321` },
  // Not a value: nothing matches.
  { name: 'a name is not a value', text: 'Nguyễn Văn A', value: 'Nguyễn Văn A', redacted: 'Nguyễn Văn A' },
  { name: 'too few digits', text: 'Phòng 1234567', value: '1234567', redacted: 'Phòng 1234567' },
];
