import { env } from 'cloudflare:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { accessEmail } from '../src/access';
import { github } from '../src/github';
import { branches } from '../src/harness';

describe('accessEmail (real Access tokens)', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] });
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  const verify = accessEmail(env, keys);

  const token = (claims: { aud?: string; iss?: string; exp?: number; email?: string }, key = privateKey) =>
    new SignJWT(claims.email === undefined ? {} : { email: claims.email })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(claims.iss ?? issuer)
      .setAudience(claims.aud ?? env.ACCESS_AUD)
      .setIssuedAt()
      .setExpirationTime(claims.exp ?? '5m')
      .sign(key);
  const call = async (jwt?: string) => verify(new Request('https://x/approve', { headers: jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {} }));

  it("accepts an approver's token and returns the email", async () => {
    expect(await call(await token({ email: 'Tsomaia.GE@gmail.com' }))).toBe('tsomaia.ge@gmail.com');
  });

  it('refuses a valid Access login whose email is not an approver', async () => {
    expect(await call(await token({ email: 'someone@else.com' }))).toBeNull();
  });

  it('refuses no token, a wrong audience or issuer, an expired one, a foreign signature, and a token without an email', async () => {
    expect(await call()).toBeNull();
    expect(await call(await token({ email: 'o@x', aud: 'another-app' }))).toBeNull();
    expect(await call(await token({ email: 'o@x', iss: 'https://evil.cloudflareaccess.com' }))).toBeNull();
    expect(await call(await token({ email: 'o@x', exp: Math.floor(Date.now() / 1000) - 60 }))).toBeNull();
    expect(await call(await token({ email: 'o@x' }, other.privateKey))).toBeNull();
    expect(await call(await token({}))).toBeNull();
  });
});

