// A stuck or finished unit is noticed within the hour: the transcript says which units run and what is armed, and
// what the session must do before it stops follows from that.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEAD_MINUTES, isPureWait, isWait, readSession, unitTodos } from '../src/units.js';

const T0 = Date.parse('2026-10-07T06:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const use = (min, id, name, input) => JSON.stringify({ timestamp: at(min), message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (min, id, agentId) =>
  JSON.stringify({ timestamp: at(min), message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: `Async agent launched.\nagentId: ${agentId} (internal ID)` }] }] } });
const notice = (min, agentId, status) =>
  JSON.stringify({ type: 'queue-operation', timestamp: at(min), content: `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>x</tool-use-id>\n<status>${status}</status>\n</task-notification>` });
const spawnUnit = (min, toolId, agentId, type = 'unit') => [use(min, toolId, 'Agent', { subagent_type: type, description: `job ${agentId}` }), result(min, toolId, agentId)];

test('a unit runs from its spawn until a final notice, and again after a message to it that did not fail', () => {
  const lines = [
    ...spawnUnit(0, 't1', 'aaa111'),
    ...spawnUnit(1, 't2', 'bbb222', 'moderator:unit-deep'),
    use(2, 't3', 'Agent', { subagent_type: 'Explore', description: 'read' }),
    result(2, 't3', 'ccc333'),
    notice(30, 'aaa111', 'completed'),
    notice(31, 'bbb222', 'killed'),
    use(40, 't4', 'SendMessage', { to: 'aaa111', message: 'fix this' }),
    JSON.stringify({ timestamp: at(40), message: { content: [{ type: 'tool_result', tool_use_id: 't4', content: 'queued' }] } }),
    use(41, 't5', 'SendMessage', { to: 'bbb222', message: 'are you there' }),
    JSON.stringify({ timestamp: at(41), message: { content: [{ type: 'tool_result', tool_use_id: 't5', is_error: true, content: 'no such agent' }] } }),
  ];
  const { units } = readSession(lines);
  assert.deepEqual(
    units.map((u) => [u.id, u.type, u.running]),
    [
      ['aaa111', 'unit', true],
      ['bbb222', 'moderator:unit-deep', false],
    ],
  );
});

test('check-ins and watched PRs are read from the calls', () => {
  const lines = [
    use(0, 's1', 'mcp__claude-code-remote__send_later', { delay_minutes: 45, message: 'check' }),
    use(5, 's2', 'mcp__claude-code-remote__send_later', { at: '2026-10-07T09:00:00Z', message: 'check' }),
    use(6, 's3', 'mcp__claude-code-remote__subscribe_pr_activity', { owner: 'o', repo: 'r', pullNumber: 229 }),
    use(7, 's4', 'mcp__claude-code-remote__subscribe_pr_activity', { owner: 'o', repo: 'r', pullNumber: 225 }),
    use(8, 's5', 'mcp__claude-code-remote__unsubscribe_pr_activity', { owner: 'o', repo: 'r', pullNumber: 225 }),
  ];
  const s = readSession(lines);
  assert.deepEqual(s.checkIns, [T0 + 45 * 60_000, Date.parse('2026-10-07T09:00:00Z')]);
  assert.deepEqual([...s.watched], [229]);
});

const running = (over = {}) => ({ id: 'abcdef123', type: 'unit', description: 'wave 1b', started: T0, running: true, idleMin: 2, ...over });

test('no running unit, nothing to do', () => {
  assert.deepEqual(unitTodos({ units: [running({ running: false })], checkIns: [], watched: new Set() }, T0), []);
});

test('a running unit without an armed check-in holds the stop', () => {
  const todo = unitTodos({ units: [running()], checkIns: [T0 - 1], watched: new Set() }, T0);
  assert.equal(todo.length, 1);
  assert.match(todo[0], /send_later.*moderator unit-watch/);
  assert.deepEqual(unitTodos({ units: [running()], checkIns: [T0 + 1], watched: new Set() }, T0), []);
});

test('an open PR not watched, a merged PR, and a long idle are each named', () => {
  const s = (u, watched = []) => unitTodos({ units: [running(u)], checkIns: [T0 + 1], watched: new Set(watched) }, T0);
  assert.match(s({ pr: { number: 229, state: 'open', merged: false } }).join(), /subscribe_pr_activity for it/);
  assert.deepEqual(s({ pr: { number: 229, state: 'open', merged: false } }, [229]), []);
  assert.match(s({ pr: { number: 225, state: 'closed', merged: true } }, [225]).join(), /already merged; stop the unit/);
  assert.match(s({ pr: { number: 225, state: 'closed', merged: false } }, [225]).join(), /is closed/);
  assert.match(s({ idleMin: 25 }).join(), /done nothing for 25 min/);
  assert.deepEqual(s({ idleMin: 5 }), []);
});

test('a unit silent for hours died without a notice: it holds nothing, so a dead unit never blocks every stop', () => {
  assert.deepEqual(unitTodos({ units: [running({ idleMin: DEAD_MINUTES })], checkIns: [], watched: new Set() }, T0), []);
});

