// Fills the two screens that demo as empty states: the Review Queue and the
// Time Table. Both go through the API, so everything here is a record the app
// itself would have created.
//
// Reviews are not inserted directly - they are a side effect of a Field
// Volunteer submitting fieldwork, so the script signs in as the demo Volunteer
// and records genuine emergences. That is the same path a real volunteer takes,
// which is the only way the queue rows end up consistent with the records they
// point at.
//
//   npm run demo:seed            preview
//   npm run demo:seed -- --confirm   apply
//
// Re-running is refused if the target week already has assignments, so a second
// run cannot double-book the rota. Pass --force to add anyway.
import { SITE } from './lib/plausibility.mjs';

const API = process.env.VITE_API_URL || 'https://turtle-backend-pxcx.onrender.com';
const CONFIRM = process.argv.includes('--confirm');
const FORCE = process.argv.includes('--force');

// The week the Time Table opens on. Monday of the current week.
const mondayOf = (d) => {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x;
};
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
};

const WEEK_START = mondayOf(new Date());

// Kefalonia's west-coast survey box, kept away from the edges so a rounded
// coordinate still lands inside it. Deliberately irregular decimals: the
// auditor flags 38.12345-style readings as someone walking up the keypad.
const COORD = (i) => ({
  lat: +(SITE.bbox.latMin + 0.07 + (i * 0.0137) % 0.22).toFixed(5),
  lon: +(SITE.bbox.lonMin + 0.06 + (i * 0.0219) % 0.24).toFixed(5),
});

// Volunteer-submitted morning finds, dated across the last few days so the
// queue reads like a backlog rather than one batch.
const EMERGENCES = [
  { beach: 'Loggos 2',      daysAgo: 1, distance_to_sea_s: 14 },
  { beach: 'Xi',            daysAgo: 2, distance_to_sea_s: 22 },
  { beach: 'Agios Ioannis', daysAgo: 3, distance_to_sea_s: 9  },
];

const login = async (role) => {
  const r = await fetch(`${API}/demo/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  if (!r.ok) throw new Error(`demo login as ${role} failed: ${r.status}`);
  return (await r.json()).token;
};
const hdrs = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

const run = async () => {
  const coordToken = await login('Coordinator');
  const volToken = await login('Volunteer');
  const cAuth = hdrs(coordToken);

  // ---- Review queue -------------------------------------------------------
  console.log(`— Review queue —`);
  const pendingBefore = (await (await fetch(`${API}/reviews?status=pending`, { headers: cAuth })).json()).reviews || [];
  console.log(`  ${pendingBefore.length} pending now`);

  for (const [i, e] of EMERGENCES.entries()) {
    const { lat, lon } = COORD(i + 3);
    const body = {
      event_date: iso(addDays(new Date(), -e.daysAgo)),
      beach: e.beach,
      distance_to_sea_s: e.distance_to_sea_s,
      gps_lat: lat,
      gps_long: lon,
    };
    const desc = `emergence  ${e.beach}  ${body.event_date}  ${lat}, ${lon}  (${e.distance_to_sea_s}m to sea)`;
    if (!CONFIRM) { console.log(`  DRY  ${desc}`); continue; }
    const res = await fetch(`${API}/emergences`, { method: 'POST', headers: hdrs(volToken), body: JSON.stringify(body) });
    console.log(res.ok ? `  OK   ${desc}` : `  FAIL ${desc} — ${res.status} ${await res.text()}`);
  }

  // ---- Time table ---------------------------------------------------------
  console.log(`\n— Time table (week of ${iso(WEEK_START)}) —`);

  const existing = (await (await fetch(`${API}/timetable/week?monday_date=${iso(WEEK_START)}`, { headers: cAuth })).json()).schedule || [];
  if (existing.length > 0 && !FORCE) {
    console.log(`  ${existing.length} assignments already exist for this week — skipping (pass --force to add anyway).`);
    if (!CONFIRM) console.log('\nDry run. Re-run with --confirm to apply.');
    return;
  }

  const users = (await (await fetch(`${API}/users`, { headers: cAuth })).json()).users;
  // Field staff only, and only accounts an evaluator can actually see.
  const crew = users
    .filter((u) => u.is_active && /Volunteer|Assistant|Leader/.test(u.role || ''))
    .sort((a, b) => Number(a.id) - Number(b.id));

  const shifts = (await (await fetch(`${API}/shifts`, { headers: cAuth })).json()).shifts;
  const byName = (n) => shifts.find((s) => s.shift_name === n);
  const MORNINGS = ['Loggos Beach Survey', 'Megas Beach Survey', 'Vatsa Beach Survey'].map(byName).filter(Boolean);
  const AFTERNOONS = ['Sandsifting', 'Beach Profile', 'Beach Clean up'].map(byName).filter(Boolean);

  // Walk the crew round-robin so nobody is on every shift and the rota looks
  // rostered rather than generated.
  let pick = 0;
  const next = () => crew[pick++ % crew.length];

  const plan = [];
  for (let day = 0; day < 6; day++) {          // Mon-Sat; Sunday stays clear
    const date = iso(addDays(WEEK_START, day));
    // Two of the three beaches each morning, rotating which one rests.
    for (let k = 0; k < 2; k++) {
      const shift = MORNINGS[(day + k) % MORNINGS.length];
      for (let p = 0; p < 2; p++) plan.push({ shift, date, user: next() });
    }
    // One afternoon task, three days a week.
    if (day % 2 === 0) {
      const shift = AFTERNOONS[(day / 2) % AFTERNOONS.length];
      for (let p = 0; p < 2; p++) plan.push({ shift, date, user: next() });
    }
  }

  const byDay = {};
  for (const a of plan) (byDay[a.date] ||= []).push(a);
  for (const [date, rows] of Object.entries(byDay)) {
    const label = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
    console.log(`  ${label} ${date}`);
    for (const a of rows) {
      const who = `${a.user.first_name || ''} ${a.user.last_name || ''}`.trim();
      console.log(`    ${CONFIRM ? '·' : 'DRY'} ${a.shift.shift_name.padEnd(22)} ${who}`);
    }
  }

  if (CONFIRM) {
    let ok = 0, fail = 0;
    for (const a of plan) {
      const res = await fetch(`${API}/timetable/create`, {
        method: 'POST', headers: cAuth,
        body: JSON.stringify({ user_id: a.user.id, shift_id: a.shift.shift_id, work_date: a.date }),
      });
      res.ok ? ok++ : (fail++, console.log(`  FAIL ${a.shift.shift_name} ${a.date} — ${res.status} ${await res.text()}`));
    }
    console.log(`\n  ${ok} assignments created${fail ? `, ${fail} failed` : ''}.`);
  } else {
    console.log(`\n  ${plan.length} assignments would be created across ${Object.keys(byDay).length} days.`);
    console.log('\nDry run. Re-run with --confirm to apply.');
  }
};

run().catch((e) => { console.error(e); process.exit(1); });
