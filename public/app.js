// SAP BAH Sandbox — UI. No build step: plain ES modules served as-is.

const $ = (sel) => document.querySelector(sel);
const el = (id) => document.getElementById(id);

const state = {
  runId: null,
  mockId: null,
  collections: [],
  traffic: [],
  selectedTraffic: null,
  testRunId: null,
  version: null,
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const adminKeyInput = el('adminKey');
adminKeyInput.value = localStorage.getItem('sandboxKey') ?? '';
function applyKey() {
  localStorage.setItem('sandboxKey', adminKeyInput.value.trim());
  adminKeyInput.value = adminKeyInput.value.trim();
  hideAuthBanner();
  // The live feed authenticates when it connects: reconnect with the new key.
  state.ws?.close();
  refreshAll();
  // Re-run whichever tab is open, so the view fills in without a reload.
  const active = document.querySelector('nav button.active');
  if (active) loadTab(active.dataset.tab);
}

adminKeyInput.addEventListener('change', applyKey);
adminKeyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') applyKey();
});

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (adminKeyInput.value) headers['X-Sandbox-Key'] = adminKeyInput.value;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.json);
    options.method = options.method ?? 'POST';
  }

  const res = await fetch(`/api${path}`, { ...options, headers });

  // A missing or wrong admin key is a setup problem, not a per-request error:
  // show one banner explaining it rather than a toast per failed call.
  if (res.status === 401) {
    showAuthBanner();
    const err = new Error('Admin key required');
    err.status = 401;
    throw err;
  }

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error(body?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/** Reports an error, unless the banner is already explaining it. */
function fail(err) {
  if (err?.status === 401) return;
  toast(err.message, 'err');
}

function showAuthBanner() {
  const banner = el('authBanner');
  if (!banner.hidden) return;
  banner.hidden = false;
  adminKeyInput.classList.add('wanted');
  if (!adminKeyInput.value) adminKeyInput.focus();
}

function hideAuthBanner() {
  el('authBanner').hidden = true;
  adminKeyInput.classList.remove('wanted');
}

function toast(message, kind = 'info', ms = 5000) {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  el('toast').append(node);
  setTimeout(() => node.remove(), ms);
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function table(node, columns, rows, opts = {}) {
  if (!rows.length) {
    node.innerHTML = `<tbody><tr><td class="empty">${esc(opts.empty ?? 'Nothing here yet.')}</td></tr></tbody>`;
    return;
  }
  const head = columns.map((c) => `<th>${esc(c.label)}</th>`).join('');
  const body = rows
    .map((row, i) => {
      const cells = columns.map((c) => `<td${c.cls ? ` class="${c.cls}"` : ''}>${c.render(row, i)}</td>`).join('');
      const cls = [opts.rowClass?.(row) ?? '', opts.onRow ? 'clickable' : ''].filter(Boolean).join(' ');
      return `<tr data-i="${i}"${cls ? ` class="${cls}"` : ''}>${cells}</tr>`;
    })
    .join('');
  node.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;

  if (opts.onRow) {
    node.querySelectorAll('tbody tr').forEach((tr) => {
      tr.addEventListener('click', () => opts.onRow(rows[Number(tr.dataset.i)], tr));
    });
  }
}

const statusTag = (status) => {
  const kind = status >= 500 ? 't-err' : status >= 400 ? 't-warn' : status ? 't-ok' : 't-info';
  return `<span class="tag ${kind}">${esc(status ?? '—')}</span>`;
};

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const fmtClock = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '—');
const fmtBytes = (n) => (n > 1024 ? `${(n / 1024).toFixed(1)} kB` : `${n ?? 0} B`);

function pretty(text, headers) {
  if (!text) return '(empty)';
  const type = String(headers?.['content-type'] ?? '');
  if (type.includes('json')) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* fall through */
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`));
    loadTab(btn.dataset.tab);
  });
});

function loadTab(tab) {
  if (tab === 'catalog') loadStatus();
  if (tab === 'changes') loadRuns();
  if (tab === 'mocks') { loadMocks(); loadSpecs(); }
  if (tab === 'tests') { loadMockOptions(); loadTestRuns(); }
  if (tab === 'network') loadTraffic();
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

async function loadStatus() {
  try {
    const s = await api('/status');
    const c = s.counts;
    el('statusCards').innerHTML = [
      ['packages', c.packages],
      ['artifacts', c.artifacts],
      ['APIs', c.apis],
      ['specs stored', c.specs],
      ['mocks', c.mocks],
      ['logged calls', c.traffic],
    ]
      .map(([label, value]) => `<div class="card"><b>${value ?? 0}</b><span>${label}</span></div>`)
      .join('');

    const notes = [];
    notes.push(
      s.lastRun
        ? `Last sync: run #${s.lastRun.id} (${s.lastRun.status}) at ${fmtTime(s.lastRun.finished_at ?? s.lastRun.started_at)}.`
        : 'No sync has run yet.'
    );
    notes.push(
      s.hub.hasCredentials
        ? 'Hub credentials configured — specifications download automatically.'
        : 'No Hub credentials: catalog tracking works, but specifications must be imported from the Mocks tab.'
    );
    notes.push(`AI provider: ${s.ai.provider}${s.ai.provider !== 'none' ? ` (${s.ai.model}) — ${s.ai.available ? 'reachable' : 'not reachable'}` : ''}.`);
    el('statusNote').textContent = notes.join(' ');
  } catch (err) {
    fail(err);
  }
}

