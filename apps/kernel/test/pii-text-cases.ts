// One case table for the free-text matcher (#1948, shared with notes step N9, #1678), run against the TypeScript twins
// (pii-text.test.ts) and the database functions (pii-text.db.test.ts): a text, the value a person gave, and the text
// after redaction, the same as the text when the value does not match.
export interface PiiTextCase {
  name: string;
  text: string;
  value: string;
  redacted: string;
}

const R = '[đã xóa]';

export const PII_TEXT_CASES: readonly PiiTextCase[] = [
  // Emails: case aside on either side, never inside a longer address.
  { name: 'an email in a sentence', text: 'Đã gửi cho ab@x.com hôm nay', value: 'ab@x.com', redacted: `Đã gửi cho ${R} hôm nay` },
  { name: 'an email in capitals', text: 'Liên hệ AB@X.COM.', value: 'ab@x.com', redacted: `Liên hệ ${R}.` },
  { name: 'a value in capitals, with spaces around', text: 'ab@x.com', value: '  AB@x.Com ', redacted: R },
  { name: 'every mention', text: 'ab@x.com, AB@x.com; <ab@x.com>', value: 'ab@x.com', redacted: `${R}, ${R}; <${R}>` },
  { name: 'not inside a longer local part', text: 'cab@x.com', value: 'ab@x.com', redacted: 'cab@x.com' },
  { name: 'not when the domain goes on', text: 'ab@x.com.vn', value: 'ab@x.com', redacted: 'ab@x.com.vn' },
  { name: 'not when the last label goes on', text: 'ab@x.company', value: 'ab@x.com', redacted: 'ab@x.company' },
  { name: 'the address and not its neighbour', text: 'xab@x.com và ab@x.com', value: 'ab@x.com', redacted: `xab@x.com và ${R}` },
  { name: 'dots and a plus taken literally', text: 'a.b+tag@x.vn và aXb+tag@x.vn', value: 'a.b+tag@x.vn', redacted: `${R} và aXb+tag@x.vn` },
  // Phones and codes: any separators, +84 or 0, never inside a longer number.
  { name: 'a phone with spaces', text: 'Gọi 0912 345 678 nhé', value: '0912345678', redacted: `Gọi ${R} nhé` },
  { name: 'a phone with dots', text: 'SĐT: 0912.345.678', value: '0912345678', redacted: `SĐT: ${R}` },
  { name: 'a phone with dashes', text: '091-234-5678', value: '0912345678', redacted: R },
  { name: 'a phone with brackets', text: 'Số (091) 234 5678', value: '0912345678', redacted: `Số (${R}` },
  { name: 'a +84 phone for a 0 value', text: 'Zalo +84 912 345 678.', value: '0912345678', redacted: `Zalo ${R}.` },
  { name: 'an 84 phone for a 0 value', text: '84912345678', value: '0912345678', redacted: R },
  { name: 'a 0 phone for a +84 value', text: 'Gọi 0912345678 nhé', value: '+84 912 345 678', redacted: `Gọi ${R} nhé` },
  { name: 'not inside a longer number', text: 'Mã 09123456789 và 10912345678', value: '0912345678', redacted: 'Mã 09123456789 và 10912345678' },
  { name: 'a tax code', text: 'MST 0101234564.', value: '0101234564', redacted: `MST ${R}.` },
  { name: 'a national ID', text: 'CCCD số 079091001234 cấp 2021', value: '0790 9100 1234', redacted: `CCCD số ${R} cấp 2021` },
  // Not a value: nothing matches.
  { name: 'a name is not a value', text: 'Nguyễn Văn A', value: 'Nguyễn Văn A', redacted: 'Nguyễn Văn A' },
  { name: 'too few digits', text: 'Phòng 1234567', value: '1234567', redacted: 'Phòng 1234567' },
];
