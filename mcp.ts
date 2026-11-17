// MCP (Model Context Protocol) over Streamable HTTP at POST /mcp.
// Modern era (2026-07-28): server/discover is mandatory. Legacy: initialize +
// notifications/initialized + Mcp-Session-Id. tools/list is a precomputed constant
// so two calls are byte-identical. Tool results carry the same JSON shapes as REST.

import type { Issue, Pull, Repo } from './store.ts';
import { FIXED_EPOCH, FIXED_ISO, VIEWER_EMAIL, VIEWER_LOGIN, VIEWER_NAME, issueNodeId, pullNodeId, repoNodeId, Store } from './store.ts';
import { getObject, parseCommit, parseTree, putObject, serializeCommit } from './git.ts';
import { jsonResponse, type HttpRequest, type HttpResponse } from './rest.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SESSION_ID = 'session-1';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; items?: { type: string } }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
        labels: { type: 'array', description: 'Label names', items: { type: 'string' } },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'integer', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_comment',
    description: 'Add a comment to an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'integer', description: 'Issue number' },
        body: { type: 'string', description: 'Comment body' },
      },
      required: ['owner', 'repo', 'issue_number', 'body'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Pull request state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get one pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** The tools/list result, precomputed once so two calls are byte-identical. */
const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOLS });

function findTool(name: string): ToolDef | undefined {
  const lower = name.toLowerCase();
  return TOOLS.find((t) => t.name.toLowerCase() === lower);
}

function textResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export class McpRouter {
  store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  handle(req: HttpRequest): HttpResponse {
    if (req.method !== 'POST') return jsonResponse(405, { message: 'Method Not Allowed' });
    const auth = req.headers['authorization'] ?? '';
    if (!/^Bearer .+/.test(auth.trim())) {
      return jsonResponse(401, { message: 'Requires authentication' });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body.toString('utf8'));
    } catch {
      return jsonResponse(400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return jsonResponse(400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      });
    }
    const msg = parsed as Record<string, unknown>;
    const method = typeof msg.method === 'string' ? msg.method : '';
    const id = 'id' in msg ? msg.id : undefined;
    // Notifications get no JSON-RPC response (202, empty).
    if (method.startsWith('notifications/') || id === undefined) {
      return { status: 202, headers: {}, body: Buffer.alloc(0) };
    }
    const params = (msg.params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'server/discover': {
        const result = {
          supportedVersions: SUPPORTED_VERSIONS,
          protocolVersion: '2026-07-28',
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: { tools: {} },
        };
        return this.rpc(id, result, { 'mcp-session-id': SESSION_ID });
      }
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
        const result = {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        };
        return this.rpc(id, result, { 'mcp-session-id': SESSION_ID });
      }
      case 'ping':
        return this.rpc(id, {});
      case 'tools/list':
        return this.rpcRaw(id, TOOLS_LIST_JSON);
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (!findTool(name)) {
          return this.rpcError(id, -32601, `Unknown tool: ${name}`);
        }
        const result = this.callTool(name, args);
        return this.rpc(id, result);
      }
      default:
        return this.rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  private rpc(id: unknown, result: unknown, extraHeaders: Record<string, string> = {}): HttpResponse {
    return jsonResponse(200, { jsonrpc: '2.0', id, result }, extraHeaders);
  }

  private rpcRaw(id: unknown, resultJson: string): HttpResponse {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result: JSON.parse(resultJson) }), 'utf8');
    return { status: 200, headers: { 'content-type': 'application/json' }, body };
  }

  private rpcError(id: unknown, code: number, message: string): HttpResponse {
    return jsonResponse(200, { jsonrpc: '2.0', id, error: { code, message } });
  }

  private callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
    const tool = findTool(name);
    if (!tool) return errorResult(`Unknown tool: ${name}`);
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      return errorResult(`Missing required argument(s): ${missing.join(', ')}`);
    }
    try {
      switch (tool.name) {
        case 'create_repo': return this.createRepo(args);
        case 'get_repo': return this.getRepo(args);
        case 'create_issue': return this.createIssue(args);
        case 'list_issues': return this.listIssues(args);
        case 'create_pull_request': return this.createPullRequest(args);
        case 'merge_pull_request': return this.mergePullRequest(args);
        case 'get_issue': return this.getIssue(args);
        case 'create_comment': return this.createComment(args);
        case 'list_pull_requests': return this.listPullRequests(args);
        case 'get_pull_request': return this.getPullRequest(args);
        default: return errorResult(`Unknown tool: ${name}`);
      }
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : 'Tool failed');
    }
  }

  private repoOf(args: Record<string, unknown>): Repo | null {
    let owner = typeof args.owner === 'string' ? args.owner : '';
    let repoName = typeof args.repo === 'string' ? args.repo : '';
    if ((owner === '' || repoName === '') && typeof args.repo_full_name === 'string') {
      const parts = (args.repo_full_name as string).split('/');
      if (parts.length === 2) {
        owner = parts[0] as string;
        repoName = parts[1] as string;
      }
    }
    if (owner === '' || repoName === '') return null;
    return this.store.getRepo(owner, repoName) ?? null;
  }

  private repoJson(repo: Repo): Record<string, unknown> {
    return {
      id: repoNodeId(repo),
      databaseId: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner },
      private: repo.isPrivate,
      description: repo.description,
      default_branch: repo.defaultBranch,
      created_at: repo.createdAt,
      updatedAt: repo.updatedAt,
    };
  }

  private issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issueNodeId(repo, issue),
      databaseId: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((l) => ({ name: l.name, color: l.color, description: l.description })),
      user: { login: issue.userLogin },
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      closed_at: issue.closedAt,
      comments: issue.comments.length,
    };
  }

  private pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
    return {
      id: pullNodeId(repo, pull),
      databaseId: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
      head: { ref: pull.headRef, sha: pull.headSha },
      base: { ref: pull.baseRef, sha: pull.baseSha },
      headRefName: pull.headRef,
      baseRefName: pull.baseRef,
      merged: pull.merged,
      mergeable: pull.mergeable,
      merge_commit_sha: pull.mergeCommitSha,
      merged_at: pull.mergedAt,
      user: { login: pull.userLogin },
      created_at: pull.createdAt,
      updated_at: pull.updatedAt,
    };
  }

  private createRepo(args: Record<string, unknown>): Record<string, unknown> {
    const name = args.name as string;
    if (this.store.getRepo(VIEWER_LOGIN, name)) return errorResult('Repository already exists');
    const repo = this.store.createRepo(
      VIEWER_LOGIN,
      name,
      args.private === true,
      typeof args.description === 'string' ? args.description : '',
      'main',
    );
    return textResult(this.repoJson(repo));
  }

  private getRepo(args: Record<string, unknown>): Record<string, unknown> {
    const repo = this.repoOf(args);
    if (!repo) return errorResult('Repository not found');
    return textResult(this.repoJson(repo));
  }

  private createIssue(args: Record<string, unknown>): Record<string, unknown> {
    const repo = this.repoOf(args);
    if (!repo) return errorResult('Repository not found');
    const title = args.title as string;
    const labels: Array<{ name: string; color: string; description: string }> = [];
    if (Array.isArray(args.labels)) {
      for (const l of args.labels) {
        const name = typeof l === 'string' ? l : (l as Record<string, unknown>).name as string;
        const label = repo.labels.get(name);
        if (!label) return errorResult(`Label does not exist: ${name}`);
        labels.push(label);
      }
    }
    const number = ++repo.issueCounter;
    const issue: Issue = {
      id: this.store.nextGlobalId(),
      number,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels,
      userLogin: VIEWER_LOGIN,
      createdAt: repo.createdAt,
      updatedAt: repo.updatedAt,
      closedAt: null,
      comments: [],
      jsonCache: '',
    };
    repo.issues.set(number, issue);
    return textResult(this.issueJson(repo, issue));
  }

  private listIssues(args: Record<string, unknown>): Record<string, unknown> {
    const repo = this.repoOf(args);
    if (!repo) return errorResult('Repository not found');
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => b.number - a.number);
    return textResult(list.map((i) => this.issueJson(repo, i)));
  }

  private createPullRequest(args: Record<string, unknown>): Record<string, unknown> {
    const repo = this.repoOf(args);
    if (!repo) return errorResult('Repository not found');
    const headName = typeof args.head === 'string' ? args.head : '';
    const baseName = typeof args.base === 'string' ? args.base : '';
    const headSha = repo.refs.get(`refs/heads/${headName}`);
    const baseSha = repo.refs.get(`refs/heads/${baseName}`);
    if (!headSha || !baseSha) return errorResult('head or base branch does not exist');
    const number = ++repo.pullCounter;
    const pull: Pull = {
      id: this.store.nextGlobalId(),
      number,
      title: args.title as string,
      body: typeof args.body === 'string' ? args.body : '',
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
      createdAt: repo.createdAt,
      updatedAt: repo.updatedAt,
    };
    repo.pulls.set(number, pull);
    return textResult(this.pullJson(repo, pull));
  }

  private mergePullRequest(args: Record<string, unknown>): Record<string, unknown> {
    const repo = this.repoOf(args);
    if (!repo) return errorResult('Repository not found');
    const num = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number), 10);
    const pull = repo.pulls.get(num);
    if (!pull) return errorResult('Pull request not found');
    if (pull.state !== 'open' || pull.merged) return errorResult('Pull request is not open');
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (!baseTip || !headTip) return errorResult('head or base branch is missing');
    const baseCommit = parseCommit(getObject(repo, baseTip)?.data ?? Buffer.alloc(0));
    const headCommit = parseCommit(getObject(repo, headTip)?.data ?? Buffer.alloc(0));
    // Conflict check: a path changed differently on both sides of the merge base.
    const base = this.mergeBase(repo, baseTip, headTip);
    const mergeBaseTree = base ? parseCommit(getObject(repo, base)?.data ?? Buffer.alloc(0)).tree : null;
    const bFiles = new Map<string, string>();
    const hFiles = new Map<string, string>();
    const tFiles = new Map<string, string>();
    this.flatten(repo, mergeBaseTree, '', bFiles);
    this.flatten(repo, headCommit.tree, '', hFiles);
    this.flatten(repo, baseCommit.tree, '', tFiles);
    const paths = new Set([...bFiles.keys(), ...hFiles.keys(), ...tFiles.keys()]);
    for (const p of paths) {
      const b = bFiles.get(p);
      const h = hFiles.get(p);
      const t = tFiles.get(p);
      if (h !== b && t !== b && h !== t) return errorResult('Merge conflict');
    }
    // Squash: one commit on the base branch with the head's tree.
    const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_EPOCH} +0000`;
    const message = `Merge pull request #${pull.number}: ${pull.title}`;
    const mergeSha = putObject(repo, 'commit', serializeCommit(headCommit.tree, [baseTip], ident, ident, message));
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = mergeSha;
    pull.mergedAt = FIXED_ISO;
    pull.updatedAt = FIXED_ISO;
    pull.baseSha = mergeSha;
    this.store.touchRefs(repo);
    return textResult({ sha: mergeSha, merged: true, message, ...this.pullJson(repo, pull) });
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

  private getIssue(args: Record<string, unknown>): Record<string, unknown> {
    const repo = this.repoOf(args);
    if (!repo) return errorResult('Repository not found');
    const num = typeof args.issue_number === 'number' ? args.issue_number : parseInt(String(args.issue_number), 10);
    const issue = repo.issues.get(num);
    if (!issue) return errorResult('Issue not found');
    return textResult(this.issueJson(repo, issue));
  }

  private createComment(args: Record<string, unknown>): Record<string, unknown> {
    const repo = this.repoOf(args);
    if (!repo) return errorResult('Repository not found');
    const num = typeof args.issue_number === 'number' ? args.issue_number : parseInt(String(args.issue_number), 10);
    const issue = repo.issues.get(num);
    if (!issue) return errorResult('Issue not found');
    const comment = {
      id: this.store.nextGlobalId(),
      body: args.body as string,
      userLogin: VIEWER_LOGIN,
      createdAt: repo.createdAt,
      updatedAt: repo.updatedAt,
    };
    issue.comments.push(comment);
    return textResult({ id: comment.id, body: comment.body, user: { login: comment.userLogin }, created_at: comment.createdAt, updated_at: comment.updatedAt });
  }

  private listPullRequests(args: Record<string, unknown>): Record<string, unknown> {
    const repo = this.repoOf(args);
    if (!repo) return errorResult('Repository not found');
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.pulls.values()];
    if (state !== 'all') list = list.filter((p) => p.state === state);
    list.sort((a, b) => b.number - a.number);
    return textResult(list.map((p) => this.pullJson(repo, p)));
  }

  private getPullRequest(args: Record<string, unknown>): Record<string, unknown> {
    const repo = this.repoOf(args);
    if (!repo) return errorResult('Repository not found');
    const num = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number), 10);
    const pull = repo.pulls.get(num);
    if (!pull) return errorResult('Pull request not found');
    return textResult(this.pullJson(repo, pull));
  }
}
