// QA-142: every nest edit outside a handful of specially-handled fields
// (status/relocation/clutch/beach/archiving/code) recorded the same generic
// "Nest LG2-9 details edited" audit line, so two different edits - or an
// edit that corrects a date and a later edit that reverts it - were
// indistinguishable in Lifecycle History. Widens the diff to name the field
// and its old -> new value for the fields Edit Nest Details can actually
// change (date_found among them, since QA-132 added editing it).
import { describe, it, expect, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';
import { stubTxClient } from './support/txClient.js';

const { app, db } = server;

const SECRET = process.env.JWT_SECRET;
const leaderToken = jwt.sign(
  { sub: '49', role: 'Field Leader', email: 'elena.papadaki@turtleguard.demo' },
  SECRET,
  { expiresIn: '1h' },
);
const auth = (req) => req.set('Authorization', `Bearer ${leaderToken}`);

afterAll(() => db.end().catch(() => {}));

const baseNest = (overrides = {}) => ({
  nest_code: 'LG2-9', status: 'incubating', relocated: false, beach: 'Loggos 2',
  total_num_eggs: 100, current_num_eggs: 100, is_archived: false,
  date_found: '2026-10-20', depth_top_egg_h: 40, depth_bottom_chamber_h: 60,
  width_w: 25, distance_to_sea_s: 19, gps_lat: 38.18412, gps_long: 20.44031,
  ...overrides,
});

const payload = (overrides = {}) => ({
  nest_code: 'LG2-9', beach: 'Loggos 2', date_found: '2026-10-19',
  depth_top_egg_h: 40, distance_to_sea_s: 19,
  gps_lat: 38.18412, gps_long: 20.44031,
  ...overrides,
});

const runUpdate = async ({ beforeRow, afterRow, body }) => {
  stubTxClient(db);
  const calls = [];
  vi.spyOn(db, 'query').mockImplementation((sql, params) => {
    const text = String(sql);
    calls.push({ text, params });
    if (text.includes('SELECT nest_code, status, relocated, beach')) {
      return Promise.resolve({ rows: [beforeRow] });
    }
    if (text.includes('UPDATE turtle_nests')) {
      return Promise.resolve({ rows: [afterRow] });
    }
    if (text.includes('INSERT INTO record_audit')) {
      return Promise.resolve({ rows: [{}] });
    }
    return Promise.resolve({ rows: [] });
  });

  const res = await auth(request(app).put('/nests/118/update')).send(body);
  const auditCall = calls.find((c) => c.text.includes('INSERT INTO record_audit'));
  return { res, summary: auditCall?.params?.[6] };
};

describe('PUT /nests/:id/update records what actually changed (QA-142)', () => {
  it('names a corrected date_found with its old and new value', async () => {
    const { res, summary } = await runUpdate({
      beforeRow: baseNest(),
      afterRow: { id: 118, ...baseNest({ date_found: '2026-10-19' }) },
      body: payload({ date_found: '2026-10-19' }),
    });

    expect(res.status).toBe(200);
    expect(summary).toBe('Date found 2026-10-20 → 2026-10-19');
  });

  it('distinguishes a date correction from its own later revert, instead of two identical "details edited" lines', async () => {
    const { summary: forwardSummary } = await runUpdate({
      beforeRow: baseNest(),
      afterRow: { id: 118, ...baseNest({ date_found: '2026-10-19' }) },
      body: payload({ date_found: '2026-10-19' }),
    });

    const { summary: revertSummary } = await runUpdate({
      beforeRow: baseNest({ date_found: '2026-10-19' }),
      afterRow: { id: 118, ...baseNest() },
      body: payload({ date_found: '2026-10-20' }),
    });

    expect(forwardSummary).not.toBe(revertSummary);
    expect(forwardSummary).toBe('Date found 2026-10-20 → 2026-10-19');
    expect(revertSummary).toBe('Date found 2026-10-19 → 2026-10-20');
  });

  it('still falls back to "details edited" when nothing in the diffed fields actually changed', async () => {
    const { summary } = await runUpdate({
      beforeRow: baseNest(),
      afterRow: { id: 118, ...baseNest() },
      body: payload(),
    });

    expect(summary).toBe('Nest LG2-9 details edited');
  });

  it('names a GPS correction, not just the already-covered fields', async () => {
    const { summary } = await runUpdate({
      beforeRow: baseNest(),
      afterRow: { id: 118, ...baseNest({ gps_lat: 38.2 }) },
      body: payload({ gps_lat: 38.2 }),
    });

    expect(summary).toBe('Latitude 38.18412 → 38.2');
  });
});
