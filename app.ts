// The forge's HTTP surface: one process, no UI.
//   GET  /healthz                                   boot probe (200 {"ok":true})
//   GET  /{owner}/{repo}.git/info/refs?service=...  git advertisement (v2 or v0)
//   POST /{owner}/{repo}.git/git-upload-pack         upload-pack v2 / v0
//   POST /{owner}/{repo}.git/git-receive-pack        receive-pack v0
//   *    /api/v3/...                                 REST v3
//   POST /api/graphql                                GraphQL v4
//   POST /mcp                                        MCP (Streamable HTTP)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { RestRouter, jsonResponse, type HttpRequest, type HttpResponse } from './rest.ts';
import { GraphqlRouter } from './graphql.ts';
import { McpRouter } from './mcp.ts';
import {
  advertiseReceiveV0, advertiseUploadV0, advertiseUploadV2,
  handleFetchV0, handleFetchV2, handleLsRefs, handleReceivePack,
} from './git-proto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const store = new Store();
const viewerToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const rest = new RestRouter(store, viewerToken);
const graphql = new GraphqlRouter(store);
const mcp = new McpRouter(store);

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) reject(new Error('request body too large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

let appRequestCounter = 0;
function nextRequestId(): string {
  appRequestCounter += 1;
  return `req-app-${appRequestCounter}`;
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer, extraHeaders: Record<string, string> = {}): void {
  // Every reply carries a non-empty X-GitHub-Request-Id (the protocol check
  // reads it on the API root, an unknown route and the 401 alike).
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  send(res, status, JSON_TYPE, Buffer.from(text, 'utf8'), headers);
}

function toHttpRequest(req: IncomingMessage, body: Buffer): HttpRequest {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers[key.toLowerCase()] = value;
    else if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(', ');
  }
  return {
    method: req.method ?? 'GET',
    path: pathOf(req),
    query: queryOf(req),
    headers,
    body,
    host: headers.host ?? 'localhost',
  };
}

function gitRepoPath(path: string): { owner: string; repo: string; suffix: string } | null {
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!m) return null;
  return { owner: decodeURIComponent(m[1] as string), repo: decodeURIComponent(m[2] as string), suffix: m[3] as string };
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const path = pathOf(req);
      try {
        // Boot probe.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        // API root, as the starter answers it (no auth).
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
          return;
        }
        const body = (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')
          ? await readBody(req)
          : Buffer.alloc(0);
        const httpReq = toHttpRequest(req, body);

        // Git smart HTTP.
        const gitPath = gitRepoPath(path);
        if (gitPath) {
          const repo = store.getRepo(gitPath.owner, gitPath.repo);
          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const isV2 = (httpReq.headers['git-protocol'] ?? '') === 'version=2';
          if (method === 'GET' && gitPath.suffix === 'info/refs') {
            const service = httpReq.query.get('service') ?? '';
            if (service === 'git-upload-pack') {
              const adv = isV2 ? advertiseUploadV2(repo) : advertiseUploadV0(repo);
              send(res, 200, 'application/x-git-upload-pack-advertisement', adv);
              return;
            }
            if (service === 'git-receive-pack') {
              send(res, 200, 'application/x-git-receive-pack-advertisement', advertiseReceiveV0(repo));
              return;
            }
            sendJson(res, 400, { message: 'service is required' });
            return;
          }
          if (method === 'POST' && gitPath.suffix === 'git-upload-pack') {
            if (isV2) {
              // ls-refs and fetch are both POSTed here; tell them apart by the first command.
              const firstLine = body.subarray(0, 64).toString('utf8');
              if (firstLine.includes('command=ls-refs')) {
                send(res, 200, 'application/x-git-upload-pack-result', handleLsRefs(repo, body));
              } else {
                send(res, 200, 'application/x-git-upload-pack-result', handleFetchV2(repo, body));
              }
            } else {
              send(res, 200, 'application/x-git-upload-pack-result', handleFetchV0(repo, body));
            }
            return;
          }
          if (method === 'POST' && gitPath.suffix === 'git-receive-pack') {
            send(res, 200, 'application/x-git-receive-pack-result', handleReceivePack(repo, body));
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql' && method === 'POST') {
          const auth = httpReq.headers['authorization'] ?? '';
          const m = /^Bearer (.+)$/.exec(auth.trim());
          if (!m || (viewerToken !== '' && m[1] !== viewerToken) || (viewerToken === '' && m[1] !== 'test-token')) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'Malformed JSON in request body' }] });
            return;
          }
          if (Array.isArray(parsed)) {
            const results = parsed.map((doc) => graphql.execute(doc as { query: string; variables?: Record<string, unknown> }));
            sendJson(res, 200, results);
          } else if (parsed !== null && typeof parsed === 'object') {
            sendJson(res, 200, graphql.execute(parsed as { query: string; variables?: Record<string, unknown> }));
          } else {
            sendJson(res, 400, { errors: [{ message: 'Request body must be a JSON object or array' }] });
          }
          return;
        }

        // MCP.
        if (path === '/mcp') {
          const out: HttpResponse = mcp.handle(httpReq);
          send(res, out.status, out.headers['content-type'] ?? JSON_TYPE, out.body, out.headers);
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const out: HttpResponse = rest.handle(httpReq);
          send(res, out.status, out.headers['content-type'] ?? JSON_TYPE, out.body, out.headers);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
        }
      }
    })();
  });
}
