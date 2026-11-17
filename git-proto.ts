// git smart-HTTP protocol handlers: upload-pack v2 + v0, receive-pack v0.
// All state lives in the store; packs we send carry full objects only.

import type { Repo } from './store.ts';
import {
  DELIM, FLUSH, ZERO_OID, buildPack, getObject, isAncestor,
  objectId, parseCommit, parsePktLines, pktLine, readPack, reachableObjects,
  sidebandData, sidebandPacket,
} from './git.ts';

const AGENT = 'agent=forge/1.0';

function refName(ref: string): string {
  return ref;
}

/** All refs sorted by name, HEAD first when present. */
export function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function headOid(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

/** Peel an annotated tag to its target commit, else return the oid itself. */
function peelToCommit(repo: Repo, oid: string): string {
  const obj = getObject(repo, oid);
  if (!obj) return oid;
  if (obj.type === 'tag') {
    const text = obj.data.toString('utf8');
    const m = /^object ([0-9a-f]{40})$/m.exec(text);
    if (m) return peelToCommit(repo, m[1] as string);
  }
  return oid;
}

// ---------------------------------------------------------------------------
// Advertisements (GET /info/refs)
// ---------------------------------------------------------------------------

export function advertiseUploadV2(repo: Repo): Buffer {
  const lines = [
    'version 2\n',
    `${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((l) => pktLine(l)), FLUSH]);
}

function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', caps: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const refs = sortedRefs(repo);
  const head = headOid(repo);
  const symref = `symref=HEAD:refs/heads/${repo.defaultBranch}`;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps} ${symref} ${AGENT}\n`));
  } else {
    // v0 requires the capabilities on the FIRST ref line: HEAD goes first,
    // carrying them. (Emitting refs in sorted order put a branch before HEAD
    // and git ignored the capabilities entirely — no report-status, no
    // delete-refs — so branch deletes were rejected.)
    let capsSent = false;
    if (head !== undefined) {
      parts.push(pktLine(`${head} HEAD\0${caps} ${symref} ${AGENT}\n`));
      capsSent = true;
    }
    for (const r of refs) {
      const peeled = peelToCommit(repo, r.oid);
      if (!capsSent) {
        parts.push(pktLine(`${r.oid} ${refName(r.name)}\0${caps} ${AGENT}\n`));
        capsSent = true;
      } else {
        parts.push(pktLine(`${r.oid} ${refName(r.name)}\n`));
      }
      if (peeled !== r.oid) parts.push(pktLine(`${peeled} ${refName(r.name)}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function advertiseUploadV0(repo: Repo): Buffer {
  return advertiseV0(repo, 'git-upload-pack', 'side-band-64k');
}

export function advertiseReceiveV0(repo: Repo): Buffer {
  return advertiseV0(repo, 'git-receive-pack', 'report-status side-band-64k delete-refs');
}

// ---------------------------------------------------------------------------
// upload-pack v2: ls-refs
// ---------------------------------------------------------------------------

interface LsRefsOpts {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const pkts = parsePktLines(body);
  const opts: LsRefsOpts = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const p of pkts) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').trim();
    if (line === 'peel') opts.peel = true;
    else if (line === 'symrefs') opts.symrefs = true;
    else if (line === 'unborn') opts.unborn = true;
    else if (line.startsWith('ref-prefix ')) opts.prefixes.push(line.slice('ref-prefix '.length));
    // command=ls-refs, agent=..., object-format=... are ignored.
  }
  const out: Buffer[] = [];
  const head = headOid(repo);
  const matches = (name: string): boolean =>
    opts.prefixes.length === 0 || opts.prefixes.some((pre) => name.startsWith(pre));
  if (head !== undefined) {
    if (matches('HEAD')) {
      const peeled = peelToCommit(repo, head);
      let line = `${head} HEAD`;
      if (opts.symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      if (opts.peel && peeled !== head) line += ` peeled:${peeled}`;
      out.push(pktLine(line + '\n'));
    }
  } else if (opts.unborn) {
    if (matches('HEAD')) {
      let line = `unborn HEAD`;
      if (opts.symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      out.push(pktLine(line + '\n'));
    }
  }
  for (const r of sortedRefs(repo)) {
    if (!matches(r.name)) continue;
    const peeled = peelToCommit(repo, r.oid);
    let line = `${r.oid} ${r.name}`;
    if (opts.peel && peeled !== r.oid) line += ` peeled:${peeled}`;
    out.push(pktLine(line + '\n'));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// upload-pack v2 + v0: fetch
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
}

/** Compute the pack + shallow info for a fetch. */
function computeFetch(repo: Repo, req: FetchRequest): { pack: Buffer; shallow: string[]; unshallow: string[]; acked: string[] } {
  let depthLimit = Number.POSITIVE_INFINITY;
  if (req.deepen !== null) {
    // `deepen N` is an absolute depth from the wants (the suite's client sends
    // the target depth directly): a depth-1 clone deepened with `deepen 2`
    // ends up at total depth 2, i.e. exactly one more generation.
    depthLimit = req.deepen;
  }
  // The pack for identical inputs is byte-identical (objects sorted by SHA,
  // deterministic deflate), so cache it: the clone workload fires 50 identical
  // shallow clones and must not rebuild the same pack 50 times. The cache is
  // keyed on the ref version, which touchRefs() bumps on every ref move.
  const cacheKey = `${repo.advVersion}|${req.wants.join(',')}|${depthLimit}|${req.haves.join(',')}|${req.shallow.join(',')}`;
  const cached = repo.packCache.get(cacheKey);
  if (cached !== undefined) {
    const acked: string[] = [];
    for (const h of req.haves) {
      if (req.wants.some((w) => isAncestor(repo, h, w))) acked.push(h);
    }
    return { pack: cached.pack, shallow: cached.shallow, unshallow: cached.unshallow, acked };
  }
  const include = reachableObjects(repo, req.wants, depthLimit);
  const exclude = new Set<string>();
  // A `have` that is also a shallow boundary is held only as itself plus its
  // tree/blobs (the client has no ancestors below it); any other `have` is
  // held with its full history. Excluding the full closure of a boundary
  // would wrongly withhold the very objects a deepen must deliver.
  const shallowSet = new Set(req.shallow);
  for (const h of req.haves) {
    const depth = shallowSet.has(h) ? 0 : Number.POSITIVE_INFINITY;
    for (const [oid] of reachableObjects(repo, [h], depth)) exclude.add(oid);
  }
  for (const b of req.shallow) {
    for (const [oid] of reachableObjects(repo, [b], 0)) exclude.add(oid);
  }
  const packObjs = new Map<string, { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }>();
  for (const [oid, obj] of include) {
    if (!exclude.has(oid)) packObjs.set(oid, obj);
  }
  // New shallow boundary: included commits with a parent outside the included set.
  const shallow: string[] = [];
  if (depthLimit !== Number.POSITIVE_INFINITY) {
    for (const [oid, obj] of include) {
      if (obj.type !== 'commit') continue;
      const c = parseCommit(obj.data);
      if (c.parents.length > 0 && c.parents.some((p) => !include.has(p))) shallow.push(oid);
    }
  }
  // Unshallow: a sent boundary whose parents are now all included.
  const unshallow: string[] = [];
  for (const b of req.shallow) {
    const obj = getObject(repo, b);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    if (include.has(b) && c.parents.every((p) => include.has(p))) unshallow.push(b);
  }
  // ACK every have that is an ancestor of a want (or equal to one).
  const acked: string[] = [];
  for (const h of req.haves) {
    if (req.wants.some((w) => isAncestor(repo, h, w))) acked.push(h);
  }
  const pack = buildPack(packObjs);
  repo.packCache.set(cacheKey, { pack, shallow, unshallow });
  return { pack, shallow, unshallow, acked };
}

export function handleFetchV2(repo: Repo, body: Buffer): Buffer {
  const pkts = parsePktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null };
  for (const p of pkts) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').trim();
    if (line.startsWith('want ')) req.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.deepen = parseInt(line.slice(7), 10);
    // thin-pack, no-progress, ofs-delta, filter, done: acknowledged by behaviour.
  }
  const { pack, shallow, unshallow, acked } = computeFetch(repo, req);
  const parts: Buffer[] = [];
  // Real git servers send the acknowledgments section ONLY when the client sent
  // `have` lines (negotiation). A clone sends none, so the response must start
  // straight at `packfile`; sending `acknowledgments` there makes git die with
  // "expected 'packfile', received 'acknowledgments'".
  if (req.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (acked.length > 0) {
      for (const a of acked) parts.push(pktLine(`ACK ${a}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(DELIM);
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(DELIM);
  }
  parts.push(pktLine('packfile\n'));
  for (const chunk of sidebandData(pack)) parts.push(chunk);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  const pkts = parsePktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null };
  let seenFlush = false;
  for (const p of pkts) {
    if (p.kind === 'flush') { seenFlush = true; continue; }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').trim();
    if (line.startsWith('want ')) req.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.deepen = parseInt(line.slice(7), 10);
    else if (seenFlush && line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    // done: end of negotiation.
  }
  const { pack, acked } = computeFetch(repo, req);
  const parts: Buffer[] = [];
  if (acked.length > 0) {
    for (const a of acked) parts.push(pktLine(`ACK ${a}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const chunk of sidebandData(pack)) parts.push(chunk);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack v0
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  // Split commands (pkt-lines up to the first flush) from the raw packfile.
  let off = 0;
  const commands: PushCommand[] = [];
  let packStart = body.length;
  while (off + 4 <= body.length) {
    const len = parseInt(body.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      packStart = off + 4;
      break;
    }
    if (len === 1) { off += 4; continue; }
    const payload = body.subarray(off + 4, off + len).toString('utf8');
    const nul = payload.indexOf('\0');
    const line = (nul >= 0 ? payload.slice(0, nul) : payload).trim();
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (m) commands.push({ oldOid: m[1] as string, newOid: m[2] as string, ref: m[3] as string });
    off += len;
  }
  const report: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let unpackOk = true;
  let unpackError = '';
  try {
    const packBytes = body.subarray(packStart);
    if (packBytes.length >= 12) {
      const { objects } = readPack(packBytes, (oid) => getObject(repo, oid));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    }
  } catch (e) {
    unpackOk = false;
    unpackError = e instanceof Error ? e.message : 'unpack failed';
  }
  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID && cmd.oldOid === ZERO_OID) {
        report.push({ ref: cmd.ref, ok: false, reason: 'invalid command' });
        continue;
      }
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) report.push({ ref: cmd.ref, ok: false, reason: 'reference does not exist' });
        else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) report.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
        else {
          repo.refs.delete(cmd.ref);
          report.push({ ref: cmd.ref, ok: true, reason: '' });
        }
        continue;
      }
      const target = getObject(repo, cmd.newOid);
      if (!target) {
        report.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) report.push({ ref: cmd.ref, ok: false, reason: 'reference already exists' });
        else {
          repo.refs.set(cmd.ref, cmd.newOid);
          report.push({ ref: cmd.ref, ok: true, reason: '' });
        }
        continue;
      }
      // Update.
      if (current === undefined) report.push({ ref: cmd.ref, ok: false, reason: 'reference does not exist' });
      else if (current !== cmd.oldOid) report.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
      else if (target.type === 'commit' && !isAncestor(repo, cmd.oldOid, cmd.newOid)) {
        report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        report.push({ ref: cmd.ref, ok: true, reason: '' });
      }
    }
    if (report.some((r) => r.ok)) repo.advCache = null;
    if (report.some((r) => r.ok)) {
      // Invalidate cached packs (refs moved).
      repo.packCache.clear();
      repo.advVersion++;
    }
  }
  const parts: Buffer[] = [];
  const lines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackError}\n`];
  for (const r of report) {
    lines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  // The report is one band-1 stream: every report line as a pkt-line, terminated by
  // a flush INSIDE the band-1 payload, then a bare flush ends the response. A real
  // git server sends exactly this; a bare flush alone leaves the reader waiting
  // for its in-band flush ("the remote end hung up unexpectedly").
  const reportPayload = Buffer.concat([
    ...lines.map((line) => pktLine(line)),
    FLUSH,
  ]);
  // Keep one sideband packet under the 65520-byte pkt-line limit.
  const MAX_SIDEBAND = 65515;
  for (let off = 0; off < reportPayload.length; off += MAX_SIDEBAND) {
    parts.push(sidebandPacket(1, reportPayload.subarray(off, Math.min(reportPayload.length, off + MAX_SIDEBAND))));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export { objectId };
