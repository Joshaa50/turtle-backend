#!/usr/bin/env node
// Wipes every nest/turtle/emergence/review/audit entry/timetable assignment/
// roster template and every user except the 4 @turtleguard.demo personas,
// then lets the server reseed fresh, realistic data in the background - the
// full "undo whatever a demo visitor broke" command for the owner to run
// directly.
//
//   node scripts/demo-reset.mjs            # preview only, nothing happens
//   node scripts/demo-reset.mjs --confirm  # wipe (server reseeds itself after)
//
// Goes through the live API, same as every other scripts/*.mjs - logs in as
// the demo Coordinator to call the reset endpoint, which is allowed since a
// script the owner runs directly is trusted either way.
const API = process.env.VITE_API_URL || process.env.API_URL || 'https://turtle-backend-pxcx.onrender.com';
const CONFIRM = process.argv.includes('--confirm');

const login = async () => {
  const r = await fetch(`${API}/demo/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'Coordinator' }),
  });
  if (!r.ok) throw new Error(`demo login failed: ${r.status}`);
  return (await r.json()).token;
};

const main = async () => {
  console.log(`API: ${API}`);
  if (!CONFIRM) {
    console.log('Preview only. This would:');
    console.log('  1. Wipe nests/turtles/emergences/reviews/audit/timetable/rosters');
    console.log('  2. Delete every user except the 4 @turtleguard.demo personas');
    console.log('  3. The server reseeds fresh nests/turtles/emergences and activity automatically, in the background');
    console.log('\nRe-run with --confirm to apply.');
    return;
  }

  const token = await login();
  console.log('Wiping...');
  const res = await fetch(`${API}/admin/reset-demo-data`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: 'RESET DEMO DATA' }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `reset failed: ${res.status}`);
  console.log('Wiped:', body.deleted);
  console.log(body.message);
};

main().catch((e) => { console.error(e); process.exit(1); });
