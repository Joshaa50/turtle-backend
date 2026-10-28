// QA-147: the Dashboard's Recent Activity feed only drew on nests,
// emergences, turtles and reviews, so nest inventories/hatching events and
// turtle re-sightings never showed up even when they were the day's biggest
// news. GET /audit/recent gives the Dashboard those two record types'
// already-human-readable audit summaries, newest first.
import { describe, it, expect, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;

const SECRET = process.env.JWT_SECRET;
const volunteerToken = jwt.sign(
  { sub: '12', role: 'Field Volunteer', email: 'volunteer@turtleguard.demo' },
  SECRET,
  { expiresIn: '1h' },
);
const auth = (req) => req.set('Authorization', `Bearer ${volunteerToken}`);

afterAll(() => db.end().catch(() => {}));

describe('GET /audit/recent (QA-147)', () => {
  it('returns only nest_event and turtle_survey_event rows, newest first, using their own summaries', async () => {
    const rows = [
      { record_type: 'turtle_survey_event', record_id: 7, action: 'created',
        summary: 'Re-sighted turtle TG-4021 at Loggos 2', occurred_at: '2026-10-24T06:10:00.000Z' },
      { record_type: 'nest_event', record_id: 3, action: 'created',
        summary: 'Full inventory recorded: 98 hatched, 2 unhatched', occurred_at: '2026-10-24T05:50:00.000Z' },
    ];
    const spy = vi.spyOn(db, 'query').mockResolvedValue({ rows });

    // No role restriction, same as /nests and /emergences - every role sees
    // the Dashboard, so a Field Volunteer token must also succeed.
    const res = await auth(request(app).get('/audit/recent'));

    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual(rows);

    const [sql] = spy.mock.calls[0];
    expect(String(sql)).toMatch(/record_type IN \('nest_event', 'turtle_survey_event'\)/);
    expect(String(sql)).toMatch(/ORDER BY occurred_at DESC/);
    expect(String(sql)).toMatch(/LIMIT 20/);
    // QA-150: deleted-record audit trail entries and rows whose underlying
    // event has since been deleted are excluded from this feed.
    expect(String(sql)).toMatch(/action != 'deleted'/);
    expect(String(sql)).toMatch(/EXISTS/);
  });

  it('requires authentication, like every other non-public route', async () => {
    const res = await request(app).get('/audit/recent');
    expect(res.status).toBe(401);
  });
});
