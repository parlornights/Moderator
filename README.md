# Moderator

A Cloudflare Worker at `moderator.parlornights.com` that holds the secrets agent sessions must not have, and does the
privileged actions for them: Jev checks and Linear writes. Every call is recorded in an audit log.

## Calling it

The full API is described at `/openapi.json` and browsable at `/docs` (Swagger UI; use **Authorize** with a key to try calls).


Every request sends `Authorization: Bearer <key>`, where `<key>` is one of the comma-separated `MODERATOR_API_KEYS`.

| Endpoint | Does |
|---|---|
| `POST /tool/jev/:check` | Runs a Jev check: `pick`, `reviewer`, `verdict`, `open-questions`, `needs-decision`, `linear-issue`, `linear-text`, `linear-comment`. Answers `{outcome: "done", result}` or `{outcome: "not_run", reason: "jev_down"}`. |
| `POST /tool/linear/issue` | `{team, title, description, project?, parent?}`. Jev checks it is a product task with what done looks like. |
| `PATCH /tool/linear/issue/:id` | `{title?, description?, status?, priority?, addLabels?, removeLabels?, links?}`. Jev checks only changed title or description. |
| `POST /tool/linear/comment` | `{issue, body}`. Jev checks it is a settled product update. |
| `GET /audit?limit=&before=` | The audit log, newest first. |

## test-integrity

Moderator's own GitHub App sends every `pull_request` (opened, synchronize, reopened, ready for review) to
`/github/webhook`. The Worker fetches the PR's changed files itself, keeps the hunks that change, remove or rename a
test that already exists (tests, fixtures, snapshots; see `src/hunks.ts`), reads the Linear issue named in the PR title,
and asks Jev per hunk whether the ticket sanctions it. It posts a `test-integrity` commit status as the App: green when
nothing is flagged, red with a link to `/approve/<owner>/<repo>/<sha>`, where the owner sees each flagged hunk and can
approve that commit. A new push runs the check again.

The owner pages (`/approve/*`, `/github/setup`, `/github/created`) sit behind Cloudflare Access (application "Moderator
owner pages"), and the Worker checks the Access token itself. `/github/setup` creates the App from a manifest in one click.

A Linear write answers `{outcome: "done", id, url}`, or `{outcome: "ask_owner", reason: "jev_refused" \| "jev_down"}`
and writes nothing; the agent then uses the Linear connector, whose write tools prompt the owner.

## Secrets (Worker settings)

`MODERATOR_API_KEYS`, `OPENROUTER_API_KEY`, `LINEAR_API_KEY`, and from `/github/setup`: `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`. Moderator keys may use only letters, digits and `._~+/-`, with `=` padding at the end (base64 or hex), as the Bearer scheme allows.

## Develop

```sh
cd service
pnpm install
pnpm test        # vitest in the Workers runtime, real D1
pnpm typecheck
pnpm deploy      # applies D1 migrations, then deploys
MODERATOR_KEY=<key> pnpm smoke   # live test of the deployed Worker; files one Linear test issue and cancels it
```
