# Moderator client

What a repository installs to run its Claude Code sessions under Moderator: the session hooks, the local gate, the
handoff note, orient and unit-watch, and the `moderator` command that calls the Moderator service for Jev checks and
Linear writes. The service holds every key; a session holds only `MODERATOR_API_KEY`.

Nothing in it is specific to one project. A repository keeps two things of its own: its hook wiring in
`.claude/settings.json` and its rules in `moderator.config.json`.

## Install

From this repository at a pinned tag or commit, with no registry:

```sh
pnpm add -D 'github:parlornights/moderator#<tag>&path:/client'
```

Node 22 or newer. The package is plain JavaScript (type-checked with JSDoc), so nothing is built on install.

## Wire the hooks

`.claude/settings.json` points each hook at the installed package:

```json
{
  "hooks": {
    "SessionStart": [{ "matcher": "startup|resume|clear|compact|fork", "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/node_modules/@parlornights/moderator/bin/moderator.js", "hook", "session-start"], "timeout": 60 }] }],
    "PreToolUse": [{ "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/node_modules/@parlornights/moderator/bin/moderator.js", "hook", "guard"], "timeout": 10 }] }],
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit", "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/node_modules/@parlornights/moderator/bin/moderator.js", "hook", "post-edit"], "timeout": 90 }] },
      { "matcher": "Artifact", "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/node_modules/@parlornights/moderator/bin/moderator.js", "hook", "post-artifact"], "timeout": 10 }] },
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/node_modules/@parlornights/moderator/bin/moderator.js", "hook", "context-watch"], "timeout": 10 }] }
    ],
    "SubagentStart": [{ "matcher": "^([\\w-]+:)?unit(-deep)?$", "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/node_modules/@parlornights/moderator/bin/moderator.js", "hook", "subagent-start"], "timeout": 10 }] }],
    "SubagentStop": [{ "matcher": "^([\\w-]+:)?unit(-deep)?$", "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/node_modules/@parlornights/moderator/bin/moderator.js", "hook", "subagent-stop"], "timeout": 2400 }] }],
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/node_modules/@parlornights/moderator/bin/moderator.js", "hook", "pre-compact"], "timeout": 30 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/node_modules/@parlornights/moderator/bin/moderator.js", "hook", "stop"], "timeout": 120 }] }]
  }
}
```

| Hook | Does |
|---|---|
| `session-start` | Prints the role (`role.md`), the orient block (which names the handoff note by path), and the lines that send the agent to the issue on Linear, the repo's start docs and the papercut log. After a compaction it first refreshes the note's auto block. |
| `guard` | Refuses a push to main or master by any agent (`moderator push-main`, run by the main session only, takes harness-only changes there), a force push, `rm -rf` at or above the repository, a unit checking out main, a unit waiting past 20 minutes in total, and a subagent editing `protectedPaths`. |
| `post-edit` | Runs `lintOnEdit` on the edited file; a failure reaches the agent at once. |
| `post-artifact` | Records a published Artifact URL; the Stop hook holds the turn until the note ties it to an issue. |
| `context-watch` | Past the hand-over share of the context window, tells the session once to write the handoff note and stop. |
| `subagent-start`, `subagent-stop` | A unit may stop only with a valid hand-back on a green gate (with a `proof` when the diff touches `proofPaths`), or an escalation; Jev judges a NEEDS DECISION line and the acceptance criteria against the diff. |
| `pre-compact` | Writes and commits the note's auto block before a compaction. |
| `stop` | Commits a checkpoint, holds the turn once for what is left (units without a check-in, open questions Jev reads as not whole or not repeated, a stale note, the issue not read on Linear, an unlinked artifact, a hand-over due), then pushes the branch. |

A hook never stops a session over its own bug or a broken config: it does nothing, and session-start, stop and
subagent-stop tell the user so in one line, since the protocol is off until it is fixed. Jev not answering never blocks: the check is skipped and the Stop hook
says so. The Stop hook commits and pushes nothing while a merge, cherry-pick or revert is unfinished; its checks still
run.

A unit is the `unit` or `unit-deep` agent, or the same from a plugin (`moderator:unit`); the matchers above take both,
whatever the plugin is called, as the hooks do.

The issue is the one the branch name carries (`issuePattern`); a branch without one gets no ledger, and the hooks
stay quiet there. The ledger is `.work/<ISSUE>/`: `handoff.md`, `events.jsonl`, the gate's results and logs.

### Sessions with more than one repository

Claude Code reads a repo's `.claude/settings.json` only while the session's project is that repo. When a second
repository joins a cloud session, the project becomes their parent directory and every repo hook stops, compaction
hooks included. `moderator user-hooks`, run in the repo, copies its hooks into `~/.claude/settings.json`, which keep
firing wherever the session works. Each copy is skipped while the project is the repo itself, so nothing runs twice,
and `moderator hook` gets `--repo`, so a session working in the other repository still grounds on this repo's task
(the guard and post-edit judge the file in hand and never fall back). Run it from the cloud environment's setup script:

