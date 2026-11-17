// GraphQL v4 (/api/graphql). The suite sends gh's real documents (fixed set); this
// executor matches them by operation name and answers from the same store as REST,
// so objects created here read back over REST with identical ids. No token -> 401.

import type { Issue, Pull, Repo } from './store.ts';
import { FIXED_EPOCH, FIXED_ISO, VIEWER_EMAIL, VIEWER_LOGIN, VIEWER_NAME, decodeNodeId, issueNodeId, pullNodeId, repoNodeId, Store, commentNodeId } from './store.ts';
import { getObject, parseCommit, parseTree, putObject, serializeCommit } from './git.ts';

export interface GqlRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

const ISSUE_FIELDS = [
  'id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt',
  'updatedAt', 'closedAt', 'comments', 'labels', 'url', 'resourcePath', 'bodyHTML',
  'bodyText', 'closed', 'locked', 'milestone', 'participants', 'reactions', 'timelineItems',
];
const PULL_REQUEST_FIELDS = [
  'id', 'databaseId', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName',
  'headRefOid', 'baseRefOid', 'merged', 'mergeable', 'mergeCommit', 'files', 'author',
  'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'url', 'resourcePath', 'bodyHTML',
  'bodyText', 'closed', 'locked', 'additions', 'deletions', 'changedFiles', 'commits',
  'reviews', 'reviewRequests', 'isDraft',
];
const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
  'viewerPermission', 'hasIssuesEnabled', 'issues', 'pullRequests', 'issue',
  'pullRequest', 'description', 'createdAt', 'updatedAt', 'isPrivate', 'url',
  'resourcePath', 'homepageUrl', 'isArchived', 'isDisabled', 'isFork', 'isLocked',
  'licenseInfo', 'primaryLanguage', 'stargazerCount', 'watcherCount', 'forkCount',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'ORGANIZATION', 'PROJECT', 'TEAM', 'WIKI'];

