// main.ts is mend, the CLI SPEC.md specifies. It does sections 1 to 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, matching lines at three tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write
// (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** A file as lines: its line break, whether it ends with one, and its lines (the empty piece after a final break is not a line). */
interface FileDoc {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function parseFile(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
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
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  move(oldP: string, newP: string, text: string): void {
    this.now.set(oldP, null);
    this.now.set(newP, text);
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

/** One line of a chunk's old or new side: 'ctx' (context, in both), 'old' (removed), 'new' (added). */
interface ChunkLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}

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
      if (tree.get(p) !== null) throw new Fail('exists', p);
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

// ---- section 5: matching lines ----

/** Tier equality for one line: 0 exact, 1 trailing spaces/tabs removed, 2 leading and trailing removed. */
function tierEqual(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  const stripT = (s: string): string => s.replace(/[ \t]+$/, '');
  if (tier === 1) return stripT(a) === stripT(b);
  const stripB = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return stripB(a) === stripB(b);
}

/** 0-based positions where O occurs in fileLines at tier, at or after `from`. Occurrences may overlap. */
function occurrencesAt(fileLines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!tierEqual(fileLines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, then 1, then 2; strict: only 0) at which O occurs at least once, with its occurrences. */
function findTier(fileLines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(fileLines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * The lines N writes when O matched at `pos` (SPEC.md section 5): a context line is the file's own matched line;
 * at tier 2 every other line of N is re-indented from O's first line's leading whitespace to the file's.
 */
function buildNew(fileLines: string[], pos: number, o: ChunkLine[], n: ChunkLine[], tier: number): string[] {
  const oCtx: number[] = [];
  o.forEach((l, i) => {
    if (l.kind === 'ctx') oCtx.push(i);
  });
  const lead = (s: string): string => s.match(/^[ \t]*/)?.[0] ?? '';
  const f = lead(fileLines[pos] ?? '');
  const p = lead(o[0]?.text ?? '');
  const out: string[] = [];
  let seen = 0;
  for (const nl of n) {
    if (nl.kind === 'ctx') {
      out.push(fileLines[pos + oCtx[seen]!]!);
      seen += 1;
    } else {
      let s = nl.text;
      if (tier === 2 && s.trim() !== '' && s.startsWith(p)) s = f + s.slice(p.length);
      out.push(s);
    }
  }
  return out;
}

// ---- section 6: unified diffs ----

interface UnifiedHunk {
  a: number;
  body: { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string }[];
}

interface UnifiedSection {
  oldPath: string | null; // null: /dev/null
  newPath: string | null; // null: /dev/null
  isCreate: boolean;
  isDelete: boolean;
  hunks: UnifiedHunk[];
}

/** Path from a `--- ` / `+++ ` line: text after the four characters, up to the first tab, spaces removed, leading a/ or b/ removed. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:[ \t].*)?$/;

function parseUnified(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let hasPair = false;
  let renameOld: string | null = null;
  let renameNew: string | null = null;
  let diffOld = '';
  let diffNew = '';
  const finishSection = (): void => {
    if (cur === null) return;
    if (!hasPair) {
      if (renameOld !== null) cur.oldPath = renameOld;
      else cur.oldPath = diffOld;
      if (renameNew !== null) cur.newPath = renameNew;
      else cur.newPath = diffNew;
    }
    sections.push(cur);
    cur = null;
  };
  const startSection = (oldP: string | null, newP: string | null): void => {
    finishSection();
    cur = { oldPath: oldP, newPath: newP, isCreate: false, isDelete: false, hunks: [] };
    hasPair = oldP !== null || newP !== null;
    renameOld = null;
    renameNew = null;
    diffOld = '';
    diffNew = '';
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(null, null);
      diffOld = m[1]!;
      diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && !hasPair) {
        // part of the current section's header
        cur.oldPath = line.slice(4).trim() === '/dev/null' ? null : headerPath(line);
        const nx = lines[i + 1]!;
        cur.newPath = nx.slice(4).trim() === '/dev/null' ? null : headerPath(nx);
        hasPair = true;
        i += 2;
        continue;
      }
      // a new section
      const oldP = line.slice(4).trim() === '/dev/null' ? null : headerPath(line);
      const nx = lines[i + 1]!;
      const newP = nx.slice(4).trim() === '/dev/null' ? null : headerPath(nx);
      startSection(oldP, newP);
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && cur.hunks.length === 0) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: UnifiedHunk = { a: Number(m[1]), body: [] };
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith('@@')) break;
        if (b === '') hunk.body.push({ kind: 'ctx', text: '' });
        else if (b[0] === ' ') hunk.body.push({ kind: 'ctx', text: b.slice(1) });
        else if (b[0] === '-') hunk.body.push({ kind: 'old', text: b.slice(1) });
        else if (b[0] === '+') hunk.body.push({ kind: 'new', text: b.slice(1) });
        else if (b[0] === '\\') hunk.body.push({ kind: 'bs', text: b.slice(1) });
        else break;
        i += 1;
      }
      // empty lines at the end of a body are not part of it
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.kind === 'ctx' && hunk.body[hunk.body.length - 1]!.text === '') {
        hunk.body.pop();
      }
      cur.hunks.push(hunk);
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // section header lines
      if (line.startsWith('rename from ')) renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i += 1;
      continue;
    }
    // outside bodies, lines that are not part of a section header are ignored
    i += 1;
  }
  finishSection();
  return sections;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function unifiedNoEol(hunk: UnifiedHunk): boolean {
  let last = -1;
  hunk.body.forEach((b, i) => {
    if (b.kind === 'ctx' || b.kind === 'new') last = i;
  });
  return last >= 0 && hunk.body[last + 1]?.kind === 'bs';
}

/** Apply one hunk to a file doc; d is the running length offset of earlier hunks in this section. */
function applyUnifiedHunk(doc: FileDoc, hunk: UnifiedHunk, d: number, strict: boolean, path: string): number {
  const o: ChunkLine[] = [];
  const n: ChunkLine[] = [];
  for (const b of hunk.body) {
    if (b.kind === 'ctx') {
      o.push({ kind: 'ctx', text: b.text });
      n.push({ kind: 'ctx', text: b.text });
    } else if (b.kind === 'old') o.push({ kind: 'old', text: b.text });
    else if (b.kind === 'new') n.push({ kind: 'new', text: b.text });
  }
  const noEol = unifiedNoEol(hunk);
  if (o.length === 0) {
    const at = Math.min(Math.max(hunk.a + d, 0), doc.lines.length);
    const atEnd = at === doc.lines.length;
    doc.lines.splice(at, 0, ...n.map((x) => x.text));
    if (atEnd) doc.final = !noEol;
    return n.length;
  }
  const oText = o.map((x) => x.text);
  const found = findTier(doc.lines, oText, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let pos = found.occ[0]!;
  for (const q of found.occ) {
    if (Math.abs(q - target) < Math.abs(pos - target)) pos = q;
  }
  const atEnd = pos + o.length === doc.lines.length;
  const repl = buildNew(doc.lines, pos, o, n, found.tier);
  doc.lines.splice(pos, o.length, ...repl);
  if (atEnd) doc.final = !noEol;
  return n.length - o.length;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((sec) => {
    return (tree: Tree): void => {
      const oldP = sec.oldPath;
      const newP = sec.newPath;
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      if (oldP === null || sec.isCreate) {
        // creation
        if (newP === null) throw new Fail('unsafe', '/dev/null');
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plus: string[] = [];
        let lastPlusBs = false;
        for (const h of sec.hunks) {
          let last = -1;
          h.body.forEach((b, i) => {
            if (b.kind === 'new') {
              plus.push(b.text);
              last = i;
            }
          });
          if (last >= 0) lastPlusBs = h.body[last + 1]?.kind === 'bs';
        }
        const text = plus.length === 0 ? '' : plus.join('\n') + (lastPlusBs ? '' : '\n');
        tree.now.set(newP, text);
        return;
      }
      if (newP === null || sec.isDelete) {
        // deletion
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
        return;
      }
      if (oldP !== newP) {
        // move
        const before = tree.get(oldP);
        if (before === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const doc = parseFile(before);
        let d = 0;
        for (const h of sec.hunks) d += applyUnifiedHunk(doc, h, d, strict, oldP);
        tree.move(oldP, newP, renderFile(doc));
        return;
      }
      // change
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      const doc = parseFile(before);
      let d = 0;
      for (const h of sec.hunks) d += applyUnifiedHunk(doc, h, d, strict, oldP);
      tree.now.set(oldP, renderFile(doc));
    };
  });
}

// ---- section 7: SEARCH/REPLACE blocks ----

interface SrBlock {
  path: string;
  old: string[];
  neu: string[];
}

function parseSr(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  let lastPath: string | null = null;
  let after = 0; // index just past the previous block's REPLACE line
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = i - 1; j >= after; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (lastPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = lastPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, old: lines.slice(i + 1, eq), neu: lines.slice(eq + 1, rep) });
    lastPath = path;
    after = rep + 1;
    i = rep + 1;
  }
  return blocks;
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks = parseSr(lines);
  return blocks.map((b) => {
    return (tree: Tree): void => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.old.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.neu.length === 0 ? '' : `${b.neu.join('\n')}\n`);
        return;
      }
      const before = tree.get(b.path);
      if (before === null) throw new Fail('missing', b.path);
      const doc = parseFile(before);
      const found = findTier(doc.lines, b.old, strict);
      if (found === null) throw new Fail('no-match', b.path);
      if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
      const o: ChunkLine[] = b.old.map((t) => ({ kind: 'old' as const, text: t }));
      const n: ChunkLine[] = b.neu.map((t) => ({ kind: 'new' as const, text: t }));
      const repl = buildNew(doc.lines, found.occ[0]!, o, n, found.tier);
      doc.lines.splice(found.occ[0]!, b.old.length, ...repl);
      tree.now.set(b.path, renderFile(doc));
    };
  });
}

// ---- section 8: V4A patches ----

interface V4aChunk {
  anchor: string | null;
  body: { kind: 'ctx' | 'old' | 'new'; text: string }[];
  eof: boolean;
}

type V4aSection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4aChunk[]; lineNo: number };

function isSectionStart(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith('*** Add File: ')) return 'add';
  if (line.startsWith('*** Delete File: ')) return 'delete';
  if (line.startsWith('*** Update File: ')) return 'update';
  return null;
}