el('btnSync').addEventListener('click', async () => {
  try {
    el('btnSync').disabled = true;
    await api('/sync', { json: { filter: el('syncFilter').value.trim(), fetchSpecs: el('syncSpecs').checked } });
    el('syncMsg').textContent = 'Sync started…';
  } catch (err) {
    fail(err);
    el('btnSync').disabled = false;
  }
});

async function loadArtifacts() {
  try {
    const params = new URLSearchParams();
    if (el('artifactQuery').value.trim()) params.set('q', el('artifactQuery').value.trim());
    if (el('artifactType').value) params.set('type', el('artifactType').value);
    const rows = await api(`/artifacts?${params}`);

    table(
      el('artifactTable'),
      [
        { label: 'Artifact', render: (r) => esc(r.display_name) },
        { label: 'Type', render: (r) => `<span class="tag t-info">${esc(r.type)}</span>` },
        { label: 'Version', cls: 'nowrap', render: (r) => esc(r.version) },
        { label: 'Package', cls: 'mono', render: (r) => esc(r.package_name) },
        { label: 'Specs', cls: 'right', render: (r) => (r.spec_count ? `<span class="tag t-ok">${r.spec_count}</span>` : '—') },
        { label: 'Modified', cls: 'nowrap muted', render: (r) => fmtTime(r.modified_at) },
      ],
      rows,
      { empty: 'No artifacts. Run a catalog sync first.' }
    );
  } catch (err) {
    fail(err);
  }
}

el('btnArtifacts').addEventListener('click', loadArtifacts);
el('artifactQuery').addEventListener('keydown', (e) => e.key === 'Enter' && loadArtifacts());

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

async function loadRuns() {
  try {
    const runs = await api('/runs');
    table(
      el('runTable'),
      [
        { label: 'Run', render: (r) => `#${r.id}` },
        { label: 'Started', cls: 'nowrap', render: (r) => fmtTime(r.started_at) },
        {
          label: 'Result',
          render: (r) =>
            r.status === 'error'
              ? `<span class="tag t-err">error</span>`
              : `<span class="tag t-ok">+${r.added}</span> <span class="tag t-warn">~${r.changed}</span> <span class="tag t-err">-${r.removed}</span>`,
        },
        {
          label: '',
          cls: 'right',
          render: (r) => (r.report_path ? `<button class="sm" data-report="${r.id}">report</button>` : ''),
        },
      ],
      runs,
      {
        empty: 'No sync runs yet.',
        rowClass: (r) => (r.id === state.runId ? 'selected' : ''),
        onRow: (r) => {
          state.runId = r.id;
          loadRuns();
          loadChanges(r.id);
        },
      }
    );

    el('runTable').querySelectorAll('button[data-report]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        openReport(Number(b.dataset.report));
      })
    );

    if (!state.runId && runs.length) {
      state.runId = runs[0].id;
      loadChanges(state.runId);
    }
  } catch (err) {
    fail(err);
  }
}

