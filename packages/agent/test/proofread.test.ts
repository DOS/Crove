// The check after an AI proofread (#1167): links, hashtags, mentions, numbers and prices, and emoji come back exactly
// as they were, whatever the proofread fixed around them.
import { describe, expect, it } from 'vitest';
import { proofreadChanges, protectedTokens } from '../src/index.ts';

const POST = 'Khai truong chi nhanh Quan 3 ngay 20/10 🎉 Giam 20% , ao chi con 1.200.000đ va phu kien tu 99k ! Xem tai https://tiemcuaban.vn/khuyen-mai. Goi 0901 234 567 hoac email ban@tiemcuaban.vn #khaitruong @tiem.cua.ban 👍🏽';
const FIXED = 'Khai trương chi nhánh Quận 3 ngày 20/10 🎉 Giảm 20%, áo chỉ còn 1.200.000đ và phụ kiện từ 99k! Xem tại https://tiemcuaban.vn/khuyen-mai. Gọi 0901 234 567 hoặc email ban@tiemcuaban.vn #khaitruong @tiem.cua.ban 👍🏽';

describe('protectedTokens', () => {
  it('finds links, emails, hashtags, mentions, numbers with their units and emoji, in order', () => {
    expect(protectedTokens(POST)).toEqual({
      link: ['https://tiemcuaban.vn/khuyen-mai', 'ban@tiemcuaban.vn'],
      hashtag: ['#khaitruong'],
      mention: ['@tiem.cua.ban'],
      number: ['3', '20/10', '20 %', '1.200.000 d', '99 k', '0901', '234', '567'],
      emoji: ['🎉', '👍🏽'],
    });
  });

  it('reads a bare address on a known domain as a link, and a missing space after a full stop as text', () => {
    expect(protectedTokens('Đặt hàng ở tiemcuaban.vn/dat-hang, hoặc www.shop.com.').link).toEqual(['tiemcuaban.vn/dat-hang', 'www.shop.com']);
    expect(protectedTokens('Mở cửa từ sáng.Mai nghỉ').link).toEqual([]);
  });

  it('keeps a hashtag or number inside a link part of the link', () => {
    expect(protectedTokens('https://shop.vn/a#top?p=2')).toMatchObject({ link: ['https://shop.vn/a#top?p=2'], hashtag: [], number: [] });
  });

  it('reads Vietnamese price units with or without their diacritics, capitals or the space before them', () => {
    expect(protectedTokens('99K, 2 tr, 150 nghìn, 100 dong, 50.000 ₫').number).toEqual(['99 k', '2 tr', '150 nghin', '100 dong', '50.000 d']);
    expect(protectedTokens('99k, 2tr, 150 nghin, 100 đồng, 50.000đ').number).toEqual(['99 k', '2 tr', '150 nghin', '100 dong', '50.000 d']);
    // A unit that runs into a word is not one: 99kg is the number 99.
    expect(protectedTokens('Nặng 99kg').number).toEqual(['99']);
  });
});

describe('proofreadChanges', () => {
  it('accepts a proofread that only fixed spelling, diacritics, spacing and punctuation', () => {
    expect(proofreadChanges([POST], [FIXED])).toEqual([]);
    expect(proofreadChanges(['Gia 99 k , giam 20 %'], ['Giá 99k, giảm 20%'])).toEqual([]);
  });

  it('refuses a changed link, hashtag, mention, price, number or emoji', () => {
    expect(proofreadChanges([POST], [FIXED.replace('khuyen-mai', 'khuyến-mãi')])).toEqual(['link']);
    expect(proofreadChanges([POST], [FIXED.replace('#khaitruong', '#khaitrương')])).toEqual(['hashtag']);
    expect(proofreadChanges([POST], [FIXED.replace('@tiem.cua.ban', '@tiemcuaban')])).toEqual(['mention']);
    expect(proofreadChanges([POST], [FIXED.replace('1.200.000đ', '1.250.000đ')])).toEqual(['number']);
    expect(proofreadChanges([POST], [FIXED.replace('99k', '99 nghìn')])).toEqual(['number']);
    expect(proofreadChanges([POST], [FIXED.replace('0901 234 567', '0901234567')])).toEqual(['number']);
    expect(proofreadChanges([POST], [FIXED.replace('👍🏽', '👍')])).toEqual(['emoji']);
    expect(proofreadChanges([POST], [FIXED.replace(' 🎉', '')])).toEqual(['emoji']);
  });

  it('refuses one that dropped, added or reordered them, and names every kind it changed', () => {
    expect(proofreadChanges(['Xem https://a.vn và https://b.vn'], ['Xem https://b.vn và https://a.vn'])).toEqual(['link']);
    expect(proofreadChanges(['Giá 99k #sale'], ['Giá 99k, rẻ nhất #sale #hot'])).toEqual(['hashtag', 'wording']);
    expect(proofreadChanges(['Giá 99k #sale 🎉'], ['Giá 199k 🎁'])).toEqual(['hashtag', 'number', 'emoji']);
  });

  it('compares the title on its own', () => {
    expect(proofreadChanges(['Khai truong', 'Giam 20%'], ['Khai trương', 'Giảm 20%'])).toEqual([]);
    expect(proofreadChanges(['Khai truong', 'Giam 20%'], ['Khai trương', 'Giảm 30%'])).toEqual(['number']);
  });

  it('treats composed and decomposed diacritics as the same text', () => {
    expect(proofreadChanges(['#khuyếnmãi'.normalize('NFD')], ['#khuyếnmãi'])).toEqual([]);
  });

  it('refuses one that added or dropped a sentence, the links and numbers kept', () => {
    expect(proofreadChanges([POST], [FIXED])).toEqual([]);
    expect(proofreadChanges([POST], [`${FIXED} Chính sách hoàn tiền trọn đời cho mọi đơn hàng.`])).toEqual(['wording']);
    expect(proofreadChanges([POST], [FIXED.replace(' Gọi 0901 234 567 hoặc email ban@tiemcuaban.vn', '').replace('Khai trương chi nhánh Quận 3 ngày 20/10 🎉 ', 'Khai trương 20/10 🎉 ')])).toContain('wording');
  });
});
