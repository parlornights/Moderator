import { afterEach, describe, expect, it, vi } from 'vitest';

import { linear } from '../src/linear';

interface Sent {
  query: string;
  variables: Record<string, unknown>;
}

/** Stands in for api.linear.app: answers each GraphQL operation by the first field it names. */
function fakeLinear(data: Record<string, unknown>) {
  const sent: Sent[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Sent;
    sent.push(body);
    // The operation's root field; the SDK puts fragment definitions before it.
    const field = body.query.match(/(?:query|mutation)\s+\w+[^{]*\{\s*(\w+)/)?.[1];
    if (!field || !(field in data)) throw new Error(`unexpected operation on ${field}`);
    return Response.json({ data: { [field]: data[field] } });
  });
  return sent;
}

const nodes = (...n: object[]) => ({ nodes: n, pageInfo: { hasNextPage: false, hasPreviousPage: false } });
const issue = { id: 'uuid-1', identifier: 'PAR-1', url: 'https://linear.app/x/PAR-1', team: { id: 'team-1' }, sharedAccess: { sharedWithUsers: [] }, reactions: [] };
const vars = (sent: Sent[], field: string) => sent.find((s) => new RegExp(`(?:query|mutation)\\s+\\w+[^{]*\\{\\s*${field}\\b`).test(s.query))?.variables;

afterEach(() => vi.restoreAllMocks());

describe('linear', () => {
  it('creates an issue in the team found by key', async () => {
    const sent = fakeLinear({ teams: nodes({ id: 'team-1', key: 'PAR' }), issueCreate: { success: true, issue: { id: 'uuid-1' } }, issue });
    expect(await linear('k').createIssue({ team: 'par', title: 'T', description: 'D' })).toEqual({ id: 'PAR-1', url: 'https://linear.app/x/PAR-1' });
    expect(vars(sent, 'teams')).toMatchObject({ filter: { key: { eqIgnoreCase: 'par' } } });
    expect(vars(sent, 'issueCreate')).toMatchObject({ input: { teamId: 'team-1', title: 'T', description: 'D' } });
  });

  it('updates status, labels and links within the issue team', async () => {
    const sent = fakeLinear({
      issue,
      team: { id: 'team-1', states: nodes({ id: 'state-done', name: 'Done' }) },
      issueLabels: nodes({ id: 'label-bug', name: 'Bug' }),
      issueUpdate: { success: true },
      attachmentLinkURL: { success: true },
    });
    await linear('k').updateIssue('PAR-1', { status: 'done', addLabels: ['Bug'], links: [{ url: 'https://e.com', title: 'E' }] });
    expect(vars(sent, 'issueLabels')).toMatchObject({ filter: { name: { in: ['Bug'] }, or: [{ team: { id: { eq: 'team-1' } } }, { team: { null: true } }] } });
    expect(vars(sent, 'issueUpdate')).toMatchObject({ id: 'uuid-1', input: { stateId: 'state-done', addedLabelIds: ['label-bug'] } });
    expect(vars(sent, 'attachmentLinkURL')).toMatchObject({ issueId: 'uuid-1', url: 'https://e.com', title: 'E' });
  });

  it('refuses a label or status that does not exist, before writing', async () => {
    const sent = fakeLinear({ issue, team: { id: 'team-1', states: nodes() }, issueLabels: nodes(), issueUpdate: { success: true } });
    await expect(linear('k').updateIssue('PAR-1', { addLabels: ['Bgu'] })).rejects.toThrow('label Bgu not found');
    await expect(linear('k').updateIssue('PAR-1', { status: 'Nope' })).rejects.toThrow('status Nope not found');
    expect(vars(sent, 'issueUpdate')).toBeUndefined();
  });

  it('comments on the issue', async () => {
    const sent = fakeLinear({ issue, commentCreate: { success: true, comment: { id: 'c1' } }, comment: { id: 'c1', url: 'https://linear.app/x/PAR-1#c1', reactions: [] } });
    expect(await linear('k').comment('PAR-1', 'Merged.')).toEqual({ id: 'c1', url: 'https://linear.app/x/PAR-1#c1' });
    expect(vars(sent, 'commentCreate')).toMatchObject({ input: { issueId: 'uuid-1', body: 'Merged.' } });
  });
});

describe('ticketBefore', () => {
  const at = (iso: string) => new Date(iso);
  const issueData = (over: object = {}) => ({
    identifier: 'PAR-1',
    title: 'T',
    description: 'D',
    createdAt: '2026-10-01T00:00:00Z',
    history: { nodes: [], pageInfo: { hasNextPage: false } },
    comments: { nodes: [] },
    ...over,
  });

  it('keeps the text written before the work began and drops what changed after', async () => {
    fakeLinear({
      issue: issueData({
        history: { nodes: [{ createdAt: '2026-10-05T00:00:00Z', updatedDescription: true, toTitle: null }], pageInfo: { hasNextPage: false } },
        comments: { nodes: [{ body: 'old', createdAt: '2026-10-02T00:00:00Z', editedAt: null }, { body: 'new', createdAt: '2026-10-06T00:00:00Z', editedAt: null }, { body: 'edited', createdAt: '2026-10-02T00:00:00Z', editedAt: '2026-10-06T00:00:00Z' }] },
      }),
    });
    expect(await linear('k').ticketBefore('PAR-1', at('2026-10-04T00:00:00Z'))).toEqual({ id: 'PAR-1', title: 'T', description: undefined, comments: ['old'] });
  });

  it('is null when nothing predates the work, and counts nothing from a history it cannot read in full', async () => {
    fakeLinear({ issue: issueData({ createdAt: '2026-10-09T00:00:00Z' }) });
    expect(await linear('k').ticketBefore('PAR-1', at('2026-10-04T00:00:00Z'))).toBeNull();
    vi.restoreAllMocks();
    fakeLinear({ issue: issueData({ history: { nodes: [], pageInfo: { hasNextPage: true } } }) });
    expect(await linear('k').ticketBefore('PAR-1', at('2026-10-04T00:00:00Z'))).toBeNull();
  });
});

describe('idempotent creates', () => {
  it('passes the client id to Linear, and on a retry returns what the first call made', async () => {
    const sent = fakeLinear({ teams: nodes({ id: 'team-1', key: 'PAR' }), issueCreate: { success: true, issue: { id: 'uuid-1' } }, issue });
    await linear('k').createIssue({ id: 'uuid-1', team: 'PAR', title: 'T', description: 'D' });
    expect(vars(sent, 'issueCreate')).toMatchObject({ input: { id: 'uuid-1' } });
    vi.restoreAllMocks();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      const q = JSON.parse(String(init?.body)).query as string;
      if (/\{\s*teams\b/.test(q)) return Response.json({ data: { teams: nodes({ id: 'team-1', key: 'PAR' }) } });
      if (/\{\s*issueCreate\b/.test(q)) return Response.json({ errors: [{ message: 'Entity already exists', extensions: { type: 'invalid input' } }] });
      return Response.json({ data: { issue } });
    });
    expect(await linear('k').createIssue({ id: 'uuid-1', team: 'PAR', title: 'T', description: 'D' })).toEqual({ id: 'PAR-1', url: 'https://linear.app/x/PAR-1' });
  });
});
