---
name: delegate
description: How the session agent runs a ticket - orient, build the context pack, brief a unit, handle the hand-back, queue the PR or escalate to the owner. Use at the start of any implementation task and whenever a unit reports back.
---

# Delegate

You are the expensive model. You judge the units' work and make the engineering calls inside the owner's limits. Product, business, platform and stack are the owner's calls, and design and legal need the owner's approval: there you bring options and a recommendation, and carry out the choice. Everything below keeps your context to script output and ten-line reports.

## 1. Orient

The SessionStart hook printed `orient`. If the handoff note says `status: in-progress`, continue from its "Next step" and skip to step 4. Otherwise pin the issue: say the id in your first message if the branch name does not carry it.

## 2. Context pack

Ask `Explore` (Haiku) one question: "List the files a change to <feature> must touch or read, with one line each why, max 15, plus the tests that cover them." Do not read those files yourself.

Write the acceptance criteria, one per line, to `.work/<ISSUE>/criteria.md`; the hand-back gate reads them. Write the brief (step 3 shape) to `.work/<ISSUE>/brief.md`, then:

```
moderator pick --issue <ISSUE> --file .work/<ISSUE>/brief.md
```

It prints `pick: unit` or `pick: unit-deep` from Jev's complexity and risk read of the brief, and `ASK THE OWNER` when the criteria leave a choice open. If it says ask, ask now, one question with options, before spending a unit on it. If Jev is unavailable it says so and defaults to `unit`; then you decide, and architectural or auth/data/infra tickets go to `unit-deep`.

## 3. Brief the unit

Spawn `unit` with this shape and nothing else:

```
Issue: ABC-123 <title>
Branch: <current branch>   (or: isolation worktree, if you run several units)
Acceptance criteria:
- <verbatim from the ticket, one per line>
Context pack:
- <path> - <why>
Scope hint: <packages/areas; what NOT to touch>
Out of scope: <explicit>
```

Spawn the agent the pick named (`unit` or `unit-deep`). One unit at a time on the session branch. Several independent tickets: pass `isolation: "worktree"` on each call, and expect a branch name per hand-back.

While it runs, do not read its files or re-plan. Answer the owner if they ask; otherwise wait for the completion notification. A unit that stalls sends no notice, so two things go with every spawn (the Stop hook holds you until both are done):

- **A check-in:** `send_later` with `delay_minutes: 45` and "Unit check-in: run moderator unit-watch and act on every flag; re-arm while units run". The report gives each running unit's idle time, branch and PR, and flags a merged PR, an unwatched PR and an idle unit.
- **A watched PR:** `subscribe_pr_activity` on the unit's PR once it exists (the brief names an existing one; the check-in finds a new one), so a merge, a CI result or a review wakes you.

## 4. Handle the hand-back

Read the HANDBACK block (the hook already validated it and re-ran the gate).

- `done`: the hook already re-ran the gate and, when Jev is configured, asked it per criterion whether the diff delivers it. Now the review, which is yours because a unit cannot spawn agents: run `reviewer` with the hand-back's `review.model` and `isolation: "worktree"`, naming the hand-back's `branch` and the criteria in its prompt (it reviews `origin/main...origin/<branch>`, never HEAD), post its output on the PR as one comment, verbatim (that comment is the review record). Findings to fix: resume the unit with them; it answers each with `fixed in <sha>` or `declined: <why>`, which you add to the record. Then check the PR's checks (`gh api repos/{owner}/{repo}/commits/<sha>/check-runs`; GitHub from a sandbox is REST only). Green, the record posted, no declined `blocking`: remove `.work/<issue>/` in one last commit, then queue the PR. Never merge it yourself: how a PR is queued or merged is the repo's own rule (its CLAUDE.md). A draft PR is marked ready first (`POST /repos/{owner}/{repo}/pulls/<n>/ccr/ready_for_review`). The merge wakes you. If CI disagrees with the gate, that is a papercut (`gate`), then resume the unit with the CI output: "Continue ABC-123: CI failed on <check>, output: <≤20 lines>".
- `partial`: resume the same unit (SendMessage) with "Continue from: <its notes>". Do not spawn a fresh one; it has the context.
- `blocked` or `BLOCKED:`: if you can clear it (a missing script, a wrong path), do that and resume the unit. If not, tell the owner in one line and stop.
- `NEEDS DECISION:`: record it under `## Open questions` in `.work/<issue>/handoff.md` in the Q shape (handoff skill), keeping the unit's question, options and recommendation, and end your message with it in full. The Stop hook checks both. Do not decide product questions yourself. When the answer comes, resume the unit with it and log the decision in `.work/<issue>/handoff.md` → Decisions.

`notes` and `papercuts` are the only free text you read. The hook already appended the papercuts to the papercut log.

## 5. Keep the note current

Before you stop, the Stop hook will ask if `.work/<issue>/handoff.md` is stale. Update "Next step", "Decisions", "Criteria" (tick what is done), set `status: done` when merged. Under 60 lines above the auto block. The hook then commits and pushes.

## What you never do

Read source files to "check" a unit. Run tests yourself (the gate did). Rewrite a unit's code. Merge a PR yourself, or queue one with a failing check. Edit `moderator.config.json` to make a gate pass; log it instead.
