const test = require('node:test');
const assert = require('node:assert');
const PT = require('../public/core.js');

const NOW = new Date(2026, 9, 11); // Sun 11 Oct 2026
const empty = () => Object.fromEntries(PT.COLLECTIONS.map((c) => [c, []]));

test('quick capture parses a risk with probability, impact and owner', () => {
  const r = PT.parseQuick('r: supplier may miss the window p4 i3 @Sam', NOW);
  assert.strictEqual(r.col, 'risks');
  assert.deepStrictEqual(r.doc, { owner: 'Sam', probability: 4, impact: 3, title: 'supplier may miss the window' });
});

test('quick capture parses actions with relative due dates', () => {
  assert.strictEqual(PT.parseQuick('a: send PID due:fri', NOW).doc.due, '2026-10-16');
  assert.strictEqual(PT.parseQuick('a: chase vendor due:+2w', NOW).doc.due, '2026-10-25');
  assert.strictEqual(PT.parseQuick('a: x due:tomorrow', NOW).doc.due, '2026-10-12');
  assert.strictEqual(PT.parseQuick('a: x due:3/1', NOW).doc.due, '2027-01-03');
  const a = PT.parseQuick('a: chase vendor', NOW);
  assert.strictEqual(a.col, 'logs');
  assert.strictEqual(a.doc.kind, 'Action');
});

test('quick capture recognises RFC issues and emergency changes', () => {
  assert.strictEqual(PT.parseQuick('i: add asset module rfc !high', NOW).doc.type, 'Request for change');
  assert.strictEqual(PT.parseQuick('i: add asset module rfc !high', NOW).doc.priority, 'High');
  const c = PT.parseQuick('c: patch firewall emergency due:today', NOW);
  assert.strictEqual(c.doc.type, 'Emergency');
  assert.strictEqual(c.doc.scheduledStart, '2026-10-11');
  assert.strictEqual(PT.parseQuick('hello world', NOW), null);
  assert.strictEqual(PT.parseQuick('r:   ', NOW), null);
});

test('risk scoring bands follow the 5x5 matrix', () => {
  assert.strictEqual(PT.riskBand(PT.riskScore({ probability: 5, impact: 3 })).key, 'vhigh');
  assert.strictEqual(PT.riskBand(12).key, 'high');
  assert.strictEqual(PT.riskBand(6).key, 'med');
  assert.strictEqual(PT.riskBand(4).key, 'low');
});

test('IT template adds transition and closing gates to the final stage', () => {
  const { project, risks } = PT.buildProject({ name: 'X', template: 'it', deliveryStages: 2 }, NOW);
  assert.strictEqual(project.stages.length, 4);
  const final = project.stages[3].checklist.map((c) => c.t);
  assert.ok(final.includes('Go / no-go decision recorded'));
  assert.ok(final.includes('End Project Report produced'));
  assert.ok(!final.includes('Board authorises next stage'));
  assert.strictEqual(risks.length, 5);
  assert.strictEqual(risks[0].ref, 'R001');
});

test('tolerance status flags cost and time breaches', () => {
  const p = { id: 'p1', budget: 100000, forecastCost: 115000, costTolPct: 10, plannedEnd: '2026-12-01', forecastEnd: '2026-12-10', timeTolDays: 10, stages: [], currentStage: 0 };
  const s = PT.toleranceStatus(p, empty());
  assert.strictEqual(s.status, 'red');
  assert.strictEqual(s.items.find((i) => i.dim === 'Cost').status, 'red');
  assert.strictEqual(s.items.find((i) => i.dim === 'Time').status, 'amber');
});

test('attention list catches overdue actions, freeze clashes and stale risks', () => {
  const d = empty();
  d.projects.push({ id: 'p1', name: 'P', status: 'Active', stages: [], currentStage: 0 });
  d.logs.push({ id: 'l1', projectId: 'p1', kind: 'Action', title: 'Overdue', due: '2026-10-01', done: false });
  d.changes.push({ id: 'c1', projectId: 'p1', ref: 'CHG-001', title: 'Go live', type: 'Normal', status: 'Authorised', scheduledStart: '2026-12-20' });
  d.risks.push({ id: 'r1', projectId: 'p1', ref: 'R001', title: 'Old', status: 'Open', probability: 1, impact: 1, updatedAt: '2026-09-01' });
  const a = PT.attention(d, { freezes: '2026-12-18..2027-01-04 Christmas freeze' }, NOW);
  const kinds = a.map((x) => x.kind);
  assert.ok(kinds.includes('Overdue action'));
  assert.ok(kinds.includes('Freeze clash'));
  assert.ok(kinds.includes('Stale'));
  assert.strictEqual(a[0].level, 'red');
});

test('closed projects are ignored by the attention list', () => {
  const d = empty();
  d.projects.push({ id: 'p1', name: 'P', status: 'Closed', stages: [], currentStage: 0 });
  d.logs.push({ id: 'l1', projectId: 'p1', kind: 'Action', title: 'Overdue', due: '2026-10-01', done: false });
  assert.strictEqual(PT.attention(d, {}, NOW).length, 0);
});

test('nextRef increments per project', () => {
  const items = [{ projectId: 'a', ref: 'R002' }, { projectId: 'b', ref: 'R009' }];
  assert.strictEqual(PT.nextRef('risks', items, 'a'), 'R003');
  assert.strictEqual(PT.nextRef('changes', [], 'a'), 'CHG-001');
});

test('reports render from sample data', () => {
  const d = PT.sampleData(NOW);
  const p = d.projects[0];
  const s = d.settings[0];
  const hl = PT.highlightReport(d, p, s, NOW);
  assert.match(hl.md, /# Highlight Report/);
  assert.match(hl.md, /Vendor confirmed migration tooling licence/);
  assert.match(PT.endStageReport(d, p, s, NOW).md, /# End Stage Report/);
  assert.match(PT.endProjectReport(d, p, s, NOW).md, /Lessons Report/);
  assert.match(PT.exceptionReport(d, p, s, NOW).md, /Risk/);
  assert.match(PT.pidDocument(d, p, s, NOW).md, /Project controls and tolerances/);
  // sample shows a risk tolerance exception and a freeze clash
  const kinds = PT.attention(d, s, NOW).map((x) => x.kind);
  assert.ok(kinds.includes('Exception'));
  assert.ok(kinds.includes('Freeze clash'));
});
