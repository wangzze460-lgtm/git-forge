// GitHub REST v3 surface (/api/v3). Node stdlib only.
// Auth: Bearer MAKEFUN_SHOP_TOKEN is the viewer (adaiversen). No token -> 401.
// Any other token is a stranger: it owns nothing, so repo-scoped reads are 404
// (never 403). All timestamps are the fixed trial instant, never the wall clock.

import type { Comment, Issue, Label, Pull, Repo } from './store.ts';
import { FIXED_EPOCH, FIXED_ISO, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, Store } from './store.ts';
import {
  ZERO_OID, getObject, isAncestor, objectId, parseCommit, parseTree, putObject,
  reachableObjects, serializeCommit, serializeTree,
} from './git.ts';

export interface HttpRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
  host: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export function jsonResponse(status: number, value: unknown, extraHeaders: Record<string, string> = {}): HttpResponse {
  const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return { status, headers: { 'content-type': 'application/json', ...extraHeaders }, body };
}

export function errorResponse(status: number, message: string): HttpResponse {
  return jsonResponse(status, { message });
}

let requestCounter = 0;
export function withRequestId(res: HttpResponse): HttpResponse {
  requestCounter += 1;
  res.headers['x-github-request-id'] = `req-${requestCounter}`;
  return res;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface Identity {
  login: string;
  id: number;
  isViewer: boolean;
}

export function authenticate(req: HttpRequest, viewerToken: string): Identity | null {
  const auth = req.headers['authorization'] ?? '';
  const m = /^Bearer (.+)$/.exec(auth.trim());
  if (!m) return null;
  const token = m[1] as string;
  if (viewerToken !== '' && token === viewerToken) {
    return { login: VIEWER_LOGIN, id: VIEWER_ID, isViewer: true };
  }
  if (viewerToken === '' && token === 'test-token') {
    return { login: VIEWER_LOGIN, id: VIEWER_ID, isViewer: true };
  }
  // Any other bearer token is some other user who owns nothing here.
  return { login: 'stranger', id: 999999, isViewer: false };
}

export function parseJsonBody(req: HttpRequest): { ok: true; value: Record<string, unknown> } | { ok: false; response: HttpResponse } {
  if (req.body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(req.body.toString('utf8')) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return { ok: true, value: value as Record<string, unknown> };
    }
    return { ok: true, value: {} };
  } catch {
    return { ok: false, response: errorResponse(400, 'Malformed JSON in request body') };
  }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 999999, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    size: 0,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: issue.userLogin, id: issue.userLogin === VIEWER_LOGIN ? VIEWER_ID : 999999, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(pull: Pull, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    mergeable: pull.mergeable,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    user: { login: pull.userLogin, id: pull.userLogin === VIEWER_LOGIN ? VIEWER_ID : 999999, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.userLogin, id: comment.userLogin === VIEWER_LOGIN ? VIEWER_ID : 999999, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Git helpers for the contents API
// ---------------------------------------------------------------------------

function gitIdentity(): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_EPOCH} +0000`;
}

/** Recursively set (or delete) a path in a tree; returns the new tree oid. */
function updateTree(repo: Repo, treeOid: string | null, parts: string[], blobOid: string | null): string {
  const entries = treeOid ? parseTree(getObject(repo, treeOid)?.data ?? Buffer.alloc(0)) : [];
  const [head, ...rest] = parts as [string, ...string[]];
  const idx = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    // Leaf.
    if (blobOid === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode: '100644', name: head, oid: blobOid };
    } else {
      entries.push({ mode: '100644', name: head, oid: blobOid });
    }
  } else {
    const childTree = idx >= 0 ? entries[idx]?.oid ?? null : null;
    const newChild = updateTree(repo, childTree, rest, blobOid);
    const childEntries = parseTree(getObject(repo, newChild)?.data ?? Buffer.alloc(0));
    if (childEntries.length === 0) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode: '040000', name: head, oid: newChild };
    } else {
      entries.push({ mode: '040000', name: head, oid: newChild });
    }
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return putObject(repo, 'tree', serializeTree(entries));
}

/** The blob oid at a path in a tree, or null. */
function lookupPath(repo: Repo, treeOid: string | null, parts: string[]): { oid: string; type: 'blob' | 'tree' } | null {
  if (!treeOid) return null;
  const entries = parseTree(getObject(repo, treeOid)?.data ?? Buffer.alloc(0));
  const [head, ...rest] = parts as [string, ...string[]];
  const entry = entries.find((e) => e.name === head);
  if (!entry) return null;
  if (rest.length === 0) {
    const obj = getObject(repo, entry.oid);
    return obj ? { oid: entry.oid, type: obj.type === 'tree' ? 'tree' : 'blob' } : null;
  }
  if (entry.mode === '040000') return lookupPath(repo, entry.oid, rest);
  return null;
}

/** List the entries of a directory tree. */
function listTree(repo: Repo, treeOid: string | null): Array<{ name: string; oid: string; mode: string }> {
  if (!treeOid) return [];
  return parseTree(getObject(repo, treeOid)?.data ?? Buffer.alloc(0)).map((e) => ({ name: e.name, oid: e.oid, mode: e.mode }));
}

function commitAtRef(repo: Repo, ref: string): { sha: string; commit: ReturnType<typeof parseCommit> } | null {
  const oid = repo.refs.get(ref);
  if (!oid) return null;
  const obj = getObject(repo, oid);
  if (!obj || obj.type !== 'commit') return null;
  return { sha: oid, commit: parseCommit(obj.data) };
}

function makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
  const data = serializeCommit(treeOid, parents, gitIdentity(), gitIdentity(), message);
  return putObject(repo, 'commit', data);
}

/** Walk commits from a tip, newest first (parents after children). */
function walkCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return out;
}

/** Best common ancestor of two commits (first shared commit in BFS order). */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>(walkCommits(repo, a));
  const queue: string[] = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (ancestorsA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return null;
}

/** Flatten a tree into path -> blob oid. */
function flattenTree(repo: Repo, treeOid: string | null, prefix: string, out: Map<string, string>): void {
  if (!treeOid) return;
  for (const e of parseTree(getObject(repo, treeOid)?.data ?? Buffer.alloc(0))) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '040000') flattenTree(repo, e.oid, path, out);
    else out.set(path, e.oid);
  }
}

/** Naive line diff: additions = lines in new not in old, deletions = lines in old not in new. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldCount = new Map<string, number>();
  for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const n = oldCount.get(l) ?? 0;
    if (n > 0) oldCount.set(l, n - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const n of oldCount.values()) deletions += n;
  return { additions, deletions };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export class RestRouter {
  store: Store;
  viewerToken: string;
  /** Per-repo response cache for hot list endpoints; cleared on mutation. */
  listCache: Map<string, string> = new Map();

  constructor(store: Store, viewerToken: string) {
    this.store = store;
    this.viewerToken = viewerToken;
  }

  clearListCache(repo: Repo): void {
    const prefix = `${repo.owner}/${repo.name}:`;
    for (const key of [...this.listCache.keys()]) {
      if (key.startsWith(prefix)) this.listCache.delete(key);
    }
  }

  handle(req: HttpRequest): HttpResponse {
    const segments = req.path.split('/').filter((s) => s !== '');
    // All routes live under /api/v3.
    if (segments[0] !== 'api' || segments[1] !== 'v3') {
      return withRequestId(errorResponse(404, 'Not Found'));
    }
    const rest = segments.slice(2);
    // The API root and /meta are public, as GitHub answers them.
    if (rest.length === 0) {
      if (req.method !== 'GET') return withRequestId(errorResponse(404, 'Not Found'));
      return withRequestId(jsonResponse(200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        rate_limit_url: '/api/v3/rate_limit',
      }, { 'x-oauth-scopes': 'repo, user', 'x-accepted-oauth-scopes': 'repo, user' }));
    }
    if (rest.length === 1 && rest[0] === 'meta') {
      if (req.method !== 'GET') return withRequestId(errorResponse(404, 'Not Found'));
      return withRequestId(jsonResponse(200, { installed_version: '1.0.0' }));
    }
    const identity = authenticate(req, this.viewerToken);
    if (!identity) return withRequestId(errorResponse(401, 'Requires authentication'));
    try {
      const res = this.dispatch(req, identity, rest);
      return withRequestId(res);
    } catch (e) {
      return withRequestId(errorResponse(500, e instanceof Error ? e.message : 'Internal error'));
    }
  }

  private dispatch(req: HttpRequest, identity: Identity, rest: string[]): HttpResponse {
    const method = req.method;
    // /user/repos
    if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
      if (method === 'POST') return this.createRepo(req, identity);
      if (method === 'GET') return this.listUserRepos(req, identity);
      return errorResponse(404, 'Not Found');
    }
    // /repos/{owner}/{repo}[...]
    if (rest[0] === 'repos' && rest.length >= 3) {
      const owner = decodeURIComponent(rest[1] as string);
      const repoName = decodeURIComponent(rest[2] as string);
      const repo = this.store.getRepo(owner, repoName);
      if (!repo) return errorResponse(404, 'Not Found');
      // A stranger owns nothing here; the viewer's repos are not theirs to read.
      if (identity.isViewer === false && repo.owner === VIEWER_LOGIN) {
        return errorResponse(404, 'Not Found');
      }
      const tail = rest.slice(3);
      return this.repoDispatch(req, identity, repo, tail);
    }
    return errorResponse(404, 'Not Found');
  }

  // -------------------------------------------------------------------------
  private createRepo(req: HttpRequest, identity: Identity): HttpResponse {
    const parsed = parseJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name === '') return errorResponse(422, 'name is required');
    const owner = identity.login;
    if (this.store.getRepo(owner, name)) return errorResponse(422, 'Repository already exists');
    const isPrivate = body.private === true;
    const description = typeof body.description === 'string' ? body.description : '';
    const defaultBranch = typeof body.default_branch === 'string' && body.default_branch !== '' ? body.default_branch : 'main';
    const repo = this.store.createRepo(owner, name, isPrivate, description, defaultBranch);
    return jsonResponse(201, repoJson(repo));
  }

  private listUserRepos(req: HttpRequest, identity: Identity): HttpResponse {
    const perPage = Math.max(1, Math.min(100, parseInt(req.query.get('per_page') ?? '30', 10) || 30));
    const page = Math.max(1, parseInt(req.query.get('page') ?? '1', 10) || 1);
    const all = [...this.store.repos.values()]
      .filter((r) => r.owner === identity.login)
      .sort((a, b) => a.id - b.id);
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    if (page * perPage < all.length) {
      const nextUrl = `http://${req.host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
      headers.link = `<${nextUrl}>; rel="next"`;
    }
    return jsonResponse(200, slice.map(repoJson), headers);
  }

  // -------------------------------------------------------------------------
  private repoDispatch(req: HttpRequest, identity: Identity, repo: Repo, tail: string[]): HttpResponse {
    const method = req.method;
    if (tail.length === 0) {
      if (method === 'GET') return jsonResponse(200, repoJson(repo));
      if (method === 'PATCH') {
        const parsed = parseJsonBody(req);
        if (!parsed.ok) return parsed.response;
        if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
        if (typeof parsed.value.default_branch === 'string' && parsed.value.default_branch !== '') {
          repo.defaultBranch = parsed.value.default_branch;
        }
        this.clearListCache(repo);
        return jsonResponse(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        this.store.deleteRepo(repo.owner, repo.name);
        this.clearListCache(repo);
        return { status: 204, headers: {}, body: Buffer.alloc(0) };
      }
      return errorResponse(404, 'Not Found');
    }
    const head = tail[0] as string;
    if (head === 'branches' && tail.length === 1 && method === 'GET') {
      const cacheKey = `${repo.owner}/${repo.name}:branches`;
      const cached = this.listCache.get(cacheKey);
      if (cached) return jsonResponse(200, cached);
      const list = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }));
      const body = JSON.stringify(list);
      this.listCache.set(cacheKey, body);
      return jsonResponse(200, body);
    }
    if (head === 'commits' && tail.length === 1 && method === 'GET') {
      return this.listCommits(req, repo);
    }
    if (head === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) return this.createRef(req, repo);
      if (method === 'GET' && tail.length > 2) return this.getRef(repo, tail.slice(2).join('/'));
      return errorResponse(404, 'Not Found');
    }
    if (head === 'contents') {
      const path = tail.slice(1).map((s) => decodeURIComponent(s)).join('/');
      if (method === 'PUT') return this.putContents(req, repo, path);
      if (method === 'GET') return this.getContents(req, repo, path);
      if (method === 'DELETE') return this.deleteContents(req, repo, path);
      return errorResponse(404, 'Not Found');
    }
    if (head === 'labels') {
      if (method === 'POST' && tail.length === 1) return this.createLabel(req, repo);
      if (method === 'GET' && tail.length === 1) {
        return jsonResponse(200, [...repo.labels.values()].map(labelJson));
      }
      return errorResponse(404, 'Not Found');
    }
    if (head === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') return this.createIssue(req, repo);
        if (method === 'GET') return this.listIssues(req, repo);
      }
      const num = parseInt(tail[1] as string, 10);
      if (Number.isInteger(num)) {
        if (tail.length === 2) {
          if (method === 'GET') return this.getIssue(repo, num);
          if (method === 'PATCH') return this.patchIssue(req, repo, num);
        }
        if (tail.length === 3 && tail[2] === 'comments') {
          if (method === 'POST') return this.createComment(req, repo, num);
          if (method === 'GET') return this.listComments(repo, num);
        }
      }
      return errorResponse(404, 'Not Found');
    }
    if (head === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') return this.createPull(req, repo);
        if (method === 'GET') return this.listPulls(req, repo);
      }
      const num = parseInt(tail[1] as string, 10);
      if (Number.isInteger(num)) {
        if (tail.length === 2 && method === 'GET') return this.getPull(repo, num);
        if (tail.length === 3 && tail[2] === 'files' && method === 'GET') return this.pullFiles(repo, num);
        if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') return this.mergePull(req, repo, num);
      }
      return errorResponse(404, 'Not Found');
    }
    return errorResponse(404, 'Not Found');
  }

  // -------------------------------------------------------------------------
  private listCommits(req: HttpRequest, repo: Repo): HttpResponse {
    const refName = req.query.get('sha') ?? repo.defaultBranch;
    const ref = refName.startsWith('refs/') ? refName : `refs/heads/${refName}`;
    const tip = repo.refs.get(ref);
    if (!tip) return errorResponse(404, 'No such ref');
    const cacheKey = `${repo.owner}/${repo.name}:commits:${ref}:${tip}`;
    const cached = this.listCache.get(cacheKey);
    if (cached) return jsonResponse(200, cached);
    const perPage = Math.max(1, Math.min(100, parseInt(req.query.get('per_page') ?? '30', 10) || 30));
    const page = Math.max(1, parseInt(req.query.get('page') ?? '1', 10) || 1);
    const all = walkCommits(repo, tip);
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const list = slice.map((sha) => {
      const c = parseCommit(getObject(repo, sha)?.data ?? Buffer.alloc(0));
      return {
        sha,
        commit: {
          message: c.message,
          author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO },
          committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO },
        },
        author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
        parents: c.parents.map((p) => ({ sha: p })),
      };
    });
    const body = JSON.stringify(list);
    this.listCache.set(cacheKey, body);
    return jsonResponse(200, body);
  }

  private createRef(req: HttpRequest, repo: Repo): HttpResponse {
    const parsed = parseJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const ref = typeof parsed.value.ref === 'string' ? parsed.value.ref : '';
    const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : '';
    if (!ref.startsWith('refs/') || sha === '') return errorResponse(422, 'ref and sha are required');
    if (repo.refs.has(ref)) return errorResponse(422, 'Reference already exists');
    const obj = getObject(repo, sha);
    if (!obj || obj.type !== 'commit') return errorResponse(422, 'Object does not exist');
    repo.refs.set(ref, sha);
    this.store.touchRefs(repo);
    this.clearListCache(repo);
    return jsonResponse(201, { ref, object: { sha, type: 'commit' } });
  }

  private getRef(repo: Repo, refPath: string): HttpResponse {
    const ref = `refs/${refPath}`;
    const oid = repo.refs.get(ref);
    if (!oid) return errorResponse(404, 'Not Found');
    return jsonResponse(200, { ref, object: { sha: oid, type: 'commit' } });
  }

  // -------------------------------------------------------------------------
  private putContents(req: HttpRequest, repo: Repo, path: string): HttpResponse {
    const parsed = parseJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      return errorResponse(400, 'content is not valid base64');
    }
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = commitAtRef(repo, ref);
    const parts = path.split('/').filter((p) => p !== '');
    if (parts.length === 0) return errorResponse(422, 'path is required');
    const existing = tip ? lookupPath(repo, tip.commit.tree, parts) : null;
    const isUpdate = existing !== null && existing.type === 'blob';
    if (isUpdate) {
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (sha !== '' && sha.toLowerCase() !== existing.oid.toLowerCase()) {
        return errorResponse(409, 'sha does not match the current blob');
      }
    }
    const blobOid = putObject(repo, 'blob', content);
    const newTree = updateTree(repo, tip ? tip.commit.tree : null, parts, blobOid);
    const parents = tip ? [tip.sha] : [];
    const commitSha = makeCommit(repo, newTree, parents, message);
    repo.refs.set(ref, commitSha);
    this.store.touchRefs(repo);
    this.clearListCache(repo);
    return jsonResponse(isUpdate ? 200 : 201, {
      content: {
        name: parts[parts.length - 1],
        path,
        sha: blobOid,
        size: content.length,
        encoding: 'base64',
        content: content.toString('base64'),
        type: 'file',
      },
      commit: { sha: commitSha, message },
    });
  }

  private getContents(req: HttpRequest, repo: Repo, path: string): HttpResponse {
    const refName = req.query.get('ref') ?? repo.defaultBranch;
    const ref = refName.startsWith('refs/') ? refName : `refs/heads/${refName}`;
    const tip = commitAtRef(repo, ref);
    if (!tip) return errorResponse(404, 'Not Found');
    const parts = path.split('/').filter((p) => p !== '');
    if (parts.length === 0) {
      // Root listing.
      const entries = listTree(repo, tip.commit.tree);
      return jsonResponse(200, entries.map((e) => ({
        type: e.mode === '040000' ? 'dir' : 'file',
        name: e.name,
        path: e.name,
        sha: e.oid,
        size: e.mode === '040000' ? 0 : (getObject(repo, e.oid)?.data.length ?? 0),
      })));
    }
    const found = lookupPath(repo, tip.commit.tree, parts);
    if (!found) return errorResponse(404, 'Not Found');
    if (found.type === 'tree') {
      const entries = listTree(repo, found.oid);
      return jsonResponse(200, entries.map((e) => ({
        type: e.mode === '040000' ? 'dir' : 'file',
        name: e.name,
        path: `${path}/${e.name}`,
        sha: e.oid,
        size: e.mode === '040000' ? 0 : (getObject(repo, e.oid)?.data.length ?? 0),
      })));
    }
    const obj = getObject(repo, found.oid);
    if (!obj) return errorResponse(404, 'Not Found');
    return jsonResponse(200, {
      type: 'file',
      encoding: 'base64',
      content: obj.data.toString('base64'),
      sha: found.oid,
      size: obj.data.length,
      name: parts[parts.length - 1],
      path,
    });
  }

  private deleteContents(req: HttpRequest, repo: Repo, path: string): HttpResponse {
    const parsed = parseJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = commitAtRef(repo, ref);
    if (!tip) return errorResponse(404, 'Not Found');
    const parts = path.split('/').filter((p) => p !== '');
    const existing = lookupPath(repo, tip.commit.tree, parts);
    if (!existing || existing.type !== 'blob') return errorResponse(404, 'Not Found');
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (sha !== '' && sha.toLowerCase() !== existing.oid.toLowerCase()) {
      return errorResponse(409, 'sha does not match the current blob');
    }
    const newTree = updateTree(repo, tip.commit.tree, parts, null);
    const commitSha = makeCommit(repo, newTree, [tip.sha], message);
    repo.refs.set(ref, commitSha);
    this.store.touchRefs(repo);
    this.clearListCache(repo);
    return jsonResponse(200, { commit: { sha: commitSha, message } });
  }

  // -------------------------------------------------------------------------
  private createLabel(req: HttpRequest, repo: Repo): HttpResponse {
    const parsed = parseJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const name = typeof parsed.value.name === 'string' ? parsed.value.name.trim() : '';
    if (name === '') return errorResponse(422, 'name is required');
    const color = typeof parsed.value.color === 'string' ? parsed.value.color : 'ededed';
    const description = typeof parsed.value.description === 'string' ? parsed.value.description : '';
    const label: Label = { name, color, description };
    repo.labels.set(name, label);
    return jsonResponse(201, labelJson(label));
  }

  private createIssue(req: HttpRequest, repo: Repo): HttpResponse {
    const parsed = parseJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    const title = typeof body.title === 'string' ? body.title : '';
    if (title === '') return errorResponse(422, 'title is required');
    const bodyText = typeof body.body === 'string' ? body.body : '';
    const labelNames: string[] = [];
    if (Array.isArray(body.labels)) {
      for (const l of body.labels) {
        if (typeof l === 'string') labelNames.push(l);
        else if (l !== null && typeof l === 'object' && typeof (l as Record<string, unknown>).name === 'string') {
          labelNames.push((l as Record<string, unknown>).name as string);
        }
      }
    }
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) return errorResponse(422, `Label does not exist: ${name}`);
      labels.push(label);
    }
    const number = ++repo.issueCounter;
    const issue: Issue = {
      id: this.store.nextGlobalId(),
      number,
      title,
      body: bodyText,
      state: 'open',
      labels,
      userLogin: VIEWER_LOGIN,
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
      closedAt: null,
      comments: [],
      jsonCache: '',
    };
    issue.jsonCache = JSON.stringify(issueJson(issue, repo));
    repo.issues.set(number, issue);
    this.clearListCache(repo);
    return jsonResponse(201, issue.jsonCache);
  }

  private listIssues(req: HttpRequest, repo: Repo): HttpResponse {
    const state = req.query.get('state') ?? 'open';
    const sort = req.query.get('sort') ?? 'created';
    const direction = req.query.get('direction') ?? 'desc';
    const cacheKey = `${repo.owner}/${repo.name}:issues:${state}:${sort}:${direction}`;
    const cached = this.listCache.get(cacheKey);
    if (cached) return jsonResponse(200, cached);
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    if (sort === 'created') {
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    }
    const body = JSON.stringify(list.map((i) => issueJson(i, repo)));
    this.listCache.set(cacheKey, body);
    return jsonResponse(200, body);
  }

  private getIssue(repo: Repo, num: number): HttpResponse {
    const issue = repo.issues.get(num);
    if (!issue) return errorResponse(404, 'Not Found');
    return jsonResponse(200, issue.jsonCache === '' ? JSON.stringify(issueJson(issue, repo)) : issue.jsonCache);
  }

  private patchIssue(req: HttpRequest, repo: Repo, num: number): HttpResponse {
    const issue = repo.issues.get(num);
    if (!issue) return errorResponse(404, 'Not Found');
    const parsed = parseJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
    if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
      issue.state = body.state;
      issue.closedAt = body.state === 'closed' ? FIXED_ISO : null;
    }
    if (Array.isArray(body.labels)) {
      const labels: Label[] = [];
      for (const l of body.labels) {
        const name = typeof l === 'string' ? l : (l as Record<string, unknown>).name as string;
        const label = repo.labels.get(name);
        if (!label) return errorResponse(422, `Label does not exist: ${name}`);
        labels.push(label);
      }
      issue.labels = labels;
    }
    issue.jsonCache = JSON.stringify(issueJson(issue, repo));
    this.clearListCache(repo);
    return jsonResponse(200, issue.jsonCache);
  }

  private createComment(req: HttpRequest, repo: Repo, num: number): HttpResponse {
    const issue = repo.issues.get(num);
    if (!issue) return errorResponse(404, 'Not Found');
    const parsed = parseJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const bodyText = typeof parsed.value.body === 'string' ? parsed.value.body : '';
    if (bodyText === '') return errorResponse(422, 'body is required');
    const comment: Comment = {
      id: this.store.nextGlobalId(),
      body: bodyText,
      userLogin: VIEWER_LOGIN,
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
    };
    issue.comments.push(comment);
    repo.commentCounter += 1;
    issue.jsonCache = JSON.stringify(issueJson(issue, repo));
    this.clearListCache(repo);
    return jsonResponse(201, commentJson(comment));
  }

  private listComments(repo: Repo, num: number): HttpResponse {
    const issue = repo.issues.get(num);
    if (!issue) return errorResponse(404, 'Not Found');
    return jsonResponse(200, issue.comments.map(commentJson));
  }

  // -------------------------------------------------------------------------
  private createPull(req: HttpRequest, repo: Repo): HttpResponse {
    const parsed = parseJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    const title = typeof body.title === 'string' ? body.title : '';
    if (title === '') return errorResponse(422, 'title is required');
    const headRef = typeof body.head === 'string' ? body.head : '';
    const baseRef = typeof body.base === 'string' ? body.base : '';
    const headName = headRef.includes(':') ? (headRef.split(':').pop() as string) : headRef;
    const baseName = baseRef.includes(':') ? (baseRef.split(':').pop() as string) : baseRef;
    const headSha = repo.refs.get(`refs/heads/${headName}`);
    const baseSha = repo.refs.get(`refs/heads/${baseName}`);
    if (!headSha || !baseSha) return errorResponse(422, 'head or base branch does not exist');
    const number = ++repo.pullCounter;
    const pull: Pull = {
      id: this.store.nextGlobalId(),
      number,
      title,
      body: typeof body.body === 'string' ? body.body : '',
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
    this.clearListCache(repo);
    return jsonResponse(201, pullJson(pull, repo));
  }

  private listPulls(req: HttpRequest, repo: Repo): HttpResponse {
    const state = req.query.get('state') ?? 'open';
    const cacheKey = `${repo.owner}/${repo.name}:pulls:${state}`;
    const cached = this.listCache.get(cacheKey);
    if (cached) return jsonResponse(200, cached);
    let list = [...repo.pulls.values()];
    if (state !== 'all') list = list.filter((p) => p.state === state);
    list.sort((a, b) => b.number - a.number);
    const body = JSON.stringify(list.map((p) => pullJson(p, repo)));
    this.listCache.set(cacheKey, body);
    return jsonResponse(200, body);
  }

  private getPull(repo: Repo, num: number): HttpResponse {
    const pull = repo.pulls.get(num);
    if (!pull) return errorResponse(404, 'Not Found');
    return jsonResponse(200, pullJson(pull, repo));
  }

  private pullFiles(repo: Repo, num: number): HttpResponse {
    const pull = repo.pulls.get(num);
    if (!pull) return errorResponse(404, 'Not Found');
    const baseTip = commitAtRef(repo, `refs/heads/${pull.baseRef}`);
    const headTip = commitAtRef(repo, `refs/heads/${pull.headRef}`);
    // Use the PR's recorded shas when the branches have moved since creation.
    const baseTree = baseTip ? baseTip.commit.tree : null;
    const headTree = headTip ? headTip.commit.tree : null;
    const baseFiles = new Map<string, string>();
    const headFiles = new Map<string, string>();
    flattenTree(repo, baseTree, '', baseFiles);
    flattenTree(repo, headTree, '', headFiles);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const files: Array<Record<string, unknown>> = [];
    for (const path of [...paths].sort()) {
      const inBase = baseFiles.has(path);
      const inHead = headFiles.has(path);
      if (inBase && !inHead) {
        const oldObj = getObject(repo, baseFiles.get(path) as string);
        const oldText = oldObj ? oldObj.data.toString('utf8') : '';
        const diff = lineDiff(oldText, '');
        files.push({ filename: path, status: 'removed', additions: 0, deletions: diff.deletions, changes: diff.deletions });
      } else if (!inBase && inHead) {
        const newObj = getObject(repo, headFiles.get(path) as string);
        const newText = newObj ? newObj.data.toString('utf8') : '';
        const diff = lineDiff('', newText);
        files.push({ filename: path, status: 'added', additions: diff.additions, deletions: 0, changes: diff.additions });
      } else {
        const baseOid = baseFiles.get(path) as string;
        const headOid = headFiles.get(path) as string;
        if (baseOid === headOid) continue;
        const oldObj = getObject(repo, baseOid);
        const newObj = getObject(repo, headOid);
        const diff = lineDiff(oldObj ? oldObj.data.toString('utf8') : '', newObj ? newObj.data.toString('utf8') : '');
        files.push({ filename: path, status: 'modified', additions: diff.additions, deletions: diff.deletions, changes: diff.additions + diff.deletions });
      }
    }
    return jsonResponse(200, files);
  }

  private mergePull(req: HttpRequest, repo: Repo, num: number): HttpResponse {
    const pull = repo.pulls.get(num);
    if (!pull) return errorResponse(404, 'Not Found');
    if (pull.state !== 'open' || pull.merged) return errorResponse(405, 'Pull request is not open');
    const parsed = parseJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const method = typeof parsed.value.merge_method === 'string' ? parsed.value.merge_method : 'squash';
    const message = typeof parsed.value.commit_message === 'string'
      ? parsed.value.commit_message
      : `Merge pull request #${pull.number}: ${pull.title}`;
    const baseTip = commitAtRef(repo, `refs/heads/${pull.baseRef}`);
    const headTip = commitAtRef(repo, `refs/heads/${pull.headRef}`);
    if (!baseTip || !headTip) return errorResponse(422, 'head or base branch is missing');
    // Three-way conflict detection against the merge base.
    const base = mergeBase(repo, baseTip.sha, headTip.sha);
    const baseTree = base ? parseCommit(getObject(repo, base)?.data ?? Buffer.alloc(0)).tree : null;
    const baseFiles = new Map<string, string>();
    const headFiles = new Map<string, string>();
    const tipFiles = new Map<string, string>();
    flattenTree(repo, baseTree, '', baseFiles);
    flattenTree(repo, headTip.commit.tree, '', headFiles);
    flattenTree(repo, baseTip.commit.tree, '', tipFiles);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
    for (const path of paths) {
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      const t = tipFiles.get(path);
      const headChanged = h !== b;
      const tipChanged = t !== b;
      if (headChanged && tipChanged && h !== t) {
        return errorResponse(405, 'Merge conflict');
      }
    }
    let mergeSha: string;
    if (method === 'merge') {
      mergeSha = makeCommit(repo, headTip.commit.tree, [baseTip.sha, headTip.sha], message);
    } else {
      // squash (and rebase): one commit on the base branch with the head's tree.
      mergeSha = makeCommit(repo, headTip.commit.tree, [baseTip.sha], message);
    }
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = mergeSha;
    pull.mergedAt = FIXED_ISO;
    pull.updatedAt = FIXED_ISO;
    pull.baseSha = mergeSha;
    this.store.touchRefs(repo);
    this.clearListCache(repo);
    return jsonResponse(200, { sha: mergeSha, merged: true, message });
  }
}

export { FIXED_ISO, ZERO_OID, objectId, reachableObjects };
