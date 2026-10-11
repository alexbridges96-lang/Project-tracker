/* Stagegate UI: storage adapters (claude.ai db, self-hosted server, browser), views and actions. */
(function () {
  'use strict';
  const PT = window.PT;
  const $ = (s, el) => (el || document).querySelector(s);

  // ---------- state ----------
  const S = {
    data: Object.fromEntries(PT.COLLECTIONS.map((c) => [c, []])),
    view: 'today', projectId: null, tab: 'overview',
    filter: { status: 'open', q: '', heat: null, level: 'all' },
    report: null, // {kind, title, md, saved}
    backend: null, ready: false, readOnly: false,
    drawer: null,
  };
  const pref = {
    get(k, d) { try { const v = localStorage.getItem('stagegate:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('stagegate:' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  const settings = () => Object.assign({ pmName: '', staleDays: 14, proximityDays: 14, freezes: '' }, S.data.settings.find((s) => s.id === 'main') || {});
  const project = (id) => S.data.projects.find((p) => p.id === (id || S.projectId));
  const T = () => PT.today();

  // ---------- helpers ----------
  const h = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ragLabel = { green: 'On track', amber: 'At risk', red: 'Exception' };
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 2600);
  }
  let renderQueued = false;
  function render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderNow(); });
  }

  // ---------- storage backends ----------
  function clean(doc) { return JSON.parse(JSON.stringify(doc)); }

  function cloudBackend(db) {
    return {
      mode: 'cloud',
      label: 'Saved to your claude.ai account',
      start() {
        return new Promise((resolve) => {
          const pending = new Set(PT.COLLECTIONS);
          for (const col of PT.COLLECTIONS) {
            db.collection(col).limit(1000).onSnapshot((snap) => {
              S.data[col] = snap.docs.map((d) => Object.assign({}, d.data(), { id: d.id }));
              if (pending.delete(col) && pending.size === 0) resolve();
              render();
            }, (err) => {
              if (err && err.code === 'revoked') S.readOnly = true;
              pending.delete(col); if (pending.size === 0) resolve();
              render();
            });
          }
          setTimeout(resolve, 8000);
        });
      },
      save: (col, doc) => db.collection(col).doc(doc.id).set(clean(doc)),
      remove: (col, id) => db.collection(col).doc(id).delete(),
    };
  }

  function serverBackend() {
    const req = async (method, url, body) => {
      const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      if (!r.ok) throw new Error((await r.text()) || r.statusText);
      return r.status === 204 ? null : r.json();
    };
    return {
      mode: 'server',
      label: 'Saved to your server (SQLite)',
      async start() {
        const all = await req('GET', 'api/data');
        for (const col of PT.COLLECTIONS) S.data[col] = all[col] || [];
      },
      save: (col, doc) => req('PUT', `api/${col}/${encodeURIComponent(doc.id)}`, clean(doc)),
      remove: (col, id) => req('DELETE', `api/${col}/${encodeURIComponent(id)}`),
    };
  }

  function localBackend(note) {
    const KEY = 'stagegate:data';
    const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(S.data)); } catch (e) { toast('This browser blocked local storage. Changes will be lost on reload.'); } };
    return {
      mode: 'local',
      label: note || 'Saved in this browser only',
      async start() {
        try {
          const raw = localStorage.getItem(KEY);
          if (raw) { const d = JSON.parse(raw); for (const col of PT.COLLECTIONS) S.data[col] = d[col] || []; }
        } catch (e) { /* start empty */ }
      },
      save: async () => persist(),
      remove: async () => persist(),
    };
  }

  async function pickBackend() {
    if (window.claude && typeof window.claude.use === 'function') {
      const db = await window.claude.use('db');
      if (db) return cloudBackend(db);
      return localBackend('Saved in this browser only. Sign in to claude.ai to save to your account.');
    }
    try {
      const r = await fetch('api/health', { cache: 'no-store' });
      if (r.ok && (await r.json()).ok) return serverBackend();
    } catch (e) { /* not self-hosted */ }
    return localBackend();
  }

  // ---------- writes ----------
  async function save(col, doc, quiet) {
    doc.updatedAt = T();
    const list = S.data[col];
    const i = list.findIndex((x) => x.id === doc.id);
    if (i >= 0) list[i] = doc; else list.push(doc);
    render();
    try { await S.backend.save(col, doc); if (!quiet) toast('Saved'); }
    catch (e) { toast(e && e.code === 'invalid_argument' ? 'You have read-only access to this tracker.' : 'Could not save: ' + (e.message || e.code || 'unknown error')); }
  }
  async function remove(col, id) {
    S.data[col] = S.data[col].filter((x) => x.id !== id);
    render();
    try { await S.backend.remove(col, id); toast('Deleted'); }
    catch (e) { toast('Could not delete: ' + (e.message || e.code)); }
  }
  function newDoc(col, projectId, extra) {
    const schema = PT.SCHEMAS[col];
    return Object.assign(schema.defaults(T()), {
      id: PT.uid(col[0]), projectId, ref: PT.nextRef(col, S.data[col], projectId), createdAt: T(),
    }, extra || {});
  }

  // ---------- navigation ----------
  function go(view, projectId, tab) {
    S.view = view;
    if (projectId) S.projectId = projectId;
    if (tab) S.tab = tab;
    S.filter.heat = null;
    if (!(S.view === 'project' && S.tab === 'reports')) S.report = null;
    pref.set('nav', { view: S.view, projectId: S.projectId, tab: S.tab });
    render();
    $('#view').scrollTop = 0; window.scrollTo(0, 0);
  }

  // ---------- rail ----------
  function renderRail() {
    const att = PT.attention(S.data, settings());
    const urgent = att.filter((a) => a.level === 'red').length;
    const projects = S.data.projects.slice().sort((a, b) => (a.status === 'Closed') - (b.status === 'Closed') || a.name.localeCompare(b.name));
    const mark = '<svg class="brand-mark" viewBox="0 0 26 26" aria-hidden="true"><rect x="1" y="9" width="7" height="8" rx="1.5" fill="var(--muted)"/><rect x="18" y="9" width="7" height="8" rx="1.5" fill="var(--line)"/><rect x="9.5" y="9" width="7" height="8" rx="1.5" fill="var(--accent)"/><path d="M8.6 13l.9-.9.9.9-.9.9z" fill="var(--green)"/></svg>';
    $('#rail').innerHTML = `
      <div class="brand">${mark}<span class="brand-name">Stagegate</span></div>
      <nav class="nav">
        <button class="nav-item" data-act="go" data-view="today" aria-current="${S.view === 'today'}"><span class="label">Today</span>${urgent ? `<span class="count" title="Items needing action">${urgent}</span>` : ''}</button>
        <div class="eyebrow nav-group-label" style="padding:12px 8px 4px">Projects</div>
        ${projects.map((p) => {
          const tol = PT.toleranceStatus(p, S.data);
          const st = p.stages[p.currentStage];
          return `<button class="nav-item" data-act="go" data-view="project" data-id="${h(p.id)}" aria-current="${S.view === 'project' && S.projectId === p.id}">
            <span class="dot ${p.status === 'Closed' ? '' : tol.status}"></span>
            <span class="label">${h(p.name)}<span class="sub">${p.status === 'Closed' ? 'Closed' : h(st ? st.name : '')}</span></span></button>`;
        }).join('')}
        <button class="nav-item" data-act="new-project"><span class="label" style="color:var(--accent)">+ New project</span></button>
      </nav>
      <div class="rail-foot">
        <button class="nav-item" data-act="go" data-view="settings" aria-current="${S.view === 'settings'}"><span class="label">Settings &amp; backup</span></button>
        <div class="storage"><strong>${h(S.backend ? S.backend.label : 'Connecting…')}</strong></div>
      </div>`;
  }

  // ---------- main render ----------
  function renderNow() {
    renderRail();
    renderHint();
    const v = $('#view');
    if (!S.ready) return;
    // Don't replace a form field while someone is typing in it; redraw on blur instead.
    const ae = document.activeElement;
    if (ae && v.contains(ae) && ae.dataset && ae.dataset.bind && ae.dataset.bind !== 'search') { S.viewStale = true; return; }
    S.viewStale = false;
    if (S.view === 'settings') v.innerHTML = viewSettings();
    else if (S.view === 'project' && project()) v.innerHTML = viewProject();
    else v.innerHTML = viewToday();
  }

  // ---------- Today ----------
  function attentionList(items, limit) {
    if (!items.length) return '<p class="muted">Nothing needs your attention. Registers are up to date.</p>';
    const shown = limit ? items.slice(0, limit) : items;
    return `<ul class="att">${shown.map((a) => {
      const p = project(a.projectId);
      return `<li class="${a.level}"><span class="stripe"></span><span class="kind">${h(a.kind)}</span><span class="txt">${h(a.text)}${S.view === 'today' && p && a.col !== 'projects' ? ` <span class="muted">· ${h(p.name)}</span>` : ''}</span>
        <button class="btn small" data-act="open-att" data-col="${a.col}" data-id="${h(a.id)}" data-pid="${h(a.projectId)}">Open</button></li>`;
    }).join('')}</ul>${limit && items.length > limit ? `<p class="muted">${items.length - limit} more</p>` : ''}`;
  }

  function viewToday() {
    const st = settings();
    const all = PT.attention(S.data, st);
    const lvl = S.filter.level;
    const items = lvl === 'all' ? all : all.filter((a) => a.level === lvl);
    const active = S.data.projects.filter((p) => p.status !== 'Closed');
    const now = T();
    const d = PT.parseDate(now);
    const greeting = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (!S.data.projects.length) {
      return `<div class="page-head"><div><div class="eyebrow">${h(greeting)}</div><h1>Welcome to Stagegate</h1></div></div>
      ${banner()}
      <div class="empty-state">
        <h2>No projects yet</h2>
        <p style="max-width:56ch">Start a project from a PRINCE2 template. You get stage gates, tolerances, standard risks and ITIL transition checks. You can also load an example project to try it out first.</p>
        <div class="toolbar" style="justify-content:center"><button class="btn primary" data-act="new-project">Create a project</button><button class="btn" data-act="load-sample">Load example project</button></div>
      </div>`;
    }
    const upcoming = S.data.logs.filter((l) => l.kind === 'Action' && !l.done && l.due && l.due <= PT.addDays(now, 7) && project(l.projectId) && project(l.projectId).status !== 'Closed')
      .sort((a, b) => (a.due < b.due ? -1 : 1));
    const counts = { red: all.filter((a) => a.level === 'red').length, amber: all.filter((a) => a.level === 'amber').length, info: all.filter((a) => a.level === 'info').length };
    return `
      <div class="page-head"><div><div class="eyebrow">${h(greeting)}</div><h1>Today</h1></div>
        <div class="toolbar"><button class="btn" data-act="new-project">+ New project</button></div></div>
      ${banner()}
      <section class="panel">
        <div class="panel-head"><h2>Needs your attention</h2>
          <div class="seg" role="group" aria-label="Filter by urgency">
            ${[['all', 'All ' + all.length], ['red', 'Act now ' + counts.red], ['amber', 'Soon ' + counts.amber], ['info', 'Tidy up ' + counts.info]].map(([k, l]) => `<button data-act="level" data-level="${k}" aria-pressed="${lvl === k}">${l}</button>`).join('')}
          </div></div>
        ${attentionList(items)}
      </section>
      <section class="cards">${active.map(projectCard).join('')}</section>
      <div class="grid-2">
        <section class="panel"><div class="panel-head"><h2>Actions due in the next 7 days</h2></div>
          ${upcoming.length ? `<div class="table-wrap compact"><table><tbody>${upcoming.map((l) => `<tr class="clickable" data-act="edit" data-col="logs" data-id="${h(l.id)}">
            <td style="width:28px"><input type="checkbox" data-act="toggle-done" data-id="${h(l.id)}" aria-label="Mark done"></td>
            <td class="t">${h(l.title)}<div class="muted" style="font-size:.78rem">${h(project(l.projectId).name)}</div></td><td class="nowrap">${h(l.owner || '')}</td><td class="nowrap mono ${l.due < now ? 'overdue' : ''}" style="${l.due < now ? 'color:var(--red)' : ''}">${h(PT.fmtDate(l.due))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No actions due this week.</p>'}
        </section>
        <section class="panel"><div class="panel-head"><h2>Change calendar</h2><span class="muted">next 60 days</span></div>${changeCalendar(null)}</section>
      </div>`;
  }

  function banner() {
    if (S.readOnly) return '<div class="banner red">Your access to this tracker changed. Reload the page to continue.</div>';
    if (S.backend && S.backend.mode === 'local' && S.backend.label.indexOf('Sign in') >= 0) return `<div class="banner">${h(S.backend.label)}</div>`;
    return '';
  }

  function projectCard(p) {
    const tol = PT.toleranceStatus(p, S.data);
    const st = p.stages[p.currentStage] || {};
    const done = (st.checklist || []).filter((c) => c.done).length;
    const total = (st.checklist || []).length;
    const openR = S.data.risks.filter((r) => r.projectId === p.id && r.status !== 'Closed').length;
    const openI = S.data.issues.filter((r) => r.projectId === p.id && PT.SCHEMAS.issues.isOpen(r)).length;
    return `<button class="pcard" data-act="go" data-view="project" data-id="${h(p.id)}">
      <div class="row"><h3>${h(p.name)}</h3><span class="pill ${tol.status}">${ragLabel[tol.status]}</span></div>
      ${stageTrack(p, true)}
      <div class="row muted" style="font-size:.8rem"><span>${h(st.name || '')}: gate ${done}/${total}</span><span class="mono">${openR} risks · ${openI} issues</span></div>
    </button>`;
  }

  function changeCalendar(projectId) {
    const now = T();
    const end = PT.addDays(now, 60);
    const freezes = PT.parseFreezes(settings().freezes).filter((f) => f.to >= now && f.from <= end);
    const ch = S.data.changes.filter((c) => (!projectId || c.projectId === projectId) && c.scheduledStart && c.scheduledStart >= PT.addDays(now, -1) && c.scheduledStart <= end && PT.SCHEMAS.changes.isOpen(c));
    const rows = freezes.map((f) => ({ date: f.from, html: `<li class="freeze"><span class="mono">${h(PT.fmtDate(f.from))}</span><span><b>Freeze:</b> ${h(f.label)} to ${h(PT.fmtDate(f.to))}</span><span></span></li>` }))
      .concat(ch.map((c) => ({ date: c.scheduledStart, html: `<li><span class="mono">${h(PT.fmtDate(c.scheduledStart))}</span><span>${h(c.ref)} ${h(c.title)}${projectId ? '' : ` <span class="muted">· ${h((project(c.projectId) || {}).name || '')}</span>`}</span><button class="btn small" data-act="open-att" data-col="changes" data-id="${h(c.id)}" data-pid="${h(c.projectId)}">${h(c.status)}</button></li>` })))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    return rows.length ? `<ul class="cal">${rows.map((r) => r.html).join('')}</ul>` : '<p class="muted">No changes or freezes scheduled. Add freeze windows in Settings.</p>';
  }

  // ---------- stage track ----------
  function stageTrack(p, mini) {
    const parts = [];
    p.stages.forEach((s, i) => {
      if (i > 0) {
        const cls = p.stages[i - 1].status === 'complete' ? 'passed' : (p.stages[i - 1].status === 'active' ? 'next' : '');
        parts.push(`<span class="track-gate ${cls}" title="Stage boundary"></span>`);
      }
      const done = s.checklist.filter((c) => c.done).length;
      const pct = s.checklist.length ? Math.round((done / s.checklist.length) * 100) : 0;
      const tag = mini ? 'div' : 'button';
      parts.push(`<${tag} class="track-stage ${s.status}" ${mini ? '' : `data-act="tab" data-tab="stages" data-stage="${i}"`}>
        <span class="nm">${h(s.name)}</span>
        ${mini ? '' : `<span class="dt">${s.plannedEnd ? 'ends ' + h(PT.fmtDate(s.actualEnd || s.plannedEnd)) : 'dates TBC'}</span>`}
        <span class="bar"><i style="width:${pct}%"></i></span></${tag}>`);
    });
    return `<div class="track ${mini ? 'mini' : ''}">${parts.join('')}</div>`;
  }

  // ---------- project ----------
  const TABS = [
    ['overview', 'Overview'], ['stages', 'Stages & gates'], ['risks', 'Risks'], ['issues', 'Issues'], ['changes', 'Changes'],
    ['quality', 'Quality'], ['logs', 'Daily log'], ['lessons', 'Lessons'], ['pid', 'PID & controls'], ['reports', 'Reports'],
  ];
  function tabCount(p, key) {
    const s = PT.SCHEMAS[key];
    if (!s) return '';
    const n = S.data[key].filter((x) => x.projectId === p.id && s.isOpen(x)).length;
    return n ? `<span class="n">${n}</span>` : '';
  }

  function viewProject() {
    const p = project();
    const tol = PT.toleranceStatus(p, S.data);
    let body = '';
    switch (S.tab) {
      case 'stages': body = viewStages(p); break;
      case 'pid': body = viewPid(p); break;
      case 'reports': body = viewReports(p); break;
      case 'risks': case 'issues': case 'changes': case 'quality': case 'logs': case 'lessons': body = viewRegister(p, S.tab); break;
      default: body = viewOverview(p, tol);
    }
    return `
      <div class="page-head"><div>
        <div class="eyebrow">${h(p.code || 'Project')}${p.example ? ' · example data' : ''}</div>
        <h1>${h(p.name)}</h1>
        <div class="meta"><span class="pill ${p.status === 'Closed' ? 'plain' : tol.status}">${p.status === 'Closed' ? 'Closed' : ragLabel[tol.status]}</span>
          <span>Executive: ${h(p.executive || 'TBC')}</span><span>·</span><span>Stage ${p.currentStage + 1} of ${p.stages.length}</span></div>
      </div></div>
      ${stageTrack(p)}
      <nav class="tabs" role="tablist">${TABS.map(([k, l]) => `<button class="tab" role="tab" data-act="tab" data-tab="${k}" aria-selected="${S.tab === k}">${l}${tabCount(p, k)}</button>`).join('')}</nav>
      ${body}`;
  }

  function viewOverview(p, tol) {
    const att = PT.attention(S.data, settings()).filter((a) => a.projectId === p.id);
    const risks = S.data.risks.filter((r) => r.projectId === p.id && r.status !== 'Closed');
    const issues = S.data.issues.filter((r) => r.projectId === p.id && PT.SCHEMAS.issues.isOpen(r));
    const actions = S.data.logs.filter((r) => r.projectId === p.id && r.kind === 'Action' && !r.done);
    const changes = S.data.changes.filter((r) => r.projectId === p.id && PT.SCHEMAS.changes.isOpen(r));
    const overdue = actions.filter((a) => a.due && a.due < T()).length;
    const vh = risks.filter((r) => PT.riskScore(r) >= 15).length;
    const kpi = (tab, label, v, s) => `<button class="kpi" data-act="tab" data-tab="${tab}"><div class="eyebrow">${label}</div><div class="v">${v}</div><div class="s">${s}</div></button>`;
    const hasBreach = tol.items.some((i) => i.status === 'red');
    return `
      ${hasBreach ? `<div class="banner red"><b>Tolerance exceeded.</b> PRINCE2 says escalate to the board now. <button class="btn small" data-act="report" data-kind="exception">Draft Exception Report</button></div>` : ''}
      <div class="kpis">
        ${kpi('risks', 'Open risks', risks.length, vh ? `${vh} very high` : 'none very high')}
        ${kpi('issues', 'Open issues', issues.length, `${issues.filter((i) => i.type === 'Request for change').length} requests for change`)}
        ${kpi('logs', 'Open actions', actions.length, overdue ? `${overdue} overdue` : 'none overdue')}
        ${kpi('changes', 'Changes in flight', changes.length, `${changes.filter((c) => c.status === 'Awaiting CAB').length} awaiting CAB`)}
      </div>
      <div class="grid-2">
        <section class="panel"><div class="panel-head"><h2>Tolerances</h2><button class="btn small" data-act="tab" data-tab="pid">Edit controls</button></div>
          ${tol.items.length ? tol.items.map((i) => `<div class="tol"><span class="dim">${h(i.dim)}</span><span class="txt">${h(i.text)}</span><span class="pill ${i.status}">${i.status}</span></div>`).join('') : '<p class="muted">Set the budget, dates and tolerances under PID &amp; controls to start tracking.</p>'}
        </section>
        <section class="panel"><div class="panel-head"><h2>Risk heat map</h2><button class="btn small" data-act="tab" data-tab="risks">Open register</button></div>${heatMap(p)}</section>
      </div>
      <section class="panel"><div class="panel-head"><h2>Needs attention on this project</h2></div>${attentionList(att)}</section>
      <section class="panel"><div class="panel-head"><h2>Change calendar</h2></div>${changeCalendar(p.id)}</section>`;
  }

  function heatMap(p) {
    const risks = S.data.risks.filter((r) => r.projectId === p.id && r.status !== 'Closed');
    let cells = '';
    for (let pr = 5; pr >= 1; pr--) {
      cells += `<span class="ax" title="${PT.PROB[pr].label}">P${pr}</span>`;
      for (let im = 1; im <= 5; im++) {
        const n = risks.filter((r) => Number(r.probability) === pr && Number(r.impact) === im).length;
        const sel = S.filter.heat && S.filter.heat[0] === pr && S.filter.heat[1] === im;
        cells += `<button class="cell ${PT.riskBand(pr * im).key} ${sel ? 'sel' : ''}" data-act="heat" data-p="${pr}" data-i="${im}" title="Probability ${PT.PROB[pr].label}, impact ${PT.IMPACT[im]}: ${n} risk(s)">${n || ''}</button>`;
      }
    }
    cells += '<span></span>' + [1, 2, 3, 4, 5].map((i) => `<span class="ax">I${i}</span>`).join('');
    return `<div class="heat" role="group" aria-label="Probability by impact">${cells}</div><div class="heat-cap"><span>Impact →</span><span>Select a cell to filter the register</span></div>`;
  }

  // ---------- stages ----------
  function viewStages(p) {
    const openIdx = S.openStage != null ? S.openStage : p.currentStage;
    return `<div class="toolbar"><p class="muted" style="flex:1;min-width:220px">Each stage ends at a gate. You can only move to the next stage once every gate item is done. Closing a stage records the date, logs a lessons review and offers the End Stage Report.</p>
      <button class="btn" data-act="add-stage">+ Add stage</button></div>
      ${p.stages.map((s, i) => {
        const done = s.checklist.filter((c) => c.done).length;
        const open = s.checklist.length - done;
        const isActive = s.status === 'active';
        const next = p.stages[i + 1];
        return `<details class="stage-card ${s.status}" ${i === openIdx ? 'open' : ''} data-stage-card="${i}">
          <summary><div><div class="eyebrow">${s.status === 'active' ? 'Current stage' : s.status === 'complete' ? 'Complete' : 'Planned'} · ${i + 1}</div><h2>${h(s.name)}</h2></div>
            <span class="mono muted">${done}/${s.checklist.length}</span></summary>
          <div class="stage-body">
            <div class="stage-fields">
              ${stageField(i, 'name', 'Stage name', 'text', s.name)}
              ${stageField(i, 'plannedStart', 'Planned start', 'date', s.plannedStart)}
              ${stageField(i, 'plannedEnd', 'Planned end', 'date', s.plannedEnd)}
              ${stageField(i, 'forecastEnd', 'Forecast end', 'date', s.forecastEnd)}
              ${stageField(i, 'budget', 'Stage budget (£)', 'number', s.budget)}
              ${stageField(i, 'forecastCost', 'Forecast cost (£)', 'number', s.forecastCost)}
            </div>
            <div><div class="eyebrow" style="margin-bottom:6px">Gate checklist</div>
              <ul class="checklist">${s.checklist.map((c, j) => `<li class="${c.done ? 'done' : ''}">
                <input type="checkbox" id="g-${i}-${j}" data-act="gate" data-stage="${i}" data-item="${j}" ${c.done ? 'checked' : ''} ${s.status === 'complete' ? 'disabled' : ''}>
                <label for="g-${i}-${j}">${h(c.t)}${c.done && c.doneAt ? ` <span class="muted mono" style="font-size:.72rem">${h(PT.fmtDate(c.doneAt))}</span>` : ''}</label>
                ${s.status === 'complete' ? '' : `<button class="btn small ghost rm" data-act="gate-rm" data-stage="${i}" data-item="${j}" aria-label="Remove item">✕</button>`}</li>`).join('')}</ul>
              ${s.status === 'complete' ? '' : `<form class="toolbar" data-form="gate-add" data-stage="${i}" style="margin-top:8px"><input class="search" id="gate-add-${i}" name="t" placeholder="Add a gate item" style="flex:1;width:auto"><button class="btn small" type="submit">Add</button></form>`}
            </div>
            ${isActive ? `<div class="gatebar">
              <span class="why">${open ? `${open} gate item${open > 1 ? 's' : ''} still open. Tick them off to unlock the stage boundary.` : next ? `Gate complete. Record the board's authorisation for ${h(next.name)}.` : 'Gate complete. Close the project.'}</span>
              <button class="btn" data-act="report" data-kind="endstage">Draft End Stage Report</button>
              <button class="btn primary" data-act="advance" ${open ? 'disabled' : ''}>${next ? 'Close stage & start ' + h(next.name) : 'Close project'}</button>
            </div>` : ''}
            ${s.status === 'planned' && i > p.currentStage ? `<div><button class="btn small danger" data-act="stage-rm" data-stage="${i}" data-confirm="Remove this stage?">Remove stage</button></div>` : ''}
          </div></details>`;
      }).join('')}`;
  }
  function stageField(i, k, label, type, v) {
    return `<label class="field"><span>${label}</span><input type="${type}" id="st-${i}-${k}" data-bind="stage" data-stage="${i}" data-k="${k}" value="${h(v)}"></label>`;
  }

  // ---------- registers ----------
  const COLUMNS = {
    risks: [['ref', 'Ref'], ['title', 'Risk', 't'], ['score', 'P×I'], ['proximity', 'Proximity', 'date'], ['response', 'Response'], ['owner', 'Owner'], ['reviewDate', 'Review', 'date'], ['status', 'Status']],
    issues: [['ref', 'Ref'], ['title', 'Issue', 't'], ['type', 'Type'], ['priority', 'Priority'], ['severity', 'Authority'], ['status', 'Status'], ['dateRaised', 'Raised', 'date'], ['promote', '']],
    changes: [['ref', 'Ref'], ['title', 'Change', 't'], ['type', 'Type'], ['risk', 'Risk'], ['status', 'Status'], ['scheduledStart', 'Scheduled', 'date'], ['authority', 'Authority']],
    quality: [['ref', 'Ref'], ['title', 'Product', 't'], ['method', 'Method'], ['plannedReview', 'Planned review', 'date'], ['actualReview', 'Reviewed', 'date'], ['result', 'Result'], ['approver', 'Approver']],
    logs: [['done', ''], ['kind', 'Kind'], ['title', 'Entry', 't'], ['owner', 'Owner'], ['due', 'Due', 'date'], ['date', 'Logged', 'date']],
    lessons: [['ref', 'Ref'], ['title', 'Lesson', 't'], ['category', 'Category'], ['sentiment', 'Effect'], ['type', 'Applies to'], ['status', 'Status'], ['dateLogged', 'Logged', 'date']],
  };
  const QUICK_HINT = { risks: 'r: text p4 i3 @owner due:date', issues: 'i: text rfc !high', changes: 'c: text emergency due:date', quality: 'q: product @producer due:date', logs: 'a: action @owner due:fri  ·  d: decision  ·  n: note', lessons: 'l: lesson text +' };

  function cell(col, r, key, kind) {
    const v = r[key];
    if (key === 'score') { const s = PT.riskScore(r); return `<td class="nowrap"><span class="score ${PT.riskBand(s).key}">${s}</span> <span class="muted mono" style="font-size:.74rem">${r.probability}×${r.impact}</span></td>`; }
    if (key === 'done') return `<td style="width:28px">${r.kind === 'Action' ? `<input type="checkbox" data-act="toggle-done" data-id="${h(r.id)}" ${r.done ? 'checked' : ''} aria-label="Mark done">` : ''}</td>`;
    if (key === 'promote') {
      if (r.changeId) { const c = S.data.changes.find((x) => x.id === r.changeId); return `<td class="nowrap"><span class="muted">→ ${h(c ? c.ref : 'change')}</span></td>`; }
      return `<td class="nowrap">${['Request for change', 'Off-specification'].includes(r.type) && PT.SCHEMAS.issues.isOpen(r) ? `<button class="btn small" data-act="promote" data-id="${h(r.id)}">Raise RFC</button>` : ''}</td>`;
    }
    if (key === 'status' || key === 'result' || key === 'priority') {
      const cls = /Closed|Pass$|Implemented|Reviewed|Approved|Actioned|Shared/.test(v) ? 'green' : /Fail|Rejected|Backed out|High/.test(v) ? 'red' : /Awaiting|Pending|Under|Medium/.test(v) ? 'amber' : 'plain';
      return `<td class="nowrap"><span class="pill ${cls}">${h(v || '')}</span></td>`;
    }
    if (kind === 'date') {
      const late = v && v < T() && ((key === 'due' && !r.done) || (key === 'reviewDate' && r.status !== 'Closed'));
      return `<td class="nowrap mono" style="${late ? 'color:var(--red)' : ''}">${h(PT.fmtDate(v))}</td>`;
    }
    if (kind === 't') return `<td class="t">${h(v)}${col === 'risks' && r.category === 'Opportunity' ? ' <span class="pill green">Opportunity</span>' : ''}</td>`;
    return `<td class="nowrap">${h(v == null ? '' : v)}</td>`;
  }

  function viewRegister(p, col) {
    const schema = PT.SCHEMAS[col];
    const f = S.filter;
    let rows = S.data[col].filter((r) => r.projectId === p.id);
    if (f.status === 'open') rows = rows.filter(schema.isOpen);
    else if (f.status === 'closed') rows = rows.filter((r) => !schema.isOpen(r));
    if (f.q) { const q = f.q.toLowerCase(); rows = rows.filter((r) => Object.values(r).some((v) => typeof v === 'string' && v.toLowerCase().includes(q))); }
    if (col === 'risks' && f.heat) rows = rows.filter((r) => Number(r.probability) === f.heat[0] && Number(r.impact) === f.heat[1]);
    if (col === 'risks') rows.sort((a, b) => PT.riskScore(b) - PT.riskScore(a));
    else if (col === 'logs') rows.sort((a, b) => (a.done - b.done) || String(a.due || a.date || '9').localeCompare(String(b.due || b.date || '9')));
    else rows.sort((a, b) => String(b.ref || '').localeCompare(String(a.ref || '')));
    const cols = COLUMNS[col];
    const top = col === 'risks' ? `<div class="grid-2"><section class="panel"><div class="panel-head"><h2>Heat map</h2>${f.heat ? '<button class="btn small" data-act="heat-clear">Clear filter</button>' : ''}</div>${heatMap(p)}</section>
        <section class="panel"><h2>How risks are scored</h2><p class="muted">Score = probability × impact on a 5×5 scale. 15 and above is very high, 10–14 high, 5–9 medium, below 5 low. Any open threat at or above the project's risk tolerance (currently ${h(p.riskTolScore || '—')}) counts as a tolerance breach and goes to the board.</p>
        <p class="muted">Proximity dates within ${h(settings().proximityDays)} days, overdue reviews and risks with no update for ${h(settings().staleDays)} days appear on Today.</p></section></div>`
      : col === 'changes' ? `<section class="panel"><div class="panel-head"><h2>Change calendar</h2><span class="muted">ITIL Change Enablement</span></div>${changeCalendar(p.id)}</section>` : '';
    return `${top}
      <div class="toolbar">
        <button class="btn primary" data-act="new" data-col="${col}">+ New ${schema.label.toLowerCase()}</button>
        <div class="seg" role="group" aria-label="Show">${[['open', 'Open'], ['closed', 'Closed'], ['all', 'All']].map(([k, l]) => `<button data-act="status-filter" data-status="${k}" aria-pressed="${f.status === k}">${l}</button>`).join('')}</div>
        <input class="search" id="reg-search" type="search" data-bind="search" placeholder="Search ${h(schema.plural.toLowerCase())}" value="${h(f.q)}">
        <span class="spacer"></span>
        <span class="muted" style="font-size:.78rem">Quick add: <code class="mono">${h(QUICK_HINT[col])}</code></span>
      </div>
      ${rows.length ? `<div class="table-wrap"><table><thead><tr>${cols.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>
        ${rows.map((r) => `<tr class="clickable ${schema.isOpen(r) ? '' : 'closed'}" data-act="edit" data-col="${col}" data-id="${h(r.id)}">${cols.map(([k, , kind]) => cell(col, r, k, kind)).join('')}</tr>`).join('')}
      </tbody></table></div>` : `<div class="empty-state"><p>No ${f.status === 'all' ? '' : f.status + ' '}entries in the ${h(schema.plural)}${f.q || f.heat ? ' match this filter' : ''}.</p><button class="btn" data-act="new" data-col="${col}">+ New ${schema.label.toLowerCase()}</button></div>`}`;
  }

  // ---------- PID ----------
  function viewPid(p) {
    const fieldsHtml = (fields, bind) => fields.map((f) => fieldInput(f, p[f.k], bind, 'pf-' + f.k, f.type === 'textarea' ? 'wide' : '')).join('');
    const sections = {};
    PT.PROJECT_FIELDS.pid.forEach((f) => { (sections[f.section] = sections[f.section] || []).push(f); });
    return `<div class="toolbar"><p class="muted" style="flex:1;min-width:220px">Changes save as you go. The PID document, reports and tolerance checks all read from these fields.</p>
        <button class="btn" data-act="report" data-kind="pid">Generate PID document</button></div>
      <section class="panel"><h2>Project board and roles</h2><div class="form-grid">${fieldsHtml(PT.PROJECT_FIELDS.board, 'project')}</div></section>
      <section class="panel"><h2>Project controls and tolerances</h2><p class="muted">The board sets these. Forecasts beyond them raise an exception on Today and in the Highlight Report.</p><div class="form-grid">${fieldsHtml(PT.PROJECT_FIELDS.controls, 'project')}</div></section>
      ${Object.entries(sections).map(([name, fs]) => `<section class="panel"><h2>${h(name)}</h2><div class="form-grid">${fieldsHtml(fs, 'project')}</div></section>`).join('')}
      <section class="panel"><h2>Delete project</h2><p class="muted">Removes the project and every register entry and report linked to it.</p><div><button class="btn danger" data-act="delete-project" data-confirm="Delete project and all its records?">Delete project</button></div></section>`;
  }

  function fieldInput(f, v, bind, id, cls) {
    const common = `id="${id}" data-bind="${bind}" data-k="${f.k}"`;
    let input;
    if (f.type === 'textarea') input = `<textarea ${common}>${h(v)}</textarea>`;
    else if (f.type === 'select') input = `<select ${common}>${(v && !f.options.includes(v) ? [v] : []).concat(f.options).map((o) => `<option ${o === v ? 'selected' : ''}>${h(o)}</option>`).join('')}</select>`;
    else if (f.type === 'checkbox') return `<label class="field check ${cls || ''}"><input type="checkbox" ${common} ${v ? 'checked' : ''}><span>${h(f.label)}</span></label>`;
    else if (f.type === 'scale') {
      const labels = f.k === 'probability' ? PT.PROB.map((x) => x && x.label) : PT.IMPACT;
      return `<div class="field ${cls || ''}"><span>${h(f.label)}</span><div class="scale" role="group" aria-label="${h(f.label)}">${f.options.map((o) => `<button type="button" data-act="scale" data-k="${f.k}" data-v="${o}" aria-pressed="${Number(v) === o}"><b>${o}</b><small>${h(labels[o])}</small></button>`).join('')}</div></div>`;
    } else input = `<input type="${f.type}" ${common} value="${h(v)}">`;
    return `<label class="field ${cls || ''}"><span>${h(f.label)}</span>${input}</label>`;
  }

  // ---------- reports ----------
  const REPORTS = {
    highlight: { label: 'Highlight Report', fn: PT.highlightReport, help: 'Progress since the last report, tolerances, top risks, issues and next period.' },
    endstage: { label: 'End Stage Report', fn: (d, p, s, n) => PT.endStageReport(d, p, s, n), help: 'Stage review against plan, gate status, products, lessons and next-stage forecast.' },
    exception: { label: 'Exception Report', fn: PT.exceptionReport, help: 'Drafted from tolerance breaches. Add options and a recommendation.' },
    endproject: { label: 'End Project Report', fn: PT.endProjectReport, help: 'Performance against baseline, follow-on actions, ITIL handover and the Lessons Report.' },
    pid: { label: 'PID document', fn: PT.pidDocument, help: 'The Project Initiation Documentation compiled from the PID tab.' },
  };
  function viewReports(p) {
    const hist = S.data.reports.filter((r) => r.projectId === p.id).sort((a, b) => (a.date < b.date ? 1 : -1));
    const r = S.report;
    return `<div class="grid-3">${Object.entries(REPORTS).map(([k, v]) => `<section class="panel"><h3>${v.label}</h3><p class="muted" style="flex:1">${v.help}</p><div><button class="btn ${k === 'highlight' ? 'primary' : ''}" data-act="report" data-kind="${k}">Generate</button></div></section>`).join('')}
      <section class="panel"><h3>Report history</h3>${hist.length ? `<ul class="history">${hist.map((x) => `<li><button class="btn ghost small" data-act="show-report" data-id="${h(x.id)}" style="text-align:left;white-space:normal">${h(x.title)}</button><span class="muted mono" style="font-size:.75rem">${h(PT.fmtDate(x.date))}</span></li>`).join('')}</ul>` : '<p class="muted">Saved reports appear here. Saving a Highlight Report resets its due date.</p>'}</section></div>
      ${r ? `<section class="panel" id="report-panel"><div class="panel-head"><h2>${h(r.title)}</h2><div class="report-actions">
          <button class="btn" data-act="copy-report">Copy as Markdown</button>
          <button class="btn" data-act="download-report">Download .md</button>
          ${r.saved ? '<span class="pill green">Saved</span>' : '<button class="btn primary" data-act="save-report">Save to history</button>'}
          <button class="btn ghost" data-act="close-report">Close</button></div></div>
        <p class="muted">Review and edit after copying. Text in <em>italics</em> marks places that need your judgement.</p>
        <article class="doc">${md(r.md)}</article></section>` : ''}`;
  }

  // minimal markdown renderer for generated reports
  function md(src) {
    const inline = (s) => h(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])_(.+?)_(?=[\s.,;:)]|$)/g, '$1<em>$2</em>').replace(/ {2}$/, '<br>');
    const lines = src.split('\n');
    let out = '', i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (/^#{1,3} /.test(l)) { const n = l.match(/^#+/)[0].length; out += `<h${n}>${inline(l.slice(n + 1))}</h${n}>`; i++; continue; }
      if (/^\|/.test(l)) {
        const rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
        const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(rows[0]);
        out += `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(2).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
        continue;
      }
      if (/^- /.test(l)) {
        out += '<ul>';
        while (i < lines.length && /^- /.test(lines[i])) { out += `<li>${inline(lines[i].slice(2))}</li>`; i++; }
        out += '</ul>'; continue;
      }
      if (!l.trim()) { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#|\||- )/.test(lines[i])) { para.push(inline(lines[i])); i++; }
      out += `<p>${para.join(' ')}</p>`;
    }
    return out;
  }

  // ---------- settings ----------
  function viewSettings() {
    const s = settings();
    const f = (k, label, type, extra) => `<label class="field ${type === 'textarea' ? 'wide' : ''}"><span>${label}</span>${type === 'textarea' ? `<textarea id="set-${k}" data-bind="settings" data-k="${k}" ${extra || ''}>${h(s[k])}</textarea>` : `<input type="${type}" id="set-${k}" data-bind="settings" data-k="${k}" value="${h(s[k])}" ${extra || ''}>`}</label>`;
    return `<div class="page-head"><div><div class="eyebrow">Stagegate</div><h1>Settings &amp; backup</h1></div></div>
      ${banner()}
      <section class="panel"><h2>You</h2><div class="form-grid">${f('pmName', 'Your name (shown as report author and project manager)', 'text')}</div></section>
      <section class="panel"><h2>Reminders</h2><div class="form-grid">
        ${f('staleDays', 'Flag open risks and issues not updated for (days)', 'number')}
        ${f('proximityDays', 'Warn about risk proximity within (days)', 'number')}
        ${f('freezes', 'Change freeze windows. One per line: YYYY-MM-DD..YYYY-MM-DD label', 'textarea', 'placeholder="2026-12-18..2027-01-04 Christmas freeze"')}
      </div></section>
      <section class="panel"><h2>Quick capture</h2>
        <p>Type into the bar at the top from anywhere. Press <kbd>/</kbd> to focus it and <kbd>Enter</kbd> to add. Entries go into the project you have open, or your most recent one.</p>
        <div class="table-wrap"><table><thead><tr><th>Type</th><th>Example</th><th>Creates</th></tr></thead><tbody>
          <tr><td class="mono">r:</td><td class="mono">r: vendor may slip p4 i3 @sam due:+3w</td><td>Risk with P4 × I3, owner and proximity date. Add <code>opp</code> for an opportunity.</td></tr>
          <tr><td class="mono">i:</td><td class="mono">i: add SSO to scope rfc !high</td><td>Issue. <code>rfc</code> = request for change, <code>offspec</code> = off-specification.</td></tr>
          <tr><td class="mono">a:</td><td class="mono">a: send PID to board @me due:fri</td><td>Daily Log action with owner and due date</td></tr>
          <tr><td class="mono">d: / n:</td><td class="mono">d: board approved stage 2</td><td>Decision or note in the Daily Log</td></tr>
          <tr><td class="mono">c:</td><td class="mono">c: firewall patch emergency due:today</td><td>ITIL change (RFC). <code>standard</code> or <code>emergency</code> sets the type.</td></tr>
          <tr><td class="mono">q:</td><td class="mono">q: test report @qa due:15/11</td><td>Quality Register entry with planned review date</td></tr>
          <tr><td class="mono">l:</td><td class="mono">l: book testers early +</td><td>Lesson. <code>+</code> marks it positive.</td></tr>
        </tbody></table></div>
        <p class="muted">Due dates: <code>today</code>, <code>tomorrow</code>, weekday names (<code>fri</code>), <code>+3d</code>, <code>+2w</code>, <code>15/11</code> or <code>2026-11-15</code>.</p>
      </section>
      <section class="panel"><h2>Backup</h2>
        <p class="muted">${h(S.backend ? S.backend.label : '')}. Export everything as JSON to keep a copy or to move between the hosted and self-hosted versions.</p>
        <div class="toolbar"><button class="btn" data-act="export">Export JSON</button>
          <label class="btn" for="import-file">Import JSON</label><input type="file" id="import-file" accept="application/json,.json" hidden>
          <button class="btn" data-act="load-sample">Add example project</button></div>
      </section>`;
  }

  // ---------- drawer (create/edit) ----------
  function openDrawer(col, doc, isNew) {
    S.drawer = { col, doc: Object.assign({}, doc), isNew };
    drawDrawer();
    $('#scrim').hidden = false; $('#drawer').hidden = false;
    setTimeout(() => { const el = $('#drawer [data-k="title"]'); if (el && isNew) el.focus(); }, 30);
  }
  function closeDrawer() { S.drawer = null; $('#scrim').hidden = true; $('#drawer').hidden = true; }
  function drawDrawer() {
    const { col, doc, isNew } = S.drawer;
    const schema = PT.SCHEMAS[col];
    const p = project(doc.projectId);
    const score = col === 'risks' ? PT.riskScore(doc) : 0;
    const linked = col === 'issues' && doc.changeId ? S.data.changes.find((c) => c.id === doc.changeId) : col === 'changes' && doc.issueId ? S.data.issues.find((c) => c.id === doc.issueId) : null;
    $('#drawer').innerHTML = `
      <div class="drawer-head"><div><div class="eyebrow">${h(p ? p.name : '')}</div><h2>${isNew ? 'New ' + h(schema.label.toLowerCase()) : h(doc.ref || '') + ' ' + h(schema.label)}</h2></div>
        <button class="btn ghost" data-act="close-drawer" aria-label="Close">✕</button></div>
      <form class="drawer-body" id="drawer-form">
        ${col === 'risks' ? `<div class="scorebox"><span class="score ${PT.riskBand(score).key}" style="font-size:1.1rem">${score}</span><span>${PT.riskBand(score).label} risk${Number(p && p.riskTolScore) && score >= Number(p.riskTolScore) && doc.category !== 'Opportunity' ? ' · <b style="color:var(--red)">beyond risk tolerance, escalate to the board</b>' : ''}</span></div>` : ''}
        ${linked ? `<div class="scorebox">Linked ${col === 'issues' ? 'change' : 'issue'}: <button type="button" class="btn small" data-act="open-att" data-col="${col === 'issues' ? 'changes' : 'issues'}" data-id="${h(linked.id)}" data-pid="${h(linked.projectId)}">${h(linked.ref)} ${h(linked.title)}</button></div>` : ''}
        <div class="form-grid">${schema.fields.map((f) => fieldInput(f, doc[f.k], 'drawer', 'dr-' + f.k, f.type === 'textarea' || f.k === 'title' || f.type === 'scale' ? 'wide' : '')).join('')}</div>
        <button type="submit" hidden></button>
      </form>
      <div class="drawer-foot">
        <button class="btn primary" data-act="drawer-save">${isNew ? 'Add' : 'Save'}</button>
        <button class="btn" data-act="close-drawer">Cancel</button>
        ${col === 'issues' && !isNew && !doc.changeId && ['Request for change', 'Off-specification'].includes(doc.type) ? '<button class="btn" data-act="promote-drawer">Raise ITIL change</button>' : ''}
        <span class="spacer"></span>
        ${isNew ? '' : '<button class="btn danger" data-act="drawer-delete" data-confirm="Delete this entry?">Delete</button>'}
      </div>`;
  }
  function readDrawer() {
    const d = S.drawer.doc;
    document.querySelectorAll('#drawer [data-bind="drawer"]').forEach((el) => {
      const k = el.dataset.k;
      if (el.type === 'checkbox') d[k] = el.checked;
      else if (el.type === 'number') d[k] = el.value === '' ? '' : Number(el.value);
      else d[k] = el.value;
    });
    return d;
  }

  // ---------- new project modal (in drawer) ----------
  function openNewProject() {
    S.drawer = { col: 'new-project' };
    $('#drawer').innerHTML = `
      <div class="drawer-head"><div><div class="eyebrow">PRINCE2 7</div><h2>New project</h2></div><button class="btn ghost" data-act="close-drawer" aria-label="Close">✕</button></div>
      <form class="drawer-body" id="np-form">
        <label class="field"><span>Project name</span><input type="text" id="np-name" name="name" required placeholder="e.g. Replace VPN service"></label>
        <div class="form-grid">
          <label class="field"><span>Project code</span><input type="text" id="np-code" name="code" placeholder="e.g. PRJ-042"></label>
          <label class="field"><span>Executive</span><input type="text" id="np-exec" name="executive"></label>
          <label class="field"><span>Start</span><input type="date" id="np-start" name="start" value="${T()}"></label>
          <label class="field"><span>Planned end</span><input type="date" id="np-end" name="plannedEnd"></label>
          <label class="field"><span>Budget (£)</span><input type="number" id="np-budget" name="budget"></label>
          <label class="field"><span>Delivery stages</span><input type="number" id="np-stages" name="deliveryStages" value="2" min="1" max="8"></label>
        </div>
        <div class="field"><span>Template</span><div class="tpl">${Object.entries(PT.TEMPLATES).map(([k, t], i) => `<label><input type="radio" name="template" value="${k}" ${i === 0 ? 'checked' : ''}><span><b>${h(t.name)}</b><br><span class="muted">${h(t.description)}${t.risks.length ? ` Includes ${t.risks.length} standard risks.` : ''}</span></span></label>`).join('')}</div></div>
        <button type="submit" hidden></button>
      </form>
      <div class="drawer-foot"><button class="btn primary" data-act="create-project">Create project</button><button class="btn" data-act="close-drawer">Cancel</button></div>`;
    $('#scrim').hidden = false; $('#drawer').hidden = false;
    setTimeout(() => $('#np-name').focus(), 30);
  }
  async function createProject() {
    const form = $('#np-form');
    const fd = Object.fromEntries(new FormData(form).entries());
    if (!fd.name.trim()) { $('#np-name').focus(); toast('Give the project a name.'); return; }
    fd.budget = fd.budget ? Number(fd.budget) : '';
    const { project: p, risks } = PT.buildProject(fd);
    closeDrawer();
    await save('projects', p, true);
    for (const r of risks) await save('risks', r, true);
    toast('Project created with ' + p.stages.length + ' stages');
    go('project', p.id, 'stages');
  }

  // ---------- quick capture ----------
  function captureTarget() {
    if (S.view === 'project' && project()) return project();
    const last = pref.get('lastProject');
    return project(last) || S.data.projects.filter((p) => p.status !== 'Closed')[0];
  }
  function renderHint() {
    const el = $('#qc-hint');
    const v = $('#qc').value;
    const target = captureTarget();
    if (!v.trim()) {
      el.innerHTML = target ? `Adds to <b>${h(target.name)}</b> · <code>r:</code> risk <code>i:</code> issue <code>a:</code> action <code>d:</code> decision <code>n:</code> note <code>c:</code> change <code>q:</code> quality <code>l:</code> lesson` : 'Create a project first, then capture risks, issues and actions here.';
      return;
    }
    const parsed = PT.parseQuick(v);
    if (!parsed) { el.innerHTML = 'Start with a type, such as <code>r:</code> for risk or <code>a:</code> for action.'; return; }
    const d = parsed.doc;
    const bits = [];
    if (d.probability || d.impact) bits.push(`P${d.probability || 3} × I${d.impact || 3} = ${(d.probability || 3) * (d.impact || 3)}`);
    if (d.type) bits.push(d.type);
    if (d.priority) bits.push(d.priority + ' priority');
    if (d.owner || d.producer) bits.push('owner ' + (d.owner || d.producer));
    if (d.due) bits.push('due ' + PT.fmtDate(d.due));
    if (d.proximity) bits.push('proximity ' + PT.fmtDate(d.proximity));
    if (d.scheduledStart) bits.push('scheduled ' + PT.fmtDate(d.scheduledStart));
    if (d.plannedReview) bits.push('review ' + PT.fmtDate(d.plannedReview));
    el.innerHTML = `<b>${h(parsed.label)}</b>: “${h(d.title)}”${bits.length ? ' · ' + h(bits.join(' · ')) : ''} → ${target ? h(target.name) : '<b>no project yet</b>'} · <kbd>Enter</kbd>`;
  }
  async function quickAdd() {
    const input = $('#qc');
    const parsed = PT.parseQuick(input.value);
    const target = captureTarget();
    if (!parsed) { toast('Start with a type, such as r: for risk.'); return; }
    if (!target) { toast('Create a project first.'); return; }
    const doc = newDoc(parsed.col, target.id, parsed.doc);
    if (parsed.col === 'risks') doc.reviewDate = PT.addDays(T(), 14);
    await save(parsed.col, doc, true);
    input.value = '';
    renderHint();
    toast(`${parsed.label} ${doc.ref} added to ${target.name}`);
  }

  // ---------- actions ----------
  function armConfirm(btn) {
    if (btn.classList.contains('armed')) { btn.classList.remove('armed'); return true; }
    btn.classList.add('armed');
    btn.dataset.orig = btn.textContent;
    btn.textContent = btn.dataset.confirm + ' Click again';
    setTimeout(() => { if (btn.isConnected) { btn.classList.remove('armed'); btn.textContent = btn.dataset.orig; } }, 3500);
    return false;
  }

  async function promoteIssue(issue) {
    const ch = newDoc('changes', issue.projectId, {
      title: issue.title, description: [issue.description, issue.impactAnalysis].filter(Boolean).join('\n\n'),
      issueId: issue.id, risk: issue.priority === 'High' ? 'High' : 'Medium',
    });
    await save('changes', ch, true);
    issue.changeId = ch.id;
    if (issue.status === 'Open') issue.status = 'Under assessment';
    await save('issues', issue, true);
    toast(`${ch.ref} raised from ${issue.ref}`);
    return ch;
  }

  async function advanceStage() {
    const p = project();
    const st = p.stages[p.currentStage];
    if (st.checklist.some((c) => !c.done)) { toast('Finish the gate checklist first.'); return; }
    st.status = 'complete'; st.actualEnd = T();
    const next = p.stages[p.currentStage + 1];
    const log = (extra) => newDoc('logs', p.id, extra);
    if (next) {
      next.status = 'active';
      if (!next.plannedStart) next.plannedStart = T();
      p.currentStage += 1;
      await save('projects', p, true);
      await save('logs', log({ kind: 'Decision', title: `Board authorised ${next.name}; ${st.name} closed` }), true);
      await save('logs', log({ kind: 'Action', title: `Hold lessons review for ${st.name}`, owner: settings().pmName || '', due: PT.addDays(T(), 5) }), true);
      toast(`${st.name} closed. ${next.name} started.`);
      S.report = Object.assign({ kind: 'endstage' }, PT.endStageReport(S.data, p, settings(), undefined, p.currentStage - 1));
      go('project', p.id, 'reports');
    } else {
      p.status = 'Closed';
      await save('projects', p, true);
      await save('logs', log({ kind: 'Decision', title: 'Project closed by the board' }), true);
      toast('Project closed');
      S.report = Object.assign({ kind: 'endproject' }, PT.endProjectReport(S.data, p, settings()));
      go('project', p.id, 'reports');
    }
  }

  async function download(filename, text) {
    if (window.claude && typeof window.claude.use === 'function') {
      const dl = await window.claude.use('downloads');
      if (dl) {
        try { await dl.save({ filename, data: text }); } catch (e) { if (e.code !== 'declined') toast('Download unavailable here. Use Copy instead.'); }
        return;
      }
      toast('Download unavailable here. Use Copy instead.');
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied. Paste into email, Word or Teams.'); }
    catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Copied'); } catch (e2) { toast('Select the report text and copy it manually.'); }
      ta.remove();
    }
  }

  async function loadSample() {
    const d = PT.sampleData();
    for (const col of PT.COLLECTIONS) {
      if (col === 'settings') {
        const merged = Object.assign({}, d.settings[0], S.data.settings.find((s) => s.id === 'main') || {});
        if (!merged.freezes) merged.freezes = d.settings[0].freezes;
        await save('settings', merged, true);
        continue;
      }
      for (const doc of d[col]) await save(col, doc, true);
    }
    toast('Example project added');
    go('project', d.projects[0].id, 'overview');
  }

  async function importJson(file) {
    try {
      const d = JSON.parse(await file.text());
      let n = 0;
      for (const col of PT.COLLECTIONS) for (const doc of (d[col] || [])) { if (doc && doc.id) { await save(col, doc, true); n++; } }
      toast(`Imported ${n} records`);
    } catch (e) { toast('That file is not a Stagegate JSON export.'); }
  }

  function onClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const a = el.dataset.act;
    const ds = el.dataset;
    const p = project();
    if (el.tagName === 'INPUT' && el.type === 'checkbox') e.stopPropagation();
    switch (a) {
      case 'go':
        if (ds.view === 'project') { pref.set('lastProject', ds.id); S.openStage = null; go('project', ds.id, S.projectId === ds.id ? S.tab : 'overview'); }
        else go(ds.view);
        break;
      case 'tab':
        S.filter.status = 'open'; S.filter.q = '';
        if (ds.stage != null) S.openStage = Number(ds.stage);
        if (ds.tab !== 'reports') S.report = null;
        go('project', null, ds.tab);
        break;
      case 'level': S.filter.level = ds.level; render(); break;
      case 'status-filter': S.filter.status = ds.status; render(); break;
      case 'heat': {
        const v = [Number(ds.p), Number(ds.i)];
        S.filter.heat = S.filter.heat && S.filter.heat[0] === v[0] && S.filter.heat[1] === v[1] ? null : v;
        S.filter.status = 'open';
        if (S.tab !== 'risks') { const keep = S.filter.heat; go('project', null, 'risks'); S.filter.heat = keep; }
        render(); break;
      }
      case 'heat-clear': S.filter.heat = null; render(); break;
      case 'new': openDrawer(ds.col, newDoc(ds.col, p.id, ds.col === 'risks' ? { reviewDate: PT.addDays(T(), 14), owner: '' } : {}), true); break;
      case 'edit': {
        if (e.target.closest('button, input, a') && e.target.closest('[data-act]') !== el) return;
        const doc = S.data[ds.col].find((x) => x.id === ds.id);
        if (doc) openDrawer(ds.col, doc, false);
        break;
      }
      case 'open-att': {
        if (ds.col === 'projects') { pref.set('lastProject', ds.pid); go('project', ds.pid, 'overview'); break; }
        const doc = S.data[ds.col].find((x) => x.id === ds.id);
        if (doc) { closeDrawer(); pref.set('lastProject', doc.projectId); S.projectId = doc.projectId; openDrawer(ds.col, doc, false); }
        break;
      }
      case 'toggle-done': {
        e.stopPropagation();
        const doc = Object.assign({}, S.data.logs.find((x) => x.id === ds.id));
        doc.done = el.checked; doc.completedAt = el.checked ? T() : '';
        save('logs', doc, true); toast(el.checked ? 'Action done' : 'Action reopened');
        break;
      }
      case 'promote': { e.stopPropagation(); const is = S.data.issues.find((x) => x.id === ds.id); if (is) promoteIssue(Object.assign({}, is)); break; }
      case 'promote-drawer': { const is = readDrawer(); save('issues', is, true).then(() => promoteIssue(is)).then((ch) => openDrawer('changes', ch, false)); break; }
      case 'scale': {
        S.drawer.doc[ds.k] = Number(ds.v); readDrawer();
        S.drawer.doc[ds.k] = Number(ds.v); drawDrawer(); break;
      }
      case 'close-drawer': closeDrawer(); break;
      case 'drawer-save': {
        const d = readDrawer();
        if (!String(d.title || '').trim()) { toast('Add a title first.'); $('#dr-title').focus(); break; }
        if (S.drawer.col === 'logs' && d.done && !d.completedAt) d.completedAt = T();
        save(S.drawer.col, d, false); closeDrawer(); break;
      }
      case 'drawer-delete': if (armConfirm(el)) { const { col, doc } = S.drawer; closeDrawer(); remove(col, doc.id); } break;
      case 'new-project': openNewProject(); break;
      case 'create-project': createProject(); break;
      case 'load-sample': loadSample(); break;
      case 'gate': {
        const st = p.stages[Number(ds.stage)];
        const item = st.checklist[Number(ds.item)];
        item.done = el.checked; item.doneAt = el.checked ? T() : '';
        S.openStage = Number(ds.stage);
        save('projects', p, true); break;
      }
      case 'gate-rm': { p.stages[Number(ds.stage)].checklist.splice(Number(ds.item), 1); S.openStage = Number(ds.stage); save('projects', p, true); break; }
      case 'add-stage': {
        const i = p.stages.length - 1;
        const st = { id: PT.uid('s'), name: 'Delivery stage ' + (i), kind: 'delivery', status: 'planned', plannedStart: '', plannedEnd: '', forecastEnd: '', actualEnd: '', budget: '', forecastCost: '', checklist: PT.GATES.delivery.map((t) => ({ t, done: false })) };
        if (p.stages[i] && p.stages[i].status === 'planned' && p.stages[i].kind === 'final') p.stages.splice(i, 0, st);
        else p.stages.push(st);
        S.openStage = p.stages.indexOf(st);
        save('projects', p, true); toast('Stage added'); break;
      }
      case 'stage-rm': if (armConfirm(el)) { p.stages.splice(Number(ds.stage), 1); S.openStage = null; save('projects', p, true); } break;
      case 'advance': advanceStage(); break;
      case 'report': {
        const R = REPORTS[ds.kind];
        S.report = Object.assign({ kind: ds.kind }, R.fn(S.data, p, settings()));
        go('project', null, 'reports');
        setTimeout(() => { const rp = $('#report-panel'); if (rp) rp.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 60);
        break;
      }
      case 'show-report': { const r = S.data.reports.find((x) => x.id === ds.id); if (r) { S.report = { kind: r.type, title: r.title, md: r.md, saved: true }; render(); } break; }
      case 'close-report': S.report = null; render(); break;
      case 'copy-report': copyText(S.report.md); break;
      case 'download-report': download(`${(p.code || p.name).replace(/[^\w-]+/g, '-')}-${S.report.kind}-${T()}.md`, S.report.md); break;
      case 'save-report': {
        const r = { id: PT.uid('rep'), projectId: p.id, type: S.report.kind, title: S.report.title, md: S.report.md, date: T() };
        S.report.saved = true;
        save('reports', r, false);
        if (S.report.kind === 'highlight') save('logs', newDoc('logs', p.id, { kind: 'Event', title: 'Highlight Report issued to the board' }), true);
        break;
      }
      case 'delete-project': if (armConfirm(el)) {
        const id = p.id;
        (async () => {
          for (const col of PT.COLLECTIONS) if (col !== 'projects' && col !== 'settings') for (const d of S.data[col].filter((x) => x.projectId === id)) await remove(col, d.id);
          await remove('projects', id);
          go('today');
        })();
      } break;
      case 'export': {
        const out = { exportedAt: new Date().toISOString(), app: 'stagegate', version: 1 };
        for (const col of PT.COLLECTIONS) out[col] = S.data[col];
        download(`stagegate-backup-${T()}.json`, JSON.stringify(out, null, 2));
        break;
      }
    }
  }

  // inline editing (project fields, stages, settings) with debounced saves
  const pending = {};
  function debounce(key, fn, ms) { clearTimeout(pending[key]); pending[key] = setTimeout(fn, ms || 600); }
  function onInput(e) {
    const el = e.target;
    if (el.id === 'qc') { renderHint(); return; }
    const b = el.dataset.bind;
    if (!b) return;
    const val = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value;
    if (b === 'search') { S.filter.q = el.value; debounce('search', () => { renderNow(); const s = $('#reg-search'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }, 250); return; }
    if (b === 'drawer') return;
    if (b === 'project') {
      const p = project();
      p[el.dataset.k] = val;
      debounce('p' + p.id, () => saveQuiet('projects', p));
    } else if (b === 'stage') {
      const p = project();
      p.stages[Number(el.dataset.stage)][el.dataset.k] = val;
      S.openStage = Number(el.dataset.stage);
      debounce('p' + p.id, () => saveQuiet('projects', p));
    } else if (b === 'settings') {
      const s = settings(); s.id = 'main'; s[el.dataset.k] = val;
      const list = S.data.settings; const i = list.findIndex((x) => x.id === 'main');
      if (i >= 0) list[i] = s; else list.push(s);
      debounce('settings', () => saveQuiet('settings', s));
    }
  }
  // Save without re-rendering the form the user is typing in.
  async function saveQuiet(col, doc) {
    doc.updatedAt = T();
    try { await S.backend.save(col, doc); renderRail(); toast('Saved'); }
    catch (e) { toast('Could not save: ' + (e.message || e.code)); }
  }

  function boot() {
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', (e) => {
      if (e.target.id === 'import-file' && e.target.files[0]) { importJson(e.target.files[0]); e.target.value = ''; return; }
      if (e.target.dataset.bind && e.target.tagName === 'SELECT') onInput(e);
    });
    document.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      if (f.dataset.form === 'gate-add') {
        const p = project(); const i = Number(f.dataset.stage);
        const t = f.elements.t.value.trim();
        if (t) { p.stages[i].checklist.push({ t, done: false }); S.openStage = i; save('projects', p, true); }
      } else if (f.id === 'np-form') createProject();
      else if (f.id === 'drawer-form') $('[data-act="drawer-save"]').click();
    });
    $('#qc').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); quickAdd(); } if (e.key === 'Escape') e.target.blur(); });
    $('#qc-add').addEventListener('click', quickAdd);
    $('#scrim').addEventListener('click', closeDrawer);
    document.addEventListener('focusout', () => { setTimeout(() => { if (S.viewStale) renderNow(); }, 0); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && S.drawer) closeDrawer();
      if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('#qc').focus(); }
    });
    // keep stage cards' open state across re-renders
    document.addEventListener('toggle', (e) => { if (e.target.dataset && e.target.dataset.stageCard != null && e.target.open) S.openStage = Number(e.target.dataset.stageCard); }, true);

    const nav = pref.get('nav', null);
    if (nav) { S.view = nav.view; S.projectId = nav.projectId; S.tab = nav.tab || 'overview'; }
    renderNow();
    pickBackend().then(async (b) => {
      S.backend = b;
      renderRail();
      try { await b.start(); } catch (e) { toast('Could not load data: ' + (e.message || e.code)); }
      S.ready = true;
      if (S.view === 'project' && !project()) S.view = 'today';
      renderNow();
    });
  }
  boot();
})();
