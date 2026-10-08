export interface Env {
  DB: D1Database;
  /** Comma-separated; a caller sends one of them as `Authorization: Bearer <key>`. */
  MODERATOR_API_KEYS: string;
  OPENROUTER_API_KEY: string;
  LINEAR_API_KEY: string;
}
