(function () {
  const vscode = acquireVsCodeApi();
  const openState = (vscode.getState() || {}).open || {};
  const $ = (id) => document.getElementById(id);
  $('back').onclick = () => vscode.postMessage({ cmd: 'back' });
  $('fwd').onclick = () => vscode.postMessage({ cmd: 'forward' });
  $('cont').onclick = () => vscode.postMessage({ cmd: 'continue' });
  $('pausebtn').onclick = () => vscode.postMessage({ cmd: 'pause' });
  $('refreshnow').onclick = () => vscode.postMessage({ cmd: 'forceRefresh' });
  const addIt = () => {
    const text = $('addname').value.trim();
    if (!text) return;
    vscode.postMessage({ cmd: 'addVar', text });
    $('addname').value = '';
  };
  $('addbtn').onclick = addIt;
  $('addname').onkeydown = (e) => { if (e.key === 'Enter') addIt(); };

  const runHist = [];
  let runPos = 0;
  const runIt = () => {
    const text = $('runline').value.trim();
    if (!text) return;
    runHist.push(text);
    runPos = runHist.length;
    $('runout').className = '';
    $('runout').textContent = 'Running\u2026';
    vscode.postMessage({ cmd: 'runLine', text });
    $('runline').value = '';
  };
  $('runbtn').onclick = runIt;
  $('runline').onkeydown = (e) => {
    if (e.key === 'Enter') runIt();
    else if (e.key === 'ArrowUp' && runHist.length) { runPos = Math.max(0, runPos - 1); $('runline').value = runHist[runPos]; e.preventDefault(); }
    else if (e.key === 'ArrowDown' && runHist.length) { runPos = Math.min(runHist.length, runPos + 1); $('runline').value = runHist[runPos] || ''; e.preventDefault(); }
  };

  window.addEventListener('message', (e) => {
    if (!e.data) return;
    if (e.data.type === 'state') render(e.data);
    else if (e.data.type === 'runResult') {
      $('runout').className = e.data.ok ? 'ok' : 'err';
      $('runout').textContent = e.data.text;
    }
  });

  let selected = new Set();

  function pretty(p) { return p.replace(/\.(\d+)(?=\.|$)/g, '[$1]'); }

  function label(n, usePath) {
    const s = (usePath ? pretty(n.path) : n.name) + (n.type ? ' (' + n.type + ')' : '') + ' = ' + n.value;
    const max = n.children && n.children.length ? 100 : 240;
    return s.length > max ? s.slice(0, max) + '\u2026' : s;
  }

  function rangeBar(n) {
    const bar = document.createElement('div');
    bar.className = 'range';
    const a = document.createElement('input'); a.type = 'number'; a.value = n.range[0]; a.min = 0;
    const b = document.createElement('input'); b.type = 'number'; b.value = n.range[1]; b.min = 1;
    const go = document.createElement('button'); go.textContent = 'Show';
    go.onclick = () => vscode.postMessage({ cmd: 'setRange', path: n.path, start: Number(a.value), end: Number(b.value) });
    bar.append('Items ', a, ' to ', b, ' (end exclusive) of ' + n.total + '  ', go);
    return bar;
  }

  let last = null;

  function editorBox(n) {
    const box = document.createElement('div');
    box.className = 'edit';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = n.value;
    inp.placeholder = 'Python expression, e.g. 42, "text", [1, 2], Player("Sam")';
    const ok = document.createElement('button'); ok.textContent = 'Set';
    const no = document.createElement('button'); no.textContent = 'Cancel';
    const submit = () => vscode.postMessage({ cmd: 'setValue', path: n.path, value: inp.value });
    ok.onclick = submit;
    no.onclick = () => { if (last) render(last); };
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') submit();
      else if (e.key === 'Escape' && last) render(last);
    };
    box.append(n.name + ' = ', inp, ok, no);
    return box;
  }

  function pick(n) {
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = selected.has(n.path);
    c.title = 'Tick to include in "Only selected" mode';
    c.onclick = (e) => e.stopPropagation();
    c.onchange = () => vscode.postMessage({ cmd: 'toggleSelect', path: n.path });
    return c;
  }

  function collect(nodes, out) {
    for (const n of nodes) {
      if (selected.has(n.path)) out.push(n);
      else if (n.children) collect(n.children, out);
    }
    return out;
  }

  function allPaths(nodes, set) {
    for (const n of nodes) { set.add(n.path); if (n.children) allPaths(n.children, set); }
    return set;
  }

  function missingRow(path, s) {
    const d = document.createElement('div');
    d.className = 'row missing';
    const r0 = s.ranges && s.ranges[path];
    const r = r0 ? (typeof r0[0] === 'number' ? r0 : r0[0]) : [0, s.defaultRange || 100];
    const num = (v) => { const i = document.createElement('input'); i.type = 'number'; i.min = 0; i.value = v; return i; };
    const a = num(r[0]);
    const b = num(r[1] === null ? '' : r[1]);
    const go = document.createElement('button');
    go.textContent = 'Set range';
    go.onclick = () => vscode.postMessage({ cmd: 'setRange', path, start: Number(a.value), end: b.value === '' ? null : Number(b.value) });
    const pickBox = pick({ path });
    d.append(pickBox, ' ' + pretty(path) + ' \u2014 not available at this stop yet.  If it is a list, range ', a, ' to ', b, ' ', go);
    return d;
  }

  function flatten(n, out) {
    if (n.sliced && n.children) n.children.forEach((c) => flatten(c, out));
    else out.push(n);
    return out;
  }

  function renderNode(n, depth, usePath, pickPath) {
    const hasKids = (n.children && n.children.length) || n.range;
    if (!hasKids) {
      const d = document.createElement('div');
      d.className = 'row' + (n.changed ? ' changed' : '');
      d.textContent = '';
      d.append(pick(pickPath ? { path: pickPath } : n), ' ' + label(n, usePath));
      d.title = 'Double-click to edit';
      d.ondblclick = () => {
        d.className = 'row';
        d.textContent = '';
        const box = editorBox(n);
        d.appendChild(box);
        const inp = box.querySelector('input'); inp.focus(); inp.select();
      };
      return d;
    }
    const det = document.createElement('details');
    det.open = n.path in openState ? openState[n.path] : depth < 1;
    det.addEventListener('toggle', () => { openState[n.path] = det.open; vscode.setState({ open: openState }); });
    const sum = document.createElement('summary');
    if (n.changed) sum.className = 'changed';
    sum.append(pick(pickPath ? { path: pickPath } : n), ' ' + label(n, usePath));
    sum.title = 'Double-click to edit the whole value';
    det.appendChild(sum);
    const body = document.createElement('div');
    body.className = 'body';
    sum.ondblclick = () => {
      if (body.querySelector('.edit')) return;
      const box = editorBox(n);
      body.insertBefore(box, body.firstChild);
      setTimeout(() => { det.open = true; const inp = box.querySelector('input'); inp.focus(); inp.select(); }, 0);
    };
    if (n.range) body.appendChild(rangeBar(n));
    (n.children || []).forEach((c) => body.appendChild(renderNode(c, depth + 1)));
    det.appendChild(body);
    return det;
  }

  function render(s) {
    last = s;
    const mode = $('mode');
    mode.className = s.replay ? 'replay' : '';
    if (s.total === 0 && !s.library) mode.textContent = s.ended ? 'FINISHED' : 'Waiting for a stop…';
    else if (s.replay) mode.textContent = 'REPLAY ' + (s.idx + 1) + '/' + s.total;
    else if (s.library && !s.running) mode.textContent = 'PAUSED in library code';
    else if (s.ended) mode.textContent = 'FINISHED (last stop ' + s.total + ')';
    else if (s.running) mode.textContent = s.live ? 'RUNNING – live refresh about every ' + (Math.max(250, s.liveMs) / 1000) + ' s' : 'RUNNING – updates at next stop';
    else mode.textContent = 'PAUSED – stop ' + s.total;
    $('loc').textContent = s.library
      ? 'Inside library code: ' + s.library.func + '  —  ' + s.library.file + ':' + s.library.line + '  (variables hidden)'
      : (s.func ? s.func + '  —  ' + s.file + ':' + s.line : '');
    const tree = $('tree');
    tree.textContent = '';
    selected = new Set(s.selected || []);
    const only = $('only');
    only.textContent = 'Show all: ' + (s.onlySelected ? 'OFF' : 'ON');
    only.onclick = () => vscode.postMessage({ cmd: 'setOnly', value: !s.onlySelected });
    $('choose').onclick = () => vscode.postMessage({ cmd: 'choose' });
    $('clearsel').onclick = () => vscode.postMessage({ cmd: 'clearSelected' });
    $('livestat').textContent = s.liveStatus ? 'Live refresh: ' + s.liveStatus : '';
    $('live').textContent = 'Live refresh: ' + (s.live ? 'ON' : 'OFF');
    $('live').onclick = () => vscode.postMessage({ cmd: 'toggleLive' });
    if (s.onlySelected) {
      const list = collect(s.vars, []);
      const present = allPaths(s.vars, new Set());
      const missing = [...selected].filter((p) => !present.has(p));
      if (!selected.size) {
        const h = document.createElement('div');
        h.className = 'row';
        h.textContent = 'No variables chosen yet. Type a name above (it can be one that does not exist yet) or click "Choose variables\u2026".';
        tree.appendChild(h);
      }
      list.forEach((n) => {
        if (!n.sliced) { tree.appendChild(renderNode(n, 0, true)); return; }
        // a variable with a range: show just the chosen items, not the list itself
        const items = flatten(n, []);
        if (!items.length) {
          const e = document.createElement('div');
          e.className = 'row';
          e.append(pick({ path: n.path }), ' ' + pretty(n.path) + ' \u2014 nothing in that range');
          tree.appendChild(e);
        }
        items.forEach((c) => tree.appendChild(renderNode(c, 0, true, n.path)));
      });
      missing.forEach((p) => tree.appendChild(missingRow(p, s)));
    } else {
      s.vars.forEach((n) => tree.appendChild(renderNode(n, 0)));
    }
  }

  vscode.postMessage({ cmd: 'ready' });
})();
