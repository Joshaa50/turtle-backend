#!/usr/bin/env node
// Clears records left behind by exploratory QA runs.
//
// Goes through the API rather than SQL, so it needs no database credentials and
// obeys the same role guards a person would. Dry run unless --confirm is passed:
// a cleanup tool that deletes on a typo is worse than no cleanup tool.
//
//   node scripts/qa-cleanup.mjs                 # list what would be deleted
//   node scripts/qa-cleanup.mjs --confirm       # delete it
//   node scripts/qa-cleanup.mjs --confirm --emergence-ids 12,13
//   node scripts/qa-cleanup.mjs --audit         # report implausible records
//   node scripts/qa-cleanup.mjs --manifest qa-out/seed-manifest.json --confirm
//
// --audit never deletes anything on its own. Judging a record implausible is a
// guess about fieldwork, and a wrong guess destroys an observation nobody can
// take again - so it reports, and a person decides with --delete-ids.
//
// Only records whose name/code starts with QA- are ever touched. Emergences carry
// no name, so they are only removed when their ids are named explicitly — take
// those from the `wrote` array in qa-report.json.

import { readFileSync } from 'node:fs';
import { auditNest, auditTurtle, auditEmergence } from './lib/plausibility.mjs';

const API = process.env.VITE_API_URL || process.env.API_URL || 'https://turtle-backend-pxcx.onrender.com';
const PREFIX = 'QA-';
const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const flagValue = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const idList = (name) => (flagValue(name) || '').split(',').map((s) => s.trim()).filter(Boolean);
const emergenceIds = idList('--emergence-ids');
const audit = args.includes('--audit');
const manifestPath = flagValue('--manifest');
const deleteIds = idList('--delete-ids'); // "nest:35,turtle:16,emergence:41"

const qaTagged = (v) => typeof v === 'string' && v.startsWith(PREFIX);

let token;
const api = async (path, init = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
};

const runAudit = async () => {
  const [nests, turtles, emergences, beachRes] = await Promise.all([
    api('/nests'), api('/turtles'), api('/emergences'), api('/beaches'),
  ]);
  const beaches = beachRes.body.beaches || [];

  const rows = [
    ...(nests.body.nests || []).map((r) => ({ kind: 'nest', id: r.id, label: r.nest_code, findings: auditNest(r, { beaches }) })),
    ...(turtles.body.turtles || []).map((r) => ({ kind: 'turtle', id: r.id, label: r.name, findings: auditTurtle(r) })),
    ...(emergences.body.emergences || []).map((r) => ({ kind: 'emergence', id: r.id, label: `${r.beach || '?'} ${String(r.event_date).slice(0, 10)}`, findings: auditEmergence(r) })),
  ].filter((r) => r.findings.length);

  const impossible = rows.filter((r) => r.findings.some((f) => f.severity === 'impossible'));
  const suspect = rows.filter((r) => !impossible.includes(r));

  const show = (title, list) => {
    if (!list.length) return;
    console.log(`\n${title}`);
    for (const r of list) {
      console.log(`  ${r.kind}:${r.id}  ${r.label}`);
      for (const f of r.findings) console.log(`      ${f.field}: ${f.message}`);
    }
  };

  show('CANNOT BE TRUE — safe to correct or remove:', impossible);
  show('LOOKS WRONG — a person should decide:', suspect);

  if (!rows.length) {
    console.log('\nEvery record is within the expected ranges.');
    return;
  }
  console.log(`\n${impossible.length} impossible, ${suspect.length} questionable, of ${
    (nests.body.nests || []).length + (turtles.body.turtles || []).length + (emergences.body.emergences || []).length} records.`);
  console.log('Nothing was deleted. To remove specific records:');
  console.log(`  node scripts/qa-cleanup.mjs --confirm --delete-ids ${
    impossible.slice(0, 3).map((r) => `${r.kind}:${r.id}`).join(',') || 'nest:1,turtle:2'}`);
  console.log('Ranges live in scripts/lib/plausibility.mjs — widen one if it is flagging real fieldwork.');
};

