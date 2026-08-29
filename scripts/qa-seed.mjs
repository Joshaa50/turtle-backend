#!/usr/bin/env node
// Fills the QA database with believable field records.
//
// "Believable" means the same thing here as in the auditor: both read their
// ranges from scripts/lib/plausibility.mjs, so seeded data passes the audit by
// construction rather than by luck. If you widen a range there, records seeded
// afterwards spread into it.
//
//   node scripts/qa-seed.mjs                          # preview, writes nothing
//   node scripts/qa-seed.mjs --confirm                # create the default set
//   node scripts/qa-seed.mjs --confirm --nests 8 --turtles 3 --emergences 10
//
// Every created record is written to qa-out/seed-manifest.json, and removed with:
//   node scripts/qa-cleanup.mjs --manifest qa-out/seed-manifest.json --confirm
//
// The records are NOT named QA-anything: a demo is worth nothing if every row on
// screen is stamped as fake. The manifest is what makes them removable.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { NEST, SEASON, TURTLE } from './lib/plausibility.mjs';

const API = process.env.VITE_API_URL || process.env.API_URL || 'https://turtle-backend-pxcx.onrender.com';
const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const count = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i === -1 ? dflt : Math.max(0, parseInt(args[i + 1], 10) || 0);
};
const WANT = { nests: count('--nests', 4), turtles: count('--turtles', 2), emergences: count('--emergences', 5) };

const rand = (min, max) => min + Math.random() * (max - min);
const round = (v, dp = 2) => Number(v.toFixed(dp));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
// Keep values off the boundaries: a clutch of exactly 40 reads like a limit, not a count.
const inside = (r, lo = 0.15, hi = 0.85) => rand(r.min + (r.max - r.min) * lo, r.min + (r.max - r.min) * hi);

// Greek names, in the style of the animals already on file (Calypso, Nireas, Athena).
const NAMES = ['Thalassa', 'Kyma', 'Iris', 'Melina', 'Orion', 'Selene', 'Aegeus', 'Phoebe',
  'Kallisto', 'Nerina', 'Damon', 'Zephyra', 'Alkyone', 'Theron', 'Ianthe'];
const HEALTH = ['Healthy', 'Healthy', 'Healthy', 'Lethargic', 'Minor flipper injury'];
const LANDMARKS = ['Wooden stake at base of dune vegetation', 'Large boulder near beach access path',
  'Concrete marker post', 'Base of the tamarisk stand', 'Rock outcrop at the north end',
  'Fence corner behind the dune', 'Signpost at the path entrance'];

