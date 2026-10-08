export interface Env {
  DB: D1Database;
  /** Comma-separated; a caller sends one of them as `Authorization: Bearer <key>`. */
  MODERATOR_API_KEYS: string;
  OPENROUTER_API_KEY: string;
  LINEAR_API_KEY: string;
  /** Moderator's GitHub App, created from /github/setup. */
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  /** vars in wrangler.jsonc */
  PUBLIC_URL: string;
  GITHUB_ORG: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
}
