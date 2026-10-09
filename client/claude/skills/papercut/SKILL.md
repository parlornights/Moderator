---
name: papercut
description: Log a learning to the papercut log (docs/papercuts.md unless moderator.config.json says otherwise) so the protocol can change - when a gate was wrong, a scope rule missed, a skill misled, a command was missing, a test flaked. Use the moment it happens; the weekly consolidation turns these into edits.
---

# Papercut

A papercut is anything that cost time and should not have. One line, logged when it happens, not remembered for later.

Write it as a gap in the protocol, never as a lapse of an agent. "The agent forgot to link the design" is not a papercut; "nothing checks that a published design is linked on its issue -> a Stop-hook check" is.

```
moderator papercut <category> "<what went wrong> -> <suggested fix>"
```

Categories:

- `gate` - a check ran that should not have, or did not run that should have, or CI disagreed with the gate.
- `scope` - a rule in `moderator.config.json` is missing or wrong (an e2e project not mapped, a path wrongly global).
- `protocol` - a skill, agent prompt or CLAUDE.md line was wrong, unclear or missing.
- `repo` - the repo map lacked a path, a command, a convention; a package has no `typecheck` or `test` script.
- `flake` - a test failed without a code cause. Name the test.

Good: `moderator papercut scope "apps/app/src/theme/** changed and no e2e ran, but it touches every screen -> map theme/** to e2e: all"`.
Bad: "tests were annoying".

Units cannot edit the ledger; they put the same line in the `papercuts` array of their hand-back and the hook appends it.

The weekly consolidation (`moderator papercut --list`, then edits, then `moderator papercut --mark`) is the only thing that changes the protocol from these. Do not edit `.claude/`, `moderator.config.json` or the protocol's rules mid-task to make something pass.
