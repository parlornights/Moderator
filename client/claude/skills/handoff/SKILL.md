---
name: handoff
description: The onboarding note at .work/<ISSUE>/handoff.md - what each section holds, when to update it, what the hooks write for you. Use when the Stop hook says the note is stale, after a NEEDS DECISION is answered, and whenever you decide something a fresh session could not infer from the code.
---

# Handoff note

A new session (fresh VM, from a phone, after compaction) reads this before its first turn. Write it for someone with no memory of this conversation and the code in front of them.

## Sections you own (keep under 60 lines total)

- `status:` line at the top: `in-progress`, `blocked`, or `done`.
- **Goal**: one paragraph, what done looks like. Copy the ticket's intent, not its title.
- **Criteria**: the acceptance criteria as checkboxes. Tick as they land. A ticked box is a claim the gate backs.
- **Decisions**: one line each, `what - why`. Owner answers go here verbatim with "(owner)".
- **In flight**: what is half done right now, in which files. Empty when nothing is.
- **Next step**: one action. "Resume unit with CI output", "Ask owner about X", "Merge #87". Never a list.
- **Known failures**: flaky tests by name, blocked items.
- **Open questions**: every question waiting on the owner, in this exact shape (the Stop hook checks it, and checks that your last message repeats each one in full):

  ```
  ## Open questions
  - Q1: <one clear question>
    - A: <option, and what it leads to>
    - B: <option, and what it leads to>
    - Recommend: A, because <reason>
  ```

  Remove a question the moment it is answered and record the answer under Decisions.

## What the hooks write (do not edit)

The auto block between `<!-- auto:start -->` and `<!-- auto:end -->`: timestamp, branch and head, uncommitted files, recent commits, last gate result, and the last 25 turns of the conversation captured before compaction. A fresh session reads those turns as "what was just happening".

## When

- The Stop hook blocks once when code commits are newer than the committed note or "Next step" is empty. Update, then stop again; it commits and pushes.
- PreCompact refreshes the auto block and commits the note by itself.
- `moderator handoff --print` shows it; `moderator handoff --stale` says why it is stale.

## Style

Facts. No narrative of what you tried. If something failed and matters, it is one line under Known failures.
