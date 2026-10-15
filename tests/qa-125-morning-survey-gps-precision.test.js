// QA-125: Review Queue showed a morning survey's corner GPS with trailing
// zeros dropped (38.1609 instead of the submitted 38.16090), while the
// entry form and nest pages showed the full 5 decimals. Root cause:
// GET /morning-surveys/:id returns the column's own stored text, but the
// Review Queue detail query builds record_detail with to_jsonb(ms), and
// Postgres's own jsonb conversion strips trailing zeros off an unscaled
// numeric column. Casting to numeric(10,5) before ::text forces that scale
// back. This can't run against a real DB (per this project's testing
// conventions), so it pins the SQL shape instead.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const leaderToken = jwt.sign({ sub: '7', role: 'Field Leader', email: 'elena@turtleguard.demo' }, SECRET, { expiresIn: '1h' });

let query;
beforeEach(() => {
  query = vi.spyOn(db, 'query').mockImplementation(async (sql) => {
    if (/FROM record_reviews/i.test(sql)) {
      return { rows: [{ id: 1, record_type: 'morning_survey', record_id: 148, status: 'pending' }] };
    }
    if (/FROM morning_surveys ms/i.test(sql)) {
      return { rows: [{ id: 148, detail: { id: 148, tl_lat: '38.16090', tr_lat: '38.16090' } }] };
    }
    return { rows: [] };
  });
});
afterAll(() => db.end().catch(() => {}));

describe('GET /reviews — morning survey GPS keeps its 5-decimal precision (QA-125)', () => {
  it('casts tl/tr lat/long to numeric(10,5) before text, not a bare to_jsonb(ms) field', async () => {
    const res = await request(app)
      .get('/reviews')
      .set('Authorization', `Bearer ${leaderToken}`);

    expect(res.status).toBe(200);
    const detailCall = query.mock.calls.find(([sql]) => /FROM morning_surveys ms/i.test(sql));
    expect(detailCall).toBeDefined();
    const [sql] = detailCall;
    expect(sql).toContain("'tl_lat', (ms.tl_lat::numeric(10,5))::text");
    expect(sql).toContain("'tl_long', (ms.tl_long::numeric(10,5))::text");
    expect(sql).toContain("'tr_lat', (ms.tr_lat::numeric(10,5))::text");
    expect(sql).toContain("'tr_long', (ms.tr_long::numeric(10,5))::text");
  });
});
