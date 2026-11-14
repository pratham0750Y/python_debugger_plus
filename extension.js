'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const cfg = () => vscode.workspace.getConfiguration('pyDebugPlus');
const isPy = (s) => s && (s.type === 'python' || s.type === 'debugpy');
const SKIP = new Set(['special variables', 'function variables', 'class variables']);

let out;
let inlineDeco;
let savedRanges = new Map();
let sel = { set: new Set(), showAll: false, live: false, rerun: false };
let sbRerun;
let rerunTimer;
let liveLoopOn = false;
function log(m) { if (out) out.appendLine(new Date().toLocaleTimeString() + '  ' + m); }
let ctx, panel, S, liveDeco, replayDeco, sbBack, sbCont, sbMode;
let chain = Promise.resolve();
const queue = (fn) => { chain = chain.then(fn).catch((e) => console.error('[PyDebugPlus]', e)); };

function freshState() {
  return {
    userPauseWanted: false,
    startedAt: null, skipCount: 0, warnedOpen: false, autoPause: null, runBusy: false, liveEntry: null,
    libraryFrame: null,
    history: [], replayIdx: null, ranges: savedRanges, fnColumns: new Map(),
    nextCol: 2, session: null, threadId: 1, running: false, ended: false,
  };
}

// ---------- helpers ----------
const samePath = (a, b) => {
  if (!a || !b) return false;
  const n = (p) => (process.platform === 'win32' ? path.normalize(p).toLowerCase() : path.normalize(p));
  return n(a) === n(b);
};

function isPackagePath(file) {
  return /site-packages|dist-packages|[\\/]lib[\\/]python\d|[\\/]python\d*[\\/]Lib[\\/]/i.test(file);
}

function flat(nodes, out = new Map()) {
  for (const n of nodes) { out.set(n.path, n.value); if (n.children) flat(n.children, out); }
  return out;
}

function markChanged(nodes, prevMap) {
  for (const n of nodes) {
    n.changed = !!prevMap && prevMap.get(n.path) !== n.value;
    if (n.children) markChanged(n.children, prevMap);
  }
}

// ---------- reading variables from the debug adapter ----------
function parseKey(k) {
  const i = k.indexOf(':');
  return i < 0 ? { scope: '', path: k } : { scope: k.slice(0, i), path: k.slice(i + 1) };
}

const keyOf = (scope, p) => (scope ? scope + ':' + p : p);

// A scope is a function name, a class name, or Class.method. Empty scope matches everywhere.
function scopeMatches(scope, ctx) {
  if (!scope) return true;
  if (!ctx) return false;
  if (scope === ctx.func || scope === ctx.qual) return true;
  if (scope === 'module' || scope === '<module>') return ctx.func === '<module>';
  return !!ctx.qual && ctx.qual.split('.').includes(scope);
}

function ctxOf(entry) { return entry ? { func: entry.func, qual: entry.qual || '' } : null; }

function applicableKeys(p, ctx) {
  return [...sel.set].filter((k) => { const pk = parseKey(k); return pk.path === p && scopeMatches(pk.scope, ctx); });
}

function effectiveSelected(ctx) {
  return new Set([...sel.set].map(parseKey).filter((pk) => scopeMatches(pk.scope, ctx)).map((pk) => pk.path));
}

function effectiveRanges(ctx) {
  const out = {};
  for (const [k, v] of S.ranges) {
    const pk = parseKey(k);
    if (!scopeMatches(pk.scope, ctx)) continue;
    if (pk.scope || !(pk.path in out)) out[pk.path] = v;
  }
  return out;
}

// Names of the functions/classes that enclose a line, e.g. "Entity.update", read from the source file.
function qualNameAt(file, line) {
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch (e) { return ''; }
  const indentOf = (t) => t.match(/^\s*/)[0].replace(/\t/g, '    ').length;
  const cur = Math.min(Math.max(0, line - 1), lines.length - 1);
  let limit = lines[cur].trim() ? indentOf(lines[cur]) : 1e9;
  const names = [];
  for (let i = cur - 1; i >= 0 && limit > 0; i--) {
    const t = lines[i];
    if (!t.trim() || /^\s*#/.test(t)) continue;
    const ind = indentOf(t);
    if (ind >= limit) continue;
    limit = ind;
    const m = /^\s*(?:async\s+def|def|class)\s+(\w+)/.exec(t);
    if (m) names.unshift(m[1]);
  }
  return names.join('.');
}

function parseSpec(text) {
  let t = String(text || '');
  let scope = '';
  const pm = /^\s*([^\[\]\s:]+)\s*:\s*(.+)$/.exec(t);
  if (pm) { scope = pm[1]; t = pm[2]; }
  const m = /^\s*([^\[\]\s:]+)\s*((?:\[[^\]]*\]\s*)*)$/.exec(t);
  if (!m) return null;
  let path = m[1];
  const slices = [];
  const indexes = [];
  const re = /\[\s*(?:(\d*)\s*:\s*(\d*)|(\d+))\s*\]/g;
  const rest = m[2];
  let x;
  while ((x = re.exec(rest))) {
    if (x[3] !== undefined) {
      const idx = Number(x[3]);
      // brackets before any slice pick an element (blocks[0] -> blocks.0); after a slice they select one item
      if (slices.length === 0) { indexes.push({ parent: path, idx }); path += '.' + idx; }
      else slices.push([idx, idx + 1]);
    } else {
      const a = x[1] === '' ? 0 : Number(x[1]);
      const b = x[2] === '' ? null : Number(x[2]);
      if (b !== null && b <= a) return null;
      slices.push([a, b]);
    }
  }
  if (rest.replace(/\[\s*(?:\d*\s*:\s*\d*|\d+)\s*\]/g, '').trim() !== '') return null;
  return { scope, path, slices, indexes };
}

function coverIndex(parent, idx, scope) {
  const key = keyOf(scope, parent);
  const arr = asSlices(S.ranges.get(key)).slice();
  const cur = arr[0] || [0, cfg().get('defaultListRange', 100)];
  if (idx >= cur[0] && (cur[1] === null || idx < cur[1])) return;
  arr[0] = [Math.min(cur[0], idx), cur[1] === null ? null : Math.max(cur[1], idx + 1)];
  S.ranges.set(key, arr);
}

function applySpec(sp) {
  for (const { parent, idx } of sp.indexes) coverIndex(parent, idx, sp.scope);
  if (sp.slices.length) S.ranges.set(keyOf(sp.scope, sp.path), sp.slices);
  saveRanges();
}

function onSelectedPath(p) {
  for (const k of sel.set) {
    const pk = parseKey(k);
    if (!scopeMatches(pk.scope, S.curCtx)) continue;
    if (pk.path === p || pk.path.startsWith(p + '.')) return true;
  }
  return false;
}

function asSlices(v) { return !v ? [] : (typeof v[0] === 'number' ? [v] : v); }

function fmtSlices(v) { return asSlices(v).map(([a, b]) => '[' + a + ':' + (b === null ? '' : b) + ']').join(''); }

