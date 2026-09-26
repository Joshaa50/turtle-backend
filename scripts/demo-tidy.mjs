// One-off demo-data tidy ahead of sending the app out for evaluation.
// Goes through the API as the demo Coordinator, so it obeys the same guards a
// person gets. Nothing is deleted: junk accounts are DEACTIVATED (the app's own
// designed path for removing someone) and real-provider addresses are moved to
// example.com, which is reserved for exactly this. Both are reversible, and a
// full snapshot is written before anything changes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.VITE_API_URL || 'https://turtle-backend-pxcx.onrender.com';
const CONFIRM = process.argv.includes('--confirm');

// Accounts whose display name alone gives the demo away.
const DEACTIVATE = [
  { id: 4,  why: 'display name is literally "Field Leader"' },
  { id: 30, why: 'display name is literally "field assistant"' },
  { id: 52, why: 'display name is "Test User"' },
];

// Believable staff personas, but on a real mail provider. Keep the people,
// move the addresses to the reserved example.com domain.
const REMAIL = [
  // A scratch account, despite the real-looking name - and the last active
  // address left on a real mail provider. The persona stays, the address goes.
  { id: 1,  email: 'joshua.ali@example.com' },
  { id: 2,  email: 'alicia.pettitt@example.com' },
  { id: 40, email: 'christina.papadopoulou@example.com' },
  { id: 41, email: 'nikos.katsaros@example.com' },
  { id: 42, email: 'sophie.bennett@example.com' },
  { id: 43, email: 'liam.oconnor@example.com' },
  { id: 44, email: 'elena.vasilikou@example.com' },
  { id: 45, email: 'marco.rossi@example.com' },
  { id: 46, email: 'ingrid.larsen@example.com' },
  { id: 47, email: 'thomas.wright@example.com' },
];

// Never touched: the four @turtleguard.demo accounts the demo buttons sign in
// as. Losing one of those takes a demo role button down with it.
const PROTECTED = new Set([48, 49, 50, 51]);

const login = async () => {
  const r = await fetch(`${API}/demo/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'Coordinator' }),
  });
  if (!r.ok) throw new Error(`demo login failed: ${r.status}`);
  return (await r.json()).token;
};

const run = async () => {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const listRes = await fetch(`${API}/users`, { headers: auth });
  const users = (await listRes.json()).users;
  const byId = new Map(users.map(u => [String(u.id), u]));

  if (CONFIRM) {
    // fileURLToPath, not URL.pathname: pathname keeps the percent-encoding, so
    // a project directory with a space in its name ("Turtle guard") wrote the
    // snapshot to a literal "Turtle%20guard" folder instead of this repo.
    const dir = fileURLToPath(new URL('../qa-out/', import.meta.url));
    fs.mkdirSync(dir, { recursive: true });
    // Stamped, so a second run cannot overwrite the rollback data the first
    // one captured - which is the whole reason the snapshot exists.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const out = path.join(dir, `users-before-demo-tidy-${stamp}.json`);
    fs.writeFileSync(out, JSON.stringify(users, null, 2));
    console.log(`snapshot of all ${users.length} accounts written to ${out}\n`);
  }

  const plan = [
    ...DEACTIVATE.map(d => ({ ...d, patch: { is_active: false }, kind: 'deactivate' })),
    ...REMAIL.map(r => ({ ...r, patch: { email: r.email }, kind: 're-email' })),
  ];

  for (const step of plan) {
    const u = byId.get(String(step.id));
    if (!u) { console.log(`SKIP  id ${step.id} — not found`); continue; }
    if (PROTECTED.has(Number(step.id))) { console.log(`SKIP  id ${step.id} — protected`); continue; }

    // Idempotent: a row already at its target is not worth a PATCH, and
    // listing it as work makes the output lie about what the run changed.
    const done = step.kind === 'deactivate' ? u.is_active === false : u.email === step.email;
    if (done) { console.log(`DONE  id ${step.id} — already ${step.kind === 'deactivate' ? 'inactive' : step.email}`); continue; }

    const name = `${u.first_name || ''} ${u.last_name || ''}`.trim();
    const desc = step.kind === 'deactivate'
      ? `deactivate  ${name} <${u.email}>  (${step.why})`
      : `re-email    ${name}  ${u.email} -> ${step.email}`;

    if (!CONFIRM) { console.log(`DRY   ${desc}`); continue; }

    const res = await fetch(`${API}/users/${step.id}`, {
      method: 'PATCH', headers: auth, body: JSON.stringify(step.patch),
    });
    console.log(res.ok ? `OK    ${desc}` : `FAIL  ${desc} — ${res.status} ${await res.text()}`);
  }

  if (!CONFIRM) console.log('\nDry run. Re-run with --confirm to apply.');
};

run().catch(e => { console.error(e); process.exit(1); });
