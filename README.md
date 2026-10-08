# Moderator

A Cloudflare Worker at `moderator.parlornights.com` that holds the secrets agent sessions must not have, and does the
privileged actions for them: Jev checks and Linear writes. Every call is recorded in an audit log.

## Calling it

Every request sends `Authorization: Bearer <key>`, where `<key>` is one of the comma-separated `MODERATOR_API_KEYS`.

| Endpoint | Does |
|---|---|
| `POST /tool/jev/:check` | Runs a Jev check: `pick`, `reviewer`, `verdict`, `open-questions`, `needs-decision`, `linear-issue`, `linear-text`, `linear-comment`. Answers `{outcome: "done", result}` or `{outcome: "not_run", reason: "jev_down"}`. |
| `POST /tool/linear/issue` | `{team, title, description, project?, parent?}`. Jev checks it is a product task with what done looks like. |
| `PATCH /tool/linear/issue/:id` | `{title?, description?, status?, priority?, addLabels?, removeLabels?, links?}`. Jev checks only changed title or description. |
| `POST /tool/linear/comment` | `{issue, body}`. Jev checks it is a settled product update. |
| `GET /audit?limit=&before=` | The audit log, newest first. |

A Linear write answers `{outcome: "done", id, url}`, or `{outcome: "ask_owner", reason: "jev_refused" \| "jev_down"}`
and writes nothing; the agent then uses the Linear connector, whose write tools prompt the owner.

## Secrets (Worker settings)

`MODERATOR_API_KEYS`, `OPENROUTER_API_KEY`, `LINEAR_API_KEY`. Moderator keys may use only letters, digits and `._~+/-`, with `=` padding at the end (base64 or hex), as the Bearer scheme allows.

## Develop

```sh
cd service
pnpm install
pnpm test        # vitest in the Workers runtime, real D1
pnpm typecheck
pnpm deploy      # applies D1 migrations, then deploys
MODERATOR_KEY=<key> pnpm smoke   # live test of the deployed Worker; files one Linear test issue and cancels it
```
