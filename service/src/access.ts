import { createRemoteJWKSet, jwtVerify } from 'jose';

import type { Env } from './env';

export type Verify = (request: Request) => Promise<string | null>;

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * The owner's email from the Cloudflare Access token on the request, or null. Access already stands in front of the
 * owner pages; checking its token here keeps them closed if that application is ever removed or misconfigured.
 */
export const accessEmail =
  (env: Env): Verify =>
  async (request) => {
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token || !env.ACCESS_AUD) return null;
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    if (!jwks.has(issuer)) jwks.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)));
    try {
      const { payload } = await jwtVerify(token, jwks.get(issuer)!, { issuer, audience: env.ACCESS_AUD });
      return typeof payload.email === 'string' ? payload.email : null;
    } catch {
      return null;
    }
  };