```sh
cd /home/user/<repo> && pnpm install --frozen-lockfile && pnpm exec moderator user-hooks
```

## Skills and agents

The protocol's skills (`delegate`, `handoff`, `unit-protocol`, `papercut`) and agents (`unit`, `unit-deep`,
`reviewer`, `Explore`) ship in `claude/`. Cloud sessions load a repository's own `.claude/skills` and `.claude/agents`,
and a plugin reaches them only through an organization's managed settings (Team and Enterprise plans), so the files are
copied in:

```sh
moderator sync           # writes them into .claude/; commit the result
moderator sync --check   # exits 1 when a copy is missing or differs from the pinned version (run it in CI)
```

Change a skill or agent here, never in a repository's copy. The repository keeps its own `repo-map` skill, which the
unit agents preload. List `.claude/**` in `protectedPaths` so no subagent edits the copies.

## Commands

`moderator help` lists them: `scope`, `gate`, `risk`, `pick`, `handback`, `handoff`, `orient`, `papercut`,
`unit-watch`, `sync`, `linear issue | update | comment`, `push-main` and `user-hooks`.

A Linear write goes through the service, which asks Jev whether it is a product-level write. When Jev refuses or
does not answer, nothing is written and the command exits 3; the agent then uses the Linear connector's own tool,
whose write tools prompt the owner. The same request on the same day carries the same id, so running a command twice
files once.

`moderator push-main` takes a commit that changes only the agent tooling (`directToMain`) to the default branch
without a pull request. It refuses a dirty tree, fetches the default branch and refuses unless `origin/main` is an
ancestor of `HEAD` (merge it first), pushes `HEAD` to `harness/<short sha>` (never forced) and calls Moderator with
the repo named by the origin remote. Moderator reads `directToMain` from the default branch's own config, so widening
it needs a pull request; it refuses any changed or renamed-from path outside it, and anything that is not a
fast-forward, then moves the branch as its GitHub App, never forced, and deletes the scratch branch. A refusal prints
its reason and the paths, and exits 1. No agent pushes to main itself, and only the main session runs `push-main`: the
guard refuses both. `moderator.config.json` itself never goes this way, whatever `directToMain` lists. The App must be a
bypass actor on the default branch's protection or ruleset, or GitHub refuses the move and the command prints why.

## moderator.config.json

```json
{
  "issuePattern": "\\b(?:CD|PAR)-\\d+\\b",
  "moderatorUrl": "https://moderator.parlornights.com",
  "base": "origin/main",
  "ignore": ["**/*.md", "docs/**", ".work/**"],
  "global": ["pnpm-lock.yaml", "package.json"],
  "lintExtensions": [".ts", ".tsx", ".js", ".mjs"],
  "lintOnEdit": "pnpm exec oxlint {file}",
  "checks": {
    "lint": { "when": "files", "order": 10, "timeoutSec": 120, "cmd": "pnpm exec oxlint {files}" },
    "typecheck": { "when": "packages", "order": 20, "cmd": "pnpm {filters} run --if-present typecheck" },
    "unit": { "when": "packages", "order": 30, "cmd": "pnpm {filters} run --if-present test" }
  },
  "rules": [{ "name": "bot balance", "match": ["packages/game/**"], "checks": ["balance"] }],
  "risk": { "highPaths": ["**/migrations/**", "infra/**"], "linesHigh": 400, "filesHigh": 15, "srcLinesNeedingTests": 30 },
  "protectedPaths": [".claude/**", "moderator.config.json", "docs/papercuts.md"],
  "directToMain": [".claude/", "CLAUDE.md", "docs/papercuts.md"],
  "proofPaths": ["apps/app/src/**"],
  "papercuts": "docs/papercuts.md",
  "readAtStart": [{ "path": "docs/TESTING.md", "why": "how every test here is written" }],
  "context": { "window": 1000000, "handoffShare": 0.7 }
}
```

Only `issuePattern` is required. A check runs `when` lintable files changed (`files`), a workspace package changed
(`packages`), a rule names it (`rule`), or `always`. In `cmd`, `{files}` is the changed lintable files and
`{filters}` is pnpm's `-r` for a global change, else `--filter "...<package>"` per changed package. `risk` decides
the reviewer: a high path or a large diff asks for opus, and Jev may raise it, never lower it. Jev's own thresholds
live in the service. `directToMain` lists the paths `moderator push-main` may take to the default branch; an entry
ending in `/` is a folder, any other entry one file. `proofPaths` lists the paths whose change is visible: when a
unit's diff against the base touches one, a hand-back with a missing or empty `proof` is refused, naming the matched
paths. `proof` is the URL of the Artifact page with the screenshots, or `none: <reason>` when nothing visible changed
(a refactor, a hook, a type), and the reviewer judges whether the reason holds. Without `proofPaths` no proof is
required.

## Develop

```sh
cd client
pnpm install
pnpm check    # oxlint, tsc (JSDoc types), node --test
```
