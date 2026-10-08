import { describe, expect, it } from 'vitest';

import { askJev } from '../src/jev';

describe('askJev', () => {
  it('posts the state and questions to Jev with the key', async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    const fetcher = (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return Response.json({ answers: { a: { noul: 0.7 } } });
    }) as typeof fetch;
    expect(await askJev('k', fetcher)({ x: 1 }, { a: { type: 'noul', instructions: 'q', criteria: { true: 't', false: 'f' } } })).toEqual({ a: { noul: 0.7 } });
    expect(sent?.url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(new Headers(sent?.init.headers).get('Authorization')).toBe('Bearer k');
    expect(JSON.parse(String(sent?.init.body))).toMatchObject({ model: 'typesafe/jev-1.13', state: { x: 1 } });
  });

  it('answers null when Jev errs or is unreachable', async () => {
    expect(await askJev('k', (async () => new Response('no', { status: 500 })) as typeof fetch)({}, {})).toBeNull();
    expect(await askJev('k', (async () => { throw new Error('down'); }) as typeof fetch)({}, {})).toBeNull();
  });
});
