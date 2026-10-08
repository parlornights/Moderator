# Moderator

A Cloudflare Worker at `moderator.parlornights.com` that holds the secrets agent sessions must not have, and does the
privileged actions for them: Jev checks and Linear writes. Every call is recorded in an audit log.

## Calling it

The full API is described at `/openapi.json` and browsable at `/docs` (Swagger UI; use **Authorize** with a key to try calls).


Every request sends `Authorization: Bearer <key>`, where `<key>` is one of the comma-separated `MODERATOR_API_KEYS`.

| Endpoint | Does |
|---|---|
| `POST /tool/jev/:check` | Runs a Jev check: `pick`, `reviewer`, `verdict`, `open-questions`, `needs-decision`, `linear-issue`, `linear-text`, `linear-comment`. Answers `{outcome: "done", result}` or `{outcome: "not_run", reason: "jev_down"}`. |
| `POST /tool/linear/issue` | `{id?, team, title, description, project?, parent?}`; `id` is an optional client UUID that makes a retry safe. Jev checks it is a product task with what done looks like. |
| `PATCH /tool/linear/issue/:id` | `{title?, description?, status?, priority?, addLabels?, removeLabels?, links?}`. Jev checks only changed title or description. |
| `POST /tool/linear/comment` | `{id?, issue, body}`. Jev checks it is a settled product update. |
| `GET /audit?limit=&before=` | The audit log, newest first. |

## test-integrity

Moderator's own GitHub App sends every `pull_request` (opened, synchronize, reopened, ready for review) to
`/github/webhook`. The Worker fetches the PR's changed files itself and keeps every hunk that changes, removes or
renames an existing test, fixture, snapshot, mock, test helper or test config (`src/hunks.ts`). It reads the Linear
issue named in the PR title as it stood before the work began (the earliest of the PR's creation and its commit dates;
text changed after that does not count), and asks Jev, neutrally and per hunk, whether that ticket sanctions it.

It posts a `test-integrity` check run as the App (only the App can write its own check runs; require it by App in the
branch rules):

- success when nothing is flagged;
- action required when Jev flags a hunk, when Jev does not answer, when GitHub shows no diff for a test file or lists
  fewer files than the PR changed, or when the check itself errors. The App then comments on the PR, mentioning its
  author, with the flagged hunks and a link to `/approve/<owner>/<repo>/<sha>`.

On that page the owner approves (success for that commit only) or rejects with an optional reason (failure; the App
posts the reason on the PR). A new push runs the check again.

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
