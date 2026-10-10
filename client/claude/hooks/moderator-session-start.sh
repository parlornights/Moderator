#!/usr/bin/env bash
# SessionStart: `moderator hook session-start`, once the client is installed. Claude Code starts a repository's
# SessionStart hooks in parallel, so in a fresh container this runs while the repository's own install step is still
# installing the client. It waits until the client loads (`moderator ready`), at most MODERATOR_INSTALL_WAIT seconds
# (120 by default), then runs the hook with the input Claude Code gave it. When the client never loads, the session
# starts without its context and the user is told in one line.
# `moderator sync` writes this file into .claude/hooks/; change it in Moderator, never in a repository's copy.

input=$(cat)
bin="${CLAUDE_PROJECT_DIR:-$PWD}/node_modules/@parlornights/moderator/bin/moderator.js"
node=(node --disable-warning=UNDICI-EHPA)
limit=${MODERATOR_INSTALL_WAIT:-120}
waited=0
until "${node[@]}" "$bin" ready >/dev/null 2>&1; do
  if ((waited >= limit)); then
    printf '{"systemMessage":"moderator: the client did not load within %s s of the session start (is it installed?), so the session has no start context. Run moderator orient once it is installed."}\n' "$limit"
    exit 0
  fi
  sleep 1
  waited=$((waited + 1))
done
printf '%s' "$input" | "${node[@]}" "$bin" hook session-start "$@"
