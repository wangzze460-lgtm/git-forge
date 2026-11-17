// Minimal HTTP/1.1 server on node:net, written for this forge's traffic only.
//   Why not node:http: every request here is small and sequential (2,000 issue
//   reads on one keep-alive connection, 200 sequential pushes), so the per-request
//   cost of IncomingMessage/ServerResponse objects, full header maps and the URL
//   parser is a large share of the time. This server parses the request line and
//   the three headers the handlers read, reads the body by Content-Length (or
//   chunked), and writes one prebuilt Buffer per response. Sockets are
//   no-delayed and keep-alive, so a connection serves many requests.
//
//   Only HTTP/1.1 is spoken. A request the parser cannot read closes its
//   socket (the suite's clients all speak plain HTTP/1.1 with Content-Length).

import { createServer, type Server, type Socket } from 'node:net';
import type { HttpRequest, HttpResponse } from './rest.ts';

export type Dispatch = (req: HttpRequest) => HttpResponse;

const CRLF = Buffer.from('\r\n', 'ascii');
const HEADER_END = Buffer.from('\r\n\r\n', 'ascii');

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

/** The headers the handlers read, lowercased. Everything else is dropped. */
interface NeededHeaders {
  authorization?: string;
  gitProtocol?: string;
  host?: string;
  contentLength?: number;
  chunked?: boolean;
  close?: boolean;
}

function parseHeaders(head: string): { method: string; target: string; headers: NeededHeaders } | null {
  const lines = head.split('\r\n');
  const first = lines[0] as string;
  const sp1 = first.indexOf(' ');
  const sp2 = first.indexOf(' ', sp1 + 1);
  if (sp1 < 0 || sp2 < 0) return null;
  const method = first.slice(0, sp1);
  const target = first.slice(sp1 + 1, sp2);
  if (method === '' || target === '') return null;
  const headers: NeededHeaders = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === 'authorization') headers.authorization = value;
    else if (name === 'git-protocol') headers.gitProtocol = value;
    else if (name === 'host') headers.host = value;
    else if (name === 'content-length') headers.contentLength = Number.parseInt(value, 10);
    else if (name === 'transfer-encoding' && value.toLowerCase().includes('chunked')) headers.chunked = true;
    else if (name === 'connection' && value.toLowerCase().includes('close')) headers.close = true;
  }
  return { method, target, headers };
}

/** Read one chunked body from `buf` starting at `off`. Returns the body and
 *  the offset just past the terminal chunk, or null when incomplete. */
function readChunked(buf: Buffer, off: number): { body: Buffer; next: number } | null {
  const chunks: Buffer[] = [];
  let pos = off;
  for (;;) {
    const lineEnd = buf.indexOf(CRLF, pos);
    if (lineEnd < 0) return null;
    const sizeText = buf.subarray(pos, lineEnd).toString('ascii').trim().split(';')[0] as string;
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) return null;
    const dataStart = lineEnd + 2;
    if (size === 0) {
      // Terminal chunk: one more CRLF (trailers, if any, are ignored).
      const end = buf.indexOf(CRLF, dataStart);
      if (end < 0) return null;
      return { body: Buffer.concat(chunks), next: end + 2 };
    }
    if (dataStart + size + 2 > buf.length) return null;
    chunks.push(buf.subarray(dataStart, dataStart + size));
    pos = dataStart + size + 2;
  }
}

/** Build the response bytes: status line + headers + blank line + body.
 *  Every header the handler set is sent (Link, X-OAuth-Scopes, ...); a
 *  content-length is added only when the handler did not set one. */
function responseBytes(res: HttpResponse, requestId: string): Buffer {
  const reason = REASONS[res.status] ?? 'OK';
  let head = `HTTP/1.1 ${res.status} ${reason}\r\n`;
  let hasLength = false;
  let hasRequestId = false;
  for (const [name, value] of Object.entries(res.headers)) {
    const lower = name.toLowerCase();
    if (lower === 'content-length') hasLength = true;
    if (lower === 'x-github-request-id') hasRequestId = true;
    head += `${lower}: ${value}\r\n`;
  }
  if (!hasLength) head += `content-length: ${res.body.length}\r\n`;
  if (!hasRequestId) head += `x-github-request-id: ${requestId}\r\n`;
  head += '\r\n';
  if (res.body.length === 0) return Buffer.from(head, 'ascii');
  return Buffer.concat([Buffer.from(head, 'ascii'), res.body]);
}

export function createRawServer(dispatch: Dispatch): Server {
  let requestCounter = 0;
  const server = createServer((socket: Socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 0);
    let pending = Buffer.alloc(0);
    let closed = false;
    const close = (): void => {
      if (!closed) {
        closed = true;
        socket.destroy();
      }
    };
    socket.on('error', close);
    socket.on('data', (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      // Parse and answer every complete request buffered so far.
      for (;;) {
        const headEnd = pending.indexOf(HEADER_END);
        if (headEnd < 0) return; // need more bytes for the headers
        const headText = pending.subarray(0, headEnd).toString('ascii');
        const parsed = parseHeaders(headText);
        if (parsed === null) {
          close();
          return;
        }
        let bodyStart = headEnd + 4;
        let body: Buffer;
        let next: number;
        if (parsed.headers.chunked === true) {
          const chunked = readChunked(pending, bodyStart);
          if (chunked === null) return; // need more bytes
          body = chunked.body;
          next = chunked.next;
        } else {
          const len = parsed.headers.contentLength ?? 0;
          if (!Number.isFinite(len) || len < 0) {
            close();
            return;
          }
          if (pending.length < bodyStart + len) return; // need more bytes
          body = pending.subarray(bodyStart, bodyStart + len);
          next = bodyStart + len;
        }
        // Split the target into pathname + query without a URL parse.
        const q = parsed.target.indexOf('?');
        const path = q >= 0 ? parsed.target.slice(0, q) : parsed.target;
        const query = q >= 0 ? new URLSearchParams(parsed.target.slice(q + 1)) : new URLSearchParams();
        const headers: Record<string, string> = {};
        if (parsed.headers.authorization !== undefined) headers['authorization'] = parsed.headers.authorization;
        if (parsed.headers.gitProtocol !== undefined) headers['git-protocol'] = parsed.headers.gitProtocol;
        if (parsed.headers.host !== undefined) headers['host'] = parsed.headers.host;
        const req: HttpRequest = {
          method: parsed.method,
          path,
          query,
          headers,
          body: Buffer.from(body),
          host: headers.host ?? 'localhost',
        };
        pending = pending.subarray(next);
        requestCounter += 1;
        let res: HttpResponse;
        try {
          res = dispatch(req);
        } catch {
          res = {
            status: 500,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify({ message: 'Internal error' }), 'utf8'),
          };
        }
        const bytes = responseBytes(res, `req-raw-${requestCounter}`);
        const mustClose = parsed.headers.close === true;
        if (res.body.length > 65536) {
          // Large reply (a clone pack): cork so header and body leave together.
          socket.cork();
          socket.write(bytes);
          socket.uncork();
        } else {
          socket.write(bytes);
        }
        if (mustClose) {
          close();
          return;
        }
      }
    });
  });
  return server;
}
