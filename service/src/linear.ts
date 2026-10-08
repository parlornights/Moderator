import { LinearClient } from '@linear/sdk';

export interface IssueInput {
  /** Optional client UUID: a retry with the same id returns the issue the first call made. */
  id?: string;
  team: string;
  title: string;
  description: string;
  project?: string;
  parent?: string;
}

export interface IssuePatch {
  title?: string;
  description?: string;
  status?: string;
  priority?: number;
  addLabels?: string[];
  removeLabels?: string[];
  links?: { url: string; title: string }[];
}

export interface Ref {
  id: string;
  url: string;
}

/** The parts of an issue written before a moment; whatever changed at or after it is left out. */
export interface Ticket {
  id: string;
  title?: string;
  description?: string;
  comments: string[];
}

export interface Linear {
  /** The issue's text as it stood before `before`; null when the issue does not exist or nothing predates it. */
  ticketBefore(id: string, before: Date): Promise<Ticket | null>;
  createIssue(i: IssueInput): Promise<Ref>;
  updateIssue(id: string, p: IssuePatch): Promise<Ref>;
  /** `id`: optional client UUID; a retry with the same id returns the comment the first call made. */
  comment(issue: string, body: string, id?: string): Promise<Ref>;
}

/** A team, project, status or label the caller named does not exist. */
export class NotFound extends Error {}

const one = <T>(nodes: T[], what: string): T => {
  if (!nodes[0]) throw new NotFound(`${what} not found`);
  return nodes[0];
};

const TICKET_QUERY = `query Ticket($id: String!) {
  issue(id: $id) {
    identifier title description createdAt
    history(first: 250) { nodes { createdAt updatedDescription toTitle } pageInfo { hasNextPage } }
    comments(first: 250) { nodes { body createdAt editedAt } }
  }
}`;

interface TicketQuery {
  issue: {
    identifier: string;
    title: string;
    description: string | null;
    createdAt: string;
    history: { nodes: { createdAt: string; updatedDescription: boolean | null; toTitle: string | null }[]; pageInfo: { hasNextPage: boolean } };
    comments: { nodes: { body: string; createdAt: string; editedAt: string | null }[] };
  };
}

export function linear(apiKey: string): Linear {
  const c = new LinearClient({ apiKey });

  // A label belongs to the issue's team or to the whole workspace; names can repeat across teams.
  const labelIds = async (teamId: string, names: string[] = []) => {
    if (!names.length) return undefined;
    const labels = (await c.issueLabels({ filter: { name: { in: names }, or: [{ team: { id: { eq: teamId } } }, { team: { null: true } }] } })).nodes;
    const missing = names.filter((n) => !labels.some((l) => l.name === n));
    if (missing.length) throw new NotFound(`label ${missing.join(', ')} not found`);
    return labels.map((l) => l.id);
  };

  return {
    async ticketBefore(id, before) {
      let issue: TicketQuery['issue'];
      try {
        issue = (await c.client.rawRequest<TicketQuery, { id: string }>(TICKET_QUERY, { id })).data!.issue;
      } catch (e) {
        if (e instanceof Error && /not found/i.test(e.message)) return null;
        throw e;
      }
      const changed = (pick: (h: TicketQuery['issue']['history']['nodes'][number]) => boolean) =>
        // A history longer than one page cannot be read in full, so nothing in it counts.
        issue.history.pageInfo.hasNextPage ? Infinity : Math.max(Date.parse(issue.createdAt), ...issue.history.nodes.filter(pick).map((h) => Date.parse(h.createdAt)));
      const t = before.getTime();
      const ticket: Ticket = {
        id: issue.identifier,
        title: changed((h) => h.toTitle != null) < t ? issue.title : undefined,
        description: changed((h) => !!h.updatedDescription) < t ? (issue.description ?? '') : undefined,
        comments: issue.comments.nodes.filter((n) => Date.parse(n.editedAt ?? n.createdAt) < t).map((n) => n.body),
      };
      return ticket.title === undefined && ticket.description === undefined && !ticket.comments.length ? null : ticket;
    },

    async createIssue(i) {
      const team = one((await c.teams({ filter: { key: { eqIgnoreCase: i.team } } })).nodes, `team ${i.team}`);
      const projectId = i.project
        ? one((await c.projects({ filter: { name: { eqIgnoreCase: i.project }, accessibleTeams: { some: { id: { eq: team.id } } } } })).nodes, `project ${i.project}`).id
        : undefined;
      const parentId = i.parent ? (await c.issue(i.parent)).id : undefined;
      try {
        const issue = await (await c.createIssue({ id: i.id, teamId: team.id, title: i.title, description: i.description, projectId, parentId })).issue;
        if (!issue) throw new Error('Linear created no issue');
        return { id: issue.identifier, url: issue.url };
      } catch (e) {
        if (!i.id) throw e;
        const existing = await c.issue(i.id).catch(() => null);
        if (!existing) throw e;
        return { id: existing.identifier, url: existing.url };
      }
    },

    async updateIssue(id, p) {
      const issue = await c.issue(id);
      const team = await issue.team;
      if (!team) throw new Error(`issue ${id} has no team`);
      const stateId = p.status ? one((await team.states({ filter: { name: { eqIgnoreCase: p.status } } })).nodes, `status ${p.status}`).id : undefined;
      await c.updateIssue(issue.id, {
        title: p.title,
        description: p.description,
        priority: p.priority,
        stateId,
        addedLabelIds: await labelIds(team.id, p.addLabels),
        removedLabelIds: await labelIds(team.id, p.removeLabels),
      });
      try {
        for (const l of p.links ?? []) await c.attachmentLinkURL(issue.id, l.url, { title: l.title });
      } catch (e) {
        throw new Error(`issue ${issue.identifier} was updated, but adding a link failed: ${e instanceof Error ? e.message : e}`);
      }
      return { id: issue.identifier, url: issue.url };
    },

    async comment(id, body, commentId) {
      const issue = await c.issue(id);
      try {
        const comment = await (await c.createComment({ id: commentId, issueId: issue.id, body })).comment;
        if (!comment) throw new Error('Linear created no comment');
        return { id: comment.id, url: comment.url };
      } catch (e) {
        if (!commentId) throw e;
        const existing = await c.comment({ id: commentId }).catch(() => null);
        if (!existing) throw e;
        return { id: existing.id, url: existing.url };
      }
    },
  };
}
