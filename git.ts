// Git object model, packfile codec and pkt-line framing. Pure Node stdlib.
// Packs we SEND are always full objects (no deltas): a real git client accepts them
// and they are far cheaper to build. Packs we RECEIVE may carry deltas (the suite's
// client sends them), so the reader resolves OFS_DELTA and REF_DELTA.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import type { GitObject, Repo } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id of an object: sha1("<type> <len>\0" + content). */
export function objectId(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export function putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const oid = objectId(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------------------
// Tree and commit parsing
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    const rawMode = data.subarray(off, space).toString('ascii');
    // Git writes a directory's mode as `40000` (no leading zero); normalize it
    // to `040000` so every consumer sees one form. The oid is read from the
    // raw bytes, so this never changes an object's identity.
    const mode = rawMode === '40000' ? '040000' : rawMode;
    const nul = data.indexOf(0, space);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface Commit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  raw: Buffer;
}

export function parseCommit(data: Buffer): Commit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, raw: data };
}

export function serializeCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  let s = `tree ${tree}\n`;
  for (const p of parents) s += `parent ${p}\n`;
  s += `author ${author}\ncommitter ${committer}\n\n${message}`;
  return Buffer.from(s, 'utf8');
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

/** All objects reachable from `roots` (commits walk parents, trees, blobs). */
export function reachableObjects(repo: Repo, roots: string[], maxDepth: number): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const queue: Array<{ oid: string; depth: number }> = roots.map((oid) => ({ oid, depth: 0 }));
  const seenCommits = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth } = queue.pop() as { oid: string; depth: number };
    const obj = repo.objects.get(oid);
    if (!obj || out.has(oid)) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      if (seenCommits.has(oid)) continue;
      seenCommits.add(oid);
      const c = parseCommit(obj.data);
      // A commit's own tree and blobs always travel with it; only parent
      // expansion stops at the depth limit (shallow boundary). A commit at
      // depth d is included iff d < maxDepth, so parents (depth d+1) are
      // pushed only when d+1 < maxDepth.
      if (c.tree) queue.push({ oid: c.tree, depth });
      if (depth + 1 < maxDepth) {
        for (const p of c.parents) queue.push({ oid: p, depth: depth + 1 });
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) queue.push({ oid: e.oid, depth });
    }
  }
  return out;
}

/** Depth (generations) from any root to `target`, or -1 when unreachable. */
export function commitDepth(repo: Repo, roots: string[], target: string): number {
  const queue: Array<{ oid: string; depth: number }> = roots.map((oid) => ({ oid, depth: 0 }));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift() as { oid: string; depth: number };
    if (cur.oid === target) return cur.depth;
    if (seen.has(cur.oid)) continue;
    seen.add(cur.oid);
    const obj = repo.objects.get(cur.oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, depth: cur.depth + 1 });
  }
  return -1;
}

/** True when `ancestor` is reachable from `tip` (or equal). */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const queue: string[] = [tip];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return false;
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Split a buffer into pkt-line packets. Throws on garbage. */
export function parsePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line');
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
    } else {
      if (off + len > buf.length) throw new Error('truncated pkt-line payload');
      out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
      off += len;
    }
  }
  return out;
}

/** Sideband packet: band byte + data, framed as one pkt-line (max 65520). */
export function sidebandPacket(band: number, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from([band]), data]);
  return pktLine(payload);
}

/** Split data into sideband band-1 packets of at most 65515 payload bytes. */
export function sidebandData(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const MAX = 65515;
  for (let off = 0; off < data.length; off += MAX) {
    out.push(sidebandPacket(1, data.subarray(off, Math.min(data.length, off + MAX))));
  }
  if (data.length === 0) out.push(sidebandPacket(1, Buffer.alloc(0)));
  return out;
}

// ---------------------------------------------------------------------------
// Pack writing (full objects only, no deltas)
// ---------------------------------------------------------------------------

