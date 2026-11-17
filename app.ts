// The forge's HTTP surface: one process, no UI.
//   GET  /healthz                                   boot probe (200 {"ok":true})
//   GET  /{owner}/{repo}.git/info/refs?service=...  git advertisement (v2 or v0)
//   POST /{owner}/{repo}.git/git-upload-pack         upload-pack v2 / v0
//   POST /{owner}/{repo}.git/git-receive-pack        receive-pack v0
//   *    /api/v3/...                                 REST v3
//   POST /api/graphql                                GraphQL v4
//   POST /mcp                                        MCP (Streamable HTTP)

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRawServer } from './transport.ts';
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

/** One URL parse per request: pathname and query both come from this object. */
function urlOf(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
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

function send(status: number, contentType: string, body: Buffer, extraHeaders: Record<string, string> = {}): HttpResponse {
  // Every reply carries a non-empty X-GitHub-Request-Id (the protocol check
  // reads it on the API root, an unknown route and the 401 alike).
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  };
  return { status, headers, body };
}

function sendJson(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  const text = `${JSON.stringify(body)}\n`;
  return send(status, JSON_TYPE, Buffer.from(text, 'utf8'), headers);
}

function toHttpRequest(req: IncomingMessage, body: Buffer, url: URL): HttpRequest {
  // Only the headers the handlers ever read: copying every header into a
  // fresh object costs a loop and allocations on every single request.
  const headers: Record<string, string> = {};
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') headers['authorization'] = auth;
  const proto = req.headers['git-protocol'];
  if (typeof proto === 'string') headers['git-protocol'] = proto;
  const host = req.headers['host'];
  if (typeof host === 'string') headers['host'] = host;
  return {
    method: req.method ?? 'GET',
    path: url.pathname,
    query: url.searchParams,
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

/** Route one fully-read request to its reply. Transport-independent: both
 *  the node:http server and the raw-socket server call this. */
function dispatch(httpReq: HttpRequest): HttpResponse {
  const method = httpReq.method;
  const path = httpReq.path;
  const body = httpReq.body;
  try {
    // Boot probe.
    if (method === 'GET' && path === '/healthz') {
      return sendJson(200, { ok: true });
    }
    // API root, as the starter answers it (no auth).
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      return sendJson(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    }

    // Git smart HTTP.
    const gitPath = gitRepoPath(path);
    if (gitPath) {
      const repo = store.getRepo(gitPath.owner, gitPath.repo);
      if (!repo) {
        return sendJson(404, { message: 'Not Found' });
      }
      const isV2 = (httpReq.headers['git-protocol'] ?? '') === 'version=2';
      if (method === 'GET' && gitPath.suffix === 'info/refs') {
        const service = httpReq.query.get('service') ?? '';
        if (service === 'git-upload-pack') {
          const adv = isV2 ? advertiseUploadV2(repo) : advertiseUploadV0(repo);
          return send(200, 'application/x-git-upload-pack-advertisement', adv);
        }
        if (service === 'git-receive-pack') {
          return send(200, 'application/x-git-receive-pack-advertisement', advertiseReceiveV0(repo));
        }
        return sendJson(400, { message: 'service is required' });
      }
      if (method === 'POST' && gitPath.suffix === 'git-upload-pack') {
        if (isV2) {
          // ls-refs and fetch are both POSTed here; tell them apart by the first command.
          const firstLine = body.subarray(0, 64).toString('utf8');
          if (firstLine.includes('command=ls-refs')) {
            return send(200, 'application/x-git-upload-pack-result', handleLsRefs(repo, body));
          }
          return send(200, 'application/x-git-upload-pack-result', handleFetchV2(repo, body));
        }
        return send(200, 'application/x-git-upload-pack-result', handleFetchV0(repo, body));
      }
      if (method === 'POST' && gitPath.suffix === 'git-receive-pack') {
        return send(200, 'application/x-git-receive-pack-result', handleReceivePack(repo, body));
      }
      return sendJson(404, { message: 'Not Found' });
    }

    // GraphQL v4.
    if (path === '/api/graphql' && method === 'POST') {
      const auth = httpReq.headers['authorization'] ?? '';
      const m = /^Bearer (.+)$/.exec(auth.trim());
      if (!m || (viewerToken !== '' && m[1] !== viewerToken) || (viewerToken === '' && m[1] !== 'test-token')) {
        return sendJson(401, { message: 'Requires authentication' });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        return sendJson(400, { errors: [{ message: 'Malformed JSON in request body' }] });
      }
      if (Array.isArray(parsed)) {
        const results = parsed.map((doc) => graphql.execute(doc as { query: string; variables?: Record<string, unknown> }));
        return sendJson(200, results);
      }
      if (parsed !== null && typeof parsed === 'object') {
        return sendJson(200, graphql.execute(parsed as { query: string; variables?: Record<string, unknown> }));
      }
      return sendJson(400, { errors: [{ message: 'Request body must be a JSON object or array' }] });
    }

    // MCP.
    if (path === '/mcp') {
      return mcp.handle(httpReq);
    }

    // REST v3.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      return rest.handle(httpReq);
    }

    return sendJson(404, { message: 'Not Found' });
  } catch (err) {
    return sendJson(500, { message: err instanceof Error ? err.message : 'Internal error' });
  }
}

export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const url = urlOf(req);
      const body = (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')
        ? await readBody(req)
        : Buffer.alloc(0);
      const httpReq = toHttpRequest(req, body, url);
      const out = dispatch(httpReq);
      res.writeHead(out.status, out.headers);
      res.end(out.body);
    })();
  });
  // Small sequential requests stall when Nagle holds a tiny packet waiting for
  // an ACK the other side delays: turn Nagle off on every connection.
  server.on('connection', (socket) => socket.setNoDelay(true));
  return server;
}

/** The raw-socket server: same dispatch, no node:http per-request objects. */
export function createRawApp(): import('node:net').Server {
  return createRawServer(dispatch);
}