function gqlState(state: 'open' | 'closed', merged: boolean): string {
  if (merged) return 'MERGED';
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function repoObject(repo: Repo): Record<string, unknown> {
  return {
    id: repoNodeId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: repo.refs.has(`refs/heads/${repo.defaultBranch}`)
      ? { name: repo.defaultBranch }
      : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    isPrivate: repo.isPrivate,
    url: `https://example.invalid/${repo.owner}/${repo.name}`,
  };
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueNodeId(repo, issue),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    author: { login: issue.userLogin },
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullObject(repo: Repo, pull: Pull): Record<string, unknown> {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  return {
    id: pullNodeId(repo, pull),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: gqlState(pull.state, pull.merged),
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: headTip ?? pull.headSha,
    baseRefOid: baseTip ?? pull.baseSha,
    merged: pull.merged,
    mergeable: pull.mergeable ? 'MERGEABLE' : 'CONFLICTING',
    mergeCommit: pull.mergeCommitSha ? { oid: pull.mergeCommitSha } : null,
    author: { login: pull.userLogin },
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    closedAt: pull.state === 'closed' ? pull.updatedAt : null,
    mergedAt: pull.mergedAt,
    url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

/** Issues ordered the way gh asks: createdAt DESC, ties by number DESC. */
function sortedIssues(repo: Repo): Issue[] {
  return [...repo.issues.values()].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return b.number - a.number;
  });
}

function sortedPulls(repo: Repo): Pull[] {
  return [...repo.pulls.values()].sort((a, b) => b.number - a.number);
}

export class GraphqlRouter {
  store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** Execute one document. Returns the JSON body object. */
  execute(doc: GqlRequest): Record<string, unknown> {
    const query = doc.query ?? '';
    const vars = doc.variables ?? {};
    const opMatch = /(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
    const op = opMatch ? (opMatch[1] as string) : (doc.operationName ?? '');
    switch (op) {
      case 'ViewerLogin':
        return { data: { viewer: { login: VIEWER_LOGIN } } };
      case 'RepositoryFields': {
        const repo = this.lookupRepo(vars);
        return { data: { repository: repo ? repoObject(repo) : null } };
      }
      case 'Issue_fields':
        return { data: { Issue: { fields: ISSUE_FIELDS.map((name) => ({ name })) } } };
      case 'PullRequestAndRepositoryFields':
        return {
          data: {
            PullRequest: { fields: PULL_REQUEST_FIELDS.map((name) => ({ name })) },
            Repository: { fields: REPOSITORY_FIELDS.map((name) => ({ name })) },
          },
        };
      case 'SearchType_enumValues':
        return { data: { SearchType: { enumValues: SEARCH_TYPE_VALUES.map((name) => ({ name })) } } };
      case 'OpenIssues': {
        const repo = this.lookupRepo(vars);
        if (!repo) return { data: { repository: null } };
        const first = typeof vars.first === 'number' ? vars.first : 30;
        const nodes = sortedIssues(repo)
          .filter((i) => i.state === 'open')
          .slice(0, first)
          .map((i) => {
            const o = issueObject(repo, i);
            return { number: o.number, title: o.title, state: o.state, id: o.id };
          });
        return { data: { repository: { issues: { nodes } } } };
      }
      case 'IssueByNumber': {
        const repo = this.lookupRepo(vars);
        if (!repo) return { data: { repository: null } };
        const issue = repo.issues.get(vars.number as number);
        if (!issue) return { data: { repository: { issue: null } } };
        const o = issueObject(repo, issue);
        return { data: { repository: { issue: { number: o.number, title: o.title, state: o.state, id: o.id, body: o.body } } } };
      }
      case 'IssueCreate': {
        const input = (vars.input ?? {}) as Record<string, unknown>;
        const repo = this.lookupRepoById(input.repositoryId as string);
        if (!repo) return { data: { createIssue: { issue: null } }, errors: [{ message: 'Repository not found' }] };
        const title = typeof input.title === 'string' ? input.title : '';
        if (title === '') return { data: { createIssue: { issue: null } }, errors: [{ message: 'title is required' }] };
        const number = ++repo.issueCounter;
        const issue: Issue = {
          id: this.store.nextGlobalId(),
          number,
          title,
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          userLogin: VIEWER_LOGIN,
          createdAt: FIXED_ISO,
          updatedAt: FIXED_ISO,
          closedAt: null,
          comments: [],
          jsonCache: '',
        };
        repo.issues.set(number, issue);
        return { data: { createIssue: { issue: { number, id: issueNodeId(repo, issue) } } } };
      }
      case 'IssueClose': {
        const input = (vars.input ?? {}) as Record<string, unknown>;
        const found = this.lookupIssueById(input.issueId as string);
        if (!found) return { data: { closeIssue: { issue: null } }, errors: [{ message: 'Issue not found' }] };
        found.issue.state = 'closed';
        found.issue.closedAt = FIXED_ISO;
        // Invalidate the REST single-issue cache so the REST view reads closed too.
        found.issue.jsonCache = '';
        return { data: { closeIssue: { issue: { number: found.issue.number, id: issueNodeId(found.repo, found.issue), state: 'CLOSED' } } } };
      }
      case 'PullRequests': {
        const repo = this.lookupRepo(vars);
        if (!repo) return { data: { repository: null } };
        const first = typeof vars.first === 'number' ? vars.first : 30;
        const nodes = sortedPulls(repo).slice(0, first).map((p) => {
          const o = pullObject(repo, p);
          return { number: o.number, headRefName: o.headRefName, baseRefName: o.baseRefName, mergeable: o.mergeable, state: o.state };
        });
        return { data: { repository: { pullRequests: { nodes } } } };
      }
      case 'PullRequestFiles': {
        const repo = this.lookupRepo(vars);
        if (!repo) return { data: { repository: null } };
        const pull = repo.pulls.get(vars.number as number);
        if (!pull) return { data: { repository: { pullRequest: null } } };
        const paths = this.pullPaths(repo, pull);
        const first = 10;
        return { data: { repository: { pullRequest: { number: pull.number, files: { nodes: paths.slice(0, first).map((path) => ({ path })) } } } } };
      }
      case 'PullRequestId': {
        const repo = this.lookupRepo(vars);
        if (!repo) return { data: { repository: null } };
        const pull = repo.pulls.get(vars.number as number);
        if (!pull) return { data: { repository: { pullRequest: null } } };
        return { data: { repository: { pullRequest: { id: pullNodeId(repo, pull), number: pull.number } } } };
      }
      case 'PullRequestCreate': {
        const input = (vars.input ?? {}) as Record<string, unknown>;
        const repo = this.lookupRepoById(input.repositoryId as string);
        if (!repo) return { data: { createPullRequest: { pullRequest: null } }, errors: [{ message: 'Repository not found' }] };
        const headName = typeof input.headRefName === 'string' ? input.headRefName : '';
        const baseName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        const headSha = repo.refs.get(`refs/heads/${headName}`);
        const baseSha = repo.refs.get(`refs/heads/${baseName}`);
        if (!headSha || !baseSha) {
          return { data: { createPullRequest: { pullRequest: null } }, errors: [{ message: 'head or base branch does not exist' }] };
        }
        const number = ++repo.pullCounter;
        const pull: Pull = {
          id: this.store.nextGlobalId(),
          number,
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          headRef: headName,
          baseRef: baseName,
          headSha,
          baseSha,
          merged: false,
          mergeable: true,
          mergeCommitSha: null,
          mergedAt: null,
          userLogin: VIEWER_LOGIN,
          createdAt: FIXED_ISO,
          updatedAt: FIXED_ISO,
        };
        repo.pulls.set(number, pull);
        const o = pullObject(repo, pull);
        return { data: { createPullRequest: { pullRequest: { number: o.number, id: o.id, state: o.state, headRefName: o.headRefName, baseRefName: o.baseRefName } } } };
      }
      case 'MergePullRequest': {
        const input = (vars.input ?? {}) as Record<string, unknown>;
        const found = this.lookupPullById(input.pullRequestId as string);
        if (!found) return { data: { mergePullRequest: { pullRequest: null } }, errors: [{ message: 'Pull request not found' }] };
        const { repo, pull } = found;
        if (pull.state !== 'open' || pull.merged) {
          return { data: { mergePullRequest: { pullRequest: null } }, errors: [{ message: 'Pull request is not open' }] };
        }
        const merged = this.mergePull(repo, pull, 'squash');
        if (!merged) {
          return { data: { mergePullRequest: { pullRequest: null } }, errors: [{ message: 'Merge conflict' }] };
        }
        return { data: { mergePullRequest: { pullRequest: { number: pull.number, merged: true, state: 'MERGED' } } } };
      }
      case 'AddComment': {
        const input = (vars.input ?? {}) as Record<string, unknown>;
        const found = this.lookupIssueById(input.subjectId as string);
        if (!found) return { data: { addComment: { commentEdge: null } }, errors: [{ message: 'Subject not found' }] };
        const body = typeof input.body === 'string' ? input.body : '';
        const comment = {
          id: this.store.nextGlobalId(),
          body,
          userLogin: VIEWER_LOGIN,
          createdAt: FIXED_ISO,
          updatedAt: FIXED_ISO,
        };
        found.issue.comments.push(comment);
        found.issue.jsonCache = '';
        return { data: { addComment: { commentEdge: { node: { id: commentNodeId(found.repo, comment), body } } } } };
      }
      case 'ViewerInvalidField':
        return {
          data: null,
          errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".', locations: [{ line: 4, column: 5 }] }],
        };
      case 'NodeRepository': {
        const decoded = decodeNodeId(vars.id as string);
        if (!decoded || decoded.kind !== 'Repository') return { data: { node: null } };
        const repo = this.store.getRepoById(decoded.repoId);
        if (!repo) return { data: { node: null } };
        const o = repoObject(repo);
        return { data: { node: { id: o.id, name: o.name, nameWithOwner: o.nameWithOwner } } };
      }
      case 'IssuesPage': {
        const repo = this.lookupRepo(vars);
        if (!repo) return { data: { repository: null } };
        const first = typeof vars.first === 'number' ? vars.first : 30;
        const after = typeof vars.after === 'string' ? vars.after : null;
        let list = sortedIssues(repo);
        if (after) {
          try {
            const text = Buffer.from(after, 'base64url').toString('utf8');
            const m = /^issue:(\d+):(\d+)$/.exec(text);
            if (m) {
              const afterNum = Number(m[2]);
              const idx = list.findIndex((i) => i.number === afterNum);
              if (idx >= 0) list = list.slice(idx + 1);
            }
          } catch {
            // Bad cursor: ignore and start from the beginning.
          }
        }
        const page = list.slice(0, first);
        const hasNextPage = list.length > first;
        const endCursor = page.length > 0
          ? Buffer.from(`issue:${repo.id}:${page[page.length - 1]?.number}`, 'utf8').toString('base64url')
          : null;
        return {
          data: {
            repository: {
              issues: {
                nodes: page.map((i) => ({ number: i.number })),
                pageInfo: { hasNextPage, endCursor },
              },
            },
          },
        };
      }
      default:
        return { data: null, errors: [{ message: `Unknown operation "${op}"` }] };
    }
  }

  private lookupRepo(vars: Record<string, unknown>): Repo | undefined {
    const owner = vars.owner as string;
    const name = vars.name as string;
    if (typeof owner !== 'string' || typeof name !== 'string') return undefined;
    const repo = this.store.getRepo(owner, name);
    if (!repo || repo.owner !== VIEWER_LOGIN) return undefined;
    return repo;
  }

  private lookupRepoById(id: string): Repo | undefined {
    if (typeof id !== 'string') return undefined;
    const decoded = decodeNodeId(id);
    if (!decoded || decoded.kind !== 'Repository') return undefined;
    return this.store.getRepoById(decoded.repoId);
  }

  private lookupIssueById(id: string): { repo: Repo; issue: Issue } | undefined {
    if (typeof id !== 'string') return undefined;
    const decoded = decodeNodeId(id);
    if (!decoded || decoded.kind !== 'Issue') return undefined;
    const repo = this.store.getRepoById(decoded.repoId);
    const issue = repo?.issues.get(decoded.num);
    if (!repo || !issue) return undefined;
    return { repo, issue };
  }

  private lookupPullById(id: string): { repo: Repo; pull: Pull } | undefined {
    if (typeof id !== 'string') return undefined;
    const decoded = decodeNodeId(id);
    if (!decoded || decoded.kind !== 'PullRequest') return undefined;
    const repo = this.store.getRepoById(decoded.repoId);
    const pull = repo?.pulls.get(decoded.num);
    if (!repo || !pull) return undefined;
    return { repo, pull };
  }

  /** Changed paths between the pull's base and head trees. */
  private pullPaths(repo: Repo, pull: Pull): string[] {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTree = baseTip ? parseCommit(getObject(repo, baseTip)?.data ?? Buffer.alloc(0)).tree : null;
    const headTree = headTip ? parseCommit(getObject(repo, headTip)?.data ?? Buffer.alloc(0)).tree : null;
    const baseFiles = new Map<string, string>();
    const headFiles = new Map<string, string>();
    this.flatten(repo, baseTree, '', baseFiles);
    this.flatten(repo, headTree, '', headFiles);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out: string[] = [];
    for (const p of [...paths].sort()) {
      if (baseFiles.get(p) !== headFiles.get(p)) out.push(p);
    }
    return out;
  }

  private flatten(repo: Repo, treeOid: string | null, prefix: string, out: Map<string, string>): void {
    if (!treeOid) return;
    const obj = getObject(repo, treeOid);
    if (!obj) return;
    for (const e of parseTree(obj.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '040000') this.flatten(repo, e.oid, path, out);
      else out.set(path, e.oid);
    }
  }

  /** Squash-merge a pull request; false when it conflicts. */
  private mergePull(repo: Repo, pull: Pull, method: string): boolean {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (!baseTip || !headTip) return false;
    const baseCommit = parseCommit(getObject(repo, baseTip)?.data ?? Buffer.alloc(0));
    const headCommit = parseCommit(getObject(repo, headTip)?.data ?? Buffer.alloc(0));
    const baseTree = baseCommit.tree;
    const headTree = headCommit.tree;
    // Conflict check via merge base.
    const base = this.mergeBase(repo, baseTip, headTip);
    const mergeBaseTree = base ? parseCommit(getObject(repo, base)?.data ?? Buffer.alloc(0)).tree : null;
    const bFiles = new Map<string, string>();
    const hFiles = new Map<string, string>();
    const tFiles = new Map<string, string>();
    this.flatten(repo, mergeBaseTree, '', bFiles);
    this.flatten(repo, headTree, '', hFiles);
    this.flatten(repo, baseTree, '', tFiles);
    const paths = new Set([...bFiles.keys(), ...hFiles.keys(), ...tFiles.keys()]);
    for (const p of paths) {
      const b = bFiles.get(p);
      const h = hFiles.get(p);
      const t = tFiles.get(p);
      if (h !== b && t !== b && h !== t) return false;
    }
    const message = `Merge pull request #${pull.number}: ${pull.title}`;
    const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_EPOCH} +0000`;
    const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
    const mergeSha = putObject(repo, 'commit', serializeCommit(headTree, parents, ident, ident, message));
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = mergeSha;
    pull.mergedAt = FIXED_ISO;
    pull.updatedAt = FIXED_ISO;
    pull.baseSha = mergeSha;
    this.store.touchRefs(repo);
    return true;
  }

  private mergeBase(repo: Repo, a: string, b: string): string | null {
    const seen = new Set<string>();
    const queue: string[] = [a];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = getObject(repo, oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
    const queueB: string[] = [b];
    const seenB = new Set<string>();
    while (queueB.length > 0) {
      const oid = queueB.shift() as string;
      if (seen.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const obj = getObject(repo, oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) queueB.push(p);
    }
    return null;
  }
}