/** A plain link cannot send the X-Sandbox-Key header, so fetch the report and open it as a blob. */
async function openReport(runId) {
  const tab = window.open('', '_blank'); // opened synchronously, or popup blockers step in
  try {
    const headers = adminKeyInput.value ? { 'X-Sandbox-Key': adminKeyInput.value } : {};
    const res = await fetch(`/api/runs/${runId}/report`, { headers });
    if (res.status === 401) {
      tab?.close();
      showAuthBanner();
      return;
    }
    if (!res.ok) throw new Error(`Report not available (HTTP ${res.status})`);
    const url = URL.createObjectURL(new Blob([await res.text()], { type: 'text/html' }));
    if (tab) tab.location.href = url;
    else window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    tab?.close();
    fail(err);
  }
}

async function loadChanges(runId) {
  el('changeRunLabel').textContent = `#${runId}`;
  try {
    const rows = await api(`/runs/${runId}/changes`);
    table(
      el('changeTable'),
      [
        {
          label: 'Change',
          cls: 'nowrap',
          render: (r) => {
            const kind = r.change_type === 'added' ? 't-ok' : r.change_type === 'removed' ? 't-err' : 't-warn';
            const breaking = r.breaking ? ' <span class="tag t-err">breaking</span>' : '';
            return `<span class="tag ${kind}">${esc(r.change_type)}</span>${breaking}`;
          },
        },
        { label: 'Scope', cls: 'nowrap muted', render: (r) => esc(r.scope) },
        { label: 'What', render: (r) => esc(r.summary) },
        {
          label: 'Version',
          cls: 'nowrap mono',
          render: (r) => (r.from_version || r.to_version ? `${esc(r.from_version ?? '—')} → ${esc(r.to_version ?? '—')}` : ''),
        },
      ],
      rows,
      { empty: 'Nothing changed in this run.' }
    );
  } catch (err) {
    fail(err);
  }
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

el('btnImportSpec').addEventListener('click', async () => {
  const file = el('specFile').files?.[0];
  if (!file) {
    toast('Choose a specification file first.', 'err');
    return;
  }
  const form = new FormData();
  form.append('file', file);
  if (el('specName').value.trim()) form.append('name', el('specName').value.trim());

  try {
    const out = await api('/specs/import', { method: 'POST', body: form });
    toast(
      `Imported ${out.format}: ${out.operations} operations, ${out.entitySets} entity sets.`,
      out.operations ? 'ok' : 'err'
    );
    for (const w of out.warnings ?? []) toast(w, 'err', 9000);
    loadSpecs();
  } catch (err) {
    fail(err);
  }
});

async function loadSpecs() {
  try {
    const rows = await api('/specs');
    table(
      el('specTable'),
      [
        { label: 'ID', cls: 'right', render: (r) => r.id },
        { label: 'Artifact', cls: 'mono', render: (r) => esc(r.artifact_id) },
        { label: 'Format', cls: 'nowrap', render: (r) => `<span class="tag t-info">${esc(r.spec_format)}</span>` },
        { label: 'Source', cls: 'nowrap muted', render: (r) => esc(r.source) },
        {
          label: '',
          cls: 'right',
          render: (r) => `<button class="sm" data-mount="${r.id}">mount</button>`,
        },
      ],
      rows,
      { empty: 'No specifications stored. Import one above, or sync with credentials.' }
    );

    el('specTable').querySelectorAll('[data-mount]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const out = await api('/mocks', { json: { specId: Number(btn.dataset.mount) } });
          toast(`Mock mounted at ${out.url}`, 'ok');
          loadMocks();
        } catch (err) {
          fail(err);
        }
      });
    });
  } catch (err) {
    fail(err);
  }
}