let token;
const api = async (path, init = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// A date inside this year's nesting season, and never in the future.
const seasonDate = () => {
  const now = new Date();
  const year = now.getUTCFullYear();
  const start = Date.UTC(year, SEASON.firstMonth - 1, 20);
  const end = Math.min(now.getTime() - 86400000, Date.UTC(year, SEASON.lastMonth - 1, 15));
  return new Date(rand(Math.min(start, end), end));
};

// Jitter a real beach's known position by a few hundred metres so nests on one
// beach cluster the way they do in life, without landing on top of each other.
const nearby = (lat, lon) => ({
  lat: round(lat + rand(-0.0025, 0.0025), 7),
  lon: round(lon + rand(-0.0025, 0.0025), 7),
});

const makeTurtle = () => {
  const species = Math.random() < 0.85 ? 'Caretta caretta' : 'Chelonia mydas';
  const range = TURTLE.species[species].scl;
  const sclMax = round(inside(range, 0.2, 0.7));
  const sclMin = round(sclMax - rand(1, 3));
  const scw = round(sclMax * rand(0.72, 0.80));
  // Curved measurements follow the dome, so they read a little longer than straight.
  const cclMax = round(sclMax * rand(1.02, 1.06));
  const cclMin = round(sclMin * rand(1.02, 1.05));
  const ccw = round(scw * rand(1.02, 1.06));
  const tag = `KF-${Math.floor(rand(1000, 2400))}`;
  return {
    name: pick(NAMES), species, sex: Math.random() < 0.7 ? 'female' : 'male',
    health_condition: pick(HEALTH),
    front_left_tag: tag, front_left_address: 'Front left flipper, 2nd scale',
    scl_max: sclMax, scl_min: sclMin, scw,
    ccl_max: cclMax, ccl_min: cclMin, ccw,
    tail_extension: round(rand(8, 18)), vent_to_tail_tip: round(rand(15, 24)), total_tail_length: round(rand(20, 30)),
  };
};

const makeNest = (beach, seq, coords) => {
  const found = seasonDate();
  const ageDays = (Date.now() - found.getTime()) / 86400000;
  // Incubation runs roughly 45-60 days, so age decides status rather than a coin flip.
  const status = ageDays > 60 ? 'hatched' : ageDays > 45 ? 'hatching' : 'incubating';
  const eggs = Math.round(inside(NEST.eggs, 0.3, 0.8));
  const top = round(inside(NEST.depthTopEgg, 0.25, 0.7));
  const bottom = round(top + rand(18, 30));
  const relocated = Math.random() < 0.15;
  const p = nearby(coords.lat, coords.lon);
  const t1 = nearby(p.lat, p.lon), t2 = nearby(p.lat, p.lon);
  return {
    nest_code: `${beach.code}-${seq}${relocated ? 'R' : ''}`,
    beach: beach.name,
    date_found: found.toISOString().slice(0, 10),
    gps_lat: p.lat, gps_long: p.lon,
    distance_to_sea_s: Math.round(inside(NEST.distanceToSea, 0.05, 0.3)),
    total_num_eggs: eggs,
    current_num_eggs: status === 'hatching' ? Math.round(eggs * rand(0.1, 0.4)) : eggs,
    depth_top_egg_h: top, depth_bottom_chamber_h: bottom,
    width_w: round(inside(NEST.width, 0.3, 0.7)),
    status, relocated,
    tri_tl_desc: pick(LANDMARKS), tri_tl_lat: t1.lat, tri_tl_long: t1.lon, tri_tl_distance: round(rand(4, 14)),
    tri_tr_desc: pick(LANDMARKS), tri_tr_lat: t2.lat, tri_tr_long: t2.lon, tri_tr_distance: round(rand(4, 14)),
    notes: null,
  };
};

const makeEmergence = (beach, coords) => {
  const p = nearby(coords.lat, coords.lon);
  return {
    beach: beach.name,
    event_date: seasonDate().toISOString().slice(0, 10),
    gps_lat: p.lat, gps_long: p.lon,
    distance_to_sea_s: Math.round(inside(NEST.distanceToSea, 0.02, 0.25)),
  };
};

const main = async () => {
  console.log(`API: ${API}`);
  console.log(confirm ? 'MODE: creating\n' : 'MODE: preview — nothing will be created\n');

  const login = await api('/demo/login', { method: 'POST', body: JSON.stringify({ role: 'Coordinator' }) });
  if (login.status !== 200) {
    console.error(`Could not sign in as the demo Coordinator (${login.status}). ${login.body.error || ''}`);
    process.exit(1);
  }
  token = login.body.token;

  const [beachRes, nestRes] = await Promise.all([api('/beaches'), api('/nests')]);
  const beaches = (beachRes.body.beaches || []).filter((b) => b.is_active);
  const existing = nestRes.body.nests || [];
  if (!beaches.length) { console.error('No beaches configured; nothing to seed against.'); process.exit(1); }

  // Anchor each beach on the nests already recorded there, so seeded positions
  // land on the actual beach rather than in the sea a kilometre away.
  const anchorFor = (beach) => {
    const on = existing.filter((n) => n.beach === beach.name && n.gps_lat);
    if (on.length) return { lat: Number(on[0].gps_lat), lon: Number(on[0].gps_long) };
    const any = existing.find((n) => n.gps_lat);
    return any ? { lat: Number(any.gps_lat), lon: Number(any.gps_long) } : { lat: 38.169, lon: 20.586 };
  };

  // Continue each beach's numbering instead of colliding with LP-1, LP-2...
  const nextSeq = (beach) => {
    const used = existing
      .filter((n) => String(n.nest_code || '').toUpperCase().startsWith(`${beach.code.toUpperCase()}-`))
      .map((n) => parseInt(String(n.nest_code).split('-')[1], 10))
      .filter((v) => !Number.isNaN(v));
    return (used.length ? Math.max(...used) : 0) + 1;
  };

  const planned = [];
  const seqs = {};
  for (let i = 0; i < WANT.nests; i++) {
    const beach = pick(beaches);
    seqs[beach.code] = (seqs[beach.code] ?? nextSeq(beach) - 1) + 1;
    planned.push({ kind: 'nest', path: '/nests/create', payload: makeNest(beach, seqs[beach.code], anchorFor(beach)) });
  }
  for (let i = 0; i < WANT.turtles; i++) planned.push({ kind: 'turtle', path: '/turtles/create', payload: makeTurtle() });
  for (let i = 0; i < WANT.emergences; i++) {
    const beach = pick(beaches);
    planned.push({ kind: 'emergence', path: '/emergences', payload: makeEmergence(beach, anchorFor(beach)) });
  }

  const describe = (p) => p.kind === 'nest'
    ? `nest ${p.payload.nest_code} on ${p.payload.beach}, ${p.payload.total_num_eggs} eggs, ${p.payload.status}, found ${p.payload.date_found}`
    : p.kind === 'turtle'
      ? `turtle ${p.payload.name}, ${p.payload.species}, ${p.payload.sex}, SCL ${p.payload.scl_max}cm`
      : `emergence on ${p.payload.beach}, ${p.payload.event_date}, ${p.payload.distance_to_sea_s}m from the sea`;

  if (!confirm) {
    planned.forEach((p) => console.log(`would create  ${describe(p)}`));
    console.log(`\n${planned.length} record(s). Re-run with --confirm to create them.`);
    return;
  }

  const created = [];
  for (const p of planned) {
    const res = await api(p.path, { method: 'POST', body: JSON.stringify(p.payload) });
    const id = res.body?.turtle?.id ?? res.body?.nest?.id ?? res.body?.emergence?.id ?? res.body?.id;
    if (res.status >= 400 || !id) {
      console.log(`FAILED  ${describe(p)} — ${res.status} ${res.body.error || JSON.stringify(res.body).slice(0, 120)}`);
      continue;
    }
    created.push({ kind: p.kind, id: String(id), label: describe(p) });
    console.log(`created ${describe(p)}  (id ${id})`);
  }

  // The manifest accumulates across runs. Overwriting it would strand every
  // record seeded before today with no way to find them again.
  mkdirSync('qa-out', { recursive: true });
  const path = 'qa-out/seed-manifest.json';
  let previous = [];
  if (existsSync(path)) {
    try {
      previous = JSON.parse(readFileSync(path, 'utf8')).created || [];
    } catch {
      // A corrupt manifest is not worth losing this run's ids over: keep it.
      const kept = `${path}.${Date.now()}.bak`;
      writeFileSync(kept, readFileSync(path));
      console.log(`Existing manifest was unreadable; kept a copy at ${kept}`);
    }
  }
  const stamped = created.map((c) => ({ ...c, seededAt: new Date().toISOString() }));
  writeFileSync(path, JSON.stringify({ api: API, created: [...previous, ...stamped] }, null, 2));
  console.log(`\n${created.length} created, ${previous.length + created.length} in the manifest: ${path}`);
  console.log('Remove them with:  node scripts/qa-cleanup.mjs --manifest qa-out/seed-manifest.json --confirm');
};

main().catch((err) => { console.error('Seed failed:', err.message); process.exit(1); });
