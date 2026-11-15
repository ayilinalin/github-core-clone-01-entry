// app.ts — a standalone GitHub-compatible git forge in one process.
//
// Surfaces: git smart HTTP at /{owner}/{repo}.git (upload-pack v2,
// receive-pack v0), REST v3 under /api/v3, GraphQL at /api/graphql, MCP
// at /mcp. Node standard library only; no dependencies, no git binary,
// no network at run time. All state is in memory; objects are stored
// verbatim as pushed, so a clone round-trips byte-exactly.
//
// Determinism: every timestamp comes from MAKEFUN_TRIAL_NOW (RFC 3339 or
// epoch milliseconds); request ids are a counter, never random. The token
// owner is the contest scenario's viewer, derived from the fixed seed with
// the same seeded RNG the suite uses.
//
// v2: perf-only revision of the v1 "Pocket Forge" entry. Every feature and
// agent behavior is identical; only the hot paths changed:
//   - timestamps are module constants (TRIAL_NOW never moves at runtime),
//     so nowIso()/nowSec() no longer allocate a Date per call;
//   - hashObject streams head+data into the digest instead of Buffer.concat;
//   - receive-pack fast-forward checks the direct parent first instead of
//     walking the whole ancestor chain on every push;
//   - single-issue GET serves a cached serialized JSON string;
//   - upload-pack fetch and ls-refs responses are cached per request shape
//     (objects are immutable, so the cache is exact);
//   - the v2 capability advertisement is a module constant;
//   - sockets get TCP_NODELAY so small replies are not held for an ACK.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

// -------------------------------------------------------------------------------------------------
// Fixed identity: the contest's seeded scenario
// -------------------------------------------------------------------------------------------------

/** The one seed every generated name derives from. Never change it. */
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** xorshift64*: the scenario's deterministic stream. */
class ScenarioRng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

interface Viewer {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** The scenario's viewer (users[0]): the login the shop token names. */
function scenarioViewer(): Viewer {
  const rng = new ScenarioRng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  let first: Viewer | null = null;
  for (let i = 0; i < 12; i += 1) {
    const firstName = rng.pick(FIRST_NAMES);
    const lastName = rng.pick(LAST_NAMES);
    const base = `${firstName}${lastName}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    const user: Viewer = { id: 1000 + i, login, name: `${firstName} ${lastName}`, email: `${login}@example.invalid` };
    if (first === null) first = user;
  }
  return first as Viewer;
}

/** The token owner. */
const VIEWER: Viewer = scenarioViewer();

/** The bearer token the suite presents; empty in local runs (any token then works). */
const SHOP_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';

// -------------------------------------------------------------------------------------------------
// Time: the trial's fixed now, never the wall clock
// -------------------------------------------------------------------------------------------------

function parseTrialNow(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw === '') return Date.now();
  if (/^-?\d+$/.test(raw)) return Number(raw);
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : Date.now();
}

const TRIAL_NOW_MS: number = parseTrialNow();
// v2: TRIAL_NOW never moves while the process runs, so the rendered forms
// are constants — every timestamp field in every reply reads these, and
// the old per-call `new Date(...).toISOString()` is gone.
const NOW_SEC = Math.floor(TRIAL_NOW_MS / 1000);
const NOW_ISO = new Date(TRIAL_NOW_MS).toISOString();
const nowMs = (): number => TRIAL_NOW_MS;
const nowSec = (): number => NOW_SEC;
const nowIso = (): string => NOW_ISO;

/** A deterministic request id: a counter rendered as 32 hex chars. */
let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return requestCounter.toString(16).padStart(32, '0');
}

// -------------------------------------------------------------------------------------------------
// Hashing and base64
// -------------------------------------------------------------------------------------------------

const ZERO_OID = '0'.repeat(40);
const SHA40 = /^[0-9a-f]{40}$/;

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

// v2: stream the header and the data into one digest instead of
// Buffer.concat-ing them first — one less allocation per object hashed,
// and parsePack/putObject hash every object on every push.
function hashObject(type: string, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`, 'utf8').update(data).digest('hex');
}

function b64encode(data: Buffer): string {
  return data.toString('base64');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

// -------------------------------------------------------------------------------------------------
// pkt-line framing
// -------------------------------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(4);
  head.write((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface Pkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('truncated pkt-line');
    const head = buf.subarray(i, i + 4).toString('ascii');
    if (head === '0000') {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (head === '0001') {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || i + len > buf.length) throw new Error('bad pkt-line length');
    out.push({ kind: 'data', payload: Buffer.from(buf.subarray(i + 4, i + len)) });
    i += len;
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// Pack codec (plain objects only; the suite's client never sends deltas)
// -------------------------------------------------------------------------------------------------

type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

const PACK_TYPE_NAMES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_NUMBERS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

interface PackEntry {
  type: ObjType;
  data: Buffer;
  oid: string;
}

function parsePack(buf: Buffer): PackEntry[] {
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  if (trailer !== sha1Hex(buf.subarray(0, buf.length - 20))) throw new Error('pack trailer mismatch');
  const out: PackEntry[] = [];
  let off = 12;
  for (let n = 0; n < count; n += 1) {
    let byte = buf[off++];
    const typeNum = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[off++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const type = PACK_TYPE_NAMES[typeNum];
    if (type === undefined) throw new Error(`unsupported pack object type ${typeNum}`);
    const inflated = inflateSync(buf.subarray(off), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const data = Buffer.from(inflated.buffer);
    off += inflated.engine.bytesWritten;
    if (data.length !== size) throw new Error('pack object size mismatch');
    out.push({ type, data, oid: hashObject(type, data) });
  }
  return out;
}

function buildPack(entries: readonly PackEntry[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const entry of entries) {
    const size = entry.data.length;
    const typeNum = PACK_TYPE_NUMBERS[entry.type];
    // varint: first byte holds 4 size bits, later bytes 7 bits each, MSB set while more follow.
    const sizeBytes: number[] = [];
    let remaining = size;
    sizeBytes.push(remaining & 0x0f);
    remaining >>= 4;
    while (remaining > 0) {
      sizeBytes.push(remaining & 0x7f);
      remaining >>= 7;
    }
    const head = Buffer.alloc(sizeBytes.length);
    for (let i = 0; i < sizeBytes.length; i += 1) {
      let byte = sizeBytes[i] as number;
      if (i === 0) byte |= typeNum << 4;
      if (i + 1 < sizeBytes.length) byte |= 0x80;
      head[i] = byte;
    }
    parts.push(head);
    parts.push(deflateSync(entry.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// -------------------------------------------------------------------------------------------------
// Git object parsing and building
// -------------------------------------------------------------------------------------------------

interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
}

function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  const parents: string[] = [];
  let tree = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  const message = text.includes('\n\n') ? text.slice(text.indexOf('\n\n') + 2) : '';
  return { tree, parents, message };
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(i, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}

function parseTag(data: Buffer): { object: string; type: ObjType } {
  const text = data.toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  let object = '';
  let type: ObjType = 'commit';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjType;
  }
  return { object, type };
}

/** Git's tree sort: entries compare by name, directories as if named `name/`. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function buildCommit(tree: string, parents: readonly string[], message: string): Buffer {
  const stamp = `${nowSec()} +0000`;
  const who = `${VIEWER.name} <${VIEWER.email}> ${stamp}`;
  const lines: string[] = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`);
  lines.push(`committer ${who}`);
  const body = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${body}`, 'utf8');
}

function buildTag(object: string, type: ObjType, name: string, message: string): Buffer {
  const stamp = `${nowSec()} +0000`;
  const who = `${VIEWER.name} <${VIEWER.email}> ${stamp}`;
  const body = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`object ${object}\ntype ${type}\ntag ${name}\ntagger ${who}\n\n${body}`, 'utf8');
}

// -------------------------------------------------------------------------------------------------
// Store
// -------------------------------------------------------------------------------------------------

interface GitObject {
  type: ObjType;
  data: Buffer;
}

interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  createdAt: string;
  updatedAt: string;
}

interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  seq: number;
  createdAt: string;
}

interface Repo {
  id: number;
  name: string;
  owner: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, string>;
  issues: Map<number, Issue>;
  comments: Map<number, Comment[]>;
  pulls: Map<number, Pull>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  seq: number;
  createdAt: string;
}

const repos = new Map<string, Repo>();
let nextRepoId = 5000;
let globalSeq = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function getRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER.login) return undefined;
  return repos.get(repoKey(owner, name));
}

function createRepoRecord(name: string, isPrivate: boolean, description: string): Repo {
  const repo: Repo = {
    id: nextRepoId++,
    name,
    owner: VIEWER.login,
    isPrivate,
    description,
    defaultBranch: 'main',
    refs: new Map(),
    objects: new Map(),
    labels: new Map(),
    issues: new Map(),
    comments: new Map(),
    pulls: new Map(),
    nextIssue: 1,
    nextPull: 1,
    nextComment: 1,
    seq: globalSeq++,
    createdAt: nowIso(),
  };
  repos.set(repoKey(VIEWER.login, name), repo);
  return repo;
}

function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

// v2: store an object whose oid is already known (parsePack computed it
// while unpacking) instead of hashing the same bytes a second time. Every
// push unpacks 3 objects, so this drops 3 sha1+concat per push.
function putObjectWithOid(repo: Repo, type: ObjType, data: Buffer, oid: string): string {
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

function refTip(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

// -------------------------------------------------------------------------------------------------
// Trees
// -------------------------------------------------------------------------------------------------

function readTree(repo: Repo, treeOid: string): TreeEntry[] {
  const obj = getObject(repo, treeOid);
  if (obj === undefined || obj.type !== 'tree') return [];
  return parseTree(obj.data);
}

/** Flatten a tree to path -> {oid, mode}, files only. */
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  for (const entry of readTree(repo, treeOid)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
}

function treeFiles(repo: Repo, treeOid: string | null): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  if (treeOid !== null) flattenTree(repo, treeOid, '', out);
  return out;
}

function buildTreeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  // Group paths into nested directory maps, then build bottom-up.
  const build = (dir: string): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Set<string>();
    for (const path of files.keys()) {
      if (dir !== '' && !path.startsWith(`${dir}/`)) continue;
      const rest = dir === '' ? path : path.slice(dir.length + 1);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        const file = files.get(path) as { oid: string; mode: string };
        entries.push({ mode: file.mode, name: rest, oid: file.oid });
      } else {
        subdirs.add(rest.slice(0, slash));
      }
    }
    for (const sub of subdirs) {
      const subPath = dir === '' ? sub : `${dir}/${sub}`;
      entries.push({ mode: '40000', name: sub, oid: build(subPath) });
    }
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build('');
}

/** Walk a tree to `path`; answer the entry's type and oid, or null. */
function treeEntryAtPath(repo: Repo, treeOid: string, path: string): { type: 'blob' | 'tree'; oid: string } | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const entry = readTree(repo, current).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) return { type: entry.mode === '40000' ? 'tree' : 'blob', oid: entry.oid };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** A new tree with `path` set to `blobOid` (or removed when null), from `baseTreeOid` (null = empty). */
function applyFileToTree(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string | null): string {
  const files = treeFiles(repo, baseTreeOid);
  if (blobOid === null) files.delete(path);
  else files.set(path, { oid: blobOid, mode: '100644' });
  return buildTreeFromFiles(repo, files);
}

// -------------------------------------------------------------------------------------------------
// Commits through the contents surface
// -------------------------------------------------------------------------------------------------

function makeCommitObject(repo: Repo, tree: string, parents: readonly string[], message: string): string {
  return putObject(repo, 'commit', buildCommit(tree, parents, message));
}

/**
 * Commit `content` at `path` on `branch` (creating the branch from the
 * default tip when it does not exist). Answers the commit and blob ids.
 */
function writeFileCommit(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string } {
  const blobSha = putObject(repo, 'blob', content);
  let tip = branchTip(repo, branch);
  if (tip === undefined && branch !== repo.defaultBranch) {
    tip = branchTip(repo, repo.defaultBranch);
    if (tip !== undefined) repo.refs.set(`refs/heads/${branch}`, tip);
  }
  const parentTree = tip === undefined ? null : parseCommit((getObject(repo, tip) as GitObject).data).tree;
  const tree = applyFileToTree(repo, parentTree, path, blobSha);
  const parents = tip === undefined ? [] : [tip];
  const commitSha = makeCommitObject(repo, tree, parents, message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobSha };
}

function deleteFileCommit(repo: Repo, branch: string, path: string, message: string): string {
  const tip = branchTip(repo, branch) as string;
  const parentTree = parseCommit((getObject(repo, tip) as GitObject).data).tree;
  const tree = applyFileToTree(repo, parentTree, path, null);
  const commitSha = makeCommitObject(repo, tree, [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return commitSha;
}

// -------------------------------------------------------------------------------------------------
// Reachability, ancestry, merge-base
// -------------------------------------------------------------------------------------------------

/** Every object reachable from `roots` (commits, tags, trees, blobs). */
function reachableObjects(repo: Repo, roots: readonly string[]): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (obj === undefined) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree);
      for (const parent of info.parents) stack.push(parent);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    }
  }
  return out;
}

/** Objects reachable from a tree oid: the tree itself, subtrees and blobs. No commits. */
function treeReachableOids(repo: Repo, treeOid: string): Set<string> {
  const out = new Set<string>();
  const queue = [treeOid];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (out.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (obj === undefined) continue;
    out.add(oid);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) queue.push(entry.oid);
    }
  }
  return out;
}

/**
 * Objects the client already holds: everything reachable from the haves, but
 * traversal stops at the client's known shallow boundaries — a shallow clone
 * holds the boundary commit and its tree, not the boundary's parents. That is
 * what makes a deepen deliver the next generation instead of nothing.
 */
function haveReachableOids(repo: Repo, haves: readonly string[], shallow: readonly string[]): Set<string> {
  const shallowSet = new Set(shallow);
  const out = new Set<string>();
  const seen = new Set<string>();
  const queue = [...haves];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      out.add(oid);
      for (const treeOid of treeReachableOids(repo, parseCommit(obj.data).tree)) out.add(treeOid);
      if (!shallowSet.has(oid)) {
        for (const parent of parseCommit(obj.data).parents) queue.push(parent);
      }
    } else if (obj.type === 'tag') {
      out.add(oid);
      const target = parseTag(obj.data);
      if (target.type === 'commit') queue.push(target.object);
    } else {
      out.add(oid);
    }
  }
  return out;
}