const PACK_TYPES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Pack entry type numbers to names; module-level so readPack does not rebuild it per pack. */
const PACK_TYPE_NAMES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function encodeObjectHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (type << 4) | (size & 0x0f);
  size >>>= 4;
  if (size > 0) b |= 0x80;
  bytes.push(b);
  while (size > 0) {
    b = size & 0x7f;
    size >>>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

export function buildPack(objects: Map<string, GitObject>): Buffer {
  const entries: Buffer[] = [];
  const sorted = [...objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [, obj] of sorted) {
    const typeNum = PACK_TYPES[obj.type] as number;
    entries.push(encodeObjectHeader(typeNum, obj.data.length));
    // An object that arrived as a pack entry keeps its validated deflated
    // bytes: concatenating them is far cheaper than deflating again, and the
    // bytes are byte-identical to what a fresh deflate would emit for this
    // data (same compressor, same level, same input).
    entries.push(obj.deflated !== undefined ? obj.deflated : deflateSync(obj.data));
  }
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  const body = Buffer.concat([header, ...entries]);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// Pack reading (with delta resolution)
// ---------------------------------------------------------------------------

function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = buf[off] & 0x7f;
  let next = off + 1;
  while (buf[off] & 0x80) {
    value = ((value + 1) << 7) | (buf[next] & 0x7f);
    off = next;
    next += 1;
  }
  return { value, next };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readDeltaVarint = (): number => {
    let v = 0;
    let shift = 0;
    while (true) {
      const b = delta[off++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readDeltaVarint();
  const dstSize = readDeltaVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) cpOff |= delta[off++] << (8 * i);
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) cpSize |= delta[off++] << (8 * i);
      }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op > 0) {
      out.push(delta.subarray(off, off + op));
      off += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== dstSize || total !== dstSize) throw new Error('delta size mismatch');
  return result;
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Parse a whole packfile. `resolveRefBase` looks up REF_DELTA bases already in the store. */
export function readPack(pack: Buffer, resolveRefBase?: (oid: string) => GitObject | undefined): ReadPackResult {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const actual = sha1Hex(pack.subarray(0, pack.length - 20));
  if (actual !== trailer.toString('hex')) throw new Error('pack trailer checksum mismatch');

  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  let off = 12;
  // First pass: read all entries, deferring deltas whose base is not yet known.
  interface Pending { offset: number; type: number; baseOff?: number; baseOid?: string; data: Buffer; }
  const pending: Pending[] = [];
  for (let i = 0; i < count; i += 1) {
    const entryStart = off;
    let b = pack[off++];
    const type = (b >> 4) & 0x7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = pack[off++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseOff: number | undefined;
    let baseOid: string | undefined;
    if (type === 6) {
      const r = readVarint(pack, off);
      baseOff = entryStart - r.value;
      off = r.next;
    } else if (type === 7) {
      baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    // One call inflates the stream AND reports how many input bytes it used
    // (engine.bytesWritten), so the next entry starts exactly at the stream's
    // end — no second pass, no guessing, no thrown probes.
    const streamStart = off;
    const inflatedOut = inflateSync(pack.subarray(off), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const inflated = inflatedOut.buffer;
    off += inflatedOut.engine.bytesWritten;
    if (type === 6 || type === 7) {
      deltaCount += 1;
      pending.push({ offset: entryStart, type, baseOff, baseOid, data: inflated });
    } else {
      const name = PACK_TYPE_NAMES[type] as GitObject['type'];
      const oid = objectId(name, inflated);
      const obj: GitObject = { type: name, data: inflated, deflated: pack.subarray(streamStart, off) };
      objects.set(oid, obj);
      byOffset.set(entryStart, obj);
    }
  }
  // Resolve deltas, possibly chained.
  const resolveOne = (p: Pending, depth: number): GitObject => {
    if (depth > 64) throw new Error('delta chain too deep');
    let base: GitObject | undefined;
    if (p.baseOff !== undefined) {
      base = byOffset.get(p.baseOff);
      if (!base) {
        const bp = pending.find((x) => x.offset === p.baseOff);
        if (!bp) throw new Error('ofs-delta base missing');
        base = resolveOne(bp, depth + 1);
      }
    } else if (p.baseOid !== undefined) {
      base = objects.get(p.baseOid) ?? resolveRefBase?.(p.baseOid);
      if (!base) {
        const bp = pending.find((x) => {
          const oid = x.type === 6 || x.type === 7 ? undefined : objectId(PACK_TYPE_NAMES[x.type] as GitObject['type'], x.data);
          return oid === p.baseOid;
        });
        if (bp) base = resolveOne(bp, depth + 1);
      }
      if (!base) throw new Error(`ref-delta base ${p.baseOid} missing`);
    } else {
      throw new Error('delta without base');
    }
    const data = applyDelta(base.data, p.data);
    // Delta result type is the base's type.
    const oid = objectId(base.type, data);
    const obj: GitObject = { type: base.type, data };
    objects.set(oid, obj);
    byOffset.set(p.offset, obj);
    return obj;
  };
  for (const p of pending) {
    if (!byOffset.has(p.offset)) resolveOne(p, 0);
  }
  return { objects, deltaCount };
}
