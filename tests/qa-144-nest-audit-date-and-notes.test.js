// QA-144: describeNestChanges (QA-142) put date_found's raw ISO value
// straight into the audit line instead of the app's dd/mm/yyyy convention,
// and never mentioned a changed `notes` field at all. Checks both are fixed.
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
  notes: 'Original notes',
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

describe('PUT /nests/:id/update audit summary formatting (QA-144)', () => {
  it('formats a changed date_found as dd/mm/yyyy, not the raw ISO value', async () => {
    const { res, summary } = await runUpdate({
      beforeRow: baseNest(),
      afterRow: { id: 118, ...baseNest({ date_found: '2026-10-19' }) },
      body: payload({ date_found: '2026-10-19' }),
    });

    expect(res.status).toBe(200);
    expect(summary).toBe('Date found 20/10/2026 → 19/10/2026');
  });

  it('flags a notes change with a short marker instead of quoting the full text', async () => {
    const { res, summary } = await runUpdate({
      beforeRow: baseNest(),
      afterRow: { id: 118, ...baseNest({ notes: 'Updated after a site visit' }) },
      body: payload({ notes: 'Updated after a site visit' }),
    });

    expect(res.status).toBe(200);
    expect(summary).toBe('Notes updated');
    expect(summary).not.toContain('Updated after a site visit');
  });

  it('does not mention notes when it is unchanged', async () => {
    const { summary } = await runUpdate({
      beforeRow: baseNest(),
      afterRow: { id: 118, ...baseNest({ date_found: '2026-10-19' }) },
      body: payload({ date_found: '2026-10-19' }),
    });

    expect(summary).not.toContain('Notes');
  });
});