async function loadMocks() {
  try {
    const rows = await api('/mocks');
    table(
      el('mockTable'),
      [
        { label: 'Endpoint', cls: 'mono', render: (r) => `<a href="/mock/${esc(r.slug)}/" target="_blank">/mock/${esc(r.slug)}</a>` },
        { label: 'Title', render: (r) => esc(r.title) },
        { label: 'Mode', cls: 'nowrap', render: (r) => `<span class="tag t-info">${esc(r.strategy)}</span>` },
        {
          label: 'On',
          cls: 'nowrap',
          render: (r) => `<input type="checkbox" data-toggle="${r.id}"${r.enabled ? ' checked' : ''}>`,
        },
        { label: 'Sets', cls: 'right', render: (r) => r.dataset_count ?? 0 },
        { label: '', cls: 'right', render: (r) => `<button class="sm danger" data-del="${r.id}">delete</button>` },
      ],
      rows,
      {
        empty: 'No mocks yet. Import a specification and press “mount”.',
        rowClass: (r) => (r.id === state.mockId ? 'selected' : ''),
        onRow: (r) => selectMock(r.id),
      }
    );

    el('mockTable').querySelectorAll('[data-toggle]').forEach((cb) => {
      cb.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await api(`/mocks/${cb.dataset.toggle}`, { method: 'PATCH', json: { enabled: cb.checked } });
        } catch (err) {
          fail(err);
        }
      });
    });

    el('mockTable').querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Delete this mock and its datasets?')) return;
        try {
          await api(`/mocks/${btn.dataset.del}`, { method: 'DELETE' });
          if (state.mockId === Number(btn.dataset.del)) {
            state.mockId = null;
            el('mockDetail').innerHTML = '';
          }
          loadMocks();
        } catch (err) {
          fail(err);
        }
      });
    });
  } catch (err) {
    fail(err);
  }
}

async function selectMock(id) {
  state.mockId = id;
  loadMocks();

  try {
    const [mocks, collections] = await Promise.all([api('/mocks'), api(`/mocks/${id}/collections`)]);
    const mock = mocks.find((m) => m.id === id);
    state.collections = collections;

    el('mockDetail').innerHTML = `
      <h2 style="font-size:.82rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)">
        /mock/${esc(mock.slug)}
      </h2>
      <div class="row" style="margin-bottom:.7rem">
        <label class="inline">mode
          <select id="mkStrategy">
            ${['faker', 'ai', 'fixture', 'proxy'].map((s) => `<option${s === mock.strategy ? ' selected' : ''}>${s}</option>`).join('')}
          </select>
        </label>
        <label class="inline">latency ms <input id="mkLatency" type="number" min="0" max="60000" size="5" value="${esc(mock.latency_ms)}"></label>
        <label class="inline">error rate <input id="mkError" type="number" min="0" max="1" step="0.05" size="4" value="${esc(mock.error_rate)}"></label>
        <label class="inline">rows <input id="mkRows" type="number" min="1" max="5000" size="4" value="${esc(mock.row_count)}"></label>
        <input id="mkProxy" class="grow" placeholder="proxy target URL" value="${esc(mock.proxy_target ?? '')}">
        <button class="primary" id="mkSave">Save</button>
      </div>
      <div class="scroll"><table id="collectionTable"></table></div>
      <p class="muted" style="margin:.6rem 0 0;font-size:.82rem">
        Datasets are generated once and reused, so test assertions stay stable across restarts.
      </p>`;

    el('mkSave').addEventListener('click', async () => {
      try {
        await api(`/mocks/${id}`, {
          method: 'PATCH',
          json: {
            strategy: el('mkStrategy').value,
            latencyMs: Number(el('mkLatency').value),
            errorRate: Number(el('mkError').value),
            rowCount: Number(el('mkRows').value),
            proxyTarget: el('mkProxy').value.trim() || null,
          },
        });
        toast('Mock updated.', 'ok');
        loadMocks();
      } catch (err) {
        fail(err);
      }
    });

    renderCollections(id);
  } catch (err) {
    fail(err);
  }
}