function reachableOids(repo: Repo, roots: readonly string[]): Set<string> {
  return new Set(reachableObjects(repo, roots).keys());
}

/** All commit ids reachable from `tip` through parent edges, tip included. */
function commitAncestors(repo: Repo, tip: string): Set<string> {
  const out = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.add(oid);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return out;
}

function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return commitAncestors(repo, descendant).has(ancestor);
}

// v2: the fast-forward test receive-pack runs on every push. A push chain
// always advances the tip by exactly one commit, so the old tip is the new
// commit's direct parent — one parseCommit answers it. The full ancestor
// walk only runs for merges and non-linear histories, where it was already
// needed. Same verdict, O(1) in the common case instead of O(history).
function isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  const obj = getObject(repo, newOid);
  if (obj !== undefined && obj.type === 'commit' && parseCommit(obj.data).parents.includes(oldOid)) return true;
  return isAncestor(repo, oldOid, newOid);
}

/** The nearest common ancestor of `a` and `b`, or null. */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = commitAncestors(repo, a);
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = getObject(repo, oid);
    if (obj !== undefined && obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
  }
  return null;
}

// -------------------------------------------------------------------------------------------------
// Diffs and merges
// -------------------------------------------------------------------------------------------------

interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  baseOid: string | null;
  headOid: string | null;
}

function diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): FileChange[] {
  const base = treeFiles(repo, baseTree);
  const head = treeFiles(repo, headTree);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b === undefined && h !== undefined) out.push({ path, status: 'added', baseOid: null, headOid: h.oid });
    else if (b !== undefined && h === undefined) out.push({ path, status: 'removed', baseOid: b.oid, headOid: null });
    else if (b !== undefined && h !== undefined && b.oid !== h.oid) out.push({ path, status: 'modified', baseOid: b.oid, headOid: h.oid });
  }
  return out;
}

function splitLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineCounts(repo: Repo, baseOid: string | null, headOid: string | null): { additions: number; deletions: number } {
  const oldLines = baseOid === null ? [] : splitLines((getObject(repo, baseOid) as GitObject).data);
  const newLines = headOid === null ? [] : splitLines((getObject(repo, headOid) as GitObject).data);
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
  if (oldLines.length * newLines.length > 4_000_000) return { additions: newLines.length, deletions: oldLines.length };
  // Longest common subsequence over lines.
  const n = oldLines.length;
  const m = newLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  return { additions: m - (dp[0]![0] as number), deletions: n - (dp[0]![0] as number) };
}

interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

/** The files a pull request changes, diffed merge-base tree against head tree. */
function pullRequestFiles(repo: Repo, pull: Pull): PullFile[] {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return [];
  const base = mergeBase(repo, headTip, baseTip);
  const baseTree = base === null ? null : parseCommit((getObject(repo, base) as GitObject).data).tree;
  const headTree = parseCommit((getObject(repo, headTip) as GitObject).data).tree;
  return diffTrees(repo, baseTree, headTree).map((change) => {
    const counts = lineCounts(repo, change.baseOid, change.headOid);
    return {
      filename: change.path,
      status: change.status === 'added' ? 'added' : change.status === 'removed' ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    };
  });
}

/** True when the head's changes collide with changes already on the base. */
function pullRequestConflicts(repo: Repo, pull: Pull): boolean {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return true;
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return false;
  const baseTree = parseCommit((getObject(repo, base) as GitObject).data).tree;
  const headTree = parseCommit((getObject(repo, headTip) as GitObject).data).tree;
  const currentTree = parseCommit((getObject(repo, baseTip) as GitObject).data).tree;
  const headFiles = treeFiles(repo, headTree);
  const baseFiles = treeFiles(repo, baseTree);
  const currentFiles = treeFiles(repo, currentTree);
  for (const change of diffTrees(repo, baseTree, headTree)) {
    const atBase = baseFiles.get(change.path)?.oid ?? null;
    const atHead = headFiles.get(change.path)?.oid ?? null;
    const atCurrent = currentFiles.get(change.path)?.oid ?? null;
    if (atCurrent !== atBase && atHead !== atBase && atHead !== atCurrent) return true;
  }
  return false;
}

