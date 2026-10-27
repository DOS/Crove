// The English page holds no Vietnamese copy (DESIGN.md §8, #1629), but its example company, people and documents stay
// Vietnamese in both languages. Each phrase below may appear on the English page, with the reason it is Vietnamese;
// anything else that carries a Vietnamese letter fails the check. Longer phrases come first, so a company's full legal
// name is taken out before the short name inside it.
const ALLOWED: ReadonlyArray<readonly [phrase: string, reason: string]> = [
  ['Công ty CP Bao Bì Phú Thịnh', 'the example vendor, its legal name as printed on the sample e-invoice'],
  ['Bao Bì Phú Thịnh', 'the example vendor, short name'],
  ['Hợp tác xã Tân Hồng', 'the example rice cooperative, its legal name on the sample purchase slip'],
  ['Tân Hồng', 'the example rice cooperative, short name (also "HTX Tân Hồng")'],
  ['Gạo Sạch Miền Tây', 'the example company, its legal name in the footer of the sample document'],
  ['Gạo Sạch Mekong', 'the example company'],
  ['Gạo ST25 vụ mới đã về', 'the example company’s social post, written for its Vietnamese customers'],
  ['Chị Lan', 'the example chief accountant, named with a Vietnamese honorific'],
  ['Chị Hoa', 'the example staff member, named with a Vietnamese honorific'],
  ['Anh Tuấn', 'the example director, named with a Vietnamese honorific'],
];

// A letter with a Vietnamese mark: a base letter followed by a combining diacritic once decomposed, or đ.
const VIETNAMESE_LETTER = /\p{L}[\u0300-\u036f]+|[đĐ]/gu;

// The Vietnamese letters left in `text` once the allowed phrases are taken out, each with a few characters around it.
export function vietnameseLeft(text: string): string[] {
  let rest = text.normalize('NFC');
  for (const [phrase] of ALLOWED) rest = rest.replaceAll(phrase, ' ');
  const found: string[] = [];
  const decomposed = rest.normalize('NFD');
  for (const match of decomposed.matchAll(VIETNAMESE_LETTER)) {
    found.push(decomposed.slice(Math.max(0, match.index - 15), match.index + 15).normalize('NFC').trim());
  }
  return found;
}

export const allowedPhrases = ALLOWED;