const main = async () => {
  console.log(`API: ${API}`);
  console.log(audit ? 'MODE: audit — reporting only\n' : confirm ? 'MODE: deleting\n' : 'MODE: dry run — nothing will be deleted\n');

  // Coordinator is the only role allowed to delete both turtles and nests.
  const login = await api('/demo/login', {
    method: 'POST',
    body: JSON.stringify({ role: 'Coordinator' }),
  });
  if (login.status !== 200) {
    console.error(`Could not sign in as the demo Coordinator (${login.status}).`);
    console.error(login.body.error || '');
    console.error('Demo login is off, or this backend does not have the demo accounts seeded.');
    process.exit(1);
  }
  token = login.body.token;

  if (audit) return runAudit();

  const [turtles, nests] = await Promise.all([api('/turtles'), api('/nests')]);
  const qaTurtles = (turtles.body.turtles || []).filter((t) => qaTagged(t.name));
  const qaNests = (nests.body.nests || []).filter((n) => qaTagged(n.nest_code));

  // Records named in a seed manifest, so seeded demo data can look real and
  // still be removable without being called QA-anything.
  let seeded = [];
  if (manifestPath) {
    try {
      seeded = JSON.parse(readFileSync(manifestPath, 'utf8')).created || [];
    } catch (err) {
      console.error(`Could not read manifest ${manifestPath}: ${err.message}`);
      process.exit(1);
    }
  }

  const pathFor = (kind, id) => ({ nest: `/nests/${id}`, turtle: `/turtles/${id}`, emergence: `/emergences/${id}` }[kind]);
  const explicit = [...deleteIds, ...seeded.map((r) => `${r.kind}:${r.id}`)]
    .map((spec) => {
      const [kind, id] = spec.split(':');
      if (!pathFor(kind, id)) { console.error(`Skipping "${spec}" — expected nest:ID, turtle:ID or emergence:ID`); return null; }
      const turtle = kind === 'turtle' ? (turtles.body.turtles || []).find((t) => String(t.id) === id) : null;
      return { what: `${kind} ${id}`, path: pathFor(kind, id), ...(kind === 'turtle' ? { archiveFirst: id, archived: turtle?.is_archived } : {}) };
    })
    .filter(Boolean);

  const targets = [
    ...qaNests.map((n) => ({ what: `nest ${n.nest_code}`, path: `/nests/${n.id}` })),
    ...qaTurtles.map((t) => ({ what: `turtle ${t.name}`, path: `/turtles/${t.id}`, archiveFirst: t.id, archived: t.is_archived })),
    ...emergenceIds.map((id) => ({ what: `emergence ${id}`, path: `/emergences/${id}` })),
    ...explicit,
  ].filter((t, i, all) => all.findIndex((o) => o.path === t.path) === i);

  if (targets.length === 0) {
    console.log(`Nothing to clean up — no records named ${PREFIX}*, and no ids or manifest given.`);
    return;
  }

  for (const t of targets) {
    if (!confirm) {
      console.log(`would delete  ${t.what}`);
      continue;
    }
    // A turtle is years of longitudinal data; the server refuses to delete one
    // that is not archived. Honour that rather than working around it.
    if (t.archiveFirst && !t.archived) {
      const arch = await api(`/turtles/${t.archiveFirst}/archive`, {
        method: 'PUT',
        body: JSON.stringify({ is_archived: true }),
      });
      if (arch.status >= 400) {
        console.log(`SKIP    ${t.what} — could not archive (${arch.status})`);
        continue;
      }
    }
    const res = await api(t.path, { method: 'DELETE' });
    console.log(res.status < 400 ? `deleted ${t.what}` : `FAILED  ${t.what} (${res.status}) ${res.body.error || ''}`);
  }

  if (!confirm) console.log(`\n${targets.length} record(s) matched. Re-run with --confirm to delete.`);
};

main().catch((err) => {
  console.error('Cleanup failed:', err.message);
  process.exit(1);
});
