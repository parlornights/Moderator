#!/usr/bin/env bash
# SessionStart: `moderator hook session-start`, once the client is installed. Claude Code starts a repository's
# SessionStart hooks in parallel, so in a fresh container this runs while the repository's own install step is still
# installing the client. It waits until the client loads (`moderator ready`), at most MODERATOR_INSTALL_WAIT seconds of
# wall time (120 by default), then runs the hook with the input Claude Code gave it. When the client never loads, the
# session starts without its context and the user is told in one line, with the last failed probe's error line (its
# first line naming an error, else its first line). At startup it also waits while node_modules was installed from
# another pnpm-lock.yaml (pnpm keeps a copy in node_modules/.pnpm/lock.yaml), so a cached environment's older client
# never runs before the reinstall; if no reinstall comes within the wait, the installed client runs.
# `moderator sync` writes this file into .claude/hooks/; change it in Moderator, never in a repository's copy.

input=$(cat)
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
bin="$dir/node_modules/@parlornights/moderator/bin/moderator.js"
node=(node --disable-warning=UNDICI-EHPA)
limit=${MODERATOR_INSTALL_WAIT:-120}
startup=0
grep -Eq '"source"[[:space:]]*:[[:space:]]*"startup"' <<<"$input" && startup=1
stale() {
  ((startup)) && [[ -f "$dir/node_modules/.pnpm/lock.yaml" && -f "$dir/pnpm-lock.yaml" ]] &&
    ! cmp -s "$dir/node_modules/.pnpm/lock.yaml" "$dir/pnpm-lock.yaml"
}
SECONDS=0
until why=$("${node[@]}" "$bin" ready 2>&1 >/dev/null) && ! stale; do
  if ((SECONDS >= limit)); then
    "${node[@]}" "$bin" ready >/dev/null 2>&1 && break
    why=$({ printf '%s\n' "$why" | grep -m 1 -E 'Error' || printf '%s\n' "${why:-no output}" | head -n 1; } | cut -c 1-200 | sed 's/[\\"]/\\&/g; s/[[:cntrl:]]//g')
    printf '{"systemMessage":"moderator: the client did not load within %s s of the session start (%s), so the session has no start context. Run moderator orient once it is installed."}\n' "$limit" "$why"
    exit 0
  fi
  sleep 1
done
printf '%s' "$input" | "${node[@]}" "$bin" hook session-start "$@"
