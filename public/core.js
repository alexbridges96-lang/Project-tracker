/*
 * Stagegate core: data model, PRINCE2 7 templates, tolerance and attention
 * rules, quick-capture parsing and report generation.
 * Pure functions only, so it runs in the browser (window.PT) and in Node
 * (require) for tests and the server.
 */
(function (root) {
  'use strict';

  const COLLECTIONS = ['projects', 'risks', 'issues', 'changes', 'quality', 'logs', 'lessons', 'reports', 'settings'];

  // ---------- dates ----------
  const pad = (n) => String(n).padStart(2, '0');
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function today(now) { return iso(now || new Date()); }
  function parseDate(s) {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(s, n) { const d = parseDate(s); d.setDate(d.getDate() + n); return iso(d); }
  function daysBetween(a, b) { // b - a in days
    const da = parseDate(a), db = parseDate(b);
    if (!da || !db) return null;
    return Math.round((db - da) / 86400000);
  }
  function fmtDate(s) {
    const d = parseDate(s);
    if (!d) return '';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function money(n) {
    if (n === '' || n == null || isNaN(n)) return '—';
    return '£' + Number(n).toLocaleString('en-GB', { maximumFractionDigits: 0 });
  }

  function uid(prefix) {
    return (prefix || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------- reference data ----------
  const PROB = [
    null,
    { label: 'Very low', hint: '<10%' },
    { label: 'Low', hint: '10–30%' },
    { label: 'Medium', hint: '30–50%' },
    { label: 'High', hint: '50–70%' },
    { label: 'Very high', hint: '>70%' },
  ];
  const IMPACT = [null, 'Very low', 'Low', 'Medium', 'High', 'Very high'];

  function riskScore(r) { return (Number(r.probability) || 0) * (Number(r.impact) || 0); }
  function riskBand(score) {
    if (score >= 15) return { key: 'vhigh', label: 'Very high' };
    if (score >= 10) return { key: 'high', label: 'High' };
    if (score >= 5) return { key: 'med', label: 'Medium' };
    return { key: 'low', label: 'Low' };
  }

  const THREAT_RESPONSES = ['Avoid', 'Reduce', 'Fallback', 'Transfer', 'Share', 'Accept'];
  const OPP_RESPONSES = ['Exploit', 'Enhance', 'Share', 'Reject'];

  // Field schemas drive the generic register forms and tables.
  const SCHEMAS = {
    risks: {
      label: 'Risk', plural: 'Risk Register', refPrefix: 'R',
      fields: [
        { k: 'title', label: 'Risk title', type: 'text', required: true },
        { k: 'category', label: 'Type', type: 'select', options: ['Threat', 'Opportunity'] },
        { k: 'cause', label: 'Cause (because of…)', type: 'textarea' },
        { k: 'event', label: 'Event (there is a risk that…)', type: 'textarea' },
        { k: 'effect', label: 'Effect (which would result in…)', type: 'textarea' },
        { k: 'probability', label: 'Probability', type: 'scale', options: [1, 2, 3, 4, 5] },
        { k: 'impact', label: 'Impact', type: 'scale', options: [1, 2, 3, 4, 5] },
        { k: 'proximity', label: 'Proximity (when it could occur)', type: 'date' },
        { k: 'response', label: 'Response', type: 'select', options: THREAT_RESPONSES.concat(OPP_RESPONSES) },
        { k: 'actions', label: 'Response actions', type: 'textarea' },
        { k: 'owner', label: 'Risk owner', type: 'text' },
        { k: 'actionee', label: 'Risk actionee', type: 'text' },
        { k: 'reviewDate', label: 'Next review', type: 'date' },
        { k: 'status', label: 'Status', type: 'select', options: ['Open', 'Closed'] },
      ],
      defaults: () => ({ category: 'Threat', probability: 3, impact: 3, status: 'Open', response: 'Reduce' }),
      isOpen: (r) => r.status !== 'Closed',
    },
    issues: {
      label: 'Issue', plural: 'Issue Register', refPrefix: 'I',
      fields: [
        { k: 'title', label: 'Issue title', type: 'text', required: true },
        { k: 'type', label: 'Issue type', type: 'select', options: ['Request for change', 'Off-specification', 'Problem/concern'] },
        { k: 'description', label: 'Description', type: 'textarea' },
        { k: 'impactAnalysis', label: 'Impact on time, cost, quality, scope, benefits, risk', type: 'textarea' },
        { k: 'priority', label: 'Priority', type: 'select', options: ['High', 'Medium', 'Low'] },
        { k: 'severity', label: 'Decision authority', type: 'select', options: ['Project manager', 'Change authority', 'Project board', 'Corporate / business'] },
        { k: 'raisedBy', label: 'Raised by', type: 'text' },
        { k: 'dateRaised', label: 'Date raised', type: 'date' },
        { k: 'owner', label: 'Issue owner', type: 'text' },
        { k: 'decision', label: 'Decision', type: 'textarea' },
        { k: 'status', label: 'Status', type: 'select', options: ['Open', 'Under assessment', 'Awaiting decision', 'Approved', 'Rejected', 'Deferred', 'Closed'] },
      ],
      defaults: (t) => ({ type: 'Problem/concern', priority: 'Medium', severity: 'Project manager', status: 'Open', dateRaised: t }),
      isOpen: (r) => !['Closed', 'Rejected'].includes(r.status),
    },
    changes: {
      label: 'Change (RFC)', plural: 'Change Enablement', refPrefix: 'CHG-',
      fields: [
        { k: 'title', label: 'Change title', type: 'text', required: true },
        { k: 'type', label: 'Change type', type: 'select', options: ['Normal', 'Standard', 'Emergency'] },
        { k: 'description', label: 'Description and reason', type: 'textarea' },
        { k: 'services', label: 'Services / CIs affected', type: 'text' },
        { k: 'risk', label: 'Change risk', type: 'select', options: ['Low', 'Medium', 'High'] },
        { k: 'impact', label: 'Business impact', type: 'textarea' },
        { k: 'implementationPlan', label: 'Implementation plan', type: 'textarea' },
        { k: 'testPlan', label: 'Test plan', type: 'textarea' },
        { k: 'backoutPlan', label: 'Backout plan', type: 'textarea' },
        { k: 'authority', label: 'Change authority', type: 'select', options: ['CAB', 'ECAB', 'Delegated (pre-approved)', 'Project board'] },
        { k: 'scheduledStart', label: 'Scheduled start', type: 'date' },
        { k: 'scheduledEnd', label: 'Scheduled end', type: 'date' },
        { k: 'status', label: 'Status', type: 'select', options: ['Draft', 'Assessed', 'Awaiting CAB', 'Authorised', 'Scheduled', 'Implemented', 'Reviewed (PIR)', 'Closed', 'Rejected', 'Backed out'] },
        { k: 'pir', label: 'Post-implementation review', type: 'textarea' },
      ],
      defaults: () => ({ type: 'Normal', risk: 'Medium', authority: 'CAB', status: 'Draft' }),
      isOpen: (r) => !['Closed', 'Rejected'].includes(r.status),
    },
    quality: {
      label: 'Quality activity', plural: 'Quality Register', refPrefix: 'Q',
      fields: [
        { k: 'title', label: 'Product', type: 'text', required: true },
        { k: 'method', label: 'Quality method', type: 'select', options: ['Review', 'Inspection', 'Test', 'Demonstration', 'Audit'] },
        { k: 'criteria', label: 'Quality criteria', type: 'textarea' },
        { k: 'producer', label: 'Producer', type: 'text' },
        { k: 'reviewers', label: 'Reviewers', type: 'text' },
        { k: 'approver', label: 'Approver', type: 'text' },
        { k: 'plannedReview', label: 'Planned review', type: 'date' },
        { k: 'actualReview', label: 'Actual review', type: 'date' },
        { k: 'plannedApproval', label: 'Planned approval', type: 'date' },
        { k: 'actualApproval', label: 'Actual approval', type: 'date' },
        { k: 'result', label: 'Result', type: 'select', options: ['Pending', 'Pass', 'Pass with actions', 'Fail'] },
        { k: 'records', label: 'Quality records / notes', type: 'textarea' },
      ],
      defaults: () => ({ method: 'Review', result: 'Pending' }),
      isOpen: (r) => r.result === 'Pending' || r.result === 'Fail' || !r.result,
    },
    logs: {
      label: 'Daily Log entry', plural: 'Daily Log', refPrefix: 'D',
      fields: [
        { k: 'title', label: 'Entry', type: 'text', required: true },
        { k: 'kind', label: 'Kind', type: 'select', options: ['Action', 'Note', 'Decision', 'Event'] },
        { k: 'owner', label: 'Owner', type: 'text' },
        { k: 'date', label: 'Date logged', type: 'date' },
        { k: 'due', label: 'Due', type: 'date' },
        { k: 'done', label: 'Done', type: 'checkbox' },
        { k: 'notes', label: 'Notes', type: 'textarea' },
      ],
      defaults: (t) => ({ kind: 'Action', date: t, done: false }),
      isOpen: (r) => r.kind === 'Action' && !r.done,
    },
    lessons: {
      label: 'Lesson', plural: 'Lessons Log', refPrefix: 'L',
      fields: [
        { k: 'title', label: 'Lesson', type: 'text', required: true },
        { k: 'type', label: 'Applies to', type: 'select', options: ['Project', 'Corporate', 'Programme'] },
        { k: 'category', label: 'Category', type: 'select', options: ['Governance', 'Planning', 'People', 'Supplier', 'Technical', 'Quality', 'Change & transition', 'Other'] },
        { k: 'sentiment', label: 'Effect', type: 'select', options: ['Negative', 'Positive'] },
        { k: 'event', label: 'What happened', type: 'textarea' },
        { k: 'cause', label: 'Cause / trigger', type: 'textarea' },
        { k: 'earlyWarning', label: 'Early warning indicators', type: 'textarea' },
        { k: 'recommendation', label: 'Recommendation', type: 'textarea' },
        { k: 'owner', label: 'Logged by', type: 'text' },
        { k: 'dateLogged', label: 'Date logged', type: 'date' },
        { k: 'status', label: 'Status', type: 'select', options: ['Logged', 'Actioned', 'Shared'] },
      ],
      defaults: (t) => ({ type: 'Project', category: 'Other', sentiment: 'Negative', status: 'Logged', dateLogged: t }),
      isOpen: (r) => r.status === 'Logged',
    },
  };

  const PROJECT_FIELDS = {
    board: [
      { k: 'name', label: 'Project name', type: 'text', required: true },
      { k: 'code', label: 'Project code', type: 'text' },
      { k: 'status', label: 'Status', type: 'select', options: ['Active', 'On hold', 'Closed'] },
      { k: 'executive', label: 'Executive', type: 'text' },
      { k: 'seniorUser', label: 'Senior user(s)', type: 'text' },
      { k: 'seniorSupplier', label: 'Senior supplier(s)', type: 'text' },
      { k: 'assurance', label: 'Project assurance', type: 'text' },
      { k: 'changeAuthority', label: 'Change authority', type: 'text' },
      { k: 'teamManagers', label: 'Team managers', type: 'text' },
      { k: 'serviceOwner', label: 'Receiving service owner (ITIL)', type: 'text' },
    ],
    controls: [
      { k: 'start', label: 'Project start', type: 'date' },
      { k: 'plannedEnd', label: 'Planned end', type: 'date' },
      { k: 'forecastEnd', label: 'Forecast end', type: 'date' },
      { k: 'budget', label: 'Approved budget (£)', type: 'number' },
      { k: 'actualCost', label: 'Spent to date (£)', type: 'number' },
      { k: 'forecastCost', label: 'Forecast cost at completion (£)', type: 'number' },
      { k: 'timeTolDays', label: 'Time tolerance (± days)', type: 'number' },
      { k: 'costTolPct', label: 'Cost tolerance (± %)', type: 'number' },
      { k: 'riskTolScore', label: 'Risk tolerance (escalate any risk scoring ≥)', type: 'number' },
      { k: 'scopeTol', label: 'Scope tolerance', type: 'text' },
      { k: 'qualityTol', label: 'Quality tolerance', type: 'text' },
      { k: 'benefitsTol', label: 'Benefits tolerance', type: 'text' },
      { k: 'sustainabilityTol', label: 'Sustainability tolerance', type: 'text' },
      { k: 'highlightDays', label: 'Highlight Report every (days)', type: 'number' },
    ],
    pid: [
      { k: 'mandate', label: 'Project mandate', type: 'textarea', section: 'Project definition' },
      { k: 'background', label: 'Background', type: 'textarea', section: 'Project definition' },
      { k: 'objectives', label: 'Objectives (time, cost, quality, scope, benefits, risk)', type: 'textarea', section: 'Project definition' },
      { k: 'outcomes', label: 'Desired outcomes and benefits', type: 'textarea', section: 'Project definition' },
      { k: 'scope', label: 'Scope', type: 'textarea', section: 'Project definition' },
      { k: 'exclusions', label: 'Exclusions', type: 'textarea', section: 'Project definition' },
      { k: 'constraints', label: 'Constraints', type: 'textarea', section: 'Project definition' },
      { k: 'assumptions', label: 'Assumptions', type: 'textarea', section: 'Project definition' },
      { k: 'interfaces', label: 'Users and interfaces', type: 'textarea', section: 'Project definition' },
      { k: 'approach', label: 'Project approach (delivery method, solution, make/buy)', type: 'textarea', section: 'Approaches' },
      { k: 'riskApproach', label: 'Risk management approach', type: 'textarea', section: 'Approaches' },
      { k: 'qualityApproach', label: 'Quality management approach', type: 'textarea', section: 'Approaches' },
      { k: 'changeApproach', label: 'Issue management and change control approach', type: 'textarea', section: 'Approaches' },
      { k: 'commsApproach', label: 'Communication management approach', type: 'textarea', section: 'Approaches' },
      { k: 'transitionApproach', label: 'Service transition approach (ITIL handover)', type: 'textarea', section: 'Approaches' },
      { k: 'tailoring', label: 'Tailoring of PRINCE2', type: 'textarea', section: 'Approaches' },
    ],
  };

  // ---------- templates ----------
  const GATES = {
    startup: [
      'Project mandate received and understood',
      'Executive and project manager appointed',
      'Project management team roles agreed',
      'Lessons from previous projects reviewed',
      'Project Brief drafted (incl. outline Business Case)',
      'Project approach selected',
      'Initiation Stage Plan drafted',
      'Board authorises initiation',
    ],
    initiation: [
      'Risk management approach agreed',
      'Issue management and change control approach agreed',
      'Quality management approach agreed',
      'Communication management approach agreed',
      'Project controls set (tolerances, reporting cadence)',
      'Project Plan produced',
      'Business Case refined and benefits identified',
      'PID assembled',
      'Next Stage Plan drafted',
      'Board authorises the project',
    ],
    delivery: [
      'Work packages authorised and accepted',
      'Stage products quality-reviewed (Quality Register current)',
      'Risk and Issue Registers reviewed',
      'Business Case reviewed',
      'Project Plan updated with actuals',
      'Next Stage Plan (or Exception Plan) drafted',
      'End Stage Report produced',
      'Lessons captured for this stage',
      'Board authorises next stage',
    ],
    transition: [
      'RFC raised and authorised by the change authority',
      'Release and deployment plan agreed, backout plan tested',
      'Go / no-go decision recorded',
      'Service acceptance criteria met',
      'Support model agreed (SLAs / OLAs in place)',
      'Service desk and support teams trained, handover signed',
      'Knowledge articles and runbooks published',
      'Configuration records (CMDB) updated',
      'Early life support period agreed with exit criteria',
    ],
    closing: [
      'All products handed over and accepted',
      'Follow-on actions recommended and owners assigned',
      'Benefits review plan confirmed',
      'Lessons Report produced',
      'End Project Report produced',
      'Records archived and registers closed',
      'Board confirms closure and notifies corporate',
    ],
  };

  const TEMPLATES = {
    it: {
      name: 'IT service change (PRINCE2 + ITIL transition)',
      description: 'Stages with ITIL Change Enablement and service transition gates on the final stage.',
      transition: true,
      risks: [
        { title: 'Key business users unavailable for testing and acceptance', probability: 3, impact: 4, response: 'Reduce', actions: 'Book UAT windows with line managers at stage start.' },
        { title: 'Supplier delivery slips past the planned release window', probability: 3, impact: 3, response: 'Reduce', actions: 'Weekly supplier checkpoint; contractual milestones.' },
        { title: 'Integration with existing services fails in test', probability: 2, impact: 4, response: 'Reduce', actions: 'Early integration spike; production-like test environment.' },
        { title: 'Support teams not ready at handover', probability: 3, impact: 4, response: 'Reduce', actions: 'Agree service acceptance criteria during initiation; shadowing before go-live.' },
        { title: 'Go-live clashes with a change freeze', probability: 2, impact: 3, response: 'Avoid', actions: 'Check the change calendar before fixing the release date.' },
      ],
    },
    standard: {
      name: 'Standard PRINCE2 project',
      description: 'Starting up, initiation, delivery stages and closing.',
      transition: false,
      risks: [
        { title: 'Key stakeholders unavailable for decisions', probability: 3, impact: 3, response: 'Reduce', actions: 'Agree board meeting cadence and delegated authority.' },
        { title: 'Requirements change after baseline', probability: 3, impact: 3, response: 'Reduce', actions: 'Apply change control; use change budget.' },
      ],
    },
    blank: { name: 'Blank', description: 'Start-up and initiation only; add your own stages.', transition: false, risks: [] },
  };

  function makeStage(name, kind, items) {
    return {
      id: uid('s'), name, kind, status: 'planned',
      plannedStart: '', plannedEnd: '', forecastEnd: '', actualEnd: '',
      budget: '', forecastCost: '',
      checklist: items.map((t) => ({ t, done: false })),
    };
  }

  function buildProject(opts, now) {
    const t = today(now);
    const tpl = TEMPLATES[opts.template] || TEMPLATES.standard;
    const n = Math.max(0, Math.min(8, Number(opts.deliveryStages) || (opts.template === 'blank' ? 0 : 2)));
    const stages = [makeStage('Starting up', 'startup', GATES.startup), makeStage('Initiation', 'initiation', GATES.initiation)];
    for (let i = 1; i <= n; i++) {
      const last = i === n;
      const items = last
        ? GATES.delivery.filter((x) => !/Next Stage Plan|Board authorises next/.test(x))
            .concat(tpl.transition ? GATES.transition : []).concat(GATES.closing)
        : GATES.delivery;
      stages.push(makeStage(last ? 'Final delivery & closure' : 'Delivery stage ' + i, last ? 'final' : 'delivery', items));
    }
    stages[0].status = 'active';
    stages[0].plannedStart = opts.start || t;
    const project = {
      id: uid('p'),
      name: opts.name || 'Untitled project',
      code: opts.code || '',
      status: 'Active',
      template: opts.template || 'standard',
      start: opts.start || t,
      plannedEnd: opts.plannedEnd || '',
      forecastEnd: opts.plannedEnd || '',
      budget: opts.budget || '',
      forecastCost: opts.budget || '',
      actualCost: 0,
      timeTolDays: 10, costTolPct: 10, riskTolScore: 15,
      highlightDays: 14,
      executive: opts.executive || '',
      currentStage: 0,
      stages,
      createdAt: t,
    };
    const risks = tpl.risks.map((r, i) => Object.assign(SCHEMAS.risks.defaults(), r, {
      id: uid('r'), projectId: project.id, ref: 'R' + pad3(i + 1), reviewDate: addDays(t, 14), updatedAt: t, createdAt: t,
    }));
    return { project, risks };
  }

  function pad3(n) { return String(n).padStart(3, '0'); }

  function nextRef(col, items, projectId) {
    const prefix = SCHEMAS[col] ? SCHEMAS[col].refPrefix : '';
    let max = 0;
    for (const it of items) {
      if (it.projectId !== projectId || !it.ref) continue;
      const m = String(it.ref).match(/(\d+)$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return prefix + pad3(max + 1);
  }

  // ---------- tolerances ----------
  // Returns {status: 'green'|'amber'|'red', items:[{dim, status, text}]}
  function toleranceStatus(p, data) {
    const items = [];
    const worst = (a, b) => (['green', 'amber', 'red'].indexOf(a) >= ['green', 'amber', 'red'].indexOf(b) ? a : b);

    // Cost
    const budget = Number(p.budget);
    if (budget > 0 && p.forecastCost !== '' && p.forecastCost != null) {
      const tolPct = Number(p.costTolPct) || 0;
      const overPct = ((Number(p.forecastCost) - budget) / budget) * 100;
      let s = 'green';
      if (Math.abs(overPct) > tolPct) s = 'red';
      else if (tolPct > 0 && Math.abs(overPct) > tolPct * 0.8) s = 'amber';
      items.push({ dim: 'Cost', status: s, text: `Forecast ${money(p.forecastCost)} vs budget ${money(budget)} (${overPct >= 0 ? '+' : ''}${overPct.toFixed(1)}%, tolerance ±${tolPct}%)` });
    }
    // Time
    if (p.plannedEnd && p.forecastEnd) {
      const tol = Number(p.timeTolDays) || 0;
      const slip = daysBetween(p.plannedEnd, p.forecastEnd);
      let s = 'green';
      if (Math.abs(slip) > tol) s = 'red';
      else if (tol > 0 && Math.abs(slip) > tol * 0.8) s = 'amber';
      items.push({ dim: 'Time', status: s, text: `Forecast end ${fmtDate(p.forecastEnd)} vs planned ${fmtDate(p.plannedEnd)} (${slip >= 0 ? '+' : ''}${slip} days, tolerance ±${tol})` });
    }
    // Current stage tolerances (same %/days as delegated by the board)
    const st = p.stages && p.stages[p.currentStage];
    if (st) {
      const sb = Number(st.budget);
      if (sb > 0 && st.forecastCost !== '' && st.forecastCost != null) {
        const tolPct = Number(p.costTolPct) || 0;
        const overPct = ((Number(st.forecastCost) - sb) / sb) * 100;
        const s = Math.abs(overPct) > tolPct ? 'red' : (tolPct > 0 && Math.abs(overPct) > tolPct * 0.8 ? 'amber' : 'green');
        items.push({ dim: 'Stage cost', status: s, text: `${st.name}: forecast ${money(st.forecastCost)} vs ${money(sb)} (${overPct >= 0 ? '+' : ''}${overPct.toFixed(1)}%)` });
      }
      if (st.plannedEnd && st.forecastEnd) {
        const tol = Number(p.timeTolDays) || 0;
        const slip = daysBetween(st.plannedEnd, st.forecastEnd);
        const s = Math.abs(slip) > tol ? 'red' : (tol > 0 && Math.abs(slip) > tol * 0.8 ? 'amber' : 'green');
        items.push({ dim: 'Stage time', status: s, text: `${st.name}: forecast end ${fmtDate(st.forecastEnd)} vs ${fmtDate(st.plannedEnd)} (${slip >= 0 ? '+' : ''}${slip} days)` });
      }
    }
    // Risk
    if (data) {
      const tol = Number(p.riskTolScore) || 0;
      if (tol > 0) {
        const over = data.risks.filter((r) => r.projectId === p.id && r.status !== 'Closed' && r.category !== 'Opportunity' && riskScore(r) >= tol);
        items.push({ dim: 'Risk', status: over.length ? 'red' : 'green', text: over.length ? `${over.length} open threat(s) at or above the risk tolerance score of ${tol}` : `No open threats at or above ${tol}` });
      }
    }
    const status = items.reduce((acc, i) => worst(acc, i.status), 'green');
    return { status, items };
  }

  // ---------- attention list ----------
  function attention(data, settings, now) {
    const t = today(now);
    const s = Object.assign({ staleDays: 14, proximityDays: 14 }, settings || {});
    const out = [];
    const projects = data.projects.filter((p) => p.status !== 'Closed');
    const pById = Object.fromEntries(data.projects.map((p) => [p.id, p]));
    const active = (x) => pById[x.projectId] && pById[x.projectId].status !== 'Closed';
    const push = (level, kind, item, text, col) => out.push({ level, kind, text, col, id: item && item.id, projectId: item && (item.projectId || item.id) });

    for (const p of projects) {
      const tol = toleranceStatus(p, data);
      for (const i of tol.items) {
        if (i.status === 'red') push('red', 'Exception', p, `${p.name}: ${i.dim} tolerance exceeded. Escalate with an Exception Report. ${i.text}`, 'projects');
        else if (i.status === 'amber') push('amber', 'Tolerance', p, `${p.name}: ${i.dim} close to tolerance. ${i.text}`, 'projects');
      }
      const st = p.stages && p.stages[p.currentStage];
      if (st && st.plannedEnd) {
        const left = daysBetween(t, st.plannedEnd);
        const open = st.checklist.filter((c) => !c.done).length;
        if (left <= 7 && open > 0) push(left < 0 ? 'red' : 'amber', 'Stage gate', p, `${p.name}: ${st.name} ${left < 0 ? 'ended ' + -left + ' days ago' : 'ends in ' + left + ' days'} with ${open} gate item(s) open`, 'projects');
      }
      if (p.highlightDays) {
        const last = data.reports.filter((r) => r.projectId === p.id && r.type === 'highlight').map((r) => r.date).sort().pop();
        const since = last || p.start;
        if (since && daysBetween(since, t) >= Number(p.highlightDays)) push('amber', 'Report due', p, `${p.name}: Highlight Report due (last ${last ? fmtDate(last) : 'never'})`, 'projects');
      }
    }

    for (const r of data.logs) {
      if (!active(r) || r.kind !== 'Action' || r.done || !r.due) continue;
      const d = daysBetween(t, r.due);
      if (d < 0) push('red', 'Overdue action', r, `${r.title}${r.owner ? ' (' + r.owner + ')' : ''}: due ${fmtDate(r.due)}`, 'logs');
      else if (d <= 2) push('amber', 'Action due', r, `${r.title}${r.owner ? ' (' + r.owner + ')' : ''}: due ${d === 0 ? 'today' : fmtDate(r.due)}`, 'logs');
    }
    for (const r of data.risks) {
      if (!active(r) || r.status === 'Closed') continue;
      if (r.reviewDate && r.reviewDate < t) push('amber', 'Risk review', r, `${r.ref} ${r.title}: review was due ${fmtDate(r.reviewDate)}`, 'risks');
      if (r.proximity) {
        const d = daysBetween(t, r.proximity);
        if (d >= 0 && d <= s.proximityDays) push(riskScore(r) >= 10 ? 'red' : 'amber', 'Risk proximity', r, `${r.ref} ${r.title}: could occur within ${d} days (score ${riskScore(r)})`, 'risks');
      }
      if (riskScore(r) >= 15 && !String(r.actions || '').trim()) push('red', 'No response', r, `${r.ref} ${r.title}: very high risk with no response actions`, 'risks');
      if (r.updatedAt && daysBetween(r.updatedAt, t) > s.staleDays) push('info', 'Stale', r, `${r.ref} ${r.title}: not updated for ${daysBetween(r.updatedAt, t)} days`, 'risks');
    }
    for (const r of data.issues) {
      if (!active(r) || !SCHEMAS.issues.isOpen(r)) continue;
      const age = r.dateRaised ? daysBetween(r.dateRaised, t) : 0;
      if (r.priority === 'High' && !String(r.decision || '').trim() && age > 7) push('red', 'Decision needed', r, `${r.ref} ${r.title}: high priority, open ${age} days without a decision`, 'issues');
      else if (r.updatedAt && daysBetween(r.updatedAt, t) > s.staleDays) push('info', 'Stale', r, `${r.ref} ${r.title}: not updated for ${daysBetween(r.updatedAt, t)} days`, 'issues');
    }
    const freezes = parseFreezes(s.freezes);
    for (const c of data.changes) {
      if (!active(c) || !SCHEMAS.changes.isOpen(c)) continue;
      if (c.scheduledStart) {
        const fz = freezes.find((f) => overlaps(c.scheduledStart, c.scheduledEnd || c.scheduledStart, f.from, f.to));
        if (fz) push('red', 'Freeze clash', c, `${c.ref} ${c.title}: scheduled ${fmtDate(c.scheduledStart)} falls in freeze "${fz.label}"`, 'changes');
        const d = daysBetween(t, c.scheduledStart);
        if (d <= 5 && ['Draft', 'Assessed', 'Awaiting CAB'].includes(c.status)) push(d < 0 ? 'red' : 'amber', 'Not authorised', c, `${c.ref} ${c.title}: scheduled ${fmtDate(c.scheduledStart)} but still "${c.status}"`, 'changes');
        if (c.scheduledEnd && c.scheduledEnd < t && ['Authorised', 'Scheduled'].includes(c.status)) push('amber', 'Update change', c, `${c.ref} ${c.title}: window ended ${fmtDate(c.scheduledEnd)}. Record the outcome.`, 'changes');
      }
      if (c.status === 'Implemented' && c.scheduledEnd && daysBetween(c.scheduledEnd, t) > 7) push('info', 'PIR due', c, `${c.ref} ${c.title}: implemented, post-implementation review outstanding`, 'changes');
      if (c.type === 'Emergency' && ['Draft', 'Assessed', 'Awaiting CAB'].includes(c.status)) push('red', 'Emergency change', c, `${c.ref} ${c.title}: emergency change needs ECAB authorisation`, 'changes');
    }
    for (const q of data.quality) {
      if (!active(q)) continue;
      if ((q.result === 'Pending' || !q.result) && q.plannedReview && q.plannedReview < t && !q.actualReview) push('amber', 'Quality review', q, `${q.ref} ${q.title}: review planned ${fmtDate(q.plannedReview)} not recorded`, 'quality');
      if (q.result === 'Fail') push('red', 'Quality fail', q, `${q.ref} ${q.title}: failed quality check`, 'quality');
    }
    const rank = { red: 0, amber: 1, info: 2 };
    return out.sort((a, b) => rank[a.level] - rank[b.level]);
  }

  function parseFreezes(text) {
    return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = l.match(/^(\d{4}-\d{2}-\d{2})\s*(?:\.\.|to|–|-)\s*(\d{4}-\d{2}-\d{2})\s*(.*)$/);
      return m ? { from: m[1], to: m[2], label: m[3].trim() || 'Change freeze' } : null;
    }).filter(Boolean);
  }
  function overlaps(a1, a2, b1, b2) { return a1 <= b2 && b1 <= a2; }

  // ---------- quick capture ----------
  const KIND_MAP = { r: 'risks', risk: 'risks', i: 'issues', issue: 'issues', a: 'action', action: 'action', t: 'action', n: 'note', note: 'note', d: 'decision', decision: 'decision', l: 'lessons', lesson: 'lessons', c: 'changes', rfc: 'changes', change: 'changes', q: 'quality' };
  const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  function parseDue(tok, t) {
    tok = tok.toLowerCase();
    if (/^\d{4}-\d{2}-\d{2}$/.test(tok)) return tok;
    if (tok === 'today') return t;
    if (tok === 'tomorrow' || tok === 'tmrw') return addDays(t, 1);
    let m = tok.match(/^\+(\d+)([dw])$/);
    if (m) return addDays(t, Number(m[1]) * (m[2] === 'w' ? 7 : 1));
    const wd = WEEKDAYS.indexOf(tok.slice(0, 3));
    if (wd >= 0) {
      const cur = parseDate(t).getDay();
      let diff = (wd - cur + 7) % 7;
      if (diff === 0) diff = 7;
      return addDays(t, diff);
    }
    m = tok.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (m) {
      const y = parseDate(t).getFullYear();
      let d = `${y}-${pad(m[2])}-${pad(m[1])}`;
      if (d < t) d = `${y + 1}-${pad(m[2])}-${pad(m[1])}`;
      return d;
    }
    return null;
  }

  // "r: supplier may slip p4 i3 @Sam due:fri" -> {col, doc, summary}
  function parseQuick(input, now) {
    const t = today(now);
    const m = String(input || '').match(/^\s*([a-z]+)\s*:\s*(.*)$/i);
    if (!m || !KIND_MAP[m[1].toLowerCase()]) return null;
    const kind = KIND_MAP[m[1].toLowerCase()];
    let text = m[2];
    const doc = {};
    const take = (re, fn) => { text = text.replace(re, (...a) => { fn(...a); return ' '; }); };
    take(/(?:^|\s)@(\S+)/g, (_, o) => { doc.owner = o; });
    take(/(?:^|\s)(?:due|by):(\S+)/gi, (_, d) => { const v = parseDue(d, t); if (v) doc.due = v; });
    let col;
    if (kind === 'risks') {
      col = 'risks';
      take(/(?:^|\s)p([1-5])\b/gi, (_, v) => { doc.probability = Number(v); });
      take(/(?:^|\s)i([1-5])\b/gi, (_, v) => { doc.impact = Number(v); });
      take(/(?:^|\s)(opp|opportunity)\b/gi, () => { doc.category = 'Opportunity'; doc.response = 'Exploit'; });
      if (doc.due) { doc.proximity = doc.due; delete doc.due; }
    } else if (kind === 'issues') {
      col = 'issues';
      take(/(?:^|\s)(rfc|change)\b/gi, () => { doc.type = 'Request for change'; });
      take(/(?:^|\s)(offspec|off-spec|defect)\b/gi, () => { doc.type = 'Off-specification'; });
      take(/(?:^|\s)!(high|med|medium|low)\b/gi, (_, v) => { doc.priority = v.toLowerCase().startsWith('h') ? 'High' : v.toLowerCase().startsWith('l') ? 'Low' : 'Medium'; });
    } else if (kind === 'changes') {
      col = 'changes';
      take(/(?:^|\s)(emergency|ecab)\b/gi, () => { doc.type = 'Emergency'; doc.authority = 'ECAB'; });
      take(/(?:^|\s)(standard)\b/gi, () => { doc.type = 'Standard'; doc.authority = 'Delegated (pre-approved)'; });
      if (doc.due) { doc.scheduledStart = doc.due; delete doc.due; }
    } else if (kind === 'lessons') {
      col = 'lessons';
      take(/(?:^|\s)(\+|positive)(?=\s|$)/gi, () => { doc.sentiment = 'Positive'; });
      delete doc.due;
    } else if (kind === 'quality') {
      col = 'quality';
      if (doc.due) { doc.plannedReview = doc.due; delete doc.due; }
      if (doc.owner) { doc.producer = doc.owner; delete doc.owner; }
    } else {
      col = 'logs';
      doc.kind = kind === 'action' ? 'Action' : kind === 'note' ? 'Note' : 'Decision';
      if (doc.kind !== 'Action') delete doc.due;
    }
    doc.title = text.replace(/\s+/g, ' ').trim();
    if (!doc.title) return null;
    return { col, doc, label: col === 'logs' ? doc.kind : SCHEMAS[col].label };
  }

  // ---------- reports (markdown) ----------
  const byProject = (arr, p) => arr.filter((x) => x.projectId === p.id);
  const within = (d, from, to) => d && d >= from && d <= to;
  function table(rows, headers) {
    if (!rows.length) return '_None._\n';
    const esc = (v) => String(v == null ? '' : v).replace(/\|/g, '/').replace(/\n/g, ' ');
    return '| ' + headers.join(' | ') + ' |\n| ' + headers.map(() => '---').join(' | ') + ' |\n' +
      rows.map((r) => '| ' + r.map(esc).join(' | ') + ' |').join('\n') + '\n';
  }
  function bullets(arr) { return arr.length ? arr.map((x) => '- ' + x).join('\n') + '\n' : '_None._\n'; }
  const ragWord = { green: 'GREEN', amber: 'AMBER', red: 'RED' };

  function header(title, p, settings, t) {
    return `# ${title}\n\n**Project:** ${p.name}${p.code ? ' (' + p.code + ')' : ''}  \n**Date:** ${fmtDate(t)}  \n**Author:** ${(settings && settings.pmName) || 'Project manager'}  \n**To:** Project board (Executive: ${p.executive || 'TBC'})\n\n`;
  }

  function topRisks(data, p, n) {
    return byProject(data.risks, p).filter((r) => r.status !== 'Closed').sort((a, b) => riskScore(b) - riskScore(a)).slice(0, n || 5);
  }

  function highlightReport(data, p, settings, now, fromDate) {
    const t = today(now);
    const last = data.reports.filter((r) => r.projectId === p.id && r.type === 'highlight').map((r) => r.date).sort().pop();
    const from = fromDate || (last ? addDays(last, 1) : addDays(t, -(Number(p.highlightDays) || 14)));
    const tol = toleranceStatus(p, data);
    const st = p.stages[p.currentStage] || {};
    const logs = byProject(data.logs, p);
    const done = logs.filter((l) => l.kind === 'Action' && l.done && within(l.completedAt || l.date, from, t));
    const decisions = logs.filter((l) => l.kind === 'Decision' && within(l.date, from, t));
    const next = logs.filter((l) => l.kind === 'Action' && !l.done && l.due && l.due <= addDays(t, Number(p.highlightDays) || 14)).sort((a, b) => (a.due < b.due ? -1 : 1));
    const gateDone = (st.checklist || []).filter((c) => c.done && within(c.doneAt, from, t));
    const gateOpen = (st.checklist || []).filter((c) => !c.done);
    const issuesNew = byProject(data.issues, p).filter((i) => within(i.dateRaised, from, t));
    const issuesOpen = byProject(data.issues, p).filter(SCHEMAS.issues.isOpen);
    const qDone = byProject(data.quality, p).filter((q) => within(q.actualReview, from, t) || within(q.actualApproval, from, t));
    const changes = byProject(data.changes, p).filter(SCHEMAS.changes.isOpen);
    const lessons = byProject(data.lessons, p).filter((l) => within(l.dateLogged, from, t));

    let md = header('Highlight Report', p, settings, t);
    md += `**Reporting period:** ${fmtDate(from)} to ${fmtDate(t)}  \n**Current stage:** ${st.name || '—'}  \n**Overall status:** ${ragWord[tol.status]}\n\n`;
    md += `## Status summary\n\n${tol.status === 'green' ? 'The stage is on track and within tolerances.' : tol.status === 'amber' ? 'The stage is within tolerance, but some forecasts are close to the limits set by the board.' : 'One or more tolerances are forecast to be exceeded. An Exception Report will follow.'}\n\n`;
    md += `## Work completed this period\n\n${bullets(gateDone.map((c) => c.t + ' (gate item)').concat(done.map((l) => l.title + (l.owner ? ' (' + l.owner + ')' : ''))).concat(qDone.map((q) => `${q.title}: quality ${q.method ? q.method.toLowerCase() : 'check'} ${q.result ? '(' + q.result + ')' : ''}`)))}\n`;
    md += `## Work planned for next period\n\n${bullets(next.map((l) => `${l.title}${l.owner ? ' (' + l.owner + ')' : ''}, due ${fmtDate(l.due)}`).concat(gateOpen.slice(0, 6).map((c) => c.t + ' (gate item)')))}\n`;
    md += `## Tolerance status\n\n${table(tol.items.map((i) => [i.dim, ragWord[i.status], i.text]), ['Dimension', 'Status', 'Detail'])}\n`;
    md += `## Key risks\n\n${table(topRisks(data, p, 5).map((r) => [r.ref, r.title, riskScore(r), r.response || '', r.owner || '']), ['Ref', 'Risk', 'Score', 'Response', 'Owner'])}\n`;
    md += `## Issues\n\n${issuesNew.length} raised this period, ${issuesOpen.length} open in total.\n\n${table(issuesOpen.slice(0, 8).map((i) => [i.ref, i.title, i.type, i.priority, i.status]), ['Ref', 'Issue', 'Type', 'Priority', 'Status'])}\n`;
    if (changes.length) md += `## Changes in flight (ITIL)\n\n${table(changes.map((c) => [c.ref, c.title, c.type, c.status, fmtDate(c.scheduledStart)]), ['Ref', 'Change', 'Type', 'Status', 'Scheduled'])}\n`;
    if (decisions.length) md += `## Decisions this period\n\n${bullets(decisions.map((d) => `${fmtDate(d.date)}: ${d.title}`))}\n`;
    if (lessons.length) md += `## Lessons logged\n\n${bullets(lessons.map((l) => l.title))}\n`;
    md += `## Business Case\n\nForecast cost ${money(p.forecastCost)} against budget ${money(p.budget)}; spent to date ${money(p.actualCost)}. No change to the expected benefits has been identified this period.\n\n`;
    md += `## Requests to the board\n\n_None this period._\n`;
    return { title: `Highlight Report: ${fmtDate(t)}`, md, from, to: t };
  }

  function endStageReport(data, p, settings, now, stageIndex) {
    const t = today(now);
    const i = stageIndex == null ? p.currentStage : stageIndex;
    const st = p.stages[i];
    const next = p.stages[i + 1];
    const from = st.plannedStart || p.start || addDays(t, -60);
    const tol = toleranceStatus(p, data);
    const q = byProject(data.quality, p);
    const lessons = byProject(data.lessons, p).filter((l) => within(l.dateLogged, from, t));
    const issues = byProject(data.issues, p);
    let md = header('End Stage Report', p, settings, t);
    md += `**Stage:** ${st.name}  \n**Planned end:** ${fmtDate(st.plannedEnd) || '—'}  **Actual end:** ${fmtDate(st.actualEnd || t)}\n\n`;
    md += `## Project manager's report\n\n${st.name} is complete. ${tol.status === 'green' ? 'The project remains within all tolerances.' : 'Some tolerances need the board\'s attention (see below).'}\n\n`;
    md += `## Review of the stage against plan\n\n${table([
      ['Time', fmtDate(st.plannedEnd) || '—', fmtDate(st.actualEnd || st.forecastEnd) || fmtDate(t)],
      ['Cost', money(st.budget), money(st.forecastCost)],
    ], ['Measure', 'Planned', 'Actual / forecast'])}\n`;
    md += `## Stage gate checklist\n\n${bullets(st.checklist.map((c) => `[${c.done ? 'x' : ' '}] ${c.t}`))}\n`;
    md += `## Review of the project against tolerances\n\n${table(tol.items.map((x) => [x.dim, ragWord[x.status], x.text]), ['Dimension', 'Status', 'Detail'])}\n`;
    md += `## Business Case review\n\nBudget ${money(p.budget)}, forecast at completion ${money(p.forecastCost)}, spent to date ${money(p.actualCost)}. The project remains justified.\n\n`;
    md += `## Products and quality\n\n${table(q.filter((x) => within(x.actualReview || x.actualApproval, from, t) || x.result === 'Pending').map((x) => [x.ref, x.title, x.method, x.result || 'Pending', fmtDate(x.actualApproval)]), ['Ref', 'Product', 'Method', 'Result', 'Approved'])}\n`;
    md += `## Issues and risks\n\n${issues.filter(SCHEMAS.issues.isOpen).length} issues open, ${issues.filter((x) => within(x.dateRaised, from, t)).length} raised during the stage.\n\n${table(topRisks(data, p, 6).map((r) => [r.ref, r.title, riskScore(r), r.response || '', r.owner || '']), ['Ref', 'Risk', 'Score', 'Response', 'Owner'])}\n`;
    md += `## Lessons\n\n${bullets(lessons.map((l) => `${l.title}${l.recommendation ? ': ' + l.recommendation : ''}`))}\n`;
    md += `## Forecast for the next stage\n\n${next ? `${next.name}: planned ${fmtDate(next.plannedStart) || 'TBC'} to ${fmtDate(next.plannedEnd) || 'TBC'}, budget ${money(next.budget)}.` : 'This is the final stage. Recommend project closure.'}\n\n`;
    md += `## Request\n\nThe board is asked to approve this End Stage Report${next ? ' and authorise ' + next.name : ' and confirm project closure'}.\n`;
    return { title: `End Stage Report: ${st.name}`, md };
  }

  function endProjectReport(data, p, settings, now) {
    const t = today(now);
    const tol = toleranceStatus(p, data);
    const lessons = byProject(data.lessons, p);
    const issuesOpen = byProject(data.issues, p).filter(SCHEMAS.issues.isOpen);
    const risksOpen = byProject(data.risks, p).filter((r) => r.status !== 'Closed');
    const changes = byProject(data.changes, p);
    let md = header('End Project Report', p, settings, t);
    md += `## Project manager's report\n\nThe project has delivered its products and is ready to close. Overall tolerance position: ${ragWord[tol.status]}.\n\n`;
    md += `## Performance against the baseline\n\n${table([
      ['End date', fmtDate(p.plannedEnd), fmtDate(p.forecastEnd)],
      ['Cost', money(p.budget), money(p.actualCost || p.forecastCost)],
    ], ['Measure', 'Baseline', 'Actual'])}\n`;
    md += `## Stages\n\n${table(p.stages.map((s) => [s.name, s.status, fmtDate(s.plannedEnd), fmtDate(s.actualEnd)]), ['Stage', 'Status', 'Planned end', 'Actual end'])}\n`;
    md += `## Objectives and Business Case\n\n${p.objectives || '_Objectives not recorded in the PID._'}\n\nExpected benefits: ${p.outcomes || 'see Business Case'}.\n\n`;
    md += `## Service transition (ITIL)\n\n${table(changes.map((c) => [c.ref, c.title, c.type, c.status]), ['Ref', 'Change', 'Type', 'Outcome'])}\nReceiving service owner: ${p.serviceOwner || 'TBC'}.\n\n`;
    md += `## Follow-on action recommendations\n\n${bullets(issuesOpen.map((i) => `${i.ref} ${i.title} (issue, ${i.status})`).concat(risksOpen.map((r) => `${r.ref} ${r.title} (risk, score ${riskScore(r)}) to transfer to ${r.owner || 'service owner'}`)))}\n`;
    md += `## Lessons Report\n\n${table(lessons.map((l) => [l.ref, l.title, l.category, l.sentiment, l.recommendation || '']), ['Ref', 'Lesson', 'Category', 'Effect', 'Recommendation'])}\n`;
    md += `## Request\n\nThe board is asked to approve this report, confirm closure and notify corporate, and confirm the benefits review plan.\n`;
    return { title: `End Project Report`, md };
  }

  function exceptionReport(data, p, settings, now) {
    const t = today(now);
    const tol = toleranceStatus(p, data);
    const breaches = tol.items.filter((i) => i.status === 'red');
    let md = header('Exception Report', p, settings, t);
    md += `## Exception title\n\n${breaches.map((b) => b.dim).join(', ') || 'Forecast tolerance breach'}\n\n`;
    md += `## Cause of the exception\n\n${bullets(breaches.map((b) => b.text))}\n_Add the underlying cause._\n\n`;
    md += `## Consequences\n\nIf no action is taken: _describe the impact on the project, the Business Case and corporate objectives._\n\n`;
    md += `## Options\n\n| Option | Effect on time | Effect on cost | Effect on benefits/risk |\n| --- | --- | --- | --- |\n| 1. Do nothing |  |  |  |\n| 2. _Option_ |  |  |  |\n| 3. _Option_ |  |  |  |\n\n`;
    md += `## Recommendation\n\n_Recommended option and why._ An Exception Plan will follow if the board requests one.\n\n`;
    md += `## Related risks and issues\n\n${table(topRisks(data, p, 5).map((r) => [r.ref, r.title, riskScore(r)]), ['Ref', 'Risk', 'Score'])}\n`;
    md += `## Lessons\n\n_What could have been done to see this earlier?_\n`;
    return { title: `Exception Report: ${fmtDate(t)}`, md };
  }

  function pidDocument(data, p, settings, now) {
    const t = today(now);
    const sec = (title, v) => `### ${title}\n\n${v && String(v).trim() ? v : '_To be completed._'}\n\n`;
    let md = `# Project Initiation Documentation\n\n**Project:** ${p.name}${p.code ? ' (' + p.code + ')' : ''}  \n**Version date:** ${fmtDate(t)}  \n**Author:** ${(settings && settings.pmName) || 'Project manager'}\n\n`;
    md += `## 1. Project definition\n\n`;
    for (const f of PROJECT_FIELDS.pid.filter((f) => f.section === 'Project definition')) md += sec(f.label, p[f.k]);
    md += `## 2. Project management team\n\n${table([
      ['Executive', p.executive], ['Senior user', p.seniorUser], ['Senior supplier', p.seniorSupplier],
      ['Project manager', settings && settings.pmName], ['Project assurance', p.assurance], ['Change authority', p.changeAuthority],
      ['Team managers', p.teamManagers], ['Receiving service owner', p.serviceOwner],
    ].map(([a, b]) => [a, b || 'TBC']), ['Role', 'Name'])}\n`;
    md += `## 3. Approaches\n\n`;
    for (const f of PROJECT_FIELDS.pid.filter((f) => f.section === 'Approaches')) md += sec(f.label, p[f.k]);
    md += `## 4. Project controls and tolerances\n\n${table([
      ['Time', `±${p.timeTolDays || 0} days on ${fmtDate(p.plannedEnd) || 'TBC'}`],
      ['Cost', `±${p.costTolPct || 0}% on ${money(p.budget)}`],
      ['Risk', `Escalate any threat scoring ${p.riskTolScore || '—'} or more (5×5 P×I)`],
      ['Scope', p.scopeTol || 'No tolerance: changes via change control'],
      ['Quality', p.qualityTol || 'As defined in product descriptions'],
      ['Benefits', p.benefitsTol || 'TBC'],
      ['Sustainability', p.sustainabilityTol || 'TBC'],
    ], ['Tolerance', 'Setting'])}\nHighlight Reports every ${p.highlightDays || 14} days. End Stage Reports at each stage boundary. Exception Reports on any forecast tolerance breach.\n\n`;
    md += `## 5. Project plan (stages)\n\n${table(p.stages.map((s) => [s.name, fmtDate(s.plannedStart), fmtDate(s.plannedEnd), money(s.budget)]), ['Stage', 'Start', 'End', 'Budget'])}\n`;
    md += `## 6. Initial risks\n\n${table(byProject(data.risks, p).map((r) => [r.ref, r.title, r.probability, r.impact, riskScore(r), r.response]), ['Ref', 'Risk', 'P', 'I', 'Score', 'Response'])}\n`;
    return { title: 'PID', md };
  }

  // ---------- sample data ----------
  function sampleData(now) {
    const t = today(now);
    const { project, risks } = buildProject({ name: 'Example: Service desk platform migration', code: 'EX-SDM', template: 'it', deliveryStages: 2, start: addDays(t, -70), plannedEnd: addDays(t, 75), budget: 180000, executive: 'Head of IT Operations' }, now);
    const p = project;
    p.example = true;
    p.seniorUser = 'Service desk manager'; p.seniorSupplier = 'Platform vendor account lead';
    p.changeAuthority = 'IT CAB (weekly, Tuesdays)'; p.serviceOwner = 'IT service owner, end-user services';
    p.forecastCost = 189000; p.actualCost = 74000; p.forecastEnd = addDays(t, 82);
    p.objectives = 'Move the service desk to the new platform by the planned date, within ±10% of budget, with no loss of ticket history and first-contact resolution held at 70% or better.';
    p.outcomes = 'Lower licence costs, a self-service portal and better SLA reporting.';
    p.scope = 'Incident, request and knowledge modules; data migration; integrations with identity and monitoring.';
    p.exclusions = 'Asset management module (phase 2).';
    p.mandate = 'Current platform contract ends next year; the board asked for a replacement that supports self-service.';
    p.currentStage = 2;
    p.stages[0].status = 'complete'; p.stages[0].checklist.forEach((c) => { c.done = true; });
    p.stages[0].plannedStart = addDays(t, -70); p.stages[0].plannedEnd = addDays(t, -60); p.stages[0].actualEnd = addDays(t, -59);
    p.stages[1].status = 'complete'; p.stages[1].checklist.forEach((c) => { c.done = true; });
    p.stages[1].plannedStart = addDays(t, -59); p.stages[1].plannedEnd = addDays(t, -35); p.stages[1].actualEnd = addDays(t, -33); p.stages[1].budget = 15000; p.stages[1].forecastCost = 16500;
    const s2 = p.stages[2];
    s2.status = 'active'; s2.plannedStart = addDays(t, -32); s2.plannedEnd = addDays(t, 6); s2.forecastEnd = addDays(t, 9); s2.budget = 90000; s2.forecastCost = 97000;
    s2.checklist.slice(0, 3).forEach((c) => { c.done = true; c.doneAt = addDays(t, -5); });
    const s3 = p.stages[3];
    s3.plannedStart = addDays(t, 7); s3.plannedEnd = addDays(t, 75); s3.budget = 60000; s3.forecastCost = 60000;
    risks[0].proximity = addDays(t, 10); risks[0].owner = 'Service desk manager';
    risks[1].probability = 4; risks[1].updatedAt = addDays(t, -20); risks[1].owner = 'Senior supplier';
    risks[3].probability = 4; risks[3].impact = 4; risks[3].reviewDate = addDays(t, -2); risks[3].owner = 'IT service owner';
    const mk = (col, extra, i) => Object.assign(SCHEMAS[col].defaults(t), { id: uid(col[0]), projectId: p.id, ref: SCHEMAS[col].refPrefix + pad3(i), createdAt: t, updatedAt: t }, extra);
    const issues = [
      mk('issues', { title: 'Service desk asks to add the asset module to scope', type: 'Request for change', priority: 'High', severity: 'Project board', status: 'Awaiting decision', dateRaised: addDays(t, -10), raisedBy: 'Service desk manager', impactAnalysis: '+3 weeks, +£22k; brings phase 2 benefits forward.' }, 1),
      mk('issues', { title: 'Migrated tickets lose attachment links', type: 'Off-specification', priority: 'Medium', status: 'Under assessment', dateRaised: addDays(t, -4), raisedBy: 'Test lead' }, 2),
    ];
    const changes = [
      mk('changes', { title: 'Production cut-over to new service desk platform', type: 'Normal', risk: 'High', services: 'Service desk; identity SSO; monitoring alerts', status: 'Draft', scheduledStart: addDays(t, 60), scheduledEnd: addDays(t, 61), backoutPlan: 'Re-point email and portal DNS to the old platform; re-enable inbound integration.' }, 1),
      mk('changes', { title: 'Configure SSO integration in pre-production', type: 'Standard', authority: 'Delegated (pre-approved)', risk: 'Low', status: 'Implemented', scheduledStart: addDays(t, -12), scheduledEnd: addDays(t, -12) }, 2),
    ];
    const quality = [
      mk('quality', { title: 'Data migration test report', method: 'Test', producer: 'Migration team', reviewers: 'Test lead, service desk SME', approver: 'Senior user', plannedReview: addDays(t, -1), result: 'Pending' }, 1),
      mk('quality', { title: 'Knowledge base structure', method: 'Review', producer: 'Knowledge manager', approver: 'Service desk manager', actualReview: addDays(t, -6), actualApproval: addDays(t, -4), result: 'Pass' }, 2),
    ];
    const logs = [
      mk('logs', { title: 'Confirm UAT tester names with team leaders', kind: 'Action', owner: 'PM', due: addDays(t, -1), date: addDays(t, -8) }, 1),
      mk('logs', { title: 'Send RFC for cut-over to CAB secretary', kind: 'Action', owner: 'PM', due: addDays(t, 2), date: addDays(t, -2) }, 2),
      mk('logs', { title: 'Vendor confirmed migration tooling licence', kind: 'Action', owner: 'Senior supplier', due: addDays(t, -6), done: true, completedAt: addDays(t, -6), date: addDays(t, -12) }, 3),
      mk('logs', { title: 'Board agreed to hold go-live outside quarter-end', kind: 'Decision', date: addDays(t, -9) }, 4),
    ];
    const lessons = [
      mk('lessons', { title: 'Book UAT testers before the stage starts', category: 'People', sentiment: 'Negative', event: 'UAT start slipped a week waiting for testers.', recommendation: 'Make tester nomination a gate item for initiation.', dateLogged: addDays(t, -15) }, 1),
    ];
    const settings = { id: 'main', pmName: 'Project manager', staleDays: 14, proximityDays: 14, freezes: `${addDays(t, 58)}..${addDays(t, 63)} Quarter-end freeze` };
    return { projects: [p], risks, issues, changes, quality, logs, lessons, reports: [], settings: [settings] };
  }

  const api = {
    COLLECTIONS, SCHEMAS, PROJECT_FIELDS, TEMPLATES, GATES, PROB, IMPACT, THREAT_RESPONSES, OPP_RESPONSES,
    iso, today, parseDate, addDays, daysBetween, fmtDate, money, uid, pad3,
    riskScore, riskBand, buildProject, nextRef, toleranceStatus, attention, parseFreezes, parseDue, parseQuick,
    highlightReport, endStageReport, endProjectReport, exceptionReport, pidDocument, sampleData,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PT = api;
})(typeof window !== 'undefined' ? window : globalThis);