function sectionPath(line: string, kind: 'add' | 'delete' | 'update'): string {
  const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
  return line.slice(prefix.length).trim();
}

function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = isSectionStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = sectionPath(line, kind);
    if (kind === 'add') {
      const fileLines: string[] = [];
      i += 1;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l) !== null || l.trim() === '*** End Patch') break;
        if (l === '') fileLines.push('');
        else if (l.startsWith('+')) fileLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      sections.push({ kind: 'add', path, lines: fileLines });
      continue;
    }
    if (kind === 'delete') {
      i += 1;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l) !== null || l.trim() === '*** End Patch') break;
        if (blank(l)) {
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      sections.push({ kind: 'delete', path });
      continue;
    }
    // update
    const updateLineNo = i + 1;
    let moveTo: string | null = null;
    const chunks: V4aChunk[] = [];
    let cur: V4aChunk | null = null;
    let closedByEof = false;
    i += 1;
    while (i < last) {
      const l = lines[i]!;
      if (isSectionStart(l) !== null || l.trim() === '*** End Patch') break;
      if (l.startsWith('*** Move to: ')) {
        if (moveTo !== null || chunks.length > 0 || cur !== null) throw new Exit2(`error: parse ${i + 1}`);
        moveTo = l.slice('*** Move to: '.length).trim();
        i += 1;
        continue;
      }
      if (l === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
        cur.eof = true;
        cur = null;
        closedByEof = true;
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        const anchor = l.slice(2).trim();
        cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
        chunks.push(cur);
        closedByEof = false;
        i += 1;
        continue;
      }
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
        if (cur === null) {
          if (chunks.length > 0) {
            if (l === '' && closedByEof) {
              i += 1;
              continue;
            }
            throw new Exit2(`error: parse ${i + 1}`);
          }
          cur = { anchor: null, body: [], eof: false };
          chunks.push(cur);
          closedByEof = false;
        }
        if (l === '') cur.body.push({ kind: 'ctx', text: '' });
        else if (l[0] === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1) });
        else if (l[0] === '-') cur.body.push({ kind: 'old', text: l.slice(1) });
        else cur.body.push({ kind: 'new', text: l.slice(1) });
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur !== null) {
      while (cur.body.length > 0 && cur.body[cur.body.length - 1]!.kind === 'ctx' && cur.body[cur.body.length - 1]!.text === '') {
        cur.body.pop();
      }
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
    sections.push({ kind: 'update', path, moveTo, chunks, lineNo: updateLineNo });
  }
  return sections;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseV4a(lines);
  return sections.map((sec) => {
    return (tree: Tree): void => {
      if (sec.kind === 'add') {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, sec.lines.length === 0 ? '' : `${sec.lines.join('\n')}\n`);
        return;
      }
      if (sec.kind === 'delete') {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
        return;
      }
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      const before = tree.get(sec.path);
      if (before === null) throw new Fail('missing', sec.path);
      if (sec.moveTo !== null) {
        if (!safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
        if (tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
      }
      const doc = parseFile(before);
      let cursor = 0;
      for (const chunk of sec.chunks) {
        if (chunk.anchor !== null) {
          const found = findTier(doc.lines, [chunk.anchor], strict, cursor);
          if (found === null) throw new Fail('no-match', sec.path);
          cursor = found.occ[0]! + 1;
        }
        const o: ChunkLine[] = [];
        const n: ChunkLine[] = [];
        for (const b of chunk.body) {
          if (b.kind === 'ctx') {
            o.push({ kind: 'ctx', text: b.text });
            n.push({ kind: 'ctx', text: b.text });
          } else if (b.kind === 'old') o.push({ kind: 'old', text: b.text });
          else n.push({ kind: 'new', text: b.text });
        }
        if (o.length === 0) {
          const at = chunk.eof ? doc.lines.length : cursor;
          doc.lines.splice(at, 0, ...n.map((x) => x.text));
          cursor = at + n.length;
          continue;
        }
        const oText = o.map((x) => x.text);
        const found = findTier(doc.lines, oText, strict, cursor);
        if (found === null) throw new Fail('no-match', sec.path);
        let pos: number | null = null;
        for (const q of found.occ) {
          if (!chunk.eof || q + o.length === doc.lines.length) {
            pos = q;
            break;
          }
        }
        if (pos === null) throw new Fail('no-match', sec.path);
        const repl = buildNew(doc.lines, pos, o, n, found.tier);
        doc.lines.splice(pos, o.length, ...repl);
        cursor = pos + repl.length;
      }
      const out = renderFile(doc);
      if (sec.moveTo !== null) tree.move(sec.path, sec.moveTo, out);
      else tree.now.set(sec.path, out);
    };
  });
}

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Rows first (originals are read from disk, before any write), then the writes.
  interface Row {
    key: string;
    line: string;
    path: string;
    now: string | null;
  }
  const rows: Row[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}`, path: newP, now: nowNew });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, path: p, now });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const r of rows) {
      if (r.line.startsWith('R ')) {
        const oldP = r.line.slice(2, r.line.indexOf(' -> '));
        rmSync(oldP, { force: true });
        mkdirSync(dirname(r.path), { recursive: true });
        writeFileSync(r.path, r.now!);
      } else if (r.now === null) {
        rmSync(r.path, { force: true });
      } else {
        mkdirSync(dirname(r.path), { recursive: true });
        writeFileSync(r.path, r.now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
