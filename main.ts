// mend: the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and this file hands over to runner.ts
// (the last lines below); that hand-over and runner.ts stay as the kit has them.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { from: string; to: string }[] = [];
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
}

type Edit = (tree: Tree) => void;

/* ---------- files, lines, breaks (SPEC.md section 3) ---------- */

interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function docText(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** A file an edit creates: LF breaks, ended by a line break unless the format says otherwise. */
function createdText(lines: string[], noFinalBreak: boolean): string {
  return docText(lines, '\n', !noFinalBreak && lines.length > 0);
}

/* ---------- matching lines (SPEC.md section 5) ---------- */

const lead = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  const t = line.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

interface Found {
  tier: number;
  positions: number[];
}

/** The occurrences of `O` in `file` at the first tier that has one, or null. */
function matchTier(file: string[], O: string[], strict: boolean): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const own = O.map((l) => norm(l, tier));
    const fl = file.map((l) => norm(l, tier));
    const positions: number[] = [];
    for (let i = 0; i + own.length <= fl.length; i++) {
      let ok = true;
      for (let k = 0; k < own.length; k++) {
        if (fl[i + k] !== own[k]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of a block's replacement: its text and whether it is a context line. */
interface NLine {
  text: string;
  ctx: boolean;
}

/** One line a block names as old: its text and whether it is a context line too. */
interface OLine {
  text: string;
  ctx: boolean;
}

/**
 * Writes `block` into `doc` at `start`: the matched lines (which run `O.length` long) replaced by `N`. Context
 * lines keep the file's own bytes; at tier 2 the other new lines are re-indented from P to F (section 5). A
 * unified hunk that runs to the file's end decides the final break itself (`unified`); every other format keeps
 * the file's own final break (section 3).
 */
function putBlock(doc: Doc, start: number, O: OLine[], N: NLine[], tier: number, noFinalBreak: boolean, unified: boolean): Doc {
  const F = lead(doc.lines[start] ?? '');
  const P = lead(O[0]?.text ?? '');
  const ctxAt: number[] = [];
  O.forEach((o, i) => {
    if (o.ctx) ctxAt.push(i);
  });
  const out = doc.lines.slice(0, start);
  let ctxIndex = 0;
  for (const n of N) {
    if (n.ctx) {
      out.push(doc.lines[start + (ctxAt[ctxIndex] ?? ctxIndex)] ?? '');
      ctxIndex += 1;
      continue;
    }
    let text = n.text;
    if (tier === 2 && text.trim() !== '' && text.startsWith(P)) text = F + text.slice(P.length);
    out.push(text);
  }
  out.push(...doc.lines.slice(start + O.length));
  const endsAtEnd = start + O.length >= doc.lines.length;
  const final = endsAtEnd && unified ? !noFinalBreak : doc.final;
  return { lines: out, br: doc.br, final };
}

/* ---------- unified diffs (SPEC.md section 6) ---------- */

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;

const stripPrefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

/** The path a `--- ` or `+++ ` line names: after the four characters, up to a tab, trimmed. */
const headerPath = (line: string): string => line.slice(4).split('\t')[0]!.trim();

interface Hunk {
  a: number;
  body: { kind: 'ctx' | 'old' | 'new' | 'note'; text: string }[];
  noFinalBreak: boolean;
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  created: boolean;
  deleted: boolean;
  hunks: Hunk[];
  line: number;
  gitOld: string | null;
  gitNew: string | null;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: null, newPath: null, created: false, deleted: false, hunks: [], line: i + 1, gitOld: stripPrefix(m[1]!), gitNew: stripPrefix(m[2]!) };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0) {
        cur = { oldPath: null, newPath: null, created: false, deleted: false, hunks: [], line: i + 1, gitOld: null, gitNew: null };
        sections.push(cur);
      }
      const a = headerPath(line);
      const b = headerPath(lines[i + 1]!);
      cur.oldPath = a === '/dev/null' ? null : stripPrefix(a);
      cur.newPath = b === '/dev/null' ? null : stripPrefix(b);
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) {
        cur.oldPath = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.newPath = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.created = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deleted = true;
        i += 1;
        continue;
      }
    }
    if (line.startsWith('@@')) {
      const m = HUNK.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [], noFinalBreak: false };
      cur.hunks.push(hunk);
      i += 1;
      let lastBody: 'ctx' | 'new' | 'old' | null = null;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ') || (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) break;
        if (b === '') {
          hunk.body.push({ kind: 'ctx', text: '' });
          lastBody = 'ctx';
          i += 1;
          continue;
        }
        const c = b[0]!;
        if (c === ' ') {
          hunk.body.push({ kind: 'ctx', text: b.slice(1) });
          lastBody = 'ctx';
        } else if (c === '-') {
          hunk.body.push({ kind: 'old', text: b.slice(1) });
          lastBody = 'old';
        } else if (c === '+') {
          hunk.body.push({ kind: 'new', text: b.slice(1) });
          lastBody = 'new';
        } else if (c === '\\') {
          hunk.body.push({ kind: 'note', text: b });
          if (lastBody === 'ctx' || lastBody === 'new') hunk.noFinalBreak = true;
        } else {
          break;
        }
        i += 1;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.kind === 'ctx' && hunk.body[hunk.body.length - 1]!.text === '') hunk.body.pop();
      continue;
    }
    i += 1;
  }

  const edits: Edit[] = [];
  for (const s of sections) {
    const oldPath = s.oldPath ?? s.gitOld;
    const newPath = s.newPath ?? s.gitNew;
    edits.push((tree) => {
      const created = s.created || oldPath === null;
      const deleted = s.deleted || newPath === null;
      const from = oldPath ?? newPath;
      const to = newPath ?? oldPath;
      if (from === null || to === null) throw new Fail('missing', '');
      if (!safe(from) || !safe(to)) throw new Fail('unsafe', created ? to : from);
      if (created) {
        if (tree.get(to) !== null) throw new Fail('exists', to);
        const out: string[] = [];
        let noFinal = false;
        for (const hunk of s.hunks) {
          for (const b of hunk.body) if (b.kind === 'new') out.push(b.text);
          noFinal = hunk.noFinalBreak;
        }
        tree.now.set(to, createdText(out, noFinal));
        return;
      }
      const before = tree.get(from);
      if (before === null) throw new Fail('missing', from);
      if (deleted) {
        tree.now.set(from, null);
        return;
      }
      if (from !== to && tree.get(to) !== null) throw new Fail('exists', to);
      let doc = parseDoc(before);
      let d = 0;
      for (const hunk of s.hunks) {
        const O: OLine[] = [];
        const N: NLine[] = [];
        for (const b of hunk.body) {
          if (b.kind === 'ctx') {
            O.push({ text: b.text, ctx: true });
            N.push({ text: b.text, ctx: true });
          } else if (b.kind === 'old') O.push({ text: b.text, ctx: false });
          else if (b.kind === 'new') N.push({ text: b.text, ctx: false });
        }
        if (O.length === 0) {
          const at = Math.min(doc.lines.length, Math.max(0, hunk.a + d));
          doc = putBlock(doc, at, [], N, 0, hunk.noFinalBreak, true);
        } else {
          const found = matchTier(doc.lines, O.map((o) => o.text), strict);
          if (found === null) throw new Fail('no-match', from);
          const want = hunk.a - 1 + d;
          let best = found.positions[0]!;
          for (const p of found.positions) if (Math.abs(p - want) < Math.abs(best - want)) best = p;
          doc = putBlock(doc, best, O, N, found.tier, hunk.noFinalBreak, true);
        }
        d += N.length - O.length;
      }
      if (from === to) tree.now.set(from, docText(doc.lines, doc.br, doc.final));
      else {
        tree.now.set(from, null);
        tree.now.set(to, docText(doc.lines, doc.br, doc.final));
        tree.moves.push({ from, to });
      }
    });
  }
  return edits;
}

