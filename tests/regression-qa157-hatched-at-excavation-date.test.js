// QA-157: Hatched & Archived (GET /nests) and Nest Details showed different
// incubation lengths for the same nest. The excavation CTE here used
// created_at - the row's DB insert timestamp - as hatched_at, while Nest
// Details reads the inventory event's own field date. An inventory done on
// 14/08 but entered into the app on 17/08 produced a hatched_at three days
// later than the real event, inflating the incubation figure versus Nest
// Details. The fix mirrors the first_emergence_at backfill pattern already
// used elsewhere in this file: COALESCE(start_time, created_at), so the
// event's own date wins whenever it is present.
import { describe, it, expect, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const tokenFor = (role, sub) =>
  jwt.sign({ sub, role, email: `${sub}@turtleguard.demo` }, SECRET, { expiresIn: '1h' });

const VOLUNTEER = tokenFor('Field Volunteer', '51');
const asVolunteer = (req) => req.set('Authorization', `Bearer ${VOLUNTEER}`);

afterAll(() => db.end().catch(() => {}));

describe('GET /nests hatched_at uses the inventory event\'s own date, not its save date (QA-157)', () => {
  it('builds the excavation CTE from COALESCE(start_time, created_at), not created_at alone', async () => {
    const spy = vi.spyOn(db, 'query').mockResolvedValue({ rows: [] });

    await asVolunteer(request(app).get('/nests'));

    const [sql] = spy.mock.calls[0];
    const text = String(sql);
    // created_at must not be used on its own as hatched_at any more.
    expect(text).not.toMatch(/nest_code,\s*created_at AS hatched_at/);
    expect(text).toMatch(/COALESCE\(start_time, created_at\) AS hatched_at/);
    expect(text).toMatch(/ORDER BY nest_code, COALESCE\(start_time, created_at\) DESC, id DESC/);
  });

  it('would surface the event\'s start_time as hatched_at, matching what Nest Details computes from the same event', async () => {
    // Simulates what Postgres would hand back once the CTE prefers
    // start_time: an inventory logged for 2026-08-14 but only entered into
    // the app on 2026-08-17 must report the field date, not the save date.
    const row = {
      id: 40, nest_code: 'LG2-9', total_num_eggs: 90, current_num_eggs: 90,
      date_found: '2026-06-01T00:00:00.000Z', hatched_at: '2026-08-14T06:00:00.000Z',
    };
    vi.spyOn(db, 'query').mockResolvedValue({ rows: [row] });

    const res = await asVolunteer(request(app).get('/nests'));

    expect(res.status).toBe(200);
    expect(res.body.nests[0].hatched_at).toBe('2026-08-14T06:00:00.000Z');
  });
});