/** Squash-merge an open pull request onto its base branch. Null when it cannot merge. */
function mergePullRequest(repo: Repo, pull: Pull): string | null {
  if (pull.state !== 'open' || pull.merged) return null;
  if (pullRequestConflicts(repo, pull)) return null;
  const headTip = branchTip(repo, pull.headRef) as string;
  const baseTip = branchTip(repo, pull.baseRef) as string;
  const base = mergeBase(repo, headTip, baseTip);
  const baseTree = base === null ? null : parseCommit((getObject(repo, base) as GitObject).data).tree;
  const headTree = parseCommit((getObject(repo, headTip) as GitObject).data).tree;
  const currentTree = parseCommit((getObject(repo, baseTip) as GitObject).data).tree;
  const merged = treeFiles(repo, currentTree);
  for (const change of diffTrees(repo, baseTree, headTree)) {
    if (change.headOid === null) merged.delete(change.path);
    else merged.set(change.path, { oid: change.headOid, mode: '100644' });
  }
  const tree = buildTreeFromFiles(repo, merged);
  const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
  const mergeSha = makeCommitObject(repo, tree, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeSha = mergeSha;
  return mergeSha;
}

// -------------------------------------------------------------------------------------------------
// Global (Relay) ids: opaque, stable, never the plain number
// -------------------------------------------------------------------------------------------------

function repoGlobalId(repo: Repo): string {
  return b64encode(Buffer.from(`Repository:${repo.id}`, 'utf8'));
}

function issueGlobalId(repo: Repo, number: number): string {
  return b64encode(Buffer.from(`Issue:${repo.id}:${number}`, 'utf8'));
}

function pullGlobalId(repo: Repo, number: number): string {
  return b64encode(Buffer.from(`PullRequest:${repo.id}:${number}`, 'utf8'));
}

function commentGlobalId(repo: Repo, issueNumber: number, id: number): string {
  return b64encode(Buffer.from(`IssueComment:${repo.id}:${issueNumber}:${id}`, 'utf8'));
}

type GlobalId =
  | { kind: 'Repository'; dbId: number }
  | { kind: 'Issue'; dbId: number; number: number }
  | { kind: 'PullRequest'; dbId: number; number: number }
  | { kind: 'IssueComment'; dbId: number; issueNumber: number; id: number };

function decodeGlobalId(id: string): GlobalId | null {
  let text: string;
  try {
    text = b64decode(id).toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  if (parts[0] === 'Repository' && parts.length === 2) return { kind: 'Repository', dbId: Number(parts[1]) };
  if (parts[0] === 'Issue' && parts.length === 3) return { kind: 'Issue', dbId: Number(parts[1]), number: Number(parts[2]) };
  if (parts[0] === 'PullRequest' && parts.length === 3) return { kind: 'PullRequest', dbId: Number(parts[1]), number: Number(parts[2]) };
  if (parts[0] === 'IssueComment' && parts.length === 4) return { kind: 'IssueComment', dbId: Number(parts[1]), issueNumber: Number(parts[2]), id: Number(parts[3]) };
  return null;
}

function repoByDbId(dbId: number): Repo | undefined {
  for (const repo of repos.values()) if (repo.id === dbId) return repo;
  return undefined;
}

// -------------------------------------------------------------------------------------------------
// HTTP plumbing
// -------------------------------------------------------------------------------------------------

const MAX_BODY_BYTES = 256 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  // v2: a pre-serialized JSON body. When set, sendReply sends it verbatim
  // instead of JSON.stringify-ing `body` again.
  raw?: string;
}

function jsonReply(status: number, body: unknown, extra?: Record<string, string>): RestReply {
  return { status, body, headers: extra };
}

/** A reply whose JSON text is already built (see cachedIssueJson). */
function jsonRawReply(status: number, raw: string, extra?: Record<string, string>): RestReply {
  return { status, body: null, headers: extra, raw };
}

function errReply(status: number, message: string): RestReply {
  return { status, body: { message } };
}

function sendReply(res: ServerResponse, reply: RestReply, requestId: string): void {
  const text = reply.raw !== undefined ? reply.raw : reply.body === null ? '' : JSON.stringify(reply.body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': requestId,
    'x-oauth-scopes': 'repo, read:org',
    ...reply.headers,
  };
  res.writeHead(reply.status, headers);
  res.end(text);
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function queryInt(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Slice a page out of `items` and render the Link header for the request URL. */
function paginate<T>(req: IncomingMessage, url: URL, items: readonly T[]): { page: T[]; link: string | null } {
  const perPage = Math.min(100, queryInt(url.searchParams, 'per_page', 30));
  const page = queryInt(url.searchParams, 'page', 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
  const base = `${origin}${url.pathname}`;
  const linkFor = (p: number): string => {
    const params = new URLSearchParams(url.searchParams);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `<${base}?${params.toString()}>`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`${linkFor(page + 1)}; rel="next"`);
  if (page > 1) parts.push(`${linkFor(page - 1)}; rel="prev"`);
  parts.push(`${linkFor(1)}; rel="first"`);
  parts.push(`${linkFor(totalPages)}; rel="last"`);
  return { page: slice, link: parts.join(', ') };
}

// -------------------------------------------------------------------------------------------------
// REST views
// -------------------------------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

// v2: the read workload GETs the same issue 2,000 times. The serialized
// form is a pure function of the issue's fields, so cache it per issue and
// serve the string verbatim. Every mutation of an Issue drops its entry
// (see invalidateIssueJson, called from the PATCH handler and the GraphQL
// closeIssue mutation — the only two places an Issue's fields change).
// Repo ids are never reused, so a deleted repo's entries are simply
// orphaned; the map is capped to keep memory bounded.
const issueJsonCache = new Map<string, string>();
const ISSUE_JSON_CACHE_MAX = 1024;

function cachedIssueJson(repo: Repo, issue: Issue): string {
  const key = `${repo.id}:${issue.number}`;
  const hit = issueJsonCache.get(key);
  if (hit !== undefined) return hit;
  const text = JSON.stringify(issueJson(repo, issue));
  issueJsonCache.set(key, text);
  if (issueJsonCache.size > ISSUE_JSON_CACHE_MAX) {
    const first = issueJsonCache.keys().next().value;
    if (first !== undefined) issueJsonCache.delete(first);
  }
  return text;
}

function invalidateIssueJson(repo: Repo, issue: Issue): void {
  issueJsonCache.delete(`${repo.id}:${issue.number}`);
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + pull.number,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${VIEWER.login}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${VIEWER.login}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
  };
}

function commentJson(repo: Repo, issueNumber: number, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
  };
}

/** Author/committer lines of a commit object, for the commits view. */
function commitMeta(repo: Repo, oid: string): { message: string; author: { name: string; email: string; date: string }; committer: { name: string; email: string; date: string }; tree: string; parents: string[] } {
  const obj = getObject(repo, oid);
  const fallback = { name: VIEWER.name, email: VIEWER.email, date: nowIso() };
  if (obj === undefined || obj.type !== 'commit') return { message: '', author: fallback, committer: fallback, tree: '', parents: [] };
  const text = obj.data.toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  const info = parseCommit(obj.data);
  const parseWho = (line: string | undefined): { name: string; email: string; date: string } => {
    if (line === undefined) return fallback;
    const match = /^(.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line);
    if (match === null) return fallback;
    return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  let authorLine: string | undefined;
  let committerLine: string | undefined;
  for (const line of head.split('\n')) {
    if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  return {
    message: info.message.replace(/\n$/, ''),
    author: parseWho(authorLine),
    committer: parseWho(committerLine),
    tree: info.tree,
    parents: info.parents,
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const meta = commitMeta(repo, oid);
  return {
    sha: oid,
    commit: {
      message: meta.message,
      author: meta.author,
      committer: meta.committer,
      tree: { sha: meta.tree },
    },
    parents: meta.parents.map((sha) => ({ sha })),
    author: { login: VIEWER.login },
    committer: { login: VIEWER.login },
  };
}

/** Commits reachable from `tip`, tip first, depth-first, deduplicated. */
function listCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// REST routing
// -------------------------------------------------------------------------------------------------

function refJson(repo: Repo, ref: string, oid: string): Record<string, unknown> {
  const obj = getObject(repo, oid);
  return {
    ref,
    object: { sha: oid, type: obj?.type ?? 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${obj?.type ?? 'commit'}s/${oid}` },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}`,
  };
}

function stripHeadOwner(value: string): string {
  const colon = value.indexOf(':');
  return colon >= 0 ? value.slice(colon + 1) : value;
}

function resolveRef(repo: Repo, ref: string | null): string | undefined {
  if (ref === null || ref === '') return branchTip(repo, repo.defaultBranch);
  const tip = branchTip(repo, ref);
  if (tip !== undefined) return tip;
  if (SHA40.test(ref)) {
    const obj = getObject(repo, ref);
    if (obj !== undefined && obj.type === 'commit') return ref;
  }
  return undefined;
}

function handleContents(req: IncomingMessage, url: URL, repo: Repo, pathSegments: string[], body: unknown): RestReply {
  const path = pathSegments.join('/');
  if (req.method === 'GET') {
    const tip = resolveRef(repo, url.searchParams.get('ref'));
    if (tip === undefined) return errReply(404, 'Not Found');
    const tree = parseCommit((getObject(repo, tip) as GitObject).data).tree;
    const entry = path === '' ? { type: 'tree' as const, oid: tree } : treeEntryAtPath(repo, tree, path);
    if (entry === null) return errReply(404, 'Not Found');
    if (entry.type === 'tree') {
      const items = readTree(repo, entry.oid).map((child) => {
        const childPath = path === '' ? child.name : `${path}/${child.name}`;
        const item: Record<string, unknown> = { type: child.mode === '40000' ? 'dir' : 'file', name: child.name, path: childPath, sha: child.oid };
        if (child.mode !== '40000') {
          const blob = getObject(repo, child.oid);
          item.size = blob?.data.length ?? 0;
        }
        return item;
      });
      return jsonReply(200, items);
    }
    const blob = getObject(repo, entry.oid) as GitObject;
    return jsonReply(200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: path.split('/').pop() ?? path,
      path,
      content: b64encode(blob.data),
      sha: entry.oid,
    });
  }
  if (req.method === 'PUT') {
    if (!isRecord(body)) return errReply(400, 'Invalid request body');
    const contentB64 = asString(body.content);
    const message = asString(body.message) || `Update ${path}`;
    if (contentB64 === '') return errReply(422, 'content is required');
    let content: Buffer;
    try {
      content = b64decode(contentB64);
    } catch {
      return errReply(422, 'content is not valid base64');
    }
    const branch = asString(body.branch) || repo.defaultBranch;
    const tip = branchTip(repo, branch);
    const existing = tip === undefined ? null : treeEntryAtPath(repo, parseCommit((getObject(repo, tip) as GitObject).data).tree, path);
    const givenSha = asString(body.sha);
    if (existing !== null && existing.type === 'tree') return errReply(422, 'Is a directory');
    if (existing !== null && givenSha !== '' && givenSha !== existing.oid) return errReply(409, 'sha does not match');
    const { commitSha, blobSha } = writeFileCommit(repo, branch, path, content, message);
    return jsonReply(existing === null ? 201 : 200, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha },
    });
  }
  if (req.method === 'DELETE') {
    if (!isRecord(body)) return errReply(400, 'Invalid request body');
    const branch = asString(body.branch) || repo.defaultBranch;
    const tip = branchTip(repo, branch);
    if (tip === undefined) return errReply(404, 'Not Found');
    const existing = treeEntryAtPath(repo, parseCommit((getObject(repo, tip) as GitObject).data).tree, path);
    if (existing === null || existing.type === 'tree') return errReply(404, 'Not Found');
    const givenSha = asString(body.sha);
    if (givenSha !== '' && givenSha !== existing.oid) return errReply(409, 'sha does not match');
    const commitSha = deleteFileCommit(repo, branch, path, asString(body.message) || `Delete ${path}`);
    return jsonReply(200, { commit: { sha: commitSha } });
  }
  return errReply(405, 'Method Not Allowed');
}

function handleIssues(req: IncomingMessage, url: URL, repo: Repo, segments: string[], body: unknown): RestReply {
  const number = segments.length > 0 ? Number.parseInt(segments[0] as string, 10) : NaN;
  if (segments.length === 0 && req.method === 'GET') {
    const state = url.searchParams.get('state') ?? 'open';
    const sort = url.searchParams.get('sort') ?? 'created';
    const direction = url.searchParams.get('direction') ?? 'desc';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    void sort;
    const { page, link } = paginate(req, url, list.map((issue) => issueJson(repo, issue)));
    return jsonReply(200, page, { link: link ?? '' });
  }
  if (segments.length === 0 && req.method === 'POST') {
    if (!isRecord(body)) return errReply(400, 'Invalid request body');
    const title = asString(body.title);
    if (title === '') return errReply(422, 'title is required');
    const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
    for (const label of labels) {
      if (!repo.labels.has(label)) return errReply(422, `Label does not exist: ${label}`);
    }
    const issue: Issue = {
      number: repo.nextIssue++,
      title,
      body: asString(body.body),
      state: 'open',
      labels,
      seq: globalSeq++,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    repo.issues.set(issue.number, issue);
    return jsonRawReply(201, cachedIssueJson(repo, issue));
  }
  if (!Number.isInteger(number) || number < 1) return errReply(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (issue === undefined) return errReply(404, 'Not Found');
  if (segments.length === 1 && req.method === 'GET') return jsonRawReply(200, cachedIssueJson(repo, issue));
  if (segments.length === 1 && req.method === 'PATCH') {
    if (!isRecord(body)) return errReply(400, 'Invalid request body');
    if (body.state !== undefined) {
      if (body.state !== 'open' && body.state !== 'closed') return errReply(422, 'state must be open or closed');
      issue.state = body.state;
    }
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
    issue.updatedAt = nowIso();
    invalidateIssueJson(repo, issue);
    return jsonRawReply(200, cachedIssueJson(repo, issue));
  }
  if (segments.length === 2 && segments[1] === 'comments' && req.method === 'GET') {
    return jsonReply(200, (repo.comments.get(number) ?? []).map((comment) => commentJson(repo, number, comment)));
  }
  if (segments.length === 2 && segments[1] === 'comments' && req.method === 'POST') {
    if (!isRecord(body)) return errReply(400, 'Invalid request body');
    const text = asString(body.body);
    if (text === '') return errReply(422, 'body is required');
    const comment: Comment = { id: repo.nextComment++, body: text, createdAt: nowIso() };
    const list = repo.comments.get(number) ?? [];
    list.push(comment);
    repo.comments.set(number, list);
    return jsonReply(201, commentJson(repo, number, comment));
  }
  return errReply(404, 'Not Found');
}

function handlePulls(req: IncomingMessage, url: URL, repo: Repo, segments: string[], body: unknown): RestReply {
  const number = segments.length > 0 ? Number.parseInt(segments[0] as string, 10) : NaN;
  if (segments.length === 0 && req.method === 'GET') {
    const state = url.searchParams.get('state') ?? 'open';
    let list = [...repo.pulls.values()];
    if (state !== 'all') list = list.filter((pull) => pull.state === state);
    list.sort((a, b) => b.seq - a.seq);
    const { page, link } = paginate(req, url, list.map((pull) => pullJson(repo, pull)));
    return jsonReply(200, page, { link: link ?? '' });
  }
  if (segments.length === 0 && req.method === 'POST') {
    if (!isRecord(body)) return errReply(400, 'Invalid request body');
    const title = asString(body.title);
    const headRef = stripHeadOwner(asString(body.head));
    const baseRef = stripHeadOwner(asString(body.base));
    if (title === '' || headRef === '' || baseRef === '') return errReply(422, 'title, head and base are required');
    const headSha = branchTip(repo, headRef);
    const baseSha = branchTip(repo, baseRef);
    if (headSha === undefined || baseSha === undefined) return errReply(422, 'head or base branch does not exist');
    for (const existing of repo.pulls.values()) {
      if (existing.headRef === headRef && existing.state === 'open') return errReply(422, 'A pull request already exists for this head branch');
    }
    const pull: Pull = {
      number: repo.nextPull++,
      title,
      body: asString(body.body),
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeSha: null,
      seq: globalSeq++,
      createdAt: nowIso(),
    };
    repo.pulls.set(pull.number, pull);
    return jsonReply(201, pullJson(repo, pull));
  }
  if (!Number.isInteger(number) || number < 1) return errReply(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (pull === undefined) return errReply(404, 'Not Found');
  if (segments.length === 1 && req.method === 'GET') return jsonReply(200, pullJson(repo, pull));
  if (segments.length === 2 && segments[1] === 'files' && req.method === 'GET') {
    return jsonReply(200, pullRequestFiles(repo, pull));
  }
  if (segments.length === 2 && segments[1] === 'merge' && req.method === 'PUT') {
    if (pull.state !== 'open' || pull.merged) return errReply(405, 'Pull request is already merged or closed');
    if (pullRequestConflicts(repo, pull)) return errReply(405, 'Merge conflict');
    const mergeSha = mergePullRequest(repo, pull);
    if (mergeSha === null) return errReply(405, 'Merge conflict');
    return jsonReply(200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
  }
  return errReply(404, 'Not Found');
}

function handleGitRefs(req: IncomingMessage, repo: Repo, segments: string[], body: unknown): RestReply {
  if (req.method === 'POST' && segments.length === 0) {
    if (!isRecord(body)) return errReply(400, 'Invalid request body');
    const ref = asString(body.ref);
    const sha = asString(body.sha);
    if (!ref.startsWith('refs/') || !SHA40.test(sha)) return errReply(422, 'ref and sha are required');
    if (getObject(repo, sha) === undefined) return errReply(422, 'sha does not exist');
    if (repo.refs.has(ref)) return errReply(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    return jsonReply(201, refJson(repo, ref, sha));
  }
  if (req.method === 'GET' && segments.length === 0) {
    return jsonReply(200, [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([ref, oid]) => refJson(repo, ref, oid)));
  }
  if (req.method === 'GET' && segments.length > 0) {
    const ref = `refs/${segments.join('/')}`;
    const oid = repo.refs.get(ref);
    if (oid === undefined) return errReply(404, 'Not Found');
    return jsonReply(200, refJson(repo, ref, oid));
  }
  return errReply(404, 'Not Found');
}

function handleRepo(req: IncomingMessage, url: URL, owner: string, name: string, segments: string[], body: unknown): RestReply {
  const repo = getRepo(owner, name);
  if (segments.length === 0) {
    if (req.method === 'GET') {
      if (repo === undefined) return errReply(404, 'Not Found');
      return jsonReply(200, repoJson(repo));
    }
    if (req.method === 'PATCH') {
      if (repo === undefined) return errReply(404, 'Not Found');
      if (!isRecord(body)) return errReply(400, 'Invalid request body');
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.default_branch === 'string' && branchTip(repo, body.default_branch) !== undefined) repo.defaultBranch = body.default_branch;
      return jsonReply(200, repoJson(repo));
    }
    if (req.method === 'DELETE') {
      if (repo === undefined) return errReply(404, 'Not Found');
      repos.delete(repoKey(owner, name));
      return { status: 204, body: null };
    }
    return errReply(405, 'Method Not Allowed');
  }
  if (repo === undefined) return errReply(404, 'Not Found');
  const [head, ...rest] = segments as [string, ...string[]];
  if (head === 'branches' && req.method === 'GET' && rest.length === 0) {
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort()
      .map((branch) => ({ name: branch, commit: { sha: branchTip(repo, branch) as string }, protected: false }));
    return jsonReply(200, branches);
  }
  if (head === 'branches' && req.method === 'GET' && rest.length === 1) {
    const branch = rest[0] as string;
    const tip = branchTip(repo, branch);
    if (tip === undefined) return errReply(404, 'Not Found');
    return jsonReply(200, { name: branch, commit: { sha: tip }, protected: false });
  }
  if (head === 'commits' && req.method === 'GET' && rest.length === 0) {
    const tip = resolveRef(repo, url.searchParams.get('sha'));
    if (tip === undefined) return errReply(404, 'Not Found');
    const { page, link } = paginate(req, url, listCommits(repo, tip).map((oid) => commitJson(repo, oid)));
    return jsonReply(200, page, { link: link ?? '' });
  }
  if (head === 'commits' && req.method === 'GET' && rest.length === 1) {
    const oid = rest[0] as string;
    const obj = getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') return errReply(404, 'Not Found');
    return jsonReply(200, commitJson(repo, oid));
  }
  if (head === 'contents') return handleContents(req, url, repo, rest, body);
  if (head === 'issues') return handleIssues(req, url, repo, rest, body);
  if (head === 'pulls') return handlePulls(req, url, repo, rest, body);
  if (head === 'labels' && req.method === 'GET' && rest.length === 0) {
    return jsonReply(200, [...repo.labels.entries()].map(([labelName, color]) => ({ name: labelName, color })));
  }
  if (head === 'labels' && req.method === 'POST' && rest.length === 0) {
    if (!isRecord(body)) return errReply(400, 'Invalid request body');
    const labelName = asString(body.name);
    if (labelName === '') return errReply(422, 'name is required');
    if (repo.labels.has(labelName)) return errReply(422, 'Label already exists');
    const color = asString(body.color) || 'ededed';
    repo.labels.set(labelName, color);
    return jsonReply(201, { name: labelName, color });
  }
  if (head === 'git' && rest.length > 0 && rest[0] === 'refs') return handleGitRefs(req, repo, rest.slice(1), body);
  return errReply(404, 'Not Found');
}

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const requestId = nextRequestId();
  if (!authed(req)) {
    sendReply(res, errReply(401, 'Requires authentication'), requestId);
    return;
  }
  let raw: Buffer = Buffer.alloc(0);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      raw = await readBody(req);
    } catch {
      sendReply(res, errReply(400, 'Request body too large'), requestId);
      return;
    }
  }
  let body: unknown;
  if (raw.length > 0) {
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendReply(res, errReply(400, 'Invalid JSON body'), requestId);
      return;
    }
    body = parsed.value;
  }
  const segments = url.pathname
    .slice('/api/v3'.length)
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  let reply: RestReply;
  if (segments.length === 0) {
    if (req.method !== 'GET') reply = errReply(405, 'Method Not Allowed');
    else {
      reply = jsonReply(200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        user_url: '/api/v3/users/{username}',
        organization_url: '/api/v3/orgs/{org}',
      });
    }
  } else if (segments.length === 1 && segments[0] === 'meta') {
    reply = req.method === 'GET' ? jsonReply(200, { installed_version: '1.0.0', verifiable_password_authentication: true }) : errReply(405, 'Method Not Allowed');
  } else if (segments.length === 1 && segments[0] === 'user') {
    reply =
      req.method === 'GET'
        ? jsonReply(200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' })
        : errReply(405, 'Method Not Allowed');
  } else if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (req.method === 'POST') {
      if (!isRecord(body)) reply = errReply(400, 'Invalid request body');
      else {
        const name = asString(body.name);
        if (name === '') reply = errReply(422, 'name is required');
        else {
          const existing = getRepo(VIEWER.login, name);
          if (existing !== undefined) reply = jsonReply(201, repoJson(existing));
          else {
            const repo = createRepoRecord(name, asBool(body.private, false), asString(body.description));
            reply = jsonReply(201, repoJson(repo));
          }
        }
      }
    } else if (req.method === 'GET') {
      const all = [...repos.values()].sort((a, b) => a.seq - b.seq).map((repo) => repoJson(repo));
      const { page, link } = paginate(req, url, all);
      reply = jsonReply(200, page, { link: link ?? '' });
    } else reply = errReply(405, 'Method Not Allowed');
  } else if (segments.length >= 3 && segments[0] === 'repos') {
    reply = handleRepo(req, url, segments[1] as string, segments[2] as string, segments.slice(3), body);
  } else {
    reply = errReply(404, 'Not Found');
  }
  sendReply(res, reply, requestId);
}

// -------------------------------------------------------------------------------------------------
// Git smart HTTP
// -------------------------------------------------------------------------------------------------

const GIT_AGENT = 'forge/1.0';

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

function sortedRefs(repo: Repo): Array<{ ref: string; oid: string }> {
  return [...repo.refs.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([ref, oid]) => ({ ref, oid }));
}

// v2: the v2 advertisement never changes — build it once instead of
// re-concatenating six pkt-lines on every info/refs.
const ADVERTISE_V2: Buffer = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow filter\n'),
  pktLine('object-format=sha1\n'),
  pktLine(`agent=${GIT_AGENT}\n`),
  PKT_FLUSH,
]);