/* ---------- SEARCH/REPLACE blocks (SPEC.md section 7) ---------- */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string | null;
    old: string[];
    neu: string[];
    line: number;
  }
  const blocks: Block[] = [];
  let lastPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.replace(/\s+$/, '') !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let k = i - 1; k >= 0; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = lastPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    const oldLines: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j]!.replace(/\s+$/, '') !== '=======' && lines[j]!.replace(/\s+$/, '') !== '>>>>>>> REPLACE') {
      oldLines.push(lines[j]!);
      j += 1;
    }
    if (j >= lines.length || lines[j]!.replace(/\s+$/, '') !== '=======') throw new Exit2(`error: parse ${i + 1}`);
    const newLines: string[] = [];
    j += 1;
    while (j < lines.length && lines[j]!.replace(/\s+$/, '') !== '>>>>>>> REPLACE') {
      newLines.push(lines[j]!);
      j += 1;
    }
    if (j >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    blocks.push({ path, old: oldLines, neu: newLines, line: i + 1 });
    lastPath = path;
    i = j + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');

  const edits: Edit[] = [];
  for (const b of blocks) {
    const p = b.path!;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (b.old.length === 0) {
        if (before !== null) throw new Fail('exists', p);
        tree.now.set(p, createdText(b.neu, false));
        return;
      }
      if (before === null) throw new Fail('missing', p);
      const doc = parseDoc(before);
      const found = matchTier(doc.lines, b.old, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const N = b.neu.map((text) => ({ text, ctx: false }));
      const O = b.old.map((text) => ({ text, ctx: false }));
      const out = putBlock(doc, found.positions[0]!, O, N, found.tier, false, false);
      tree.now.set(p, docText(out.lines, out.br, out.final));
    });
  }
  return edits;
}