function renderCollections(mockId) {
  table(
    el('collectionTable'),
    [
      { label: 'Collection', cls: 'mono', render: (c) => esc(c.name) },
      { label: 'Key', cls: 'mono muted', render: (c) => esc(c.keys.join(', ') || '—') },
      { label: 'Fields', cls: 'right muted', render: (c) => c.fields.length },
      { label: 'Rows', cls: 'right', render: (c) => (c.generated ? c.rows : '<span class="muted">on demand</span>') },
      {
        label: '',
        cls: 'right nowrap',
        render: (c) => `
          <button class="sm" data-view="${esc(c.name)}">view</button>
          <button class="sm" data-ai="${esc(c.name)}">AI</button>
          <button class="sm" data-fix="${esc(c.name)}">fixture</button>
          <button class="sm danger" data-reset="${esc(c.name)}">reset</button>`,
      },
    ],
    state.collections,
    { empty: 'This specification declares no entity sets — operations are served from response schemas.' }
  );

  const node = el('collectionTable');

  node.querySelectorAll('[data-view]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        const rows = await api(`/mocks/${mockId}/datasets/${encodeURIComponent(b.dataset.view)}`);
        showJson(`${b.dataset.view} — ${rows.length} rows`, rows.slice(0, 25));
      } catch (err) {
        fail(err);
      }
    })
  );

  node.querySelectorAll('[data-ai]').forEach((b) =>
    b.addEventListener('click', async () => {
      const hint = prompt(`Context for ${b.dataset.ai} (optional):`, '');
      if (hint === null) return;
      b.disabled = true;
      b.textContent = '…';
      try {
        const out = await api(`/mocks/${mockId}/datasets/${encodeURIComponent(b.dataset.ai)}/ai`, { json: { hint } });
        toast(`${out.provider} generated ${out.rows} rows for ${out.collection}.`, 'ok');
        selectMock(mockId);
      } catch (err) {
        // Provider errors are worth reading, so give them longer on screen.
        if (err?.status !== 401) toast(err.message, 'err', 9000);
        b.disabled = false;
        b.textContent = 'AI';
      }
    })
  );

  node.querySelectorAll('[data-fix]').forEach((b) =>
    b.addEventListener('click', () => {
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = '.json,.csv';
      picker.addEventListener('change', async () => {
        const form = new FormData();
        form.append('file', picker.files[0]);
        try {
          const out = await api(`/mocks/${mockId}/datasets/${encodeURIComponent(b.dataset.fix)}`, {
            method: 'PUT',
            body: form,
          });
          toast(`Imported ${out.rows} rows into ${out.collection}.`, 'ok');
          selectMock(mockId);
        } catch (err) {
          fail(err);
        }
      });
      picker.click();
    })
  );

  node.querySelectorAll('[data-reset]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api(`/mocks/${mockId}/datasets/${encodeURIComponent(b.dataset.reset)}`, { method: 'DELETE' });
        toast(`${b.dataset.reset} will be regenerated on next request.`, 'ok');
        selectMock(mockId);
      } catch (err) {
        fail(err);
      }
    })
  );
}

