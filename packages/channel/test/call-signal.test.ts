// The call signal a publish job sets (#382): once the job gives up on a call, the adapter's requests are aborted.
import { describe, expect, it } from 'vitest';
import { allowlistedFetch, withCallSignal, type Fetch } from '../src/index.ts';

describe('withCallSignal', () => {
  it('joins every request of the call to the call signal, and leaves requests outside a call alone', async () => {
    const seen: AbortSignal[] = [];
    const fake: Fetch = async (_url, init) => {
      if (init?.signal) seen.push(init.signal);
      return new Response('{}', { status: 200 });
    };
    const fetchIt = allowlistedFetch(['api.example.com'], fake);
    const call = new AbortController();
    await withCallSignal(call.signal, async () => {
      await fetchIt('https://api.example.com/a');
      // Still inside the call after an await: the scope follows the async chain.
      await new Promise((resolve) => setTimeout(resolve, 1));
      await fetchIt('https://api.example.com/b');
    });
    await fetchIt('https://api.example.com/outside');
    expect(seen.map((s) => s.aborted)).toEqual([false, false, false]);
    call.abort(new Error('job timed out'));
    expect(seen.map((s) => s.aborted)).toEqual([true, true, false]);
  });

  it('makes a request started after the job gave up fail at once with real fetch semantics', async () => {
    const call = new AbortController();
    call.abort(new Error('job timed out'));
    const honest: Fetch = async (_url, init) => {
      // What fetch does with an aborted signal: it rejects before sending anything.
      if (init?.signal?.aborted) throw init.signal.reason;
      return new Response('{}', { status: 200 });
    };
    const fetchIt = allowlistedFetch(['api.example.com'], honest);
    await expect(withCallSignal(call.signal, () => fetchIt('https://api.example.com/post'))).rejects.toThrow('job timed out');
  });
});
