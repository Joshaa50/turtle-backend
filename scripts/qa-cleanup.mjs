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
//
// Only records whose name/code starts with QA- are ever touched. Emergences carry
// no name, so they are only removed when their ids are named explicitly — take
// those from the `wrote` array in qa-report.json.

const API = process.env.VITE_API_URL || process.env.API_URL || 'https://turtle-backend-pxcx.onrender.com';
const PREFIX = 'QA-';
const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const idsArg = args[args.indexOf('--emergence-ids') + 1];
const emergenceIds = args.includes('--emergence-ids') && idsArg ? idsArg.split(',').map((s) => s.trim()) : [];

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

const main = async () => {
  console.log(`API: ${API}`);
  console.log(confirm ? 'MODE: deleting\n' : 'MODE: dry run — nothing will be deleted\n');

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

  const [turtles, nests] = await Promise.all([api('/turtles'), api('/nests')]);
  const qaTurtles = (turtles.body.turtles || []).filter((t) => qaTagged(t.name));
  const qaNests = (nests.body.nests || []).filter((n) => qaTagged(n.nest_code));

  const targets = [
    ...qaNests.map((n) => ({ what: `nest ${n.nest_code}`, path: `/nests/${n.id}` })),
    ...qaTurtles.map((t) => ({ what: `turtle ${t.name}`, path: `/turtles/${t.id}`, archiveFirst: t.id, archived: t.is_archived })),
    ...emergenceIds.map((id) => ({ what: `emergence ${id}`, path: `/emergences/${id}` })),
  ];

  if (targets.length === 0) {
    console.log(`Nothing to clean up — no records named ${PREFIX}* and no emergence ids given.`);
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
