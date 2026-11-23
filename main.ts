// main.ts is mend, the CLI SPEC.md specifies: Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`. It reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none, printing what it changed or why it failed.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** A file's text split at its own line break, with whether it ends with one. */
interface Split {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): Split {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  private readonly disk = new Map<string, 'file' | 'dir' | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as (old, new) pairs, in the order the edits made them. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  diskType(p: string): 'file' | 'dir' | null {
    if (!this.disk.has(p)) {
      let v: 'file' | 'dir' | null = null;
      try {
        v = statSync(p).isFile() ? 'file' : 'dir';
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** True when a file (or a directory) stands at the path in the tree as it now is. */
  existsNow(p: string): boolean {
    if (this.get(p) !== null) return true;
    return !this.now.has(p) && this.diskType(p) === 'dir';
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- line matching (SPEC.md section 5) ----

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Start positions where `pat` occurs in `lines` at one tier (occurrences may overlap). */
function occurrences(lines: string[], pat: string[], tier: number, from = 0): number[] {
  const np = pat.map((l) => normLine(l, tier));
  const out: number[] = [];
  for (let i = from; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (normLine(lines[i + j]!, tier) !== np[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `pat` occurs at least once (at or after `from`), with its positions. */
function findTier(lines: string[], pat: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrences(lines, pat, t, from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** First line at or after `from` equal to the single-line `anchor`, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const want = normLine(anchor, t);
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === want) return i;
    }
  }
  return -1;
}

/** Re-indent one new line at tier 2: the patch's first-line indent P becomes the file's F. */
function reindentLine(t: string, p: string, f: string): string {
  if (t === '' || t.trim() === '') return t;
  return t.startsWith(p) ? f + t.slice(p.length) : t;
}

/** One body line of a unified hunk or a V4A chunk: context, old or new. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A `\` line follows this item (no newline at end of file for the new text). */
  noEol: boolean;
}

/**
 * Build the lines that replace a match: context lines are written as the file's own matched
 * lines, other new lines are re-indented at tier 2.
 */
function buildReplacement(items: BodyItem[], oldLines: string[], fileLines: string[], at: number, tier: number): string[] {
  const p = leadingWs(oldLines[0]!);
  const f = leadingWs(fileLines[at]!);
  let oIdx = 0;
  const out: string[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[at + oIdx]!);
      oIdx++;
    } else if (it.kind === 'old') {
      oIdx++;
    } else {
      out.push(tier === 2 ? reindentLine(it.text, p, f) : it.text);
    }
  }
  return out;
}

// ---- JSON edits (SPEC.md section 9) ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.existsNow(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- unified diffs (SPEC.md section 6) ----

interface UHunk {
  /** The -A of the hunk header. */
  a: number;
  items: BodyItem[];
  /** A `\` line follows the hunk's last context or `+` line. */
  lastCtxOrNewNoEol: boolean;
  /** A `\` line follows the hunk's last `+` line (null when it has none). */
  lastPlusNoEol: boolean | null;
}

interface USection {
  pairOld: string | null;
  pairNew: string | null;
  havePair: boolean;
  renOld: string | undefined;
  renNew: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UHunk[];
}

/** The path after `--- ` / `+++ `: up to the first tab, spaces removed, /dev/null is null. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function parseHunk(lines: string[], i: number): { hunk: UHunk; next: number } {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const items: BodyItem[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      const kind = l === '' || l.startsWith(' ') ? 'ctx' : l.startsWith('-') ? 'old' : 'new';
      items.push({ kind, text: l === '' ? '' : l.slice(1), noEol: false });
      j++;
    } else if (l.startsWith('\\')) {
      if (items.length > 0) items[items.length - 1]!.noEol = true;
      j++;
    } else break;
  }
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') items.pop();
    else break;
  }
  let lastCtxOrNewNoEol = false;
  let lastPlusNoEol: boolean | null = null;
  for (const it of items) {
    if (it.kind === 'ctx' || it.kind === 'new') lastCtxOrNewNoEol = it.noEol;
    if (it.kind === 'new') lastPlusNoEol = it.noEol;
  }
  return { hunk: { a: parseInt(m[1]!, 10), items, lastCtxOrNewNoEol, lastPlusNoEol }, next: j };
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !cur.havePair) {
        cur.pairOld = headerPath(l);
        cur.pairNew = headerPath(lines[i + 1]!);
        cur.havePair = true;
        i += 2;
        continue;
      }
      cur = { pairOld: headerPath(l), pairNew: headerPath(lines[i + 1]!), havePair: true, renOld: undefined, renNew: undefined, diffOld: undefined, diffNew: undefined, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { pairOld: null, pairNew: null, havePair: false, renOld: undefined, renNew: undefined, diffOld: m[1]!, diffNew: m[2]!, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('@@')) {
        const { hunk, next } = parseHunk(lines, i);
        cur.hunks.push(hunk);
        inHeader = false;
        i = next;
        continue;
      }
      if (l.startsWith('rename from ')) cur.renOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renNew = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const { hunk, next } = parseHunk(lines, i);
      cur.hunks.push(hunk);
      i = next;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

/** Apply a section's hunks in order to a file's text; throws Fail('no-match', path). */
function applyHunks(text: string, hunks: UHunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let cur = f.lines.slice();
  let finalBreak = f.final;
  let d = 0;
  for (const h of hunks) {
    const oldLines = h.items.filter((it) => it.kind !== 'new').map((it) => it.text);
    if (oldLines.length > 0) {
      const found = findTier(cur, oldLines, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const rep = buildReplacement(h.items, oldLines, cur, best, found.tier);
      const touchesEnd = best + oldLines.length === cur.length;
      cur = [...cur.slice(0, best), ...rep, ...cur.slice(best + oldLines.length)];
      if (touchesEnd) finalBreak = !h.lastCtxOrNewNoEol;
      d += rep.length - oldLines.length;
    } else {
      const added = h.items.filter((it) => it.kind === 'new').map((it) => it.text);
      let at = h.a + d;
      if (at < 0) at = 0;
      if (at > cur.length) at = cur.length;
      const touchesEnd = at === cur.length;
      cur = [...cur.slice(0, at), ...added, ...cur.slice(at)];
      if (touchesEnd) finalBreak = !h.lastCtxOrNewNoEol;
      d += added.length;
    }
  }
  return joinFile(cur, f.br, finalBreak);
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  const oldP = sec.havePair ? sec.pairOld : sec.renOld !== undefined ? sec.renOld : sec.diffOld !== undefined ? sec.diffOld : null;
  const newP = sec.havePair ? sec.pairNew : sec.renNew !== undefined ? sec.renNew : sec.diffNew !== undefined ? sec.diffNew : null;
  const isCreate = oldP === null || sec.newFile;
  const isDelete = !isCreate && (newP === null || sec.deletedFile);
  const isMove = !isCreate && !isDelete && oldP !== newP;
  return (tree) => {
    if (isCreate) {
      const np = newP ?? '';
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.existsNow(np)) throw new Fail('exists', np);
      const plus: string[] = [];
      let lastPlusNoEol: boolean | null = null;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind === 'new') {
            plus.push(it.text);
            lastPlusNoEol = it.noEol;
          }
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoEol === true ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const op = oldP ?? '';
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (isMove) {
      const op = oldP ?? '';
      const np = newP ?? '';
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.existsNow(np)) throw new Fail('exists', np);
      const out = applyHunks(before, sec.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, out);
      tree.moves.push([op, np]);
      return;
    }
    const p = oldP ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  };
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let k = searchIdx + 1;
    while (k < lines.length) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
      k++;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    k = eq + 1;
    while (k < lines.length) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
      k++;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks;
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.existsNow(b.path)) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const f = splitFile(before);
    const found = findTier(f.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.positions[0]!;
    const rep = b.newLines.map((t) => (found.tier === 2 ? reindentLine(t, leadingWs(b.oldLines[0]!), leadingWs(f.lines[pos]!)) : t));
    const cur = [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + b.oldLines.length)];
    tree.now.set(b.path, joinFile(cur, f.br, f.final));
  };
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
  sawLine: boolean;
}

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let curChunk: VChunk | null = null;
  let chunkOpen = false;
  const endSection = (): void => {
    if (cur === null) return;
    if (cur.kind === 'add') {
      while (cur.addLines.length > 0 && cur.addLines[cur.addLines.length - 1] === '') cur.addLines.pop();
    }
    if (cur.kind === 'update' && chunkOpen && curChunk !== null) {
      while (curChunk.items.length > 0) {
        const lastItem = curChunk.items[curChunk.items.length - 1]!;
        if (lastItem.kind === 'ctx' && lastItem.text.trim() === '') curChunk.items.pop();
        else break;
      }
    }
    if (cur.kind === 'update' && cur.chunks.length === 0 && cur.moveTo === null) {
      throw new Exit2(`error: parse ${cur.line}`);
    }
    cur = null;
    curChunk = null;
    chunkOpen = false;
  };
  const headerOf = (l: string): VSection | null => {
    if (l.startsWith('*** Add File:')) return { kind: 'add', path: l.slice('*** Add File:'.length).trim(), line: 0, addLines: [], moveTo: null, chunks: [], sawLine: false };
    if (l.startsWith('*** Delete File:')) return { kind: 'delete', path: l.slice('*** Delete File:'.length).trim(), line: 0, addLines: [], moveTo: null, chunks: [], sawLine: false };
    if (l.startsWith('*** Update File:')) return { kind: 'update', path: l.slice('*** Update File:'.length).trim(), line: 0, addLines: [], moveTo: null, chunks: [], sawLine: false };
    return null;
  };
  let i = first + 1;
  const isHeaderLine = (s: string): boolean => s.startsWith('*** Add File:') || s.startsWith('*** Delete File:') || s.startsWith('*** Update File:');
  /** True when every line after `from`, up to the next section or `*** End Patch`, is blank. */
  const trailingBlanks = (from: number): boolean => {
    for (let j = from + 1; j < last; j++) {
      if (isHeaderLine(lines[j]!)) return true;
      if (!blank(lines[j]!)) return false;
    }
    return true;
  };
  while (i < last) {
    const l = lines[i]!;
    const head = headerOf(l);
    if (head !== null) {
      endSection();
      head.line = i + 1;
      cur = head;
      sections.push(cur);
      i++;
      continue;
    }
    if (cur === null) {
      if (blank(l)) {
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'add') {
      if (l.startsWith('+')) cur.addLines.push(l.slice(1));
      else if (l === '') cur.addLines.push('');
      else if (blank(l) && trailingBlanks(i)) {
        // A blank line at the end of the section is not part of it.
      } else throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (cur.kind === 'delete') {
      if (blank(l)) {
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // update
    if (cur.chunks.length === 0 && curChunk === null && !cur.sawLine && l.startsWith('*** Move to:')) {
      cur.moveTo = l.slice('*** Move to:'.length).trim();
      cur.sawLine = true;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      curChunk = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), items: [], eof: false };
      cur.chunks.push(curChunk);
      chunkOpen = true;
      cur.sawLine = true;
      i++;
      continue;
    }
    if (l === '*** End of File') {
      if (!chunkOpen || curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
      curChunk.eof = true;
      chunkOpen = false;
      cur.sawLine = true;
      i++;
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (!chunkOpen) {
        if (cur.chunks.length > 0) {
          if (blank(l)) {
            i++;
            continue;
          }
          throw new Exit2(`error: parse ${i + 1}`);
        }
        curChunk = { anchor: null, items: [], eof: false };
        cur.chunks.push(curChunk);
        chunkOpen = true;
      }
      const kind = l === '' || l.startsWith(' ') ? 'ctx' : l.startsWith('-') ? 'old' : 'new';
      curChunk!.items.push({ kind, text: l === '' ? '' : l.slice(1), noEol: false });
      cur.sawLine = true;
      i++;
      continue;
    }
    if (blank(l) && trailingBlanks(i)) {
      // A blank line at the end of the section is not part of it.
      i++;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  endSection();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.existsNow(sec.path)) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.existsNow(sec.moveTo)) throw new Fail('exists', sec.moveTo);
    const f = splitFile(before);
    let cur = f.lines.slice();
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(cur, ch.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', sec.path);
        cursor = at + 1;
      }
      const oldLines = ch.items.filter((it) => it.kind !== 'new').map((it) => it.text);
      if (oldLines.length === 0) {
        const added = ch.items.filter((it) => it.kind === 'new').map((it) => it.text);
        const at = ch.eof ? cur.length : cursor;
        cur = [...cur.slice(0, at), ...added, ...cur.slice(at)];
        cursor = at + added.length;
      } else {
        const found = findTier(cur, oldLines, strict, cursor);
        if (found === null) throw new Fail('no-match', sec.path);
        let pos = found.positions[0]!;
        if (ch.eof) {
          const ok = found.positions.find((p) => p + oldLines.length === cur.length);
          if (ok === undefined) throw new Fail('no-match', sec.path);
          pos = ok;
        }
        const rep = buildReplacement(ch.items, oldLines, cur, pos, found.tier);
        cur = [...cur.slice(0, pos), ...rep, ...cur.slice(pos + oldLines.length)];
        cursor = pos + rep.length;
      }
    }
    const text = joinFile(cur, f.br, f.final);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, text);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, text);
    }
  };
}

// ---- driver (SPEC.md sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines).map((s) => unifiedEdit(s, strict));
    else if (kind === 'search-replace') edits = parseSearchReplace(lines).map((b) => srEdit(b, strict));
    else edits = parseV4a(lines).map((s) => v4aEdit(s, strict));
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const used = new Set<string>();
  const claimedNew = new Set<string>();
  for (const [o, nw] of tree.moves) {
    if (claimedNew.has(nw)) continue;
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(nw) === null && tree.get(nw) !== null) {
      rows.push({ key: nw, line: `R ${o} -> ${nw}` });
      used.add(o);
      used.add(nw);
      claimedNew.add(nw);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