// Pick the slice for the list at path p: nearest saved ancestor (or itself); each nesting level uses the next slice.
function sliceFor(p, explicitOnly) {
  let best = null;
  for (const [key, v] of S.ranges) {
    const pk = parseKey(key);
    if (!scopeMatches(pk.scope, S.curCtx)) continue;
    if (p === pk.path || p.startsWith(pk.path + '.')) {
      if (!best || pk.path.length > best.k.length || (pk.path.length === best.k.length && pk.scope)) best = { k: pk.path, v };
    }
  }
  const def = [0, cfg().get('defaultListRange', 100)];
  if (!best) return explicitOnly ? null : def;
  const level = p === best.k ? 0 : p.slice(best.k.length + 1).split('.').length;
  return asSlices(best.v)[level] || (explicitOnly ? null : def);
}

async function nodesFrom(session, vars, prefix, depth, parentRef) {
  const out = [];
  const max = cfg().get('maxChildren', 200);
  const maxDepth = cfg().get('maxDepth', 2);
  for (const v of vars.slice(0, max)) {
    if (SKIP.has(v.name) || v.name === 'len()' || v.type === 'MoreItemsRange') continue;
    const mi = /^\[?(\d+)\]?$/.exec(v.name);
    const seg = mi ? String(parseInt(mi[1], 10)) : v.name;
    const p = prefix ? prefix + '.' + seg : seg;
    const sval = String(v.value);
    if (v.type === 'module' || /^<module /.test(sval)) {
      const from = /from '([^']*)'/.exec(sval);
      const fromPath = from ? from[1].replace(/\\/g, '\\'.slice(1)) : '';
      const isLib = !from || isPackagePath(fromPath);
      if (isLib && !cfg().get('showLibraryVariables', false)) continue;
      out.push({ name: v.name, path: p, value: sval, type: 'module', parentRef, children: [] });
      continue;
    }
    const node = { name: v.name, path: p, value: String(v.value), type: v.type || '', parentRef, children: [] };
    if (v.variablesReference > 0 && (depth < maxDepth || onSelectedPath(p))) {
      const r = await childrenOf(session, v, p, depth);
      node.children = r.kids;
      if (r.range) { node.range = r.range; node.total = r.total; node.sliced = !!r.sliced; }
    }
    out.push(node);
  }
  return out;
}

function orderExpr(x) {
  return "(lambda o: __import__('json').dumps([str(k) for k in (o if isinstance(o, dict) else vars(o) if hasattr(o, '__dict__') else "
    + "(lambda s: (s,) if isinstance(s, str) else tuple(s))(getattr(type(o), '__slots__', ())))]))(" + x + ")";
}

