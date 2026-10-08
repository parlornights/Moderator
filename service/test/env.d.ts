import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { Env as ModeratorEnv } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends ModeratorEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
