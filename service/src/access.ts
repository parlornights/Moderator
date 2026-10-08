import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

import type { Env } from './env';

export type Verify = (request: Request) => Promise<string | null>;

const jwks = new Map<string, JWTVerifyGetKey>();

/**
 * The owner's email from the Cloudflare Access token on the request, or null. Access already stands in front of the
 * owner pages; checking its token here keeps them closed if that application is ever removed or misconfigured.
 */
export const accessEmail = (env: Env, keys?: JWTVerifyGetKey): Verify => {
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  return async (request) => {
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token || !env.ACCESS_AUD) return null;
    if (!keys && !jwks.has(issuer)) jwks.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)));
    try {
      const { payload } = await jwtVerify(token, keys ?? jwks.get(issuer)!, { issuer, audience: env.ACCESS_AUD });
      const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
      // A valid Access login is not enough: only the listed approvers count, even if the Access policy is ever widened.
      const approvers = (env.APPROVER_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase());
      return email && approvers.includes(email) ? email : null;
    } catch {
      return null;
    }
  };
};