function showJson(title, data) {
  const wrap = document.createElement('section');
  wrap.innerHTML = `<h2>${esc(title)}</h2><pre>${esc(JSON.stringify(data, null, 2))}</pre>
    <button class="sm" style="margin-top:.5rem">close</button>`;
  wrap.querySelector('button').addEventListener('click', () => wrap.remove());
  el('mockDetail').append(wrap);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function loadMockOptions() {
  try {
    const mocks = await api('/mocks');
    el('testMock').innerHTML = mocks.length
      ? mocks.map((m) => `<option value="${m.id}">/mock/${esc(m.slug)} — ${esc(m.title)}</option>`).join('')
      : '<option value="">(no mocks yet)</option>';
  } catch (err) {
    fail(err);
  }
}

el('btnRunTests').addEventListener('click', async () => {
  const mockId = Number(el('testMock').value);
  if (!mockId) {
    toast('Create a mock first.', 'err');
    return;
  }
  el('btnRunTests').disabled = true;
  el('testMsg').textContent = 'Running…';

  try {
    const summary = await api('/tests/run', {
      json: {
        mockId,
        target: el('testTarget').value.trim() || undefined,
        readOnly: el('testReadOnly').checked,
      },
    });
    state.testRunId = summary.runId;
    el('testMsg').textContent = `Run #${summary.runId}: ${summary.passed}/${summary.total} passed.`;
    toast(`${summary.passed}/${summary.total} passed.`, summary.failed ? 'err' : 'ok');
    renderTestResults(summary.results);
    loadTestRuns();
  } catch (err) {
    fail(err);
    el('testMsg').textContent = err.message;
  } finally {
    el('btnRunTests').disabled = false;
    el('testBar').style.width = '0';
  }
});

function renderTestResults(results) {
  table(
    el('testResultTable'),
    [
      { label: '', cls: 'nowrap', render: (r) => `<span class="tag ${r.passed ? 't-ok' : 't-err'}">${r.passed ? 'pass' : 'fail'}</span>` },
      { label: 'Operation', cls: 'mono', render: (r) => `${esc((r.method ?? '').toUpperCase())} ${esc(r.path)}` },
      { label: 'Status', cls: 'nowrap', render: (r) => statusTag(r.status) },
      { label: 'ms', cls: 'right muted', render: (r) => Math.round(r.durationMs ?? r.duration_ms ?? 0) },
      {
        label: 'Findings',
        render: (r) => {
          const errors = r.errors ?? JSON.parse(r.errors_json ?? '[]');
          return errors.length ? `<span class="muted">${esc(errors.join(' · '))}</span>` : '';
        },
      },
    ],
    results,
    { empty: 'No results yet.' }
  );
}

async function loadTestRuns() {
  try {
    const runs = await api('/tests/runs');
    table(
      el('testRunTable'),
      [
        { label: 'Run', render: (r) => `#${r.id}` },
        { label: 'When', cls: 'nowrap', render: (r) => fmtTime(r.started_at) },
        { label: 'Target', cls: 'mono muted', render: (r) => esc(r.target) },
        {
          label: 'Result',
          cls: 'nowrap',
          render: (r) => `<span class="tag ${r.failed ? 't-err' : 't-ok'}">${r.passed}/${r.total}</span>`,
        },
      ],
      runs,
      {
        empty: 'No test runs yet.',
        rowClass: (r) => (r.id === state.testRunId ? 'selected' : ''),
        onRow: async (r) => {
          state.testRunId = r.id;
          const data = await api(`/tests/runs/${r.id}`);
          renderTestResults(data.results);
          loadTestRuns();
        },
      }
    );
  } catch (err) {
    fail(err);
  }
}

// ---------------------------------------------------------------------------
// Network inspector
// ---------------------------------------------------------------------------

async function loadTraffic() {
  try {
    state.traffic = await api('/traffic?limit=300');
    renderTraffic();
  } catch (err) {
    fail(err);
  }
}

function renderTraffic() {
  const needle = el('netFilter').value.trim().toLowerCase();
  const rows = needle
    ? state.traffic.filter((t) =>
        `${t.method} ${t.path} ${t.status} ${t.mock_slug ?? ''} ${t.matched_op ?? ''}`.toLowerCase().includes(needle)
      )
    : state.traffic;

  table(
    el('netTable'),
    [
      { label: 'Time', cls: 'nowrap muted', render: (t) => fmtClock(t.ts) },
      { label: 'Method', cls: 'nowrap', render: (t) => `<b>${esc(t.method)}</b>` },
      { label: 'Path', cls: 'mono', render: (t) => esc(t.path) },
      { label: 'Status', cls: 'nowrap', render: (t) => statusTag(t.status) },
      { label: 'Size', cls: 'right muted nowrap', render: (t) => fmtBytes(t.res_bytes) },
      { label: 'ms', cls: 'right muted', render: (t) => Math.round(t.duration_ms) },
    ],
    rows,
    {
      empty: 'No calls captured yet. Point a client at /mock/<slug>.',
      rowClass: (t) => (t.id === state.selectedTraffic ? 'selected' : ''),
      onRow: (t) => showTrafficDetail(t),
    }
  );
}

function showTrafficDetail(entry) {
  state.selectedTraffic = entry.id;
  renderTraffic();

  const reqHeaders = safeParse(entry.req_headers);
  const resHeaders = safeParse(entry.res_headers);

  el('netDetail').innerHTML = `
    <section>
      <h2>${esc(entry.method)} ${esc(entry.path)}</h2>
      <div class="row tight" style="margin-bottom:.7rem">
        ${statusTag(entry.status)}
        <span class="tag t-info">${esc(entry.outcome)}</span>
        ${entry.matched_op ? `<span class="tag t-info">${esc(entry.matched_op)}</span>` : ''}
        <span class="muted">${Math.round(entry.duration_ms)} ms · ${fmtBytes(entry.res_bytes)} · ${esc(entry.client_ip ?? '')}</span>
      </div>
      ${entry.query ? `<p class="mono muted">?${esc(entry.query)}</p>` : ''}
      ${entry.note ? `<p class="muted">${esc(entry.note)}</p>` : ''}

      <h2>Request headers</h2>
      <pre>${esc(formatHeaders(reqHeaders))}</pre>

      ${entry.req_body ? `<h2>Request payload</h2><pre>${esc(pretty(entry.req_body, reqHeaders))}</pre>` : ''}

      <h2>Response headers</h2>
      <pre>${esc(formatHeaders(resHeaders))}</pre>

      <h2>Response payload</h2>
      <pre>${esc(pretty(entry.res_body, resHeaders))}</pre>
    </section>`;
}

function formatHeaders(headers) {
  const entries = Object.entries(headers ?? {});
  if (!entries.length) return '(none)';
  return entries.map(([k, v]) => `${k}: ${v}`).join('\n');
}

function safeParse(text) {
  try {
    return JSON.parse(text ?? '{}');
  } catch {
    return {};
  }
}

el('netFilter').addEventListener('input', renderTraffic);
el('btnNetReload').addEventListener('click', loadTraffic);
el('btnNetClear').addEventListener('click', async () => {
  if (!confirm('Delete every logged call?')) return;
  try {
    await api('/traffic', { method: 'DELETE' });
    state.traffic = [];
    state.selectedTraffic = null;
    el('netDetail').innerHTML = '<p class="empty">Select a request to inspect headers, payloads and timing.</p>';
    renderTraffic();
  } catch (err) {
    fail(err);
  }
});

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

async function loadUpdate(manual = false) {
  try {
    const u = manual ? await api('/update/check', { method: 'POST' }) : await api('/update');
    renderUpdate(u);
    if (!manual) return;
    if (u.error) toast(`Update check failed: ${u.error}`, 'err');
    else if (u.available) toast(`Version ${u.latest} is available.`, 'info');
    else toast(`You are on the latest version (${u.current}).`, 'ok');
  } catch (err) {
    if (manual) fail(err);
  }
}

function renderUpdate(u) {
  // The page outlives a self-update: the WebSocket reconnects to the new build.
  if (state.version && state.version !== u.current) toast(`Updated to version ${u.current}.`, 'ok', 9000);
  state.version = u.current;
  el('appVersion').textContent = `v${u.current}`;

  el('updateBanner').hidden = !u.available;
  if (!u.available) return;
  el('updLatest').textContent = u.latest;
  el('updCurrent').textContent = u.current;
  if (/^https:\/\//.test(u.url)) el('updNotes').href = u.url;
  el('btnUpdate').hidden = !u.canApply || u.applying;
  el('updHint').textContent = u.applying
    ? 'Installing: the sandbox restarts by itself and this page reconnects when it is back.'
    : !u.canApply
      ? 'Update by running the installer from the new release.'
      : u.auto
        ? 'It installs itself the next time the sandbox is idle, or right now:'
        : '';
}

el('btnUpdate').addEventListener('click', async () => {
  const ok = confirm(
    'Install the update now?\n\nThe sandbox stops while it installs, so the mock endpoints ' +
      'are unavailable for a minute or two. Your data and settings are kept.'
  );
  if (!ok) return;
  try {
    const r = await api('/update/apply', { method: 'POST' });
    toast(r.message, 'info', 9000);
    loadUpdate();
  } catch (err) {
    fail(err);
  }
});

el('btnCheckUpdate').addEventListener('click', () => loadUpdate(true));

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

/** Browsers cannot set headers on a WebSocket, so the key rides in a subprotocol (base64url keeps it header-safe). */
function wsProtocols() {
  const key = adminKeyInput.value;
  if (!key) return ['sandbox'];
  const bytes = new TextEncoder().encode(key);
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return ['sandbox', `key.${b64}`];
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`, wsProtocols());
  state.ws = ws;

  ws.addEventListener('open', () => {
    el('wsDot').classList.add('live');
    el('wsText').textContent = 'live';
    loadUpdate();
  });

  ws.addEventListener('close', () => {
    el('wsDot').classList.remove('live');
    el('wsText').textContent = 'offline';
    setTimeout(connect, 3000);
  });

  ws.addEventListener('message', (event) => {
    const { channel, payload } = JSON.parse(event.data);

    if (channel === 'traffic') {
      state.traffic.unshift(payload);
      state.traffic = state.traffic.slice(0, 300);
      if (el('netFollow').checked && el('tab-network').classList.contains('active')) renderTraffic();
    }

    if (channel === 'sync') {
      const pct = payload.total ? Math.round((payload.current / payload.total) * 100) : 0;
      el('syncBar').style.width = `${pct}%`;
      el('syncMsg').textContent = `${payload.phase}: ${payload.message}`;
    }

    if (channel === 'sync-done') {
      el('btnSync').disabled = false;
      el('syncBar').style.width = '100%';
      el('syncMsg').textContent =
        `Run #${payload.runId}: ${payload.packagesSeen} packages, ${payload.artifactsSeen} artifacts, ` +
        `+${payload.added} / ~${payload.changed} / -${payload.removed}.`;
      toast(`Sync finished — report in ${payload.reportPath}`, 'ok', 9000);
      if (payload.specAuthBlocked) {
        toast('Specification downloads were skipped: api.sap.com asked for a session.', 'err', 12000);
      }
      loadStatus();
      loadRuns();
    }

    if (channel === 'sync-error') {
      el('btnSync').disabled = false;
      el('syncMsg').textContent = `Failed: ${payload.message}`;
      toast(payload.message, 'err', 9000);
    }

    if (channel === 'update') renderUpdate(payload);

    if (channel === 'test') {
      const pct = payload.total ? Math.round((payload.done / payload.total) * 100) : 0;
      el('testBar').style.width = `${pct}%`;
      el('testMsg').textContent = `${payload.done}/${payload.total} — ${payload.label}`;
    }
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function refreshAll() {
  loadStatus();
  loadArtifacts();
  loadUpdate();
}

connect();
refreshAll();