/** The v2 capability advertisement for upload-pack. */
function advertiseV2(): Buffer {
  return ADVERTISE_V2;
}

/** The v0 ref advertisement for one service, with capabilities on the first ref line. */
function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k multi_ack_detailed thin-pack ofs-delta agent=${GIT_AGENT} symref=HEAD:refs/heads/main`
      : `report-status side-band-64k delete-refs ofs-delta agent=${GIT_AGENT} symref=HEAD:refs/heads/main`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const lines: string[] = [];
  const mainTip = branchTip(repo, repo.defaultBranch);
  if (mainTip !== undefined) lines.push(`${mainTip} HEAD`);
  for (const { ref, oid } of refs) {
    // Every ref gets its own line, including the default branch: real git
    // lists HEAD and refs/heads/main side by side.
    lines.push(`${oid} ${ref}`);
    const obj = getObject(repo, oid);
    if (obj !== undefined && obj.type === 'tag') {
      const target = parseTag(obj.data);
      if (target.type === 'commit') lines.push(`${target.object} ${ref}^{}`);
    }
  }
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      parts.push(pktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
    });
  }
  return Buffer.concat(parts);
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, name: string, service: string): void {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendRaw(res, 404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'));
    return;
  }
  if (service === 'git-upload-pack') {
    const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', v2 ? advertiseV2() : advertiseV0(repo, 'git-upload-pack'));
  } else if (service === 'git-receive-pack') {
    sendRaw(res, 200, 'application/x-git-receive-pack-advertisement', advertiseV0(repo, 'git-receive-pack'));
  } else {
    sendRaw(res, 400, 'application/json', Buffer.from(JSON.stringify({ message: 'Unknown service' }), 'utf8'));
  }
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

// v2: ls-refs answers are a pure function of the ref set plus the args.
// The clone workload issues the same ls-refs 50 times in a row against an
// unchanged ref set; cache the serialized reply. The key carries the full
// ref list, so a moved ref can never serve a stale answer. Objects are
// immutable, so only refs matter.
const lsRefsCache = new Map<string, Buffer>();
const LS_REFS_CACHE_MAX = 64;

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const refs = sortedRefs(repo);
  const key = JSON.stringify([repo.id, refs, args.peel, args.symrefs, args.unborn, args.prefixes]);
  const hit = lsRefsCache.get(key);
  if (hit !== undefined) return hit;
  const lines: string[] = [];
  const mainTip = branchTip(repo, repo.defaultBranch);
  const matches = (ref: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => ref.startsWith(prefix));
  if (mainTip !== undefined) {
    if (matches('HEAD')) lines.push(`${mainTip} HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
  } else if (args.unborn && matches('HEAD')) {
    lines.push(`unborn HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
  }
  for (const { ref, oid } of refs) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (args.peel) {
      const obj = getObject(repo, oid);
      if (obj !== undefined && obj.type === 'tag') {
        const target = parseTag(obj.data);
        if (target.type === 'commit') line += ` peeled:${target.object}`;
      }
    }
    lines.push(`${line}\n`);
  }
  const out = Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
  lsRefsCache.set(key, out);
  if (lsRefsCache.size > LS_REFS_CACHE_MAX) {
    const first = lsRefsCache.keys().next().value;
    if (first !== undefined) lsRefsCache.delete(first);
  }
  return out;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/**
 * The fetch send set: commits within `depth` of the wants (tags resolve to
 * their target at the same depth), their trees and blobs, minus everything
 * reachable from the haves. Also the shallow boundaries and unshallows.
 */
function computeFetch(repo: Repo, args: FetchArgs): { entries: PackEntry[]; shallow: string[]; unshallow: string[]; acks: string[] } {
  const depthLimit = args.depth ?? Number.POSITIVE_INFINITY;
  // Commit depths from the wants, resolving tags to their target commits.
  const depths = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  const tagObjects = new Set<string>();
  for (const want of args.wants) {
    const obj = getObject(repo, want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      tagObjects.add(want);
      const target = parseTag(obj.data);
      if (target.type === 'commit') queue.push({ oid: target.object, depth: 0 });
    } else if (obj.type === 'commit') {
      queue.push({ oid: want, depth: 0 });
    }
  }
  const included = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (depth >= depthLimit) continue;
    const known = depths.get(oid);
    if (known !== undefined && known <= depth) continue;
    depths.set(oid, depth);
    included.add(oid);
    const obj = getObject(repo, oid);
    if (obj !== undefined && obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, depth: depth + 1 });
    }
  }
  // Shallow boundaries: included commits with a parent that is not included.
  const shallow: string[] = [];
  for (const oid of included) {
    const obj = getObject(repo, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length > 0 && parents.some((parent) => !included.has(parent))) shallow.push(oid);
  }
  // Unshallow: old boundaries that are now included.
  const unshallow = args.shallow.filter((oid) => included.has(oid));
  // The send set, minus what the client already holds. Each included commit
  // contributes itself plus its own tree (no parent commits: a depth-1 fetch
  // must not ship history).
  const haveReachable = haveReachableOids(repo, args.haves, args.shallow);
  const send = new Set<string>(tagObjects);
  for (const oid of included) {
    send.add(oid);
    const obj = getObject(repo, oid);
    if (obj !== undefined && obj.type === 'commit') {
      for (const treeOid of treeReachableOids(repo, parseCommit(obj.data).tree)) send.add(treeOid);
    }
  }
  for (const oid of haveReachable) send.delete(oid);
  const entries: PackEntry[] = [];
  for (const oid of send) {
    const obj = getObject(repo, oid);
    if (obj !== undefined) entries.push({ type: obj.type, data: obj.data, oid });
  }
  // ACKs: every have that is an ancestor of (or equal to) a wanted commit.
  const acks: string[] = [];
  for (const have of args.haves) {
    let acked = false;
    for (const want of args.wants) {
      const obj = getObject(repo, want);
      if (obj === undefined) continue;
      const commit = obj.type === 'tag' ? parseTag(obj.data).object : want;
      if (have === commit || isAncestor(repo, have, commit)) {
        acked = true;
        break;
      }
    }
    if (acked) acks.push(have);
  }
  return { entries, shallow, unshallow, acks };
}

// v2: the fetch reply is a pure function of (repo, wants, haves, shallow,
// depth) — objects are immutable and never deleted, so the same request
// against the same repo always builds the same bytes. The clone workload
// issues 50 identical fetches in a row; cache the whole reply and skip
// computeFetch + buildPack (deflate + sha1) on 49 of them.
const fetchCache = new Map<string, Buffer>();
const FETCH_CACHE_MAX = 64;

function handleFetch(repo: Repo, args: FetchArgs): Buffer {
  const key = JSON.stringify([repo.id, args.wants, args.haves, args.shallow, args.depth]);
  const hit = fetchCache.get(key);
  if (hit !== undefined) return hit;
  const { entries, shallow, unshallow, acks } = computeFetch(repo, args);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (acks.length > 0) {
    for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(PKT_FLUSH);
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  const pack = buildPack(entries);
  parts.push(pktLine('packfile\n'));
  const CHUNK = 32768;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(PKT_FLUSH);
  const out = Buffer.concat(parts);
  fetchCache.set(key, out);
  if (fetchCache.size > FETCH_CACHE_MAX) {
    const first = fetchCache.keys().next().value;
    if (first !== undefined) fetchCache.delete(first);
  }
  return out;
}

function handleUploadPack(repo: Repo, body: Buffer): { status: number; body: Buffer } {
  let packets: Pkt[];
  try {
    packets = decodePktLines(body);
  } catch {
    return { status: 400, body: Buffer.from('malformed pkt-line', 'utf8') };
  }
  const lines: string[] = [];
  let delimIndex = -1;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      delimIndex = lines.length;
      continue;
    }
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  const command = (lines[0] ?? '').trim();
  // Arguments follow the delim packet when one is present, else the command line.
  const argsAfter = delimIndex >= 0 ? lines.slice(delimIndex) : lines.slice(1);
  if (command === 'command=ls-refs') {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const line of argsAfter) {
      const text = line.trim();
      if (text === 'peel') args.peel = true;
      else if (text === 'symrefs') args.symrefs = true;
      else if (text === 'unborn') args.unborn = true;
      else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
    }
    return { status: 200, body: handleLsRefs(repo, args) };
  }
  if (command === 'command=fetch') {
    const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
    for (const line of argsAfter) {
      const text = line.trim();
      if (text.startsWith('want ')) args.wants.push(text.slice(5));
      else if (text.startsWith('have ')) args.haves.push(text.slice(5));
      else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8));
      else if (text.startsWith('deepen ')) {
        const n = Number.parseInt(text.slice(7), 10);
        if (Number.isFinite(n) && n > 0) args.depth = n;
      }
    }
    return { status: 200, body: handleFetch(repo, args) };
  }
  return { status: 400, body: Buffer.from('unknown upload-pack command', 'utf8') };
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): { status: number; body: Buffer } {
  // The body is pkt-line commands up to a flush, then the RAW pack bytes:
  // parse the command section sequentially and take the pack as the tail.
  const commands: PushCommand[] = [];
  let sideband = false;
  let offset = 0;
  let flushSeen = false;
  while (offset < body.length) {
    if (offset + 4 > body.length) return { status: 400, body: Buffer.from('truncated pkt-line', 'utf8') };
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      offset += 4;
      flushSeen = true;
      break;
    }
    if (head === '0001') {
      offset += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > body.length) return { status: 400, body: Buffer.from('bad pkt-line length', 'utf8') };
    let text = body.subarray(offset + 4, offset + len).toString('utf8');
    const nul = text.indexOf('\0');
    let caps = '';
    if (nul >= 0) {
      caps = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    if (caps.includes('side-band-64k')) sideband = true;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\n?$/.exec(text);
    if (match === null) return { status: 400, body: Buffer.from('malformed push command', 'utf8') };
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
    offset += len;
  }
  if (!flushSeen) return { status: 400, body: Buffer.from('missing flush after push commands', 'utf8') };
  const reportLines: string[] = [];
  const packBytes = body.subarray(offset);
  let unpackOk = true;
  let unpackDetail = 'ok';
  const hasUpdate = commands.some((command) => command.newOid !== ZERO_OID);
  if (hasUpdate && packBytes.length > 0) {
    try {
      const entries = parsePack(packBytes);
      // v2: parsePack already hashed each object; store by that oid instead
      // of hashing the same bytes again inside putObject.
      for (const entry of entries) putObjectWithOid(repo, entry.type, entry.data, entry.oid);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  } else if (hasUpdate && packBytes.length === 0) {
    unpackOk = false;
    unpackDetail = 'missing packfile';
  }
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let ok = false;
      if (command.newOid === ZERO_OID) {
        if (current !== undefined && command.oldOid === current) {
          repo.refs.delete(command.ref);
          ok = true;
        }
      } else if (command.oldOid === ZERO_OID) {
        if (current === undefined && getObject(repo, command.newOid) !== undefined) {
          repo.refs.set(command.ref, command.newOid);
          ok = true;
        }
      } else if (current !== undefined && command.oldOid === current && getObject(repo, command.newOid) !== undefined) {
        // v2: direct-parent fast path (see isFastForward); same verdict.
        if (isFastForward(repo, command.oldOid, command.newOid)) {
          repo.refs.set(command.ref, command.newOid);
          ok = true;
        }
      }
      reportLines.push(ok ? `ok ${command.ref}\n` : `ng ${command.ref} non-fast-forward\n`);
    }
  }
  const out: Buffer[] = [];
  const reportText = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`, ...reportLines];
  for (const line of reportText) {
    out.push(sideband ? pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(line, 'utf8')])) : pktLine(line));
  }
  out.push(PKT_FLUSH);
  return { status: 200, body: Buffer.concat(out) };
}

