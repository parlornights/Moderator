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