describe('github (real Octokit)', () => {
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const gh = github({ ...env, GITHUB_APP_ID: '1', GITHUB_PRIVATE_KEY: pem.replace(/\n/g, ' '), GITHUB_WEBHOOK_SECRET: 'whsec' });

  afterEach(() => vi.restoreAllMocks());

  it('verifies a real webhook signature and refuses a forged one', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('whsec'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
    const signature = `sha256=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    expect(await gh.verifyWebhook(body, signature)).toBe(true);
    expect(await gh.verifyWebhook(`${body} `, signature)).toBe(false);
  });

  it('reads the diff of exactly the two commits, and posts the check run', async () => {
    const sent: { url: string; body?: unknown }[] = [];
    let graphql: { query: string; variables: Record<string, string> }[] = [];
    let graphqlErrors = false;
    let compare: unknown = { files: [{ filename: 'a.test.ts', status: 'modified', patch: '@@' }], commits: [{ commit: { author: { date: 'a' }, committer: { date: 'c' } } }] };
    const blobs: Record<string, string> = { 'mb1:big.test.ts': 'b-big', 'mb1:moved.test.ts': 'h2' };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      sent.push({ url: url.pathname + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.pathname.endsWith('/access_tokens')) return Response.json({ token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
      if (url.pathname.includes('/compare/')) return Response.json(compare);
      if (url.pathname === '/graphql') {
        const { query, variables } = JSON.parse(String(init!.body)) as { query: string; variables: Record<string, string> };
        graphql.push({ query, variables });
        if (graphqlErrors) return Response.json({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] });
        const repository = Object.fromEntries(Object.entries(variables).filter(([k]) => /^e\d+$/.test(k)).map(([k, v]) => [`f${k.slice(1)}`, blobs[v] ? { oid: blobs[v] } : null]));
        return Response.json({ data: { repository } });
      }
      return Response.json({ id: 1 }, { status: 201 });
    });
    expect(await gh.compare(9, 'o', 'r', 'b1', 'h1')).toEqual({ files: [{ filename: 'a.test.ts', status: 'modified', previousFilename: undefined, patch: '@@' }], commitDates: ['a', 'c'] });
    expect(sent.at(-1)?.url).toBe('/repos/o/r/compare/b1...h1');

    // Files GitHub sends no patch for carry their blob at the merge base, looked up in one GraphQL request.
    graphql = [];
    compare = {
      merge_base_commit: { sha: 'mb1' },
      files: [
        { filename: 'a.test.ts', status: 'modified', patch: '@@' },
        { filename: 'big.test.ts', status: 'modified', sha: 'h1' },
        { filename: 'new/moved.test.ts', previous_filename: 'moved.test.ts', status: 'renamed', sha: 'h2' },
        { filename: 'added.png', status: 'added', sha: 'h3' },
      ],
      commits: [],
    };
    expect((await gh.compare(9, 'o', 'r', 'b1', 'h1')).files).toEqual([
      { filename: 'a.test.ts', status: 'modified', previousFilename: undefined, patch: '@@' },
      { filename: 'big.test.ts', status: 'modified', previousFilename: undefined, patch: undefined, sha: 'h1', baseSha: 'b-big' },
      { filename: 'new/moved.test.ts', status: 'renamed', previousFilename: 'moved.test.ts', patch: undefined, sha: 'h2', baseSha: 'h2' },
      { filename: 'added.png', status: 'added', previousFilename: undefined, patch: undefined, sha: 'h3', baseSha: null },
    ]);
    expect(graphql).toHaveLength(1);
    // An added file was not at the merge base: no lookup.
    expect(graphql[0].variables).toEqual({ owner: 'o', repo: 'r', e0: 'mb1:big.test.ts', e1: 'mb1:moved.test.ts' });

    // 101 files go in two requests, each numbering its own files from 0.
    graphql = [];
    compare = { merge_base_commit: { sha: 'mb1' }, files: Array.from({ length: 101 }, (_, n) => ({ filename: `f${n}.bin`, status: 'modified', sha: `h${n}` })), commits: [] };
    for (let n = 0; n < 101; n++) blobs[`mb1:f${n}.bin`] = `b${n}`;
    const many = (await gh.compare(9, 'o', 'r', 'b1', 'h1')).files;
    expect(graphql.map((g) => Object.keys(g.variables).length)).toEqual([102, 3]);
    expect(graphql[1].variables).toEqual({ owner: 'o', repo: 'r', e0: 'mb1:f100.bin' });
    expect(many.map((f) => f.baseSha)).toEqual(Array.from({ length: 101 }, (_, n) => `b${n}`));

    // A GraphQL error fails the read rather than leaving a file without its base blob.
    graphqlErrors = true;
    await expect(gh.compare(9, 'o', 'r', 'b1', 'h1')).rejects.toThrow();
    await gh.setCheck(9, 'o', 'r', 'sha0', { title: 'Checking', summary: 'S', detailsUrl: 'https://d' });
    expect(sent.at(-1)?.body).toMatchObject({ status: 'in_progress' });
    await gh.setCheck(9, 'o', 'r', 'sha1', { conclusion: 'action_required', title: 'T', summary: 'S', detailsUrl: 'https://d' });
    expect(sent.at(-1)).toEqual({
      url: '/repos/o/r/check-runs',
      body: { name: 'test-integrity', head_sha: 'sha1', status: 'completed', conclusion: 'action_required', details_url: 'https://d', output: { title: 'T', summary: 'S' } },
    });
  });
  it('moves a branch only as a fast-forward: compare base...head, config read raw at the tip sha, PATCH with force false', async () => {
    const b = branches({ ...env, GITHUB_APP_ID: '1', GITHUB_PRIVATE_KEY: pem, GITHUB_WEBHOOK_SECRET: 'whsec' });
    const sent: { method: string; url: string; accept?: string | null; body?: unknown }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(req.url);
      const text = init?.body ? String(init.body) : '';
      sent.push({ method: init?.method ?? req.method, url: url.pathname + url.search, accept: new Headers(init?.headers).get('accept'), body: text ? JSON.parse(text) : undefined });
      if (url.pathname.endsWith('/access_tokens')) return Response.json({ token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
      if (url.pathname === '/repos/o/r/installation') return Response.json({ id: 9 });
      if (url.pathname === '/repos/o/r') return Response.json({ default_branch: 'main' });
      if (url.pathname === '/repos/o/r/git/ref/heads%2Fmain' || url.pathname === '/repos/o/r/git/ref/heads/main') return Response.json({ object: { sha: 'tip1' } });
      if (url.pathname.startsWith('/repos/o/r/contents/')) return new Response('{"directToMain":[".claude/"]}');
      if (url.pathname.includes('/compare/')) return Response.json({ status: 'ahead', files: [{ filename: '.claude/a.md' }, { filename: '.claude/b.md', previous_filename: 'src/b.md' }] });
      if ((init?.method ?? req.method) === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({ object: { sha: 'h1' } });
    });
    expect(await b.tip('o', 'r')).toEqual({ installation: 9, branch: 'main', sha: 'tip1' });
    expect(await b.file(9, 'o', 'r', 'moderator.config.json', 'tip1')).toBe('{"directToMain":[".claude/"]}');
    expect(sent.at(-1)).toMatchObject({ method: 'GET', url: '/repos/o/r/contents/moderator.config.json?ref=tip1', accept: 'application/vnd.github.raw+json' });
    expect(await b.compare(9, 'o', 'r', 'tip1', 'h1')).toEqual({ status: 'ahead', paths: ['.claude/a.md', '.claude/b.md', 'src/b.md'], complete: true });
    expect(sent.at(-1)?.url).toBe('/repos/o/r/compare/tip1...h1?per_page=100');
    expect(await b.head(9, 'o', 'r', 'main')).toBe('tip1');
    expect(await b.move(9, 'o', 'r', 'main', 'h1')).toBe('done');
    expect(sent.at(-1)).toMatchObject({ method: 'PATCH', body: { sha: 'h1', force: false } });
    expect(sent.at(-1)?.url).toMatch(/^\/repos\/o\/r\/git\/refs\/heads(\/|%2F)main$/);
    await b.remove(9, 'o', 'r', 'harness/h1');
    expect(sent.at(-1)?.method).toBe('DELETE');
    expect(sent.at(-1)?.url).toMatch(/^\/repos\/o\/r\/git\/refs\/heads(\/|%2F)harness(\/|%2F)h1$/);
  });
  it('fails closed on a file listing GitHub cut at 300 or left out, and tells a moved branch from a protection', async () => {
    const b = branches({ ...env, GITHUB_APP_ID: '1', GITHUB_PRIVATE_KEY: pem, GITHUB_WEBHOOK_SECRET: 'whsec' });
    let compare: unknown;
    let patch: Response;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith('/access_tokens')) return Response.json({ token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
      if (url.pathname.includes('/compare/')) return Response.json(compare);
      if (init?.method === 'PATCH') return patch.clone();
      return new Response(null, { status: 404 });
    });
    compare = { status: 'ahead', files: Array.from({ length: 300 }, (_, i) => ({ filename: `.claude/f${i}.md` })) };
    expect((await b.compare(9, 'o', 'r', 'b', 'h')).complete).toBe(false);
    compare = { status: 'ahead' };
    expect(await b.compare(9, 'o', 'r', 'b', 'h')).toEqual({ status: 'ahead', paths: [], complete: false });
    compare = { status: 'ahead', files: [] };
    expect((await b.compare(9, 'o', 'r', 'b', 'h')).complete).toBe(false);
    compare = { status: 'ahead', files: Array.from({ length: 299 }, (_, i) => ({ filename: `.claude/f${i}.md` })) };
    expect((await b.compare(9, 'o', 'r', 'b', 'h')).complete).toBe(true);

    patch = Response.json({ message: 'Update is not a fast forward' }, { status: 422 });
    expect(await b.move(9, 'o', 'r', 'main', 'h')).toBe('moved');
    patch = Response.json({ message: 'Protected branch update failed for refs/heads/main.' }, { status: 422 });
    expect(await b.move(9, 'o', 'r', 'main', 'h')).toEqual({ refused: 'Protected branch update failed for refs/heads/main.' });
    patch = Response.json({ message: 'Repository rule violations found' }, { status: 422 });
    expect(await b.move(9, 'o', 'r', 'main', 'h')).toEqual({ refused: 'Repository rule violations found' });
    expect(await b.head(9, 'o', 'r', 'harness/abc1234')).toBeNull();
  });
});
