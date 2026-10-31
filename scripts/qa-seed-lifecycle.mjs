#!/usr/bin/env node
// One-off: the demo database had no nest that had gone through its full
// lifecycle (laid -> emergence -> inventory/excavation -> hatched), so
// "Hatched & Archived" had nothing real to show. This creates a handful of
// such nests the same way a field team would: a nest record, then a real
// EMERGENCE nest-event dated after date_found, then a real FULL_INVENTORY
// nest-event with a plausible (not 100%) hatch rate - exercising the actual
// status-transition and first_emergence_at logic (QA-145/QA-157) rather than
// writing a status into the nest row directly.
//
//   node scripts/qa-seed-lifecycle.mjs             # preview, writes nothing
//   node scripts/qa-seed-lifecycle.mjs --confirm   # create for real
//
// Created ids are appended to qa-out/seed-manifest.json like qa-seed.mjs's,
// so they can be found and removed the same way:
//   node scripts/qa-cleanup.mjs --manifest qa-out/seed-manifest.json --confirm

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { NEST } from './lib/plausibility.mjs';

const API = process.env.VITE_API_URL || process.env.API_URL || 'https://turtle-backend-pxcx.onrender.com';
const confirm = process.argv.includes('--confirm');

const round = (v, dp = 2) => Number(v.toFixed(dp));
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

