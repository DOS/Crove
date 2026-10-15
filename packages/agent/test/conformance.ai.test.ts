// AI endpoint conformance (plan §8.8): must pass before an OpenAI-compatible endpoint is enabled or an alias is
// locked. Runs against AI_BASE_URL / AI_API_KEY / AI_MODEL with `pnpm ai:conformance`; skipped without them.
// 429 and 5xx cannot be triggered on demand, so their mapping is covered by errors.test.ts on every CI run.
import { generateText, Output, stepCountIs, streamText, tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { chatModel, classifyAiError, InvoiceExtractor, type AiErrorInfo } from '../src/index.ts';
import { aiConfigFromEnv, SKIP_NOTICE } from './support.ts';

const config = aiConfigFromEnv();
if (!config) console.warn(SKIP_NOTICE);

// Synthetic, checksum-invalid tax code.
const TAX_CODE = '9900123450';

async function failure(run: () => Promise<unknown>): Promise<AiErrorInfo> {
  try {
    await run();
  } catch (error) {
    return classifyAiError(error);
  }
  throw new Error('expected the call to fail');
}

// The describe body runs even when skipped, so nothing here may assume an endpoint.
const cfg = config ?? { baseURL: 'http://127.0.0.1:1/v1', apiKey: null, model: 'unset' };

describe.skipIf(!config)('AI endpoint conformance', () => {
  const model = chatModel(cfg);

  it('answers a plain chat completion', async () => {
    const { text } = await generateText({ model, prompt: 'Reply with the single word "pong" and nothing else.' });
    expect(text.toLowerCase()).toContain('pong');
  });

  it('calls a tool with arguments that match its schema', async () => {
    const lookupVendor = tool({
      description: 'Look up a vendor by Vietnamese tax code',
      inputSchema: z.object({ taxCode: z.string(), year: z.number().int() }),
      execute: async (input) => input,
    });
    const result = await generateText({
      model,
      tools: { lookupVendor },
      toolChoice: 'required',
      stopWhen: stepCountIs(1),
      prompt: `Look up the vendor with tax code ${TAX_CODE} for the year 2026.`,
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ toolName: 'lookupVendor', input: { taxCode: TAX_CODE, year: 2026 } });
  });

  it('completes a tool round trip', async () => {
    const lookupVendor = tool({
      description: 'Look up a vendor name by Vietnamese tax code',
      inputSchema: z.object({ taxCode: z.string() }),
      execute: async ({ taxCode }) => ({ taxCode, name: taxCode === TAX_CODE ? 'Công ty Mẫu Thử Zeta' : 'unknown' }),
    });
    const result = await generateText({
      model,
      tools: { lookupVendor },
      stopWhen: stepCountIs(3),
      prompt: `Use the lookupVendor tool to find the vendor with tax code ${TAX_CODE}, then answer with the vendor name only.`,
    });
    expect(result.steps.length).toBeGreaterThanOrEqual(2);
    expect(result.text).toContain('Zeta');
  });

  it('returns structured output that matches a zod schema', async () => {
    const schema = z.object({
      currency: z.enum(['VND', 'USD']),
      lines: z.array(z.object({ description: z.string(), amount: z.string().regex(/^\d+$/) })),
      total: z.string().regex(/^\d+$/),
    });
    const { output } = await generateText({
      model,
      output: Output.object({ schema }),
      prompt: 'Structure this receipt. Amounts are plain digits.\nCà phê sữa: 35000 VND\nBánh mì: 25000 VND\nTổng: 60000 VND',
    });
    expect(schema.parse(output)).toMatchObject({ currency: 'VND', total: '60000' });
    expect(output.lines.map((l) => l.amount)).toEqual(['35000', '25000']);
  });

  it('extracts an invoice through the production extractor', async () => {
    const invoice = await new InvoiceExtractor(cfg).fromText(
      [
        'HÓA ĐƠN GIÁ TRỊ GIA TĂNG',
        'Ngày 05 tháng 09 năm 2026. Ký hiệu: C26TZZ. Số: 0000042',
        `Người bán: CÔNG TY TNHH MẪU THỬ ZETA. Mã số thuế: ${TAX_CODE}`,
        'Người mua: Khách lẻ',
        '1 | Dịch vụ tư vấn | Gói | 1 | 100.000 | 100.000 | 10%',
        'Cộng tiền hàng: 100.000. Tiền thuế GTGT: 10.000. Tổng tiền thanh toán: 110.000',
      ].join('\n'),
    );
    expect(invoice).toMatchObject({ series: 'C26TZZ', number: '42', issueDate: '2026-09-05', subtotal: '100000', vatTotal: '10000', total: '110000' });
  });

  it('streams text in more than one chunk', async () => {
    const result = streamText({ model, prompt: 'Count from 1 to 40, numbers separated by single spaces, nothing else.' });
    const chunks: string[] = [];
    for await (const chunk of result.textStream) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(await result.text);
    expect(await result.text).toContain('40');
    expect(await result.finishReason).toBe('stop');
  });

  it.skipIf(!cfg.apiKey)('maps a wrong API key to an auth error', async () => {
    const wrongKey = chatModel({ ...cfg, apiKey: 'crove-conformance-invalid-key' });
    const info = await failure(() => generateText({ model: wrongKey, prompt: 'ping', maxRetries: 0 }));
    expect(info).toMatchObject({ kind: 'auth', retryable: false });
  });

  it('maps an unknown model to a 4xx that is not retried', async () => {
    const unknown = chatModel({ ...cfg, model: 'crove-conformance-no-such-model' });
    const info = await failure(() => generateText({ model: unknown, prompt: 'ping', maxRetries: 0 }));
    expect(info.retryable, JSON.stringify(info)).toBe(false);
    expect(info.status).toBeGreaterThanOrEqual(400);
    expect(info.status).toBeLessThan(500);
  });
});
