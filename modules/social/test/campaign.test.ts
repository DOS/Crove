// Campaign labels (#1169): the label's tag rule, the UTM fields a campaign label fills in, and the two findings.
import { describe, expect, it } from 'vitest';
import { campaignFindings, isCalendarDay, isCampaign, labelUtmTag, outsideCampaign, prefillUtm, type Campaign, type CampaignChannel } from '../src/domain/campaign.ts';
import { utmTag } from '../src/domain/utm.ts';

const tet: Campaign = { name: 'Tết', startsOn: '2027-01-20', endsOn: '2027-02-15', utmCampaign: 'tet-2027', utmMedium: null };
const plain: Campaign = { name: 'Khách A', startsOn: null, endsOn: null, utmCampaign: null, utmMedium: null };
const channel = (over: Partial<CampaignChannel> = {}): CampaignChannel => ({
  name: 'Trang',
  settings: { utm: { campaign: 'tet-2027', medium: 'social' } },
  linkUrl: 'https://shop.example/',
  // Noon in Hồ Chí Minh City on 1 February 2027.
  at: '2027-02-01T05:00:00.000Z',
  ...over,
});

describe('label UTM tags', () => {
  it('keeps what the links accept and the table can check, NFC and trimmed', () => {
    expect(labelUtmTag('  Tết 2027 '.normalize('NFD'))).toBe('Tết 2027');
    expect(labelUtmTag("q1_sale/vn+hcm a.b,c:d;e!f?g'h(i)&j%k@l#m")).toBe("q1_sale/vn+hcm a.b,c:d;e!f?g'h(i)&j%k@l#m");
    expect(labelUtmTag('中文活动')).toBe('中文活动');
    expect(labelUtmTag('x'.repeat(100))).toBe('x'.repeat(100));
    for (const bad of ['', '   ', 'a*b', 'a"b', 'a<b', 'a=b', 'a|b', 'a\nb', '😀', 'x'.repeat(101), 42, null]) expect(labelUtmTag(bad)).toBeNull();
  });

  it('refuses the few tags a link accepts that the table cannot check', () => {
    // Fractions and other numbers outside ASCII are \p{N} for the link, but not ASCII digits or letters for the table.
    expect(utmTag('½ giá')).toBe('½ giá');
    expect(labelUtmTag('½ giá')).toBeNull();
  });

  it('reads calendar days', () => {
    expect(isCalendarDay('2027-02-28')).toBe(true);
    expect(isCalendarDay('2028-02-29')).toBe(true);
    for (const bad of ['2027-02-29', '2027-13-01', '0000-01-01', '2027-1-01', '2027-01-01T00:00']) expect(isCalendarDay(bad)).toBe(false);
  });
});

describe('campaign dates', () => {
  it('says which days fall outside, both ends included and either open', () => {
    expect([outsideCampaign('2027-01-19', tet), outsideCampaign('2027-01-20', tet), outsideCampaign('2027-02-15', tet), outsideCampaign('2027-02-16', tet)]).toEqual([true, false, false, true]);
    expect(outsideCampaign('1999-01-01', { startsOn: null, endsOn: '2027-01-01' })).toBe(false);
    expect(outsideCampaign('2027-01-02', { startsOn: null, endsOn: '2027-01-01' })).toBe(true);
    expect(outsideCampaign('2099-01-01', plain)).toBe(false);
    expect([isCampaign(tet), isCampaign(plain), isCampaign({ ...plain, endsOn: '2027-01-01' })]).toEqual([true, false, true]);
  });
});

describe('prefillUtm', () => {
  it('fills only the empty fields, and turns the tags on when they were off', () => {
    expect(prefillUtm(null, tet)).toEqual({ campaign: 'tet-2027', medium: 'social' });
    expect(prefillUtm(null, { utmCampaign: 'he', utmMedium: 'email' })).toEqual({ campaign: 'he', medium: 'email' });
    expect(prefillUtm({ campaign: '', medium: 'social' }, tet)).toEqual({ campaign: 'tet-2027', medium: 'social' });
    expect(prefillUtm({ campaign: ' ', medium: '' }, { utmCampaign: 'he', utmMedium: 'email' })).toEqual({ campaign: 'he', medium: 'email' });
  });

  it('changes nothing typed, and nothing for a label without a UTM campaign', () => {
    expect(prefillUtm({ campaign: 'khac', medium: 'social' }, tet)).toBeNull();
    expect(prefillUtm({ campaign: 'khac', medium: 'cpc' }, { utmCampaign: 'he', utmMedium: 'email' })).toBeNull();
    expect(prefillUtm(null, plain)).toBeNull();
    expect(prefillUtm({ campaign: '', medium: '' }, plain)).toBeNull();
  });
});

describe('campaignFindings', () => {
  it('finds nothing for plain labels or a channel that follows the campaign', () => {
    expect(campaignFindings([plain], [channel({ settings: {}, at: '2099-01-01T00:00:00Z' })], 'Asia/Ho_Chi_Minh')).toEqual([]);
    expect(campaignFindings([tet], [channel()], 'Asia/Ho_Chi_Minh')).toEqual([]);
    expect(campaignFindings([], [channel({ settings: {} })], 'Asia/Ho_Chi_Minh')).toEqual([]);
  });

  it('flags another UTM campaign, or none on a link, and leaves a channel without a link alone', () => {
    // GA4 tells campaigns apart by case.
    expect(campaignFindings([tet], [channel({ settings: { utm: { campaign: 'Tet-2027' } } })], 'Asia/Ho_Chi_Minh')).toEqual([
      { kind: 'utm_campaign', label: 'Tết', channel: 'Trang', expected: 'tet-2027', actual: 'Tet-2027' },
    ]);
    expect(campaignFindings([tet], [channel({ settings: {} })], 'Asia/Ho_Chi_Minh')).toEqual([{ kind: 'utm_campaign', label: 'Tết', channel: 'Trang', expected: 'tet-2027', actual: null }]);
    expect(campaignFindings([tet], [channel({ settings: {}, linkUrl: null })], 'Asia/Ho_Chi_Minh')).toEqual([]);
  });

  it("flags a channel planned outside the dates, by the day in the post's time zone", () => {
    // 20:00 UTC on 15 February is already 16 February in Hồ Chí Minh City, but still the 15th in UTC.
    const late = channel({ at: '2027-02-15T20:00:00Z' });
    expect(campaignFindings([tet], [late], 'Asia/Ho_Chi_Minh')).toEqual([{ kind: 'outside_dates', label: 'Tết', channel: 'Trang', day: '2027-02-16', startsOn: '2027-01-20', endsOn: '2027-02-15' }]);
    expect(campaignFindings([tet], [late], 'UTC')).toEqual([]);
    // No time yet, nothing to judge.
    expect(campaignFindings([tet], [channel({ at: null })], 'Asia/Ho_Chi_Minh')).toEqual([]);
  });

  it('goes label by label, then channel by channel', () => {
    const he: Campaign = { name: 'Hè', startsOn: '2027-06-01', endsOn: null, utmCampaign: null, utmMedium: null };
    const found = campaignFindings([tet, he], [channel({ name: 'A' }), channel({ name: 'B', settings: {} })], 'Asia/Ho_Chi_Minh');
    expect(found.map((f) => [f.kind, f.label, f.channel])).toEqual([
      ['utm_campaign', 'Tết', 'B'],
      ['outside_dates', 'Hè', 'A'],
      ['outside_dates', 'Hè', 'B'],
    ]);
  });
});