// debugpy lists attributes alphabetically; ask Python for the order they were created in (dict insertion order too).
function parseJsonRepr(r) {
  r = String(r || '').trim();
  const q = r[0];
  if (r.length < 2 || (q !== "'" && q !== '"') || r[r.length - 1] !== q) return null;
  try { return JSON.parse(r.slice(1, -1).replace(/\\(['"\\])/g, '$1')); } catch (e) { return null; }
}

async function reorderByCreation(session, v, list) {
  try {
    const r = await session.customRequest('evaluate', { expression: orderExpr(v.evaluateName), frameId: S.curFrameId, context: 'watch' });
    const order = parseJsonRepr(r && r.result);
    if (!Array.isArray(order)) return list;
    const pos = new Map(order.map((k, i) => [String(k), i]));
    const bare = (x) => { const m = /^(['"])([\s\S]*)\1$/.exec(x.name); return m ? m[2] : x.name; };
    return list
      .map((x, i) => ({ x, p: pos.has(bare(x)) ? pos.get(bare(x)) : 1e9 + i }))
      .sort((a, b) => a.p - b.p)
      .map((w) => w.x);
  } catch (e) {
    return list;
  }
}

async function childrenOf(session, v, p, depth) {
  try {
    if (v.indexedVariables > 0) {
      const total = v.indexedVariables;
      const exs = sliceFor(p, true);
      const [s, e] = exs || sliceFor(p);
      const start = Math.min(s, total);
      const end = e === null ? total : Math.min(e, total);
      let items = [];
      if (end > start) {
        const idx = await session.customRequest('variables', {
          variablesReference: v.variablesReference, filter: 'indexed', start, count: end - start,
        });
        items = idx.variables;
      }
      let named = [];
      if (v.namedVariables > 0) {
        const nm = await session.customRequest('variables', { variablesReference: v.variablesReference, filter: 'named' });
        named = nm.variables;
      }
      const kids = await nodesFrom(session, items.concat(named), p, depth + 1, v.variablesReference);
      return { kids, range: [start, end], total, sliced: !!exs };
    }
    const res = await session.customRequest('variables', { variablesReference: v.variablesReference });
    let list = res.variables;
    if (v.evaluateName && S.curFrameId !== undefined && cfg().get('orderByCreation', true)) list = await reorderByCreation(session, v, list);
    let range;
    let total;
    const ex = sliceFor(p, true);
    if (ex) {
      const isIdx = (x) => /^\[?\d+\]?$/.test(x.name);
      const idx = list.filter(isIdx);
      if (idx.length > 0) {
        const start = Math.min(ex[0], idx.length);
        const end = ex[1] === null ? idx.length : Math.min(ex[1], idx.length);
        const keep = new Set(idx.slice(start, end));
        list = list.filter((x) => !isIdx(x) || keep.has(x));
        range = [start, end];
        total = idx.length;
      }
    }
    return { kids: await nodesFrom(session, list, p, depth + 1, v.variablesReference), range, total, sliced: !!range };
  } catch (e) {
    return { kids: [] };
  }
}

const isUserFrame = (f) => f.source && f.source.path && !f.source.path.startsWith('<') && !isPackagePath(f.source.path) && !/debugpy|pydevd/i.test(f.source.path);

function exprForPath(p) {
  const segs = p.split('.');
  return segs.slice(1).reduce((acc, seg) => acc + (/^\d+$/.test(seg) ? '[' + seg + ']' : '.' + seg), segs[0]);
}

// Read one chosen variable straight from a frame (no walking over everything else in the frame).
async function readPath(session, frame, ctx, p) {
  const expression = exprForPath(p);
  let r;
  try { r = await rq(session, 'evaluate', { expression, frameId: frame.id, context: 'watch' }, 5000); } catch (e) { return null; }
  if (!r) return null;
  S.curCtx = ctx;
  S.curFrameId = frame.id;
  const node = { name: p, path: p, value: String(r.result), type: r.type || '', children: [], expr: expression, frameId: frame.id };
  if (r.variablesReference > 0 && r.type !== 'module' && cfg().get('maxDepth', 2) > 0) {
    const v = { name: p, variablesReference: r.variablesReference, indexedVariables: r.indexedVariables, namedVariables: r.namedVariables, evaluateName: expression, type: r.type };
    const c = await childrenOf(session, v, p, 0);
    node.children = c.kids;
    if (c.range) { node.range = c.range; node.total = c.total; node.sliced = !!c.sliced; }
  }
  return node;
}

// Chosen variables only: each is looked up in the frames on the stack whose function/class matches its scope.
async function readChosen(session, frames, primary) {
  const user = frames.filter(isUserFrame);
  const order = [primary, ...user.filter((f) => f !== primary)];
  const ctxs = new Map();
  const ctxFor = (f) => {
    if (!ctxs.has(f)) ctxs.set(f, { func: f.name, qual: qualNameAt(f.source.path, f.line) });
    return ctxs.get(f);
  };
  const vars = [];
  const wanted = [];
  const done = new Set();
  for (const k of [...sel.set].map(parseKey)) {
    const frs = order.filter((f) => f.source && f.source.path && scopeMatches(k.scope, ctxFor(f)));
    if (!frs.length) continue; // its function or class is not on the stack right now
    if (!wanted.includes(k.path)) wanted.push(k.path);
    if (done.has(k.path)) continue;
    for (const f of frs) {
      const node = await readPath(session, f, ctxFor(f), k.path);
      if (node) { vars.push(node); done.add(k.path); break; }
    }
  }
  return { vars, wanted };
}

async function buildEntry(session, threadId, pick) {
  let st;
  try { st = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 40 }); } catch (e) { return null; }
  const frame = pick ? pick(st.stackFrames || []) : (st.stackFrames && st.stackFrames[0]);
  if (!frame) return null;
  const file0 = (frame.source && frame.source.path) || '';
  if (!file0 || file0.startsWith('<')) {
    const t = st.stackFrames.find((f) => f.source && f.source.path && !f.source.path.startsWith('<')) || frame;
    return {
      file: (t.source && t.source.path) || '', line: t.line, func: t.name,
      library: true, frozen: file0.startsWith('<frozen'), vars: [], time: Date.now(),
    };
  }
  if (file0 && isPackagePath(file0) && !cfg().get('showLibraryVariables', false)) {
    return { file: file0, line: frame.line, func: frame.name, library: true, vars: [], time: Date.now() };
  }
  const qual = qualNameAt(file0, frame.line);
  S.curCtx = { func: frame.name, qual };
  S.curFrameId = frame.id;
  let vars = [];
  let top = [];
  let wanted;
  try {
    const sc = await rq(session, 'scopes', { frameId: frame.id }, 5000);
    const locals = sc.scopes.find((s) => /local/i.test(s.name)) || sc.scopes[0];
    const res = await rq(session, 'variables', { variablesReference: locals.variablesReference }, 8000);
    top = res.variables
      .filter((v) => !SKIP.has(v.name) && v.name !== 'len()' && v.type !== 'MoreItemsRange')
      .map((v) => ({ name: v.name, type: v.type || '', value: String(v.value) }));
    if (sel.showAll) vars = await nodesFrom(session, res.variables, '', 0, locals.variablesReference);
  } catch (e) { /* leave empty */ }
  if (!sel.showAll) {
    const c = await readChosen(session, st.stackFrames || [], frame);
    vars = c.vars;
    wanted = c.wanted;
    S.curCtx = { func: frame.name, qual };
    S.curFrameId = frame.id;
  }
  return {
    top,
    wanted,
    file: (frame.source && frame.source.path) || '',
    line: frame.line,
    func: frame.name,
    qual,
    depth: st.totalFrames || st.stackFrames.length,
    vars,
    time: Date.now(),
  };
}

// ---------- stop handling ----------
async function onStopped(session, body) {
  S.session = session;
  S.threadId = (body && body.threadId) || S.threadId;
  S.running = false;
  S.liveEntry = null;
  S.replayIdx = null;
  setReplayCtx(false);
  const entry = await buildEntry(session, S.threadId);
  if (!entry) return;
  if (entry.frozen && cfg().get('skipFrozenFrames', true) && S.skipCount < 200 && (!body || body.reason === 'step')) {
    S.skipCount++;
    log('stopped in Python-internal frozen code, stepping on (' + S.skipCount + ')');
    try { await session.customRequest('stepIn', { threadId: S.threadId }); } catch (e) { log('stepIn failed: ' + e); }
    return;
  }
  S.skipCount = 0;
  log('stopped: ' + entry.func + ' @ ' + entry.file + ':' + entry.line + (entry.library ? '  [library or internal: no variables]' : ''));
  if (entry.library) {
    S.libraryFrame = entry;
    await showEntry(entry, false);
    render();
    updateStatus();
    return;
  }
  S.libraryFrame = null;
  const prev = S.history[S.history.length - 1];
  const comparable = prev && prev.file === entry.file && prev.func === entry.func;
  markChanged(entry.vars, comparable ? flat(prev.vars) : null);
  S.history.push(entry);
  const max = cfg().get('maxHistory', 500);
  while (S.history.length > max) S.history.shift();
  await showEntry(entry, false);
  render();
  updateStatus();
}

async function refreshLive(quiet) {
  if (!S.session || S.running || S.ended || S.libraryFrame || S.replayIdx !== null || !S.history.length) {
    if (quiet) { render(); return; }
    vscode.window.showInformationMessage('Range saved. It applies the next time the program stops (live values can only be re-read while paused, not in replay).');
    return;
  }
  const entry = await buildEntry(S.session, S.threadId);
  if (!entry) return;
  const prev = S.history[S.history.length - 2];
  const comparable = prev && prev.file === entry.file && prev.func === entry.func;
  markChanged(entry.vars, comparable ? flat(prev.vars) : null);
  S.history[S.history.length - 1] = entry;
  render();
}

// ---------- editor handling ----------
function clearDecos() {
  for (const ed of vscode.window.visibleTextEditors) {
    ed.setDecorations(liveDeco, []);
    ed.setDecorations(replayDeco, []);
  }
}

function decorate(entry, replay) {
  clearDecos();
  const line = Math.max(0, entry.line - 1);
  const r = new vscode.Range(line, 0, line, 0);
  for (const ed of vscode.window.visibleTextEditors) {
    if (samePath(ed.document.uri.fsPath, entry.file)) ed.setDecorations(replay ? replayDeco : liveDeco, [r]);
  }
}

async function showEntry(entry, replay) {
  // Files are never opened automatically. If the file is already open in a visible
  // editor, highlight the line there (and scroll to it when replaying).
  if (!entry.file) return;
  decorate(entry, replay);
  if (replay) {
    const line = Math.max(0, entry.line - 1);
    const range = new vscode.Range(line, 0, line, 0);
    for (const ed of vscode.window.visibleTextEditors) {
      if (samePath(ed.document.uri.fsPath, entry.file)) ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }
}

// ---------- replay (step back) ----------
function setReplayCtx(v) { vscode.commands.executeCommand('setContext', 'pyDebugPlus.replaying', v); }

function currentEntry() {
  if (S.replayIdx === null && S.libraryFrame) return S.libraryFrame;
  if (!S.history.length) return null;
  return S.replayIdx === null ? S.history[S.history.length - 1] : S.history[S.replayIdx];
}

async function showCurrent() {
  const e = currentEntry();
  if (!e) return;
  setReplayCtx(S.replayIdx !== null);
  await showEntry(e, S.replayIdx !== null);
  render();
  updateStatus();
}

function stepBack() {
  const need = S.libraryFrame ? 1 : 2;
  if (S.history.length < need) { vscode.window.showInformationMessage('No earlier step recorded yet.'); return; }
  if (S.replayIdx === null) S.replayIdx = S.history.length - need;
  else if (S.replayIdx > 0) S.replayIdx--;
  else { vscode.window.showInformationMessage('Reached the start of the recorded history.'); return; }
  showCurrent();
}

async function liveForward() {
  const session = S.session || vscode.debug.activeDebugSession;
  if (!session || S.ended) { vscode.window.showInformationMessage('Forward: there is no paused debug session to step.'); return; }
  log('forward: stepping to the next line');
  try {
    await vscode.commands.executeCommand('workbench.action.debug.stepOver');
  } catch (e) {
    log('stepOver command failed (' + ((e && e.message) || e) + '), sending a step request directly');
    try { await session.customRequest('next', { threadId: S.threadId }); }
    catch (e2) { vscode.window.showWarningMessage('Forward could not step: ' + ((e2 && e2.message) || e2)); }
  }
}

function stepForward() {
  if (S.replayIdx === null) { liveForward(); return; }
  if (S.replayIdx + 1 >= S.history.length - (S.libraryFrame ? 0 : 1)) S.replayIdx = null;
  else S.replayIdx++;
  showCurrent();
}

function doContinue() {
  S.replayIdx = null;
  setReplayCtx(false);
  render();
  updateStatus();
  vscode.commands.executeCommand('workbench.action.debug.continue');
}

// ---------- list range ----------
async function setListRange(arg) {
  const base = arg && arg.variable && arg.variable.name;
  const text = await vscode.window.showInputBox({
    title: 'Variable and ranges, e.g. entities[0:10][0:10] (end excluded; chain brackets for nested lists)',
    value: base ? base + fmtSlices(S.ranges.get(base)) : '',
    validateInput: (v) => (parseSpec(v) ? null : 'Use a form like blocks[0], entities[0:10] or grid[0:5][2:8]'),
  });
  if (!text) return;
  const sp = parseSpec(text);
  if (!sp) return;
  if (!sp.slices.length) S.ranges.delete(keyOf(sp.scope, sp.path));
  applySpec(sp);
  refreshLive();
}

function applyRange(p, start, end) {
  if (!Number.isInteger(start) || start < 0 || (end !== null && (!Number.isInteger(end) || end <= start))) {
    vscode.window.showWarningMessage('Start must be 0 or more, and end must be greater than start.');
    return;
  }
  const vctx = ctxOf(currentEntry());
  let key = p;
  for (const k of S.ranges.keys()) {
    const pk = parseKey(k);
    if (pk.scope && pk.path === p && scopeMatches(pk.scope, vctx)) { key = k; break; }
  }
  const arr = asSlices(S.ranges.get(key)).slice();
  arr[0] = [start, end];
  S.ranges.set(key, arr);
  saveRanges();
  refreshLive();
}

function findNode(nodes, p) {
  for (const n of nodes) {
    if (n.path === p) return n;
    if (n.children) { const r = findNode(n.children, p); if (r) return r; }
  }
  return null;
}

async function setValue(p, value) {
  if (!S.session || S.running || S.ended) {
    vscode.window.showWarningMessage('Values can only be edited while the program is paused.');
    return;
  }
  if (S.libraryFrame) {
    vscode.window.showWarningMessage('The program is paused inside library code, where variables are not shown. Step out to your own code to edit values.');
    return;
  }
  if (S.replayIdx !== null) {
    vscode.window.showWarningMessage('You are viewing a replay of past values. Step Forward to the live stop, then edit.');
    return;
  }
  const live = S.history[S.history.length - 1];
  const node = live && findNode(live.vars, p);
  if (!node || (node.parentRef === undefined && !node.expr)) {
    vscode.window.showWarningMessage('Could not find "' + p + '" in the current values.');
    return;
  }
  try {
    if (node.parentRef !== undefined) await S.session.customRequest('setVariable', { variablesReference: node.parentRef, name: node.name, value });
    else await S.session.customRequest('evaluate', { expression: node.expr + ' = ' + value, frameId: node.frameId, context: 'repl' });
  } catch (e) {
    vscode.window.showErrorMessage('Could not set ' + p + ': ' + ((e && e.message) || e));
    return;
  }
  await refreshLive();
}

function addVar(text) {
  const sp = parseSpec(text);
  if (!sp) {
    vscode.window.showWarningMessage('Use a form like entities, blocks[0], entities[0:10] or grid[0:5][2:8].');
    return;
  }
  sel.set.add(keyOf(sp.scope, sp.path));
  sel.showAll = false;
  saveSel();
  applySpec(sp);
  refreshLive(true);
}

async function chooseVariables() {
  const base = S.history[S.replayIdx !== null ? S.replayIdx : S.history.length - 1];
  const ctx = ctxOf(base);
  const offered = [];
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      if (!/^\[?\d+\]?$/.test(n.name) && offered.length < 400) offered.push(n);
      if (n.children && depth < 2) walk(n.children, depth + 1);
    }
  };
  if (base && base.wanted && base.top) base.top.forEach((t) => offered.push({ name: t.name, path: t.name, type: t.type, value: t.value }));
  else if (base) walk(base.vars, 0);
  const items = [{ label: '$(add) Add a variable by name…', manual: true }].concat(offered.map((n) => ({
    label: n.path, description: n.type,
    detail: n.value.length > 80 ? n.value.slice(0, 80) + '…' : n.value,
    picked: applicableKeys(n.path, ctx).length > 0, path: n.path,
  })));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true, title: 'Variables to show in Live Variables',
    placeHolder: base ? 'Tick the ones you want to see' : 'Run to a breakpoint first to list variables, or add one by name',
  });
  if (!picked) return;
  const next = new Set(sel.set);
  const pickedPaths = new Set(picked.filter((it) => it.path).map((it) => it.path));
  for (const n of offered) {
    const ks = applicableKeys(n.path, ctx);
    if (pickedPaths.has(n.path)) { if (!ks.length) next.add(n.path); }
    else ks.forEach((k) => next.delete(k));
  }
  if (picked.some((it) => it.manual)) {
    const txt = await vscode.window.showInputBox({ title: 'Variables, comma separated: player.health, blocks[0:5], or drawall:blocks[0:5] to limit to one function or class' });
    if (txt) {
      txt.split(',').map((x) => x.trim()).filter(Boolean).forEach((x) => {
        const sp = parseSpec(x);
        if (!sp) return;
        next.add(keyOf(sp.scope, sp.path));
        applySpec(sp);
      });
    }
  }
  sel.set = next;
  sel.showAll = false;
  saveSel();
  render();
}

async function quietDefaultDebugUI() {
  const dbg = vscode.workspace.getConfiguration('debug');
  const changed = [];
  if (cfg().get('keepDefaultDebugViewClosed', true) && dbg.get('openDebug') !== 'neverOpen') {
    await dbg.update('openDebug', 'neverOpen', vscode.ConfigurationTarget.Global);
    changed.push('debug.openDebug = neverOpen (Run and Debug panel stays closed)');
  }
  const iv = dbg.get('inlineValues');
  if (cfg().get('hideDefaultInlineValues', true) && iv !== false && iv !== 'off') {
    await dbg.update('inlineValues', false, vscode.ConfigurationTarget.Global);
    changed.push('debug.inlineValues = false (no values for every variable in the editor)');
  }
  if (changed.length) {
    vscode.window.showInformationMessage('Py Debug Plus changed: ' + changed.join('; ') + '. Only your chosen variables are shown instead. Undo in Settings.');
  }
}

function toggleSelect(p) {
  const cur = currentEntry();
  let ks = applicableKeys(p, ctxOf(cur));
  if (!ks.length && cur && cur.wanted && cur.wanted.includes(p)) ks = [...sel.set].filter((k) => parseKey(k).path === p);
  if (ks.length) ks.forEach((k) => sel.set.delete(k)); else sel.set.add(p);
  saveSel();
  render();
}

// ---------- run a Python line ----------
const PY_KEYWORDS = new Set(['if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'def', 'class', 'lambda', 'return', 'async', 'match', 'case']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error((what || 'request') + ' timed out')), ms);
    Promise.resolve(promise).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

const rq = (session, cmd, args, ms) => withTimeout(session.customRequest(cmd, args), ms || 3000, cmd);
const errText = (e) => String((e && e.message) || e);

function splitRunScope(text) {
  let rest = String(text || '').trim();
  let file = '';
  const fm = /^([\w./\\-]+\.py)\s*:\s*([\s\S]*)$/.exec(rest);
  if (fm) { file = fm[1]; rest = fm[2].trim(); }
  const m = /^([A-Za-z_<][\w.<>]*)\s*:\s+(\S[\s\S]*)$/.exec(rest);
  if (m && !PY_KEYWORDS.has(m[1])) return { file, scope: m[1], code: m[2].trim() };
  return { file, scope: '', code: rest };
}

function fileMatches(fp, file) {
  const a = fp.replace(/\\/g, '/').toLowerCase();
  const b = file.replace(/\\/g, '/').toLowerCase().replace(/^\.\//, '');
  return a === b || a.endsWith('/' + b);
}

function looksLikeExpression(code) {
  if (/[;\n]/.test(code)) return false;
  if (/^\s*(import|from|del|pass|global|nonlocal|if|elif|else|for|while|with|def|class|try|raise|assert|return|async)\b/.test(code)) return false;
  const plain = code.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""').replace(/==|!=|<=|>=|:=/g, '');
  return !/=/.test(plain);
}

// Run code in the top-level variables of the module loaded from `target`.
function moduleExecExpr(target, code, isExpr) {
  const T = JSON.stringify(target);
  const C = JSON.stringify(code);
  const run = (isExpr ? "__import__('builtins').eval(" : "__import__('builtins').exec(") + C + ", d)";
  return "(lambda os, sys: (lambda d: " + run + " if d is not None else (_ for _ in ()).throw(LookupError('that file is not loaded as a module in the program')))"
    + "(next((m.__dict__ for m in list(sys.modules.values()) if getattr(m, '__file__', None) and os.path.normcase(os.path.abspath(m.__file__)) == os.path.normcase(os.path.abspath(" + T + "))), None)))"
    + "(__import__('os'), __import__('sys'))";
}

async function resolveTarget(file, frames) {
  for (const f of frames || []) {
    const fp = f.source && f.source.path;
    if (fp && fileMatches(fp, file)) return fp;
  }
  if (path.isAbsolute(file) && fs.existsSync(file)) return file;
  try {
    const found = await vscode.workspace.findFiles('**/' + file.replace(/\\/g, '/').replace(/^\.\//, ''), '**/{node_modules,.venv,venv,site-packages}/**', 5);
    if (found.length) return found[0].fsPath;
  } catch (e) { /* not found */ }
  return '';
}

// Stops we caused with a pause request are handled here and never recorded; everything else is a normal stop.
function handleStoppedEvent(session, body) {
  const ap = S.autoPause;
  const ours = ap && body && body.reason === 'pause' && !S.userPauseWanted;
  if (ap) { S.autoPause = null; clearTimeout(ap.timer); }
  if (ours) {
    if (ap.timedOut) vscode.commands.executeCommand('workbench.action.debug.continue');
    else ap.resolve({ auto: true, threadId: body.threadId });
    return;
  }
  S.userPauseWanted = false; // a stop we do not hide, including one you asked for with Pause
  queue(() => onStopped(session, body));
  if (ap && !ap.timedOut) ap.resolve({ auto: false, after: chain });
}

function waitForPause(ms) {
  return new Promise((resolve) => {
    const ap = { resolve, timedOut: false };
    ap.timer = setTimeout(() => { ap.timedOut = true; resolve(null); }, ms);
    S.autoPause = ap;
  });
}

async function mainThreadId(session) {
  try {
    const r = await rq(session, 'threads');
    const ts = (r && r.threads) || [];
    const t = ts.find((x) => /MainThread/i.test(x.name)) || ts[0];
    if (t) return t.id;
  } catch (e) { /* use the last known thread */ }
  return S.threadId || 1;
}

// Is the thread paused, and if so which frame should the line run in?
async function probe(session, tid, scope, file) {
  let st;
  try { st = await rq(session, 'stackTrace', { threadId: tid, startFrame: 0, levels: 40 }); } catch (e) { return { paused: false }; }
  const frames = (st && st.stackFrames) || [];
  if (!frames.length) return { paused: false };
  const isUser = (f) => f.source && f.source.path && !f.source.path.startsWith('<') && !isPackagePath(f.source.path) && !/debugpy|pydevd/i.test(f.source.path);
  const anyFrame = frames.find(isUser) || frames[0];
  for (const f of frames) {
    const fp = f.source && f.source.path;
    if (!fp || fp.startsWith('<')) continue;
    if (file && !fileMatches(fp, file)) continue;
    if (scope) {
      if (!scopeMatches(scope, { func: f.name, qual: qualNameAt(fp, f.line) })) continue;
    } else if (!file && (isPackagePath(fp) || /debugpy|pydevd/i.test(fp))) continue;
    return { paused: true, frame: f, frames, anyFrame };
  }
  return { paused: true, frame: null, frames, anyFrame };
}

// Run the code where the probe says it can go. Returns the text to show, or null when it cannot run here.
async function runWhere(session, p, req) {
  if (p.frame) return ranText(await evalIn(session, p.frame, req.code), p.frame);
  if (req.file && !req.scope) {
    const target = await resolveTarget(req.file, p.frames);
    if (!target) throw new Error('Could not find a file named ' + req.file + ' in the project.');
    const frame = p.anyFrame || (p.frames && p.frames[0]);
    if (!frame) throw new Error('There is no frame to run in.');
    const res = await evalIn(session, frame, moduleExecExpr(target, req.code, looksLikeExpression(req.code)));
    return (res && res !== 'None' ? res + '   \u2014 ' : '\u2014 ') + 'ran in the top-level variables of ' + path.basename(target);
  }
  return null;
}

async function evalIn(session, frame, code) {
  const r = await session.customRequest('evaluate', { expression: code, frameId: frame.id, context: 'repl' });
  return r && r.result !== undefined && r.result !== null ? String(r.result) : '';
}

function ranText(res, frame) {
  const where = 'ran in ' + frame.name + (frame.source ? ' (' + path.basename(frame.source.path || '') + ':' + frame.line + ')' : '');
  return (res ? res + '   \u2014 ' : '\u2014 ') + where;
}

async function resumeProgram(session, tid) {
  if (S.userPauseWanted) {
    // you pressed Pause while an automatic pause was in progress: keep the program paused
    S.userPauseWanted = false;
    log('Pause was pressed during an automatic pause, so the program stays paused');
    queue(() => onStopped(session, { reason: 'pause', threadId: tid }));
    return;
  }
  await vscode.commands.executeCommand('workbench.action.debug.continue');
  await sleep(200);
  const p = await probe(session, tid, '');
  if (p.paused) { try { await session.customRequest('continue', { threadId: tid }); } catch (e) { /* ignore */ } }
}

async function runLine(text) {
  const req = splitRunScope(text);
  const { scope, file, code } = req;
  if (!code) return { ok: false, text: 'Nothing to run.' };
  const session = S.session || vscode.debug.activeDebugSession;
  if (!session || S.ended || !isPy(session)) return { ok: false, text: 'There is no active Python debug session.' };
  for (let w = 0; S.runBusy && w < 80; w++) await sleep(50);
  if (S.runBusy) return { ok: false, text: 'Still running the previous line.' };
  S.runBusy = true;
  const where = () => (scope ? '"' + scope + '"' : file ? file : 'your own code');
  try {
    const tid = await mainThreadId(session);

    // Already paused (breakpoint or step): run it right here.
    const first = await probe(session, tid, scope, file);
    if (first.paused) {
      let out1;
      try { out1 = await runWhere(session, first, req); } catch (e) { return { ok: false, text: errText(e) }; }
      if (out1 === null) return { ok: false, text: 'Paused, but not inside ' + where() + '. Step into it, or leave the name out.' };
      log('run line (paused): ' + code);
      await refreshLive(true);
      return { ok: true, text: out1 };
    }

    // Running: pause, run the line, continue. Retry until the pause lands where the line can run.
    const tries = cfg().get('runLineMaxTries', 10);
    for (let i = 1; i <= tries; i++) {
      const waiting = waitForPause(5000);
      try { await session.customRequest('pause', { threadId: tid }); } catch (e) {
        if (S.autoPause) { clearTimeout(S.autoPause.timer); S.autoPause = null; }
        return { ok: false, text: 'Could not pause the program: ' + errText(e) };
      }
      const r = await waiting;
      if (!r) return { ok: false, text: 'The program did not pause within 5 seconds (is it inside a long native call?). It will keep running.' };
      const t2 = r.threadId || tid;
      if (!r.auto) {
        // a breakpoint stopped it first: run the line there and leave it paused
        await r.after;
        const p = await probe(session, t2, scope, file);
        let outB;
        try { outB = await runWhere(session, p, req); } catch (e) { return { ok: false, text: errText(e) }; }
        if (outB === null) return { ok: false, text: 'Stopped at a breakpoint, but not inside ' + where() + '.' };
        await refreshLive(true);
        return { ok: true, text: outB + '   (program is paused at the breakpoint)' };
      }
      const p = await probe(session, t2, scope, file);
      let outA;
      let err;
      try { outA = await runWhere(session, p, req); } catch (e) { err = e; }
      if (err || outA !== null) {
        await resumeProgram(session, t2);
        log('run line (auto-pause, try ' + i + '): ' + code);
        if (err) return { ok: false, text: errText(err) };
        return { ok: true, text: outA };
      }
      await resumeProgram(session, t2);
      await sleep(40 + Math.floor(Math.random() * 120));
    }
    return { ok: false, text: 'The program was never inside ' + where() + ' when paused (' + tries + ' tries). Nothing was run.' };
  } finally {
    S.runBusy = false;
    if (S.autoPause && !S.autoPause.timedOut) { clearTimeout(S.autoPause.timer); S.autoPause = null; }
  }
}

// ---------- live refresh (brief pauses) ----------
function pickLiveFrame(frames) {
  const user = frames.filter((f) => f.source && f.source.path && !f.source.path.startsWith('<') && !isPackagePath(f.source.path) && !/debugpy|pydevd/i.test(f.source.path));
  const scoped = [...sel.set].map(parseKey).filter((k) => k.scope);
  if (scoped.length) {
    const hit = user.find((f) => scoped.some((k) => scopeMatches(k.scope, { func: f.name, qual: qualNameAt(f.source.path, f.line) })));
    if (hit) return hit;
  }
  return user[0] || null;
}

function setLive(text) {
  S.liveStatus = new Date().toLocaleTimeString() + '  ' + text;
  if (text !== S.lastLiveText) { S.lastLiveText = text; log('live: ' + text); }
  render();
}

function cancelWait() {
  if (S.autoPause) { clearTimeout(S.autoPause.timer); S.autoPause = null; }
}

async function liveTick(force) {
  const session = S.session || vscode.debug.activeDebugSession;
  if (!session || !isPy(session) || S.ended) { setLive('no active debug session'); return; }
  S.session = session;
  if (S.userPauseWanted) return;
  if (S.startedAt && Date.now() - S.startedAt < 3000) { setLive('waiting for the program to start'); return; }
  if (S.runBusy) { if (force) setLive('busy with another action, try again'); return; }
  if (!S.running) { setLive('paused \u2013 press Continue and live refresh carries on'); return; }
  if (S.replayIdx !== null) {
    if (!force) { setLive('showing a replay \u2013 live refresh is on hold'); return; }
    S.replayIdx = null;
    setReplayCtx(false);
  }
  S.runBusy = true;
  try {
    const tid = await mainThreadId(session);
    const waiting = waitForPause(3000);
    try { await rq(session, 'pause', { threadId: tid }, 3000); } catch (e) {
      cancelWait();
      setLive('could not pause the program: ' + errText(e));
      return;
    }
    const r = await waiting;
    if (!r) { setLive('the program did not pause within 3 s (busy in native code?)'); return; }
    if (!r.auto) { setLive('stopped at a breakpoint'); return; }
    const t2 = r.threadId || tid;
    const entry = await buildEntry(session, t2, pickLiveFrame);
    let note;
    if (entry && !entry.library) {
      const prev = S.liveEntry;
      const comparable = prev && prev.file === entry.file && prev.func === entry.func;
      markChanged(entry.vars, comparable ? flat(prev.vars) : null);
      S.liveEntry = entry;
      note = 'refreshed from ' + entry.func + ' (' + path.basename(entry.file) + ':' + entry.line + ')';
    } else {
      note = 'paused, but found no frame of your own code to read';
    }
    await resumeProgram(session, t2);
    setLive(note);
  } catch (e) {
    setLive('failed: ' + errText(e));
  } finally {
    S.runBusy = false;
    cancelWait();
  }
}

async function forceRefresh() {
  const session = S.session || vscode.debug.activeDebugSession;
  if (!session || !isPy(session) || S.ended) { setLive('no active debug session'); return; }
  S.session = session;
  if (!S.running) {
    await refreshLive(true);
    setLive('refreshed (the program is paused)');
    return;
  }
  for (let w = 0; S.runBusy && w < 60; w++) await sleep(50);
  await liveTick(true);
}

async function userPause() {
  const session = S.session || vscode.debug.activeDebugSession;
  if (!session || !isPy(session)) { vscode.window.showInformationMessage('There is no Python debug session to pause.'); return; }
  if (S.ended) { vscode.window.showInformationMessage('The program has already finished.'); return; }
  if (!S.running) { vscode.window.showInformationMessage('The program is already paused.'); return; }
  S.session = session;
  S.userPauseWanted = true;
  log('pause pressed');
  const waitStop = async (ms) => { for (let i = 0; i < ms / 100 && S.userPauseWanted && S.running; i++) await sleep(100); };
  try { await vscode.commands.executeCommand('workbench.action.debug.pause'); } catch (e) { log('pause command failed: ' + errText(e)); }
  await waitStop(1500);
  if (S.userPauseWanted && S.running) {
    log('the pause command had no effect, sending a pause request instead');
    try { await rq(session, 'pause', { threadId: await mainThreadId(session) }, 3000); } catch (e) { log('pause request failed: ' + errText(e)); }
    await waitStop(4000);
  }
  if (S.userPauseWanted && S.running) {
    S.userPauseWanted = false;
    log('could not pause the program');
    vscode.window.showWarningMessage('Could not pause the program. Details: Output > Py Debug Plus.');
  } else {
    log('paused');
  }
}

async function startLiveLoop() {
  if (liveLoopOn) return;
  liveLoopOn = true;
  try {
    while (sel.live && S && !S.ended) {
      await liveTick();
      await sleep(Math.max(250, cfg().get('liveRefreshMs', 1000)));
    }
  } finally {
    liveLoopOn = false;
  }
}

function toggleLive() {
  sel.live = !sel.live;
  if (!sel.live) S.liveEntry = null;
  saveSel();
  render();
  if (sel.live) startLiveLoop();
}

// ---------- rerun when a file is saved ----------
function updateRerunItem() {
  if (!sbRerun) return;
  sbRerun.text = '$(sync) Rerun on save: ' + (sel.rerun ? 'ON' : 'OFF');
}

function toggleRerun() {
  sel.rerun = !sel.rerun;
  saveSel();
  updateRerunItem();
}

function onSaved(doc) {
  if (!sel.rerun || doc.languageId !== 'python') return;
  const session = vscode.debug.activeDebugSession;
  if (!session || !isPy(session) || S.ended) return;
  if (!vscode.workspace.getWorkspaceFolder(doc.uri) || /[\\/](\.venv|venv|site-packages)[\\/]/i.test(doc.uri.fsPath)) return;
  clearTimeout(rerunTimer);
  rerunTimer = setTimeout(() => {
    log('rerun: ' + doc.fileName + ' was saved');
    vscode.commands.executeCommand('workbench.action.debug.restart');
  }, cfg().get('rerunDelayMs', 600));
}

function saveRanges() { ctx.workspaceState.update('pyDebugPlus.ranges', Object.fromEntries(savedRanges)); }

function saveSel() {
  ctx.workspaceState.update('pyDebugPlus.selected', [...sel.set]);
  ctx.workspaceState.update('pyDebugPlus.showAll', sel.showAll);
  ctx.workspaceState.update('pyDebugPlus.live', sel.live);
  ctx.workspaceState.update('pyDebugPlus.rerun', sel.rerun);
}

// ---------- live panel ----------
function payload() {
  const idx = S.replayIdx === null ? S.history.length - 1 : S.replayIdx;
  const useLive = S.running && S.liveEntry && S.replayIdx === null;
  const inLib = S.replayIdx === null && S.libraryFrame && !useLive;
  const e = useLive ? S.liveEntry : (inLib ? null : S.history[idx]);
  const lf = S.libraryFrame;
  const vctx = ctxOf(e);
  return {
    library: inLib ? { func: lf.func, file: path.basename(lf.file || ''), line: lf.line } : null,
    type: 'state', ranges: effectiveRanges(vctx), defaultRange: cfg().get('defaultListRange', 100), selected: [...(e && e.wanted ? new Set(e.wanted) : effectiveSelected(vctx))], onlySelected: !sel.showAll, liveStatus: S.liveStatus || '', live: sel.live, liveMs: cfg().get('liveRefreshMs', 1000), running: S.running, ended: S.ended, replay: S.replayIdx !== null,
    idx, total: S.history.length,
    file: e ? path.basename(e.file || '') : '', line: e ? e.line : 0, func: e ? e.func : '',
    vars: e ? e.vars : [],
  };
}

function render() {
  if (panel) panel.webview.postMessage(payload());
  refreshInline();
}

function exprFor(path) {
  return path.split('.').map((seg, i) => (i === 0 ? seg : (/^\d+$/.test(seg) ? '[' + seg + ']' : '.' + seg))).join('');
}

function refreshInline() {
  if (!inlineDeco) return;
  for (const ed of vscode.window.visibleTextEditors) ed.setDecorations(inlineDeco, []);
  if (!cfg().get('showInlineSelected', true) || S.running || sel.showAll || !sel.set.size) return;
  const entry = currentEntry();
  if (!entry || entry.library || !entry.file) return;
  const exprs = [...(entry.wanted ? new Set(entry.wanted) : effectiveSelected(ctxOf(entry)))].map((p) => ({
    p, re: new RegExp('(?<![\\w.])' + exprFor(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!\\w)'),
  }));
  for (const ed of vscode.window.visibleTextEditors) {
    if (!samePath(ed.document.uri.fsPath, entry.file)) continue;
    const doc = ed.document;
    const cur = Math.min(Math.max(0, entry.line - 1), doc.lineCount - 1);
    let start = 0;
    for (let i = cur; i >= 0; i--) {
      if (/^\s*(async\s+)?(def|class)\s/.test(doc.lineAt(i).text)) { start = i; break; }
    }
    const opts = [];
    for (const r of ed.visibleRanges) {
      for (let i = Math.max(r.start.line, start); i <= Math.min(r.end.line, cur); i++) {
        const text = doc.lineAt(i).text;
        if (/^\s*#/.test(text)) continue;
        const parts = [];
        for (const { p, re } of exprs) {
          if (parts.length >= 3 || !re.test(text)) continue;
          const node = findNode(entry.vars, p);
          if (!node) continue;
          const v = node.value.length > 60 ? node.value.slice(0, 60) + '\u2026' : node.value;
          parts.push(exprFor(p) + ' = ' + v);
        }
        if (parts.length) {
          const end = new vscode.Position(i, text.length);
          opts.push({
            range: new vscode.Range(end, end),
            renderOptions: { after: { contentText: '   ' + parts.join('   '), color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic' } },
          });
        }
      }
    }
    ed.setDecorations(inlineDeco, opts);
  }
}

function openPanel() {
  if (panel) { panel.reveal(undefined, true); return; }
  panel = vscode.window.createWebviewPanel(
    'pyDebugPlusLive', 'Live Variables',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] }
  );
  const w = panel.webview;
  const nonce = Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
  const js = w.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'live.js'));
  const css = w.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', 'live.css'));
  w.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body>
<div id="statusrow"><span id="mode"></span></div>
<div id="bar">
<button id="back" title="Step back (recorded replay)">&#9664; Back</button>
<button id="fwd" title="Forward: next recorded step while replaying, otherwise run to the next line">Forward &#9654;</button>
<button id="cont" title="Continue to next breakpoint">&#9205; Continue</button>
<button id="choose" title="Pick which variables to watch">Choose variables…</button>
<button id="only" title="Switch between your chosen variables and everything"></button>
<button id="clearsel" title="Untick all variables">Clear ticks</button>
<button id="live" title="Refresh values while the program runs, using a brief pause each time"></button>
<button id="pausebtn" title="Pause the program and keep it paused">Pause</button>
<button id="refreshnow" title="Read the values right now">Force refresh</button></div>
<div id="addbar"><input id="addname" placeholder="Add variable, e.g. scores, blocks[0], entities[0:10][0:10], drawall:blocks[0:5]"><button id="addbtn">Add</button></div>
<div id="runbar"><input id="runline" placeholder="Run a Python line, e.g. score += 10 or drawall: blocks[3] = []"><button id="runbtn">Run</button></div>
<div id="runout"></div>
<div id="livestat"></div>
<div id="loc"></div><div id="tree"></div>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
  w.onDidReceiveMessage((m) => {
    if (m.cmd === 'ready') render();
    else if (m.cmd === 'back') stepBack();
    else if (m.cmd === 'forward') stepForward();
    else if (m.cmd === 'continue') doContinue();
    else if (m.cmd === 'setRange') applyRange(m.path, m.start, m.end);
    else if (m.cmd === 'setValue') setValue(m.path, m.value);
    else if (m.cmd === 'toggleSelect') toggleSelect(m.path);
    else if (m.cmd === 'setOnly') { sel.showAll = !m.value; saveSel(); render(); }
    else if (m.cmd === 'choose') chooseVariables();
    else if (m.cmd === 'addVar') addVar(m.text);
    else if (m.cmd === 'toggleLive') toggleLive();
    else if (m.cmd === 'forceRefresh') forceRefresh();
    else if (m.cmd === 'pause') userPause();
    else if (m.cmd === 'runLine') {
      runLine(m.text)
        .catch((e) => ({ ok: false, text: String((e && e.message) || e) }))
        .then((r) => { if (panel) panel.webview.postMessage({ type: 'runResult', ok: r.ok, text: r.text }); });
    }
    else if (m.cmd === 'clearSelected') { sel.set.clear(); saveSel(); render(); }
  });
  panel.onDidDispose(() => { panel = undefined; });
}

// ---------- status bar ----------
function updateStatus() {
  if (S.replayIdx !== null) {
    sbMode.text = '$(history) REPLAY ' + (S.replayIdx + 1) + '/' + S.history.length;
    sbMode.show();
  } else sbMode.hide();
}

function showStatus(on) {
  if (on) { sbBack.show(); sbCont.show(); if (sbRerun) sbRerun.show(); } else { sbCont.hide(); }
}

// ---------- activate ----------
function activate(context) {
  ctx = context;
  out = vscode.window.createOutputChannel('Py Debug Plus');
  context.subscriptions.push(out);
  sel = {
    set: new Set(context.workspaceState.get('pyDebugPlus.selected', [])),
    showAll: context.workspaceState.get('pyDebugPlus.showAll', false),
    live: false, // never switched on automatically, so it cannot touch a debug session while it starts
    rerun: context.workspaceState.get('pyDebugPlus.rerun', false),
  };
  savedRanges = new Map(Object.entries(context.workspaceState.get('pyDebugPlus.ranges', {})));
  S = freshState();

  inlineDeco = vscode.window.createTextEditorDecorationType({});
  liveDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true, backgroundColor: 'rgba(255, 210, 0, 0.22)',
  });
  replayDeco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true, backgroundColor: 'rgba(80, 160, 255, 0.28)',
    after: { contentText: '   \u23EA replay', color: 'rgba(80,160,255,0.9)' },
  });

  sbBack = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  sbBack.text = '$(debug-reverse-continue) Back'; sbBack.command = 'pyDebugPlus.stepBack'; sbBack.tooltip = 'Step back (recorded replay)';
  sbCont = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  sbCont.text = '$(debug-continue) Continue'; sbCont.command = 'pyDebugPlus.continue'; sbCont.tooltip = 'Continue to next breakpoint';
  sbRerun = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  sbRerun.command = 'pyDebugPlus.toggleRerun';
  sbRerun.tooltip = 'Restart the program whenever you save a Python file';
  updateRerunItem();
  sbMode = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  sbMode.command = 'pyDebugPlus.openLiveView';

  context.subscriptions.push(
    liveDeco, replayDeco, inlineDeco, sbBack, sbCont, sbMode, sbRerun,
    vscode.workspace.onDidSaveTextDocument(onSaved),
    vscode.window.onDidChangeTextEditorVisibleRanges(() => refreshInline()),
    vscode.window.onDidChangeVisibleTextEditors(() => refreshInline()),
    vscode.commands.registerCommand('pyDebugPlus.stepBack', stepBack),
    vscode.commands.registerCommand('pyDebugPlus.stepForward', stepForward),
    vscode.commands.registerCommand('pyDebugPlus.continue', doContinue),
    vscode.commands.registerCommand('pyDebugPlus.openLiveView', openPanel),
    vscode.commands.registerCommand('pyDebugPlus.setListRange', setListRange),
    vscode.commands.registerCommand('pyDebugPlus.chooseVariables', chooseVariables),
    vscode.commands.registerCommand('pyDebugPlus.showLog', () => out.show(true)),
    vscode.commands.registerCommand('pyDebugPlus.toggleLive', toggleLive),
    vscode.commands.registerCommand('pyDebugPlus.forceRefresh', forceRefresh),
    vscode.commands.registerCommand('pyDebugPlus.pauseProgram', userPause),
    vscode.commands.registerCommand('pyDebugPlus.toggleRerun', toggleRerun),
    vscode.commands.registerCommand('pyDebugPlus.runLine', async () => {
      const text = await vscode.window.showInputBox({ title: 'Run a Python line (optionally "function: code")', placeHolder: 'score += 10' });
      if (!text) return;
      const r = await runLine(text).catch((e) => ({ ok: false, text: String((e && e.message) || e) }));
      (r.ok ? vscode.window.showInformationMessage : vscode.window.showWarningMessage)(r.text);
    }),
    vscode.commands.registerCommand('pyDebugPlus.clearHistory', () => {
      S.history = []; S.replayIdx = null; setReplayCtx(false); clearDecos(); render(); updateStatus();
    }),

    vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker(session) {
        if (!isPy(session)) return undefined;
        return {
          onDidSendMessage(m) {
            if (m.type !== 'event') return;
            if (m.event === 'stopped') handleStoppedEvent(session, m.body);
            else if (m.event === 'continued') { log('event: continued'); S.running = true; clearDecos(); render(); }
          },
        };
      },
    }),

    ...['python', 'debugpy'].map((t) => vscode.debug.registerDebugConfigurationProvider(t, {
      resolveDebugConfigurationWithSubstitutedVariables(folder, config) {
        if (cfg().get('stepIntoLibraries', true)) config.justMyCode = false;
        return config;
      },
    })),

    vscode.debug.onDidStartDebugSession((s) => {
      if (!isPy(s)) return;
      S = freshState();
      S.session = s;
      S.startedAt = Date.now();
      S.running = true;
      if (sel.live) startLiveLoop();
      setReplayCtx(false);
      showStatus(true);
      quietDefaultDebugUI();
      if (cfg().get('autoOpenLiveView', true)) openPanel();
      render();
    }),
    vscode.debug.onDidTerminateDebugSession((s) => {
      if (!isPy(s)) return;
      S.ended = true; S.running = false;
      sbCont.hide();
      render();
    })
  );
}

function deactivate() {
  if (!cfg().get('stopDebuggingOnClose', true)) return undefined;
  return Promise.race([
    Promise.resolve(vscode.debug.stopDebugging()).catch(() => {}),
    new Promise((r) => setTimeout(r, 4000)),
  ]);
}
module.exports = { activate, deactivate };
