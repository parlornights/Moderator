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
    "SubagentStart": [{ "matcher": "unit|unit-deep", "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/node_modules/@parlornights/moderator/bin/moderator.js", "hook", "subagent-start"], "timeout": 10 }] }],
    "SubagentStop": [{ "matcher": "unit|unit-deep", "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/node_modules/@parlornights/moderator/bin/moderator.js", "hook", "subagent-stop"], "timeout": 2400 }] }],
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/node_modules/@parlornights/moderator/bin/moderator.js", "hook", "pre-compact"], "timeout": 30 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/node_modules/@parlornights/moderator/bin/moderator.js", "hook", "stop"], "timeout": 120 }] }]
  }
}
```

| Hook | Does |
|---|---|
| `session-start` | Prints the role (`role.md`), the orient block (which names the handoff note by path), and the lines that send the agent to the issue on Linear, the repo's start docs and the papercut log. After a compaction it first refreshes the note's auto block. |
| `guard` | Refuses a push to main or master, a force push, `rm -rf` at or above the repository, a unit checking out main, a unit waiting past 20 minutes in total, and a subagent editing `protectedPaths`. |
| `post-edit` | Runs `lintOnEdit` on the edited file; a failure reaches the agent at once. |
| `post-artifact` | Records a published Artifact URL; the Stop hook holds the turn until the note ties it to an issue. |
| `context-watch` | Past the hand-over share of the context window, tells the session once to write the handoff note and stop. |
| `subagent-start`, `subagent-stop` | A unit may stop only with a valid hand-back on a green gate, or an escalation; Jev judges a NEEDS DECISION line and the acceptance criteria against the diff. |
| `pre-compact` | Writes and commits the note's auto block before a compaction. |
| `stop` | Commits a checkpoint, holds the turn once for what is left (units without a check-in, open questions Jev reads as not whole or not repeated, a stale note, the issue not read on Linear, an unlinked artifact, a hand-over due), then pushes the branch. |

A hook never stops a session over its own bug: the error goes to stderr and the hook says nothing. Jev not answering
never blocks: the check is skipped and the Stop hook says so.

The issue is the one the branch name carries (`issuePattern`); a branch without one gets no ledger, and the hooks
stay quiet there. The ledger is `.work/<ISSUE>/`: `handoff.md`, `events.jsonl`, the gate's results and logs.

## Commands

`moderator help` lists them: `scope`, `gate`, `risk`, `pick`, `handback`, `handoff`, `orient`, `papercut`,
`unit-watch`, and `linear issue | update | comment`.

A Linear write goes through the service, which asks Jev whether it is a product-level write. When Jev refuses or
does not answer, nothing is written and the command exits 3; the agent then uses the Linear connector's own tool,
whose write tools prompt the owner. The same request always carries the same id, so running a command twice files
once.

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
  "papercuts": "docs/papercuts.md",
  "readAtStart": [{ "path": "docs/TESTING.md", "why": "how every test here is written" }],
  "context": { "window": 1000000, "handoffShare": 0.7 }
}
```

Only `issuePattern` is required. A check runs `when` lintable files changed (`files`), a workspace package changed
(`packages`), a rule names it (`rule`), or `always`. In `cmd`, `{files}` is the changed lintable files and
`{filters}` is pnpm's `-r` for a global change, else `--filter "...<package>"` per changed package. `risk` decides
the reviewer: a high path or a large diff asks for opus, and Jev may raise it, never lower it. Jev's own thresholds
live in the service.

## Develop

```sh
cd client
pnpm install
pnpm check    # oxlint, tsc (JSDoc types), node --test
```
