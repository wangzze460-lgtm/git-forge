// In-memory store for the forge. Everything lives in Maps; nothing touches disk.
// Determinism: every timestamp the store emits comes from a fixed instant (the trial's
// MAKEFUN_TRIAL_NOW when set, else a constant), never from the wall clock, so two runs
// of the same trial leave identical state.

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

export const FIXED_ISO: string = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim() !== ''
  ? (process.env.MAKEFUN_TRIAL_NOW as string)
  : '2026-11-14T06:30:00.000Z';
/** Fixed epoch seconds stamped into every server-created git object. */
export const FIXED_EPOCH = 1700000000;

export type Json = unknown;

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
  /** Pre-rendered JSON for the single-issue GET hot path. */
  jsonCache: string;
}

export interface Comment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeable: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  data: Buffer;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  issueCounter: number;
  pullCounter: number;
  commentCounter: number;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  /** refname -> sha */
  refs: Map<string, string>;
  /** sha -> object */
  objects: Map<string, GitObject>;
  /** Cache: fetch results by key (want set + depth + haves + shallow boundary). */
  packCache: Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>;
  /** Cache: advertisement lines by ref-version. */
  advCache: string | null;
  advVersion: number;
}

let repoIdCounter = 5000;
let globalIdCounter = 100000;

export class Store {
  repos: Map<string, Repo> = new Map(); // key: owner + '/' + name
  reposById: Map<number, Repo> = new Map();

  repoKey(owner: string, name: string): string {
    return owner + '/' + name;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string, defaultBranch: string): Repo {
    const repo: Repo = {
      id: repoIdCounter++,
      name,
      owner,
      description,
      isPrivate,
      defaultBranch,
      createdAt: FIXED_ISO,
      updatedAt: FIXED_ISO,
      issueCounter: 0,
      pullCounter: 0,
      commentCounter: 0,
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      refs: new Map(),
      objects: new Map(),
      packCache: new Map(),
      advCache: null,
      advVersion: 0,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.getRepo(owner, name);
    if (!repo) return false;
    this.repos.delete(this.repoKey(owner, name));
    this.reposById.delete(repo.id);
    return true;
  }

  nextGlobalId(): number {
    return globalIdCounter++;
  }

  /** Bump a repo's ref version: drops cached advertisements and packs. */
  touchRefs(repo: Repo): void {
    repo.advVersion++;
    repo.advCache = null;
    repo.packCache.clear();
  }
}

/** Base64url without padding, for GraphQL global ids. */
export function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

export function repoNodeId(repo: Repo): string {
  return b64url(`Repository:${repo.id}`);
}

export function issueNodeId(repo: Repo, issue: Issue): string {
  return b64url(`Issue:${repo.id}:${issue.number}`);
}

export function pullNodeId(repo: Repo, pull: Pull): string {
  return b64url(`PullRequest:${repo.id}:${pull.number}`);
}

export function commentNodeId(repo: Repo, comment: Comment): string {
  return b64url(`IssueComment:${repo.id}:${comment.id}`);
}

/** Decode a global id back into its parts; null when it is not one of ours.
 *  Repository ids are `Repository:<id>` (2 parts); Issue/PullRequest/IssueComment
 *  ids are `<Kind>:<repoId>:<num>` (3 parts). */
export function decodeNodeId(id: string): { kind: string; repoId: number; num: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2 || parts.length > 3) return null;
    const repoId = Number(parts[1]);
    const num = parts.length === 3 ? Number(parts[2]) : 0;
    if (!Number.isInteger(repoId) || !Number.isInteger(num)) return null;
    return { kind: parts[0] as string, repoId, num };
  } catch {
    return null;
  }
}
