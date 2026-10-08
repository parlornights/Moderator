import { env } from 'cloudflare:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { accessEmail } from '../src/access';
import { github } from '../src/github';

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

  it("accepts the owner's token and returns the email", async () => {
    expect(await call(await token({ email: 'owner@example.com' }))).toBe('owner@example.com');
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

  it('reads every page of PR files and commits, and posts the check run', async () => {
    const sent: { url: string; body?: unknown }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      sent.push({ url: url.pathname + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.pathname.endsWith('/access_tokens')) return Response.json({ token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
      const page = Number(url.searchParams.get('page'));
      if (url.pathname.endsWith('/files')) return Response.json(Array.from({ length: page === 1 ? 100 : 5 }, (_, n) => ({ filename: `f${page}-${n}`, status: 'modified' })));
      if (url.pathname.endsWith('/commits')) return Response.json(page === 1 ? [{ commit: { author: { date: 'a' }, committer: { date: 'c' } } }] : []);
      return Response.json({ id: 1 }, { status: 201 });
    });
    expect(await gh.pullFiles(9, 'o', 'r', 4)).toHaveLength(105);
    expect(await gh.commitDates(9, 'o', 'r', 4)).toEqual(['a', 'c']);
    await gh.setCheck(9, 'o', 'r', 'sha1', { conclusion: 'action_required', title: 'T', summary: 'S', detailsUrl: 'https://d' });
    expect(sent.at(-1)).toEqual({
      url: '/repos/o/r/check-runs',
      body: { name: 'test-integrity', head_sha: 'sha1', status: 'completed', conclusion: 'action_required', details_url: 'https://d', output: { title: 'T', summary: 'S' } },
    });
  });
});