let token;
const api = async (path, init = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// Three different beaches, three different seasons' timing, three different
// clutch sizes/hatch rates - so these do not read as three copies of one row.
const PLAN = [
  {
    beachName: 'Kounopetra', beachAnchor: { lat: 38.153596, lon: 20.38787 }, codePrefix: 'KP',
    dateFound: '2026-08-05', emergenceDaysAfter: 52, inventoryDaysAfterEmergence: 6,
    totalEggs: 112, hatchRate: 0.84,
  },
  {
    beachName: 'Vrakhinari', beachAnchor: { lat: 38.162176, lon: 20.377554 }, codePrefix: 'VR',
    dateFound: '2026-07-20', emergenceDaysAfter: 58, inventoryDaysAfterEmergence: 7,
    totalEggs: 96, hatchRate: 0.91,
  },
  {
    beachName: 'Makris Gialos', beachAnchor: { lat: 38.154348, lon: 20.480945 }, codePrefix: 'MG',
    dateFound: '2026-08-15', emergenceDaysAfter: 47, inventoryDaysAfterEmergence: 5,
    totalEggs: 131, hatchRate: 0.76,
  },
];

const nearby = (lat, lon) => ({
  lat: round(lat + (Math.random() * 2 - 1) * 0.0007, 7),
  lon: round(lon + (Math.random() * 2 - 1) * 0.0007, 7),
});

const main = async () => {
  console.log(`API: ${API}`);
  console.log(confirm ? 'MODE: creating\n' : 'MODE: preview — nothing will be created\n');

  const login = await api('/demo/login', { method: 'POST', body: JSON.stringify({ role: 'Coordinator' }) });
  if (login.status !== 200) {
    console.error(`Could not sign in as the demo Coordinator (${login.status}). ${login.body.error || ''}`);
    process.exit(1);
  }
  token = login.body.token;

  const nestRes = await api('/nests');
  const existing = nestRes.body.nests || [];
  const nextSeq = (prefix) => {
    const used = existing
      .filter((n) => String(n.nest_code || '').toUpperCase().startsWith(`${prefix}-`))
      .map((n) => parseInt(String(n.nest_code).split('-')[1], 10))
      .filter((v) => !Number.isNaN(v));
    return (used.length ? Math.max(...used) : 0) + 1;
  };

  const plan = PLAN.map((p) => {
    const found = new Date(`${p.dateFound}T00:00:00.000Z`);
    const emergence = addDays(found, p.emergenceDaysAfter);
    const inventory = addDays(emergence, p.inventoryDaysAfterEmergence);
    const hatched = Math.round(p.totalEggs * p.hatchRate);
    const nonViable = p.totalEggs - hatched;
    const seq = nextSeq(p.codePrefix);
    const nestCode = `${p.codePrefix}-${seq}`;
    const nestPos = nearby(p.beachAnchor.lat, p.beachAnchor.lon);
    return { ...p, found, emergence, inventory, hatched, nonViable, nestCode, nestPos };
  });

  for (const n of plan) {
    console.log(
      `${confirm ? 'would create'.padEnd(0) : ''}nest ${n.nestCode} on ${n.beachName}: laid ${iso(n.found)}, ` +
      `emergence ${iso(n.emergence)} (+${n.emergenceDaysAfter}d), inventory ${iso(n.inventory)} ` +
      `(+${n.inventoryDaysAfterEmergence}d after emergence), ${n.totalEggs} eggs, ${n.hatched} hatched ` +
      `(${Math.round((n.hatched / n.totalEggs) * 100)}%), ${n.nonViable} non-viable`
    );
  }

  if (!confirm) {
    console.log(`\n${plan.length} nest lifecycle(s) planned. Re-run with --confirm to create them.`);
    return;
  }

  const created = [];
  for (const n of plan) {
    const nestPayload = {
      nest_code: n.nestCode,
      beach: n.beachName,
      date_found: iso(n.found),
      gps_lat: n.nestPos.lat, gps_long: n.nestPos.lon,
      distance_to_sea_s: Math.round(NEST.distanceToSea.min + Math.random() * 30),
      total_num_eggs: n.totalEggs,
      current_num_eggs: n.totalEggs,
      depth_top_egg_h: round(NEST.depthTopEgg.min + Math.random() * 10),
      depth_bottom_chamber_h: round(NEST.depthBottomChamber.min + Math.random() * 10),
      width_w: round(NEST.width.min + Math.random() * 8),
      status: 'incubating',
      relocated: false,
      notes: null,
    };
    const nestRes = await api('/nests/create', { method: 'POST', body: JSON.stringify(nestPayload) });
    const nestId = nestRes.body?.nest?.id;
    if (nestRes.status >= 400 || !nestId) {
      console.log(`FAILED creating nest ${n.nestCode} — ${nestRes.status} ${nestRes.body.error || JSON.stringify(nestRes.body).slice(0, 160)}`);
      continue;
    }
    console.log(`created nest ${n.nestCode} (id ${nestId})`);
    created.push({ kind: 'nest', id: String(nestId), label: `nest ${n.nestCode} on ${n.beachName}, ${n.totalEggs} eggs, laid ${iso(n.found)}` });

    // Real EMERGENCE nest-event, dated after date_found (QA-157: never before).
    const emergencePos = nearby(n.nestPos.lat, n.nestPos.lon);
    const emergenceRes = await api('/nest-events/create', {
      method: 'POST',
      body: JSON.stringify({
        event_type: 'EMERGENCE',
        nest_code: n.nestCode,
        tracks_to_sea: n.hatched,
        tracks_lost: 0,
        start_time: n.emergence.toISOString(),
        original_gps_lat: emergencePos.lat,
        original_gps_long: emergencePos.lon,
        observer: 'Sofia Manthou',
        notes: 'Hatchling tracks observed leading to the sea during morning survey.',
      }),
    });
    const emergenceId = emergenceRes.body?.event?.id;
    if (emergenceRes.status >= 400 || !emergenceId) {
      console.log(`FAILED creating EMERGENCE event for ${n.nestCode} — ${emergenceRes.status} ${emergenceRes.body.error || JSON.stringify(emergenceRes.body).slice(0, 160)}`);
      continue;
    }
    console.log(`created EMERGENCE event for ${n.nestCode} dated ${iso(n.emergence)} (id ${emergenceId})`);
    created.push({ kind: 'nest_event', id: String(emergenceId), label: `EMERGENCE on ${n.nestCode}, ${iso(n.emergence)}` });

    // Real FULL_INVENTORY nest-event: eggs_reburied = 0 finalises the nest as
    // hatched (see applyApprovalSideEffects in server.js).
    const inventoryRes = await api('/nest-events/create', {
      method: 'POST',
      body: JSON.stringify({
        event_type: 'FULL_INVENTORY',
        nest_code: n.nestCode,
        total_eggs: n.totalEggs,
        hatched_count: n.hatched,
        non_viable_count: n.nonViable,
        eggs_reburied: 0,
        start_time: n.inventory.toISOString(),
        observer: 'Sofia Manthou',
        notes: `Excavation ${n.inventoryDaysAfterEmergence} days after last hatchling tracks observed.`,
      }),
    });
    const inventoryId = inventoryRes.body?.event?.id;
    if (inventoryRes.status >= 400 || !inventoryId) {
      console.log(`FAILED creating FULL_INVENTORY event for ${n.nestCode} — ${inventoryRes.status} ${inventoryRes.body.error || JSON.stringify(inventoryRes.body).slice(0, 160)}`);
      continue;
    }
    console.log(`created FULL_INVENTORY event for ${n.nestCode} dated ${iso(n.inventory)} (id ${inventoryId}), ${n.hatched}/${n.totalEggs} hatched`);
    created.push({ kind: 'nest_event', id: String(inventoryId), label: `FULL_INVENTORY on ${n.nestCode}, ${iso(n.inventory)}, ${n.hatched}/${n.totalEggs} hatched` });
  }

  mkdirSync('qa-out', { recursive: true });
  const path = 'qa-out/seed-manifest.json';
  let previous = [];
  if (existsSync(path)) {
    try {
      previous = JSON.parse(readFileSync(path, 'utf8')).created || [];
    } catch {
      const kept = `${path}.${Date.now()}.bak`;
      writeFileSync(kept, readFileSync(path));
      console.log(`Existing manifest was unreadable; kept a copy at ${kept}`);
    }
  }
  const stamped = created.map((c) => ({ ...c, seededAt: new Date().toISOString() }));
  writeFileSync(path, JSON.stringify({ api: API, created: [...previous, ...stamped] }, null, 2));
  console.log(`\n${created.length} record(s) created, ${previous.length + created.length} in the manifest: ${path}`);
};

main().catch((err) => { console.error('Seed failed:', err.message); process.exit(1); });