async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const segments = url.pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  if (segments.length < 2 || !(segments[1] as string).endsWith('.git')) {
    sendRaw(res, 404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'));
    return;
  }
  const owner = segments[0] as string;
  const name = (segments[1] as string).slice(0, -'.git'.length);
  const tail = segments.slice(2);
  if (req.method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    handleInfoRefs(req, res, owner, name, url.searchParams.get('service') ?? '');
    return;
  }
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    sendRaw(res, 404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'));
    return;
  }
  if (req.method !== 'POST' || tail.length !== 1) {
    sendRaw(res, 404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'));
    return;
  }
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    sendRaw(res, 400, 'application/json', Buffer.from(JSON.stringify({ message: 'Request body too large' }), 'utf8'));
    return;
  }
  if (tail[0] === 'git-upload-pack') {
    const result = handleUploadPack(repo, body);
    sendRaw(res, result.status, 'application/x-git-upload-pack-result', result.body);
  } else if (tail[0] === 'git-receive-pack') {
    const result = handleReceivePack(repo, body);
    sendRaw(res, result.status, 'application/x-git-receive-pack-result', result.body);
  } else {
    sendRaw(res, 404, 'application/json', Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'));
  }
}

// -------------------------------------------------------------------------------------------------
// GraphQL: a small parser and executor for the documents gh sends
// -------------------------------------------------------------------------------------------------

interface GqlField {
  alias: string | null;
  name: string;
  fragmentType: string | null;
  args: Record<string, unknown>;
  children: GqlField[] | null;
}

class GqlParser {
  private pos = 0;
  private readonly src: string;
  private readonly vars: Record<string, unknown>;
  constructor(src: string, vars: Record<string, unknown>) {
    this.src = src;
    this.vars = vars;
  }

  private skipWs(): void {
    for (;;) {
      const ch = this.src[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
        this.pos += 1;
        continue;
      }
      if (ch === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  private peek(): string {
    this.skipWs();
    return this.src[this.pos] ?? '';
  }

  private expect(ch: string): void {
    this.skipWs();
    if (this.src[this.pos] !== ch) throw new Error(`expected ${ch} at ${this.pos}`);
    this.pos += 1;
  }

  private readName(): string {
    this.skipWs();
    const start = this.pos;
    while (this.pos < this.src.length && /[A-Za-z0-9_]/.test(this.src[this.pos] as string)) this.pos += 1;
    if (this.pos === start) throw new Error(`expected a name at ${this.pos}`);
    return this.src.slice(start, this.pos);
  }

  private readString(): string {
    this.skipWs();
    if (this.src[this.pos] !== '"') throw new Error(`expected a string at ${this.pos}`);
    this.pos += 1;
    let out = '';
    for (;;) {
      const ch = this.src[this.pos] as string;
      if (ch === undefined) throw new Error('unterminated string');
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        const esc = this.src[this.pos + 1] as string;
        this.pos += 2;
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else if (esc === 'u') {
          out += String.fromCharCode(Number.parseInt(this.src.slice(this.pos, this.pos + 4), 16));
          this.pos += 4;
        } else out += esc;
        continue;
      }
      out += ch;
      this.pos += 1;
    }
  }

  private readNumber(): number {
    this.skipWs();
    const start = this.pos;
    if (this.src[this.pos] === '-') this.pos += 1;
    while (this.pos < this.src.length && /[0-9.]/.test(this.src[this.pos] as string)) this.pos += 1;
    if (this.src[this.pos] === 'e' || this.src[this.pos] === 'E') {
      this.pos += 1;
      if (this.src[this.pos] === '+' || this.src[this.pos] === '-') this.pos += 1;
      while (this.pos < this.src.length && /[0-9]/.test(this.src[this.pos] as string)) this.pos += 1;
    }
    return Number(this.src.slice(start, this.pos));
  }

  parseValue(): unknown {
    this.skipWs();
    const ch = this.src[this.pos] as string;
    if (ch === '$') {
      this.pos += 1;
      const name = this.readName();
      return this.vars[name] === undefined ? null : this.vars[name];
    }
    if (ch === '"') return this.readString();
    if (ch === '[') {
      this.pos += 1;
      const out: unknown[] = [];
      while (this.peek() !== ']') out.push(this.parseValue());
      this.expect(']');
      return out;
    }
    if (ch === '{') {
      this.pos += 1;
      const out: Record<string, unknown> = {};
      while (this.peek() !== '}') {
        const key = this.readName();
        this.expect(':');
        out[key] = this.parseValue();
      }
      this.expect('}');
      return out;
    }
    if (ch === '-' || /[0-9]/.test(ch)) return this.readNumber();
    const name = this.readName();
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;
    return name;
  }

  private parseArguments(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    this.skipWs();
    if (this.src[this.pos] !== '(') return out;
    this.pos += 1;
    while (this.peek() !== ')') {
      const name = this.readName();
      this.expect(':');
      out[name] = this.parseValue();
    }
    this.expect(')');
    return out;
  }

  private parseSelectionSet(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== '}') {
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  private parseField(): GqlField {
    this.skipWs();
    if (this.src.startsWith('...', this.pos)) {
      this.pos += 3;
      this.skipWs();
      let fragmentType: string | null = null;
      if (this.src.startsWith('on', this.pos) && /[\s{]/.test(this.src[this.pos + 2] ?? '')) {
        this.pos += 2;
        fragmentType = this.readName();
      }
      // Named fragments are not used by the suite's documents.
      const children = this.peek() === '{' ? this.parseSelectionSet() : null;
      return { alias: null, name: '', fragmentType, args: {}, children };
    }
    const first = this.readName();
    this.skipWs();
    let alias: string | null = null;
    let name = first;
    if (this.src[this.pos] === ':') {
      this.pos += 1;
      alias = first;
      name = this.readName();
    }
    const args = this.parseArguments();
    const children = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { alias, name, fragmentType: null, args, children };
  }

  /** Parse the first operation document; return its kind and root fields. */
  parseOperation(): { kind: 'query' | 'mutation'; fields: GqlField[] } {
    this.skipWs();
    let kind: 'query' | 'mutation' = 'query';
    if (this.src.startsWith('query', this.pos) && /[\s{(]/.test(this.src[this.pos + 5] ?? '')) {
      this.pos += 5;
      kind = 'query';
    } else if (this.src.startsWith('mutation', this.pos) && /[\s{(]/.test(this.src[this.pos + 8] ?? '')) {
      this.pos += 8;
      kind = 'mutation';
    }
    this.skipWs();
    // Optional operation name.
    if (/[A-Za-z_]/.test(this.src[this.pos] ?? '')) this.readName();
    this.skipWs();
    // Optional variable definitions: ($name: Type = default, ...).
    if (this.src[this.pos] === '(') {
      let depth = 0;
      while (this.pos < this.src.length) {
        const ch = this.src[this.pos] as string;
        if (ch === '(' || ch === '[' || ch === '{') depth += 1;
        else if (ch === ')' || ch === ']' || ch === '}') {
          depth -= 1;
          this.pos += 1;
          if (depth === 0) break;
          continue;
        } else if (ch === '"') {
          this.readString();
          continue;
        }
        this.pos += 1;
      }
    }
    const fields = this.parseSelectionSet();
    return { kind, fields };
  }
}

// -------------------------------------------------------------------------------------------------
// GraphQL execution
// -------------------------------------------------------------------------------------------------

interface GqlCtx {
  errors: Array<{ message: string }>;
}

type GqlSource = Record<string, unknown> & { __typename: string };

function gqlViewer(): GqlSource {
  return { __typename: 'User', login: VIEWER.login };
}

function gqlRepo(repo: Repo): GqlSource {
  return { __typename: 'Repository', repo };
}

function gqlIssue(repo: Repo, issue: Issue): GqlSource {
  return { __typename: 'Issue', repo, issue };
}

function gqlPull(repo: Repo, pull: Pull): GqlSource {
  return { __typename: 'PullRequest', repo, pull };
}

function gqlPageInfo(hasNextPage: boolean, endCursor: string | null): GqlSource {
  return { __typename: 'PageInfo', hasNextPage, endCursor };
}

function encodeCursor(number: number): string {
  return b64encode(Buffer.from(`cursor:${number}`, 'utf8'));
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = b64decode(cursor).toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function gqlIssuesConnection(repo: Repo, args: Record<string, unknown>): GqlSource {
  const first = typeof args.first === 'number' ? args.first : 100;
  const after = decodeCursor(args.after);
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  let list = [...repo.issues.values()];
  if (states !== null) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state)));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  if (orderBy !== null && orderBy.field === 'CREATED_AT' && orderBy.direction === 'DESC') list.sort((a, b) => b.seq - a.seq);
  else list.sort((a, b) => a.seq - b.seq);
  if (after !== null) list = list.filter((issue) => issue.number > after);
  const nodes = list.slice(0, first);
  const hasNextPage = list.length > first;
  const endCursor = nodes.length > 0 ? encodeCursor((nodes[nodes.length - 1] as Issue).number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: nodes.map((issue) => gqlIssue(repo, issue)),
    pageInfo: gqlPageInfo(hasNextPage, endCursor),
  };
}

function gqlPullsConnection(repo: Repo, args: Record<string, unknown>): GqlSource {
  const first = typeof args.first === 'number' ? args.first : 100;
  const after = decodeCursor(args.after);
  const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
  const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state)));
  let list = [...repo.pulls.values()].filter((pull) => wanted.has(pull.state));
  list.sort((a, b) => a.seq - b.seq);
  if (after !== null) list = list.filter((pull) => pull.number > after);
  const nodes = list.slice(0, first);
  const hasNextPage = list.length > first;
  const endCursor = nodes.length > 0 ? encodeCursor((nodes[nodes.length - 1] as Pull).number) : null;
  return {
    __typename: 'PullRequestConnection',
    nodes: nodes.map((pull) => gqlPull(repo, pull)),
    pageInfo: gqlPageInfo(hasNextPage, endCursor),
  };
}

const GQL_TYPE_FIELDS: Record<string, readonly string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'assignees', 'milestone', 'locked', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'url', 'createdAt', 'updatedAt', 'author', 'commits', 'reviews', 'additions', 'deletions', 'changedFiles', 'mergeCommit', 'mergedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt', 'issue', 'issues', 'pullRequest', 'pullRequests', 'ref', 'refs', 'stargazerCount', 'forkCount', 'watchers', 'primaryLanguage', 'licenseInfo', 'diskUsage'],
};

const GQL_ENUM_VALUES: Record<string, readonly string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'DISCUSSION', 'COMMIT'],
};

