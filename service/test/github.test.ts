import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { normalizePem } from '../src/github';

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

describe('normalizePem', () => {
  it('rebuilds a key whose line breaks were dropped, spaced or escaped', () => {
    for (const pasted of [pem.replace(/\n/g, ''), pem.replace(/\n/g, ' '), pem.replace(/\n/g, '\\n'), pem]) expect(normalizePem(pasted)).toBe(pem);
  });
});
