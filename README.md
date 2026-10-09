# Moderator

A Cloudflare Worker at `moderator.parlornights.com` that holds the secrets agent sessions must not have, and does the
privileged actions for them: Jev checks, Linear writes and harness-only pushes to a default branch. Every call is recorded in an audit log.

The client a repository installs for its sessions (hooks, the local gate, the handoff note, the `moderator` command)
is in [`client/`](client/README.md).

## Calling it

The full API is described at `/openapi.json` and browsable at `/docs` (Swagger UI; use **Authorize** with a key to try calls).


Every request sends `Authorization: Bearer <key>`, where `<key>` is one of the comma-separated `MODERATOR_API_KEYS`.

| Endpoint | Does |
|---|---|
| `POST /tool/jev/:check` | Runs a Jev check: `pick`, `reviewer`, `verdict`, `open-questions`, `needs-decision`, `linear-issue`, `linear-text`, `linear-comment`. Answers `{outcome: "done", result}` or `{outcome: "not_run", reason: "jev_down"}`. |
| `POST /tool/linear/issue` | `{id?, team, title, description, project?, parent?}`; `id` is an optional client UUID that makes a retry safe. Jev checks it is a product task with what done looks like. |
| `PATCH /tool/linear/issue/:id` | `{title?, description?, status?, priority?, addLabels?, removeLabels?, links?}`. Jev checks only changed title or description. |
| `POST /tool/linear/comment` | `{id?, issue, body}`. Jev checks it is a settled product update. |
| `POST /tool/harness/push` | `{repo: "owner/name", sha, branch?}`. Moves the default branch to `sha` as Moderator's GitHub App, never forced, when `sha` is a fast-forward of it and every changed or renamed-from path is in `directToMain` of the default branch's own `moderator.config.json`; then deletes the scratch branch `branch`. Answers `{outcome: "done", branch, sha, paths}`, or `{outcome: "refused", reason, paths?}` with 403 (a path outside, listed; no `directToMain`), 404 (App not installed), 409 (not a fast-forward, or the branch moved meanwhile) or 422. `moderator push-main` calls it. |
| `GET /audit?limit=&before=` | The audit log, newest first. |

## test-integrity

Moderator's own GitHub App sends every `pull_request` (opened, synchronize, reopened, ready for review) to
`/github/webhook`. The Worker fetches the PR's changed files itself and keeps every hunk that changes, removes or
renames an existing test file. Test files are known by name: a `.test.`, `.spec.` or `.e2e.` infix (`src/hunks.ts`).
A new test file only adds coverage and is not judged. It reads the Linear
issue named in the PR title as it stood before the work began (the earliest of the PR's creation and its commit dates;
text changed after that does not count), and asks Jev, neutrally and per hunk, whether that ticket sanctions it.

It posts a `test-integrity` check run as the App (only the App can write its own check runs; require it by App in the
branch rules):

- success when nothing is flagged;
- action required when Jev flags a hunk, when Jev does not answer, when GitHub shows no diff for a test file or lists
  fewer files than the PR changed, or when the check itself errors. The App then comments on the PR, mentioning its
  author, with the flagged hunks and a link to `/approve/<owner>/<repo>/<sha>`.

On that page the owner approves (success for that commit; a later commit of the same PR and base keeps the approval when its own diff is unchanged, such as a merge of the base branch, and each approved test file keeps it while its changes stay exactly as approved, whatever else the commit changes) or rejects with an optional reason (failure; the App
posts the reason on the PR). A new push runs the check again.

The owner pages (`/approve/*`, `/github/setup`, `/github/created`) sit behind Cloudflare Access (application "Moderator
owner pages"), and the Worker checks the Access token itself. `/github/setup` creates the App from a manifest in one click. The App needs
`contents: write` for `/tool/harness/push`; on an App created before, the owner raises it in the App's GitHub settings and accepts it on the installation.

A Linear write answers `{outcome: "done", id, url}`, or `{outcome: "ask_owner", reason: "jev_refused" \| "jev_down"}`
and writes nothing; the agent then uses the Linear connector, whose write tools prompt the owner.

## Secrets (Worker settings)

`MODERATOR_API_KEYS`, `OPENROUTER_API_KEY`, `LINEAR_API_KEY`, and from `/github/setup`: `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`. Moderator keys may use only letters, digits and `._~+/-`, with `=` padding at the end (base64 or hex), as the Bearer scheme allows.

## Build and deploy

Workers Builds (Cloudflare dashboard → Workers & Pages → moderator → Settings → Build), connected to this repository:
root directory `service`, build command `pnpm run check` (lint, types, tests), deploy command `pnpm run deploy`
(D1 migrations, then deploy), production branch `main`. Every other branch is checked and uploaded as a preview
version without being deployed.

## Develop

```sh
cd service
pnpm install
pnpm check       # oxlint, tsc and vitest (in the Workers runtime, real D1)
pnpm deploy      # applies D1 migrations, then deploys
MODERATOR_KEY=<key> pnpm smoke   # live test of the deployed Worker; files one Linear test issue and cancels it
```