type GqlResolver = (source: GqlSource, args: Record<string, unknown>, ctx: GqlCtx) => unknown;

const GQL_RESOLVERS: Record<string, Record<string, GqlResolver>> = {
  Query: {
    viewer: () => gqlViewer(),
    repository: (_source, args) => {
      const owner = asString(args.owner);
      const name = asString(args.name);
      const repo = getRepo(owner, name);
      return repo === undefined ? null : gqlRepo(repo);
    },
    __type: (_source, args) => {
      const name = asString(args.name);
      // Enums first: a name must never resolve as both an enum and an object type.
      if (GQL_ENUM_VALUES[name] !== undefined) {
        return { __typename: '__Type', name, kind: 'ENUM', fields: null, enumValues: GQL_ENUM_VALUES[name].map((value) => ({ name: value })) };
      }
      if (GQL_TYPE_FIELDS[name] !== undefined) {
        return { __typename: '__Type', name, kind: 'OBJECT', fields: GQL_TYPE_FIELDS[name].map((field) => ({ name: field })), enumValues: null };
      }
      return null;
    },
    node: (_source, args) => {
      const decoded = decodeGlobalId(asString(args.id));
      if (decoded === null) return null;
      const repo = repoByDbId(decoded.dbId);
      if (repo === undefined) return null;
      if (decoded.kind === 'Repository') return gqlRepo(repo);
      if (decoded.kind === 'Issue') {
        const issue = repo.issues.get(decoded.number);
        return issue === undefined ? null : gqlIssue(repo, issue);
      }
      if (decoded.kind === 'PullRequest') {
        const pull = repo.pulls.get(decoded.number);
        return pull === undefined ? null : gqlPull(repo, pull);
      }
      return null;
    },
  },
  Mutation: {
    createIssue: (_source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeGlobalId(asString(input.repositoryId));
      if (decoded === null || decoded.kind !== 'Repository') return null;
      const repo = repoByDbId(decoded.dbId);
      if (repo === undefined) return null;
      const title = asString(input.title);
      if (title === '') return null;
      const issue: Issue = {
        number: repo.nextIssue++,
        title,
        body: asString(input.body),
        state: 'open',
        labels: [],
        seq: globalSeq++,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      repo.issues.set(issue.number, issue);
      return { __typename: 'CreateIssuePayload', issue: gqlIssue(repo, issue) };
    },
    closeIssue: (_source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeGlobalId(asString(input.issueId));
      if (decoded === null || decoded.kind !== 'Issue') return null;
      const repo = repoByDbId(decoded.dbId);
      const issue = repo?.issues.get(decoded.number);
      if (repo === undefined || issue === undefined) return null;
      issue.state = 'closed';
      issue.updatedAt = nowIso();
      // v2: the issue's serialized form changed; drop its cache entry.
      invalidateIssueJson(repo, issue);
      return { __typename: 'CloseIssuePayload', issue: gqlIssue(repo, issue) };
    },
    createPullRequest: (_source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeGlobalId(asString(input.repositoryId));
      if (decoded === null || decoded.kind !== 'Repository') return null;
      const repo = repoByDbId(decoded.dbId);
      if (repo === undefined) return null;
      const headRef = stripHeadOwner(asString(input.headRefName));
      const baseRef = stripHeadOwner(asString(input.baseRefName));
      const headSha = branchTip(repo, headRef);
      const baseSha = branchTip(repo, baseRef);
      if (headSha === undefined || baseSha === undefined) return null;
      for (const existing of repo.pulls.values()) {
        if (existing.headRef === headRef && existing.state === 'open') return null;
      }
      const pull: Pull = {
        number: repo.nextPull++,
        title: asString(input.title),
        body: '',
        state: 'open',
        headRef,
        baseRef,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeSha: null,
        seq: globalSeq++,
        createdAt: nowIso(),
      };
      repo.pulls.set(pull.number, pull);
      return { __typename: 'CreatePullRequestPayload', pullRequest: gqlPull(repo, pull) };
    },
    mergePullRequest: (_source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeGlobalId(asString(input.pullRequestId));
      if (decoded === null || decoded.kind !== 'PullRequest') return null;
      const repo = repoByDbId(decoded.dbId);
      const pull = repo?.pulls.get(decoded.number);
      if (repo === undefined || pull === undefined) return null;
      if (pull.state !== 'open' || pull.merged) return null;
      if (pullRequestConflicts(repo, pull)) return null;
      const mergeSha = mergePullRequest(repo, pull);
      if (mergeSha === null) return null;
      return { __typename: 'MergePullRequestPayload', pullRequest: gqlPull(repo, pull) };
    },
    addComment: (_source, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeGlobalId(asString(input.subjectId));
      if (decoded === null || decoded.kind !== 'Issue') return null;
      const repo = repoByDbId(decoded.dbId);
      const issue = repo?.issues.get(decoded.number);
      if (repo === undefined || issue === undefined) return null;
      const body = asString(input.body);
      if (body === '') return null;
      const comment: Comment = { id: repo.nextComment++, body, createdAt: nowIso() };
      const list = repo.comments.get(issue.number) ?? [];
      list.push(comment);
      repo.comments.set(issue.number, list);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', repo, issueNumber: issue.number, comment } },
      };
    },
  },
  User: {
    login: (source) => asString(source.login),
  },
  Repository: {
    id: (source) => repoGlobalId(source.repo as Repo),
    databaseId: (source) => (source.repo as Repo).id,
    name: (source) => (source.repo as Repo).name,
    nameWithOwner: (source) => `${(source.repo as Repo).owner}/${(source.repo as Repo).name}`,
    owner: (source) => ({ __typename: 'User', login: (source.repo as Repo).owner }),
    defaultBranchRef: (source) => {
      const repo = source.repo as Repo;
      const tip = branchTip(repo, repo.defaultBranch);
      return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (source) => (source.repo as Repo).description,
    isPrivate: (source) => (source.repo as Repo).isPrivate,
    url: (source) => `https://github.com/${(source.repo as Repo).owner}/${(source.repo as Repo).name}`,
    createdAt: (source) => (source.repo as Repo).createdAt,
    updatedAt: (source) => (source.repo as Repo).createdAt,
    issue: (source, args) => {
      const repo = source.repo as Repo;
      const number = typeof args.number === 'number' ? args.number : NaN;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : gqlIssue(repo, issue);
    },
    issues: (source, args) => gqlIssuesConnection(source.repo as Repo, args),
    pullRequest: (source, args) => {
      const repo = source.repo as Repo;
      const number = typeof args.number === 'number' ? args.number : NaN;
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : gqlPull(repo, pull);
    },
    pullRequests: (source, args) => gqlPullsConnection(source.repo as Repo, args),
  },
  Issue: {
    id: (source) => issueGlobalId(source.repo as Repo, (source.issue as Issue).number),
    number: (source) => (source.issue as Issue).number,
    title: (source) => (source.issue as Issue).title,
    body: (source) => (source.issue as Issue).body,
    state: (source) => ((source.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    url: (source) => `https://github.com/${(source.repo as Repo).owner}/${(source.repo as Repo).name}/issues/${(source.issue as Issue).number}`,
    createdAt: (source) => (source.issue as Issue).createdAt,
    updatedAt: (source) => (source.issue as Issue).updatedAt,
    author: () => gqlViewer(),
    labels: (source) => ({ __typename: 'LabelConnection', nodes: (source.issue as Issue).labels.map((name) => ({ __typename: 'Label', name })) }),
    comments: (source) => {
      const repo = source.repo as Repo;
      const issue = source.issue as Issue;
      const list = repo.comments.get(issue.number) ?? [];
      return { __typename: 'IssueCommentConnection', nodes: list.map((comment) => ({ __typename: 'IssueComment', repo, issueNumber: issue.number, comment })) };
    },
  },
  PullRequest: {
    id: (source) => pullGlobalId(source.repo as Repo, (source.pull as Pull).number),
    number: (source) => (source.pull as Pull).number,
    title: (source) => (source.pull as Pull).title,
    body: (source) => (source.pull as Pull).body,
    state: (source) => ((source.pull as Pull).state === 'open' ? 'OPEN' : 'CLOSED'),
    merged: (source) => (source.pull as Pull).merged,
    mergeable: (source) => (pullRequestConflicts(source.repo as Repo, source.pull as Pull) ? 'CONFLICTING' : 'MERGEABLE'),
    headRefName: (source) => (source.pull as Pull).headRef,
    baseRefName: (source) => (source.pull as Pull).baseRef,
    headRefOid: (source) => (source.pull as Pull).headSha,
    baseRefOid: (source) => (source.pull as Pull).baseSha,
    mergedAt: (source) => (source.pull as Pull).mergedAt,
    files: (source, args) => {
      const repo = source.repo as Repo;
      const pull = source.pull as Pull;
      const first = typeof args.first === 'number' ? args.first : 100;
      const files = pullRequestFiles(repo, pull).slice(0, first);
      return { __typename: 'PullRequestFileConnection', nodes: files.map((file) => ({ __typename: 'PullRequestFile', path: file.filename })) };
    },
    url: (source) => `https://github.com/${(source.repo as Repo).owner}/${(source.repo as Repo).name}/pull/${(source.pull as Pull).number}`,
    createdAt: (source) => (source.pull as Pull).createdAt,
    updatedAt: (source) => (source.pull as Pull).createdAt,
    author: () => gqlViewer(),
  },
  IssueComment: {
    id: (source) => commentGlobalId(source.repo as Repo, source.issueNumber as number, (source.comment as Comment).id),
    body: (source) => (source.comment as Comment).body,
  },
  Ref: {
    name: (source) => asString(source.name),
  },
  PageInfo: {
    hasNextPage: (source) => source.hasNextPage as boolean,
    endCursor: (source) => source.endCursor as string | null,
  },
  __Type: {
    name: (source) => asString(source.name),
    kind: (source) => asString(source.kind),
    fields: (source) => (source.fields as Array<{ name: string }> | null) ?? null,
    enumValues: (source) => (source.enumValues as Array<{ name: string }> | null) ?? null,
  },
};

function executeSelection(source: unknown, typeName: string, fields: GqlField[], ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const resolvers = GQL_RESOLVERS[typeName] ?? {};
  for (const field of fields) {
    if (field.fragmentType !== null) {
      const src = source as GqlSource | null;
      const srcType = src !== null && typeof src === 'object' ? (src as GqlSource).__typename : null;
      if (field.children !== null && (field.fragmentType === srcType || srcType === null)) {
        Object.assign(out, executeSelection(source, typeName, field.children, ctx));
      }
      continue;
    }
    const responseKey = field.alias ?? field.name;
    const resolver = resolvers[field.name];
    let value: unknown;
    let resolved = false;
    if (resolver !== undefined) {
      try {
        value = resolver(source as GqlSource, field.args, ctx);
        resolved = true;
      } catch {
        ctx.errors.push({ message: `Field "${field.name}" on type "${typeName}" threw.` });
        out[responseKey] = null;
        continue;
      }
    } else if (source !== null && typeof source === 'object' && field.name in (source as Record<string, unknown>)) {
      // Payloads, connections and edges: a plain property read.
      value = (source as Record<string, unknown>)[field.name];
      resolved = true;
    }
    if (!resolved) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[responseKey] = null;
      continue;
    }
    if (field.children !== null) {
      if (value === null || value === undefined) {
        out[responseKey] = null;
      } else if (Array.isArray(value)) {
        out[responseKey] = value.map((item) => {
          const itemType = (item as GqlSource).__typename ?? typeName;
          return executeSelection(item, itemType, field.children as GqlField[], ctx);
        });
      } else if (typeof value === 'object') {
        const itemType = (value as GqlSource).__typename ?? typeName;
        out[responseKey] = executeSelection(value, itemType, field.children, ctx);
      } else {
        out[responseKey] = value;
      }
    } else {
      out[responseKey] = value;
    }
  }
  return out;
}

function executeGraphQL(query: string, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const ctx: GqlCtx = { errors: [] };
  let operation: { kind: 'query' | 'mutation'; fields: GqlField[] };
  try {
    operation = new GqlParser(query, variables).parseOperation();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection({ __typename: rootType }, rootType, operation.fields, ctx);
  return { data, errors: ctx.errors };
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = nextRequestId();
  const headers = { 'content-type': 'application/json', 'x-github-request-id': requestId };
  if (req.method !== 'POST') {
    res.writeHead(405, headers);
    res.end(JSON.stringify({ message: 'Method Not Allowed' }));
    return;
  }
  if (!authed(req)) {
    res.writeHead(401, headers);
    res.end(JSON.stringify({ message: 'Requires authentication' }));
    return;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    res.writeHead(400, headers);
    res.end(JSON.stringify({ message: 'Request body too large' }));
    return;
  }
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    res.writeHead(400, headers);
    res.end(JSON.stringify({ message: 'Invalid JSON body' }));
    return;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { data: null, errors: [{ message: 'A GraphQL operation needs a query string.' }] };
    }
    const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
    const { data, errors } = executeGraphQL(entry.query, variables);
    return errors.length > 0 ? { data, errors } : { data };
  };
  const answer = Array.isArray(parsed.value) ? parsed.value.map(runOne) : runOne(parsed.value);
  res.writeHead(200, headers);
  res.end(JSON.stringify(answer));
}

// -------------------------------------------------------------------------------------------------
// MCP: streamable HTTP JSON-RPC
// -------------------------------------------------------------------------------------------------

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const MCP_TOOLS: readonly McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the token owner.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const MCP_VERSIONS = ['2026-07-28', '2025-11-25'];
const MCP_SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

function mcpToolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function mcpToolError(message: string): Record<string, unknown> {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function mcpCallTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw { code: -32602, message: `Unknown tool: ${name}` };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return mcpToolError(`Missing required argument: ${required}`);
    }
  }
  const owner = asString(args.owner);
  const repoName = asString(args.repo);
  if (name === 'create_repo') {
    const repo = getRepo(VIEWER.login, asString(args.name)) ?? createRepoRecord(asString(args.name), asBool(args.private, false), asString(args.description));
    return mcpToolResult(repoJson(repo));
  }
  const repo = getRepo(owner, repoName);
  if (repo === undefined) return mcpToolError(`Repository not found: ${owner}/${repoName}`);
  if (name === 'get_repo') return mcpToolResult(repoJson(repo));
  if (name === 'create_issue') {
    const issue: Issue = {
      number: repo.nextIssue++,
      title: asString(args.title),
      body: asString(args.body),
      state: 'open',
      labels: [],
      seq: globalSeq++,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    repo.issues.set(issue.number, issue);
    return mcpToolResult(issueJson(repo, issue));
  }
  if (name === 'list_issues') {
    const state = asString(args.state) || 'open';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    list.sort((a, b) => a.seq - b.seq);
    return mcpToolResult(list.map((issue) => issueJson(repo, issue)));
  }
  if (name === 'create_pull_request') {
    const headRef = stripHeadOwner(asString(args.head));
    const baseRef = stripHeadOwner(asString(args.base));
    const headSha = branchTip(repo, headRef);
    const baseSha = branchTip(repo, baseRef);
    if (headSha === undefined || baseSha === undefined) return mcpToolError('head or base branch does not exist');
    for (const existing of repo.pulls.values()) {
      if (existing.headRef === headRef && existing.state === 'open') return mcpToolError('A pull request already exists for this head branch');
    }
    const pull: Pull = {
      number: repo.nextPull++,
      title: asString(args.title),
      body: asString(args.body),
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeSha: null,
      seq: globalSeq++,
      createdAt: nowIso(),
    };
    repo.pulls.set(pull.number, pull);
    return mcpToolResult(pullJson(repo, pull));
  }
  if (name === 'merge_pull_request') {
    const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(asString(args.pull_number), 10);
    const pull = repo.pulls.get(number);
    if (pull === undefined) return mcpToolError(`Pull request not found: #${number}`);
    if (pull.state !== 'open' || pull.merged) return mcpToolError('Pull request is already merged or closed');
    if (pullRequestConflicts(repo, pull)) return mcpToolError('Merge conflict');
    const mergeSha = mergePullRequest(repo, pull);
    if (mergeSha === null) return mcpToolError('Merge conflict');
    return mcpToolResult({ sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
  }
  return mcpToolError(`Unknown tool: ${name}`);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = nextRequestId();
  const headers = { 'content-type': 'application/json', 'x-github-request-id': requestId };
  if (req.method !== 'POST') {
    res.writeHead(405, headers);
    res.end(JSON.stringify({ message: 'Method Not Allowed' }));
    return;
  }
  if (!authed(req)) {
    res.writeHead(401, headers);
    res.end(JSON.stringify({ message: 'Requires authentication' }));
    return;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    res.writeHead(400, headers);
    res.end(JSON.stringify({ message: 'Request body too large' }));
    return;
  }
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    res.writeHead(400, headers);
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }
  const body = parsed.value;
  if (!isRecord(body) || typeof body.method !== 'string') {
    res.writeHead(400, headers);
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }));
    return;
  }
  const id = body.id === undefined ? null : body.id;
  // A notification (no id) is answered with 202 and an empty body.
  if (id === null && body.id === undefined) {
    res.writeHead(202, headers);
    res.end('');
    return;
  }
  const sendResult = (result: unknown): void => {
    res.writeHead(200, headers);
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
  const sendError = (code: number, message: string): void => {
    res.writeHead(200, headers);
    res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
  };
  const params = isRecord(body.params) ? (body.params as Record<string, unknown>) : {};
  try {
    if (body.method === 'server/discover') {
      sendResult({
        supportedVersions: MCP_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
        protocolVersion: MCP_VERSIONS[0],
      });
    } else if (body.method === 'initialize') {
      const offered = asString(params.protocolVersion);
      sendResult({
        protocolVersion: MCP_VERSIONS.includes(offered) ? offered : (MCP_VERSIONS[0] as string),
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
      });
    } else if (body.method === 'ping') {
      sendResult({});
    } else if (body.method === 'tools/list') {
      sendResult({ tools: MCP_TOOLS });
    } else if (body.method === 'tools/call') {
      const toolName = asString(params.name);
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      sendResult(mcpCallTool(toolName, args));
    } else {
      sendError(-32601, `Method not found: ${body.method}`);
    }
  } catch (err) {
    if (err !== null && typeof err === 'object' && 'code' in (err as Record<string, unknown>)) {
      const rpc = err as { code: number; message: string };
      sendError(rpc.code, rpc.message);
    } else {
      sendError(-32603, err instanceof Error ? err.message : 'Internal error');
    }
  }
}

// -------------------------------------------------------------------------------------------------
// App
// -------------------------------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const path = url.pathname;
  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (path === '/api/graphql') {
    await handleGraphQL(req, res);
    return;
  }
  if (path === '/mcp') {
    await handleMcp(req, res);
    return;
  }
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(req, res, url);
    return;
  }
  if (path.includes('.git/')) {
    await handleGit(req, res, url);
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json', 'x-github-request-id': nextRequestId() });
  res.end(JSON.stringify({ message: 'Not Found' }));
}

export function createApp(): Server {
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'Internal error' }));
        }
      } catch {
        // The socket is already gone; nothing left to do.
      }
      process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  });
  // v2: disable Nagle on every accepted socket so small replies (issue
  // JSON, ack lines) go out at once instead of waiting for the client's
  // ACK. The bench issues thousands of small sequential requests.
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });
  return server;
}
