import { LinearClient } from '@linear/sdk';

export interface IssueInput {
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

export interface Linear {
  createIssue(i: IssueInput): Promise<Ref>;
  updateIssue(id: string, p: IssuePatch): Promise<Ref>;
  comment(issue: string, body: string): Promise<Ref>;
}

const one = <T>(nodes: T[], what: string): T => {
  if (!nodes[0]) throw new Error(`${what} not found`);
  return nodes[0];
};

export function linear(apiKey: string): Linear {
  const c = new LinearClient({ apiKey });

  // A label belongs to the issue's team or to the whole workspace; names can repeat across teams.
  const labelIds = async (teamId: string, names: string[] = []) =>
    names.length
      ? (await c.issueLabels({ filter: { name: { in: names }, or: [{ team: { id: { eq: teamId } } }, { team: { null: true } }] } })).nodes.map((l) => l.id)
      : undefined;

  return {
    async createIssue(i) {
      const team = one((await c.teams({ filter: { key: { eqIgnoreCase: i.team } } })).nodes, `team ${i.team}`);
      const projectId = i.project ? one((await c.projects({ filter: { name: { eqIgnoreCase: i.project } } })).nodes, `project ${i.project}`).id : undefined;
      const parentId = i.parent ? (await c.issue(i.parent)).id : undefined;
      const issue = await (await c.createIssue({ teamId: team.id, title: i.title, description: i.description, projectId, parentId })).issue;
      if (!issue) throw new Error('Linear created no issue');
      return { id: issue.identifier, url: issue.url };
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
      for (const l of p.links ?? []) await c.attachmentLinkURL(issue.id, l.url, { title: l.title });
      return { id: issue.identifier, url: issue.url };
    },

    async comment(id, body) {
      const issue = await c.issue(id);
      const comment = await (await c.createComment({ issueId: issue.id, body })).comment;
      if (!comment) throw new Error('Linear created no comment');
      return { id: comment.id, url: comment.url };
    },
  };
}
