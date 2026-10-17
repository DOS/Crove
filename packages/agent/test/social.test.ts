// SocialWriter with a stand-in for the model: what it is told, and what it keeps of the answer.
import { describe, expect, it } from 'vitest';
import { SocialWriter, type DraftGenerator, type WriterChannel } from '../src/index.ts';

const CONFIG = { baseURL: 'http://localhost:1/v1', apiKey: null, model: 'test' };
const channels: WriterChannel[] = [
  { key: 'c-fb', provider: 'facebook_page', label: 'Facebook Page (Quán A)', maxChars: 63206, title: null },
  { key: 'c-zalo', provider: 'zalo_oa', label: 'Zalo OA (Quán A)', maxChars: null, title: { required: true, max: 150 } },
];

function recorder(answer: Awaited<ReturnType<DraftGenerator>>) {
  const asked: { system: string; prompt: string }[] = [];
  const generate: DraftGenerator = async (args) => {
    asked.push(args);
    return answer;
  };
  return { asked, writer: new SocialWriter(CONFIG, generate) };
}

describe('SocialWriter', () => {
  it('tells the model the channels and their limits, and fences the brief as data', async () => {
    const { asked, writer } = recorder({ body: 'Khai trương!', title: null, variants: [] });
    await writer.draft({ brief: 'Khai trương chi nhánh Quận 3, giảm 20% tuần đầu', channels, language: 'vi', tone: 'thân thiện' });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.system).toContain('Write in Vietnamese.');
    expect(asked[0]?.system).toContain('never invent prices');
    expect(asked[0]?.prompt).toContain('- key c-fb: Facebook Page (Quán A), text at most 63206 characters; no title');
    expect(asked[0]?.prompt).toContain('- key c-zalo: Zalo OA (Quán A), text no length limit; title required, at most 150 characters');
    expect(asked[0]?.prompt).toContain('Voice: thân thiện');
    expect(asked[0]?.prompt).toContain('<<<\nKhai trương chi nhánh Quận 3, giảm 20% tuần đầu\n>>>');
  });

  it('keeps only variants of the given channels, once each, and drops empty ones', async () => {
    const { writer } = recorder({
      body: '  Khai trương chi nhánh mới  ',
      title: '  ',
      variants: [
        { key: 'c-zalo', body: null, title: 'Khai trương Quận 3' },
        { key: 'c-zalo', body: 'second copy', title: null },
        { key: 'someone-else', body: 'x', title: null },
        { key: 'c-fb', body: ' ', title: null },
      ],
    });
    expect(await writer.draft({ brief: 'Khai trương', channels, language: 'vi' })).toEqual({
      body: 'Khai trương chi nhánh mới',
      title: null,
      variants: [{ key: 'c-zalo', body: null, title: 'Khai trương Quận 3' }],
    });
  });

  it('answers null for an empty brief, no channels or an empty answer, without asking twice', async () => {
    const { asked, writer } = recorder({ body: '  ', title: null, variants: [] });
    expect(await writer.draft({ brief: '   ', channels, language: 'vi' })).toBeNull();
    expect(await writer.draft({ brief: 'x', channels: [], language: 'vi' })).toBeNull();
    expect(asked).toHaveLength(0);
    expect(await writer.draft({ brief: 'x', channels, language: 'en' })).toBeNull();
    expect(asked[0]?.system).toContain('Write in English.');
  });
});
