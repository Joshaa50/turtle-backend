// QA-098: many nests are found already laid or in a rush, with no chamber
// depth (H/h) or width (w) ever recorded at NestEntry time - the final
// inventory (a FULL_INVENTORY/PARTIAL_INVENTORY nest_event) is often the
// first time anyone actually measures the chamber, via
// original_depth_top_egg_h/original_depth_bottom_chamber_h/original_width_w
// on the event. Approving that event only ever updated the nest's status
// (QA-070/QA-075); the measurements stayed stranded on the event and never
// reached the nest's own depth_top_egg_h/depth_bottom_chamber_h/width_w
// columns, so the nest's own details page kept showing them as missing.
//
// This pins that approving an inventory event with original_* measurements
// now backfills only the nest's missing fields (never overwriting a real
// measurement taken when the nest was first logged), and is a no-op when
// the nest already has every field or the event carries no measurements.
import { describe, it, expect, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const tokenFor = (role, sub) =>
  jwt.sign({ sub, role, email: `${sub}@turtleguard.demo` }, SECRET, { expiresIn: '1h' });

const LEADER = tokenFor('Field Leader', '7');
const asLeader = (req) => req.set('Authorization', `Bearer ${LEADER}`);

afterAll(() => db.end().catch(() => {}));

const mockApprovalFlow = ({
  nestId = 90,
  nestCode = 'VA-2',
  nestStatus = 'incubating',
  eggsReburied = 0,
  totalEggs = 100,
  original = { h: 10, H: 44, w: 21 },
} = {}) => {
  const calls = [];
  const impl = (sql, params) => {
    const text = String(sql);
    calls.push({ text, params });

    if (text.includes('UPDATE record_reviews') && params?.[0] === 'approved') {
      return Promise.resolve({ rows: [{ id: 5, record_type: 'nest_event', record_id: 11 }] });
    }
    if (text.includes('FROM turtle_nest_events e')) {
      return Promise.resolve({
        rows: [{
          event_type: 'FULL_INVENTORY', nest_id: nestId, eggs_reburied: eggsReburied, total_eggs: totalEggs,
          original_depth_top_egg_h: original.h, original_depth_bottom_chamber_h: original.H, original_width_w: original.w,
        }],
      });
    }
    if (text.includes('UPDATE turtle_nests SET') && text.includes('depth_top_egg_h = COALESCE')) {
      return Promise.resolve({ rows: [{ nest_code: nestCode }] });
    }
    if (text.includes('SELECT nest_code, status FROM turtle_nests') && text.includes('status = ANY')) {
      const fromStatuses = params?.[1] || [];
      return fromStatuses.includes(nestStatus)
        ? Promise.resolve({ rows: [{ nest_code: nestCode, status: nestStatus }] })
        : Promise.resolve({ rows: [] });
    }
    if (text.includes('UPDATE turtle_nests SET status = $2')) {
      return Promise.resolve({ rows: [{ nest_code: nestCode }] });
    }
    if (text.includes('INSERT INTO record_audit')) {
      return Promise.resolve({ rows: [{ id: 1 }] });
    }
    return Promise.resolve({ rows: [] });
  };
  const query = vi.spyOn(db, 'query').mockImplementation(impl);
  return { query, calls };
};

const backfillCall = (calls) =>
  calls.find((c) => c.text.includes('UPDATE turtle_nests SET') && c.text.includes('depth_top_egg_h = COALESCE'));

const wroteNestAudit = (calls, summaryMatch) =>
  calls.some(
    (c) =>
      c.text.includes('INSERT INTO record_audit') &&
      c.params?.[0] === 'nest' &&
      c.params?.[2] === 'updated' &&
      (!summaryMatch || String(c.params?.[6] || '').includes(summaryMatch))
  );

describe('approving an inventory nest_event backfills missing chamber depth/width (QA-098)', () => {
  it('backfills the nest from the event original_* measurements and audits it', async () => {
    const { calls } = mockApprovalFlow({ original: { h: 10, H: 44, w: 21 } });

    const res = await asLeader(request(app).post('/reviews/5/approve')).send({});

    expect(res.status).toBe(200);
    const call = backfillCall(calls);
    expect(call).toBeTruthy();
    expect(call.params).toEqual([90, 10, 44, 21]);
    expect(wroteNestAudit(calls, 'Chamber depth/width filled in from inventory measurements')).toBe(true);
  });

  it('does not touch turtle_nests when the inventory event carries no measurements at all', async () => {
    const { calls } = mockApprovalFlow({ original: { h: null, H: null, w: null } });

    const res = await asLeader(request(app).post('/reviews/5/approve')).send({});

    expect(res.status).toBe(200);
    expect(backfillCall(calls)).toBeFalsy();
  });

  it('never overwrites a measurement the nest already has (only the nest\'s own missing fields are touched - the SQL guards this with COALESCE and a NULL-only WHERE)', async () => {
    const { calls } = mockApprovalFlow({ original: { h: 10, H: 44, w: 21 } });

    await asLeader(request(app).post('/reviews/5/approve')).send({});

    const call = backfillCall(calls);
    expect(call.text).toMatch(/depth_top_egg_h\s*=\s*COALESCE\(depth_top_egg_h,\s*\$2\)/);
    expect(call.text).toMatch(/depth_bottom_chamber_h\s*=\s*COALESCE\(depth_bottom_chamber_h,\s*\$3\)/);
    expect(call.text).toMatch(/width_w\s*=\s*COALESCE\(width_w,\s*\$4\)/);
    expect(call.text).toMatch(/WHERE id = \$1\s*AND \(depth_top_egg_h IS NULL OR depth_bottom_chamber_h IS NULL OR width_w IS NULL\)/);
  });

  it('is a no-op (and not audited) when the nest already has every field, even with measurements on the event', async () => {
    const { calls } = mockApprovalFlow({ original: { h: 10, H: 44, w: 21 } });
    // Simulate the nest already having every field: the UPDATE's WHERE
    // clause excludes it, so RETURNING comes back empty.
    const query = vi.spyOn(db, 'query').mockImplementation((sql, params) => {
      const text = String(sql);
      calls.push({ text, params });
      if (text.includes('UPDATE record_reviews') && params?.[0] === 'approved') {
        return Promise.resolve({ rows: [{ id: 5, record_type: 'nest_event', record_id: 11 }] });
      }
      if (text.includes('FROM turtle_nest_events e')) {
        return Promise.resolve({
          rows: [{
            event_type: 'FULL_INVENTORY', nest_id: 90, eggs_reburied: 0, total_eggs: 100,
            original_depth_top_egg_h: 10, original_depth_bottom_chamber_h: 44, original_width_w: 21,
          }],
        });
      }
      if (text.includes('UPDATE turtle_nests SET') && text.includes('depth_top_egg_h = COALESCE')) {
        return Promise.resolve({ rows: [] }); // nothing matched: nest already fully measured
      }
      if (text.includes('SELECT nest_code, status FROM turtle_nests') && text.includes('status = ANY')) {
        return Promise.resolve({ rows: [{ nest_code: 'VA-2', status: 'incubating' }] });
      }
      if (text.includes('UPDATE turtle_nests SET status = $2')) {
        return Promise.resolve({ rows: [{ nest_code: 'VA-2' }] });
      }
      if (text.includes('INSERT INTO record_audit')) {
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await asLeader(request(app).post('/reviews/5/approve')).send({});

    expect(res.status).toBe(200);
    expect(wroteNestAudit(calls, 'Chamber depth/width filled in')).toBe(false);
  });
});