/* ---------- V4A patches (SPEC.md section 8) ---------- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: { kind: 'ctx' | 'old' | 'new'; text: string }[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
  line: number;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: VSection[] = [];
  let cur: VSection | null = null;
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    const add = line.startsWith('*** Add File: ');
    const del = line.startsWith('*** Delete File: ');
    const upd = line.startsWith('*** Update File: ');
    if (add || del || upd) {
      cur = {
        kind: add ? 'add' : del ? 'delete' : 'update',
        path: (add ? line.slice(14) : del ? line.slice(17) : line.slice(16)).trim(),
        moveTo: null,
        lines: [],
        chunks: [],
        line: i + 1,
      };
      sections.push(cur);
      continue;
    }
    if (blank(line)) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur.kind === 'add') cur.lines.push('');
      else if (cur.kind === 'update' && cur.chunks.length > 0) cur.chunks[cur.chunks.length - 1]!.body.push({ kind: 'ctx', text: '' });
      continue;
    }
    if (cur.kind === 'add') {
      if (line.startsWith('+')) cur.lines.push(line.slice(1));
      else throw new Exit2(`error: parse ${i + 1}`);
      continue;
    }
    if (cur.kind === 'delete') throw new Exit2(`error: parse ${i + 1}`);
    if (line.startsWith('*** Move to: ')) {
      cur.moveTo = line.slice(13).trim();
      continue;
    }
    if (line.startsWith('*** End of File')) {
      const chunk = cur.chunks[cur.chunks.length - 1];
      if (chunk === undefined) throw new Exit2(`error: parse ${i + 1}`);
      chunk.eof = true;
      continue;
    }
    if (line.startsWith('@@')) {
      const anchorText = line.slice(2).trim();
      cur.chunks.push({ anchor: anchorText === '' ? null : anchorText, eof: false, body: [] });
      continue;
    }
    const c = line[0]!;
    if (c !== ' ' && c !== '-' && c !== '+') throw new Exit2(`error: parse ${i + 1}`);
    if (cur.chunks.length === 0) cur.chunks.push({ anchor: null, eof: false, body: [] });
    const chunk = cur.chunks[cur.chunks.length - 1]!;
    if (c === ' ') chunk.body.push({ kind: 'ctx', text: line.slice(1) });
    else if (c === '-') chunk.body.push({ kind: 'old', text: line.slice(1) });
    else chunk.body.push({ kind: 'new', text: line.slice(1) });
  }
  for (const s of sections) {
    if (s.kind === 'update' && s.chunks.length === 0 && s.moveTo === null) throw new Exit2(`error: parse ${s.line}`);
    for (const c of s.chunks) while (c.body.length > 0 && c.body[c.body.length - 1]!.kind === 'ctx' && c.body[c.body.length - 1]!.text === '') c.body.pop();
  }

  const edits: Edit[] = [];
  for (const s of sections) {
    edits.push((tree) => {
      if (!safe(s.path) || (s.moveTo !== null && !safe(s.moveTo))) throw new Fail('unsafe', s.moveTo ?? s.path);
      if (s.kind === 'add') {
        if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
        tree.now.set(s.path, createdText(s.lines, false));
        return;
      }
      const before = tree.get(s.path);
      if (before === null) throw new Fail('missing', s.path);
      if (s.kind === 'delete') {
        tree.now.set(s.path, null);
        return;
      }
      const to = s.moveTo ?? s.path;
      if (s.moveTo !== null && tree.get(to) !== null) throw new Fail('exists', to);
      let doc = parseDoc(before);
      let cursor = 0;
      for (const chunk of s.chunks) {
        if (chunk.anchor !== null) {
          const found = matchTier(doc.lines.slice(cursor), [chunk.anchor], strict);
          if (found === null) throw new Fail('no-match', s.path);
          cursor += found.positions[0]! + 1;
        }
        const O: OLine[] = [];
        const N: NLine[] = [];
        for (const b of chunk.body) {
          if (b.kind === 'ctx') {
            O.push({ text: b.text, ctx: true });
            N.push({ text: b.text, ctx: true });
          } else if (b.kind === 'old') O.push({ text: b.text, ctx: false });
          else N.push({ text: b.text, ctx: false });
        }
        if (O.length === 0) {
          const at = chunk.eof ? doc.lines.length : cursor;
          doc = putBlock(doc, at, [], N, 0, false, false);
          cursor = at + N.length;
          continue;
        }
        const found = matchTier(doc.lines.slice(cursor), O.map((o) => o.text), strict);
        if (found === null) throw new Fail('no-match', s.path);
        const starts = found.positions.map((p) => p + cursor);
        let best = starts[0]!;
        if (chunk.eof) {
          const end = starts.filter((p) => p + O.length === doc.lines.length);
          if (end.length === 0) throw new Fail('no-match', s.path);
          best = end[0]!;
        }
        doc = putBlock(doc, best, O, N, found.tier, false, false);
        cursor = best + N.length;
      }
      if (s.moveTo === null) tree.now.set(s.path, docText(doc.lines, doc.br, doc.final));
      else {
        tree.now.set(s.path, null);
        tree.now.set(to, docText(doc.lines, doc.br, doc.final));
        tree.moves.push({ from: s.path, to });
      }
    });
  }
  return edits;
}

/* ---------- JSON edits (SPEC.md section 9) ---------- */

/** One JSON edit object, or null when it is not one. */
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

/* ---------- the command line (SPEC.md sections 1, 2, 10) ---------- */

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
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  const movesDone = tree.moves.filter((m) => tree.get(m.to) !== null && tree.get(m.from) === null);
  const skip = new Set<string>();
  for (const m of movesDone) {
    skip.add(m.from);
    skip.add(m.to);
  }
  const rows: { sort: string; text: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    if (skip.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ sort: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of movesDone) rows.push({ sort: m.to, text: `R ${m.from} -> ${m.to}` });
  const out = rows
    .sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)) || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))
    .map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (tree.original(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
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