test('an open watched PR needs a check-in even with no unit running, and its merge conflict is named', () => {
  const open = (over = {}) => ({ number: 237, state: 'open', merged: false, mergeable: 'clean', ...over });
  const none = { units: [], watched: new Set([237]) };
  assert.match(unitTodos({ ...none, checkIns: [], prs: [open()] }, T0).join(), /watched PR #237 is open and no check-in is armed/);
  assert.deepEqual(unitTodos({ ...none, checkIns: [T0 + 1], prs: [open()] }, T0), []);
  assert.match(unitTodos({ ...none, checkIns: [T0 + 1], prs: [open({ mergeable: 'dirty' })] }, T0).join(), /#237 has a merge conflict/);
  assert.deepEqual(unitTodos({ ...none, checkIns: [], prs: [open({ state: 'closed', merged: true })] }, T0), []);
});

test("a conflict on a PR whose unit is running is the unit's, so it holds nothing", () => {
  const pr = { number: 237, state: 'open', merged: false, mergeable: 'dirty' };
  const unit = running({ pr: { number: 237, state: 'open', merged: false } });
  assert.deepEqual(unitTodos({ units: [unit], watched: new Set([237]), checkIns: [T0 + 1], prs: [pr] }, T0), []);
});

test('a wait is a sleep or a sleeping loop; quoted text and other work are told apart', () => {
  const cases = [
    ['pnpm gate', false, false],
    ['sleep 30', true, true],
    ['sleep 90s', true, true],
    ["timeout 590 bash -c 'while kill -0 6729 2>/dev/null; do sleep 15; done'", true, true],
    ['ps -p 6729 >/dev/null && echo still || echo gone; sleep 60', true, true],
    ['until curl -s localhost:4173; do sleep 1; done; pnpm e2e', true, false],
    ['while (echo > /dev/tcp/127.0.0.1/4173) 2>/dev/null; do sleep 15; done; date; cd /x && pnpm gate', true, false],
    ['git commit -m "retry until up; do not sleep"', false, false],
    ["cat <<'EOF' > notes.md\nwhile x; do sleep 1; done\nEOF", false, false],
    ['curl --connect-timeout 5 https://x', false, false],
    ['echo waiting; sleep 60', true, true],
    ['echo starting && pnpm dev & sleep 5; pnpm e2e', true, false],
  ];
  for (const [cmd, wait, pure] of cases) {
    assert.equal(isWait(cmd), wait, `isWait: ${cmd}`);
    assert.equal(isPureWait(cmd), pure, `isPureWait: ${cmd}`);
  }
});

test("the README's SubagentStart and SubagentStop matchers pick the same agents as isUnitType", async () => {
  const { isUnitType } = await import('../src/units.js');
  const readme = (await import('node:fs')).readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const hooks = JSON.parse(readme.match(/```json\n(\{\n {2}"hooks"[\s\S]*?)\n```/)[1]).hooks;
  for (const event of ['SubagentStart', 'SubagentStop']) {
    const matcher = new RegExp(hooks[event][0].matcher);
    for (const type of ['unit', 'unit-deep', 'moderator:unit', 'acme:unit-deep', 'reviewer', 'Explore', 'community-unit', 'unit2', 'moderator:reviewer']) {
      assert.equal(matcher.test(type), isUnitType(type), `${event} ${type}`);
    }
  }
});

test('every test-integrity approval waiting on the owner must be in the last message, link by link', async () => {
  const { approvalTodos } = await import('../src/units.js');
  const prs = [
    { number: 244, state: 'open', merged: false, approval: 'https://moderator.parlornights.com/approve/parlornights/CrookedDuke/244/abc' },
    { number: 229, state: 'open', merged: false, approval: null },
    { number: 251, state: 'open', merged: false, approval: 'https://moderator.parlornights.com/approve/parlornights/CrookedDuke/251/def' },
  ];
  const todo = approvalTodos({ units: [], checkIns: [], watched: new Set(), prs }, 'Please approve #244: https://moderator.parlornights.com/approve/parlornights/CrookedDuke/244/abc');
  assert.equal(todo.length, 1);
  assert.match(todo[0], /#251 https:\/\/moderator\.parlornights\.com\/approve\/parlornights\/CrookedDuke\/251\/def/);
  assert.doesNotMatch(todo[0], /#244|#229/);
  assert.deepEqual(approvalTodos({ units: [], checkIns: [], watched: new Set(), prs: prs.slice(1, 2) }, ''), []);
});

test('a session that handed over is not held to re-arm check-ins for the PRs it watched', () => {
  const open = { number: 244, state: 'open', merged: false, mergeable: 'clean' };
  const session = { units: [], checkIns: [], watched: new Set([244]), prs: [open] };
  assert.equal(unitTodos(session, T0).length, 1);
  assert.deepEqual(unitTodos(session, T0, { handedOver: true }), []);
  assert.equal(unitTodos({ ...session, units: [running()] }, T0, { handedOver: true }).length, 1, 'a running unit still needs its check-in');
});
