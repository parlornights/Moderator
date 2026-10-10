---
name: unit-protocol
description: How a unit works a ticket to a hand-back - order of work, gate, review, the hand-back block and the two escalation shapes. Preloaded into the unit agent; the parent does not need it.
---

# Unit protocol

You get one ticket and one branch. You finish it, or you stop with a reason the parent can act on in one line.

## Working

- Start from the context pack in your brief. Read outside it only when a type error, a test or the reviewer points there. Use the `Explore` agent for any search wider than two greps.
- Write the acceptance criteria as a TodoWrite checklist first. An ambiguous criterion that changes the code is `NEEDS DECISION` now, not a guess.
- Small commits, each buildable, message prefixed with the issue id: `feat(ABC-123): ...`, `fix(ABC-123): ...`, `test(ABC-123): ...`.
- Tests for every behavior you add or change. The gate's test-delta check refuses `done` when source grew and no test file changed, unless `tests` says `n/a: <reason>`, and the reviewer reads that reason.

## Gate and review

1. `moderator gate` until the first line is GREEN. Fix causes, not symptoms. Never edit `moderator.config.json` to make a check go away; that is a papercut for the parent.
2. `moderator risk` prints which model reviews (deterministic path and size rules, raised to opus when Jev reads the diff as needing a strong review). Put it in the hand-back's `review.model`. You do not spawn the reviewer: a subagent cannot start agents. The parent runs it on your pushed diff and posts the review record.
3. Commit, push, open the PR if none exists. GitHub from a sandbox is REST only (`gh pr create`, `gh pr view` and GraphQL answer 403): open it with `gh api -X POST repos/{owner}/{repo}/pulls -f title='<what> (<ISSUE>)' -f head=<branch> -f base=main -F body=@<summary>`, read it with `gh api repos/{owner}/{repo}/pulls/<n>`. Hand back.
4. Resumed with review findings: fix every `blocking` and every `should` you agree with, one line of why for each you decline, `moderator gate` again, push, hand back `fixed in <sha>` / `declined: <why>` per finding.

## Ending your message

The last thing in your message is one of these, with nothing after it.

Hand-back:

```
HANDBACK
{"status":"done","issue":"ABC-123","branch":"wt/ABC-123-x","pr":87,"scope":["<package>"],"gate":"a1b2c3d4e5f6","tests":"added 3 (apps/app/src/screens/game/__tests__/Lobby.test.tsx)","review":{"findings":2,"fixed":2,"declined":0,"declinedWhy":""},"notes":"","papercuts":["scope: apps/app/src/theme/** matched no e2e rule but changes every screen"]}
```

- `status`: `done`, `blocked` (could not finish; say what in `notes`), `partial` (turn limit; `notes` says exactly where you stopped and the next step).
- `gate`: the tree hash from your last GREEN gate line.
- `tests`: `added N (path)`, `updated N`, or `n/a: <reason>`.
- `papercuts`: one line each, `category: text -> fix`. Categories: gate, scope, protocol, repo, flake. Empty array if none.
- `notes`: one line, only what the parent must know. Not a summary of your work; the PR has that.

Escalations:

```
BLOCKED: <one line: what is outside your reach>
NEEDS DECISION: <question> | options: A / B | recommend: A because <one line>
```

A stop hook checks all of this, re-runs the gate, and when Jev is configured asks it, per acceptance criterion, whether the diff delivers it with a test. A criterion Jev reads as missing comes back to you as a block. If it blocks you, its message is the reason; fix it and end again. After three blocks it lets you through as `blocked`.

## Never

Push to main. Force push. Edit the repo's protected paths (`protectedPaths` in `moderator.config.json`). Post to Linear. Spawn a second reviewer to get a kinder one.

A test asserts correct behaviour and is never altered to pass buggy behaviour; a failing test means fix the code, or prove the test wrong, never loosen, skip or re-baseline it to get green.
