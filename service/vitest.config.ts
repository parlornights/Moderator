import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          MODERATOR_API_KEYS: 'key-one, key-two',
          OPENROUTER_API_KEY: 'jev-key',
          LINEAR_API_KEY: 'linear-key',
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
        },
      },
    }),
  ],
  test: { setupFiles: ['./test/setup.ts'] },
}));
