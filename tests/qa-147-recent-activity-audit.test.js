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
  it('returns only nest_event and turtle_survey_event rows, newest first, summary rebuilt from the join', async () => {
    // QA-150: the route now joins turtle_survey_events/turtle_nest_events
    // (and turtles/turtle_nests) at read time, so the rows the mocked pool
    // returns carry those joined columns rather than a ready-made summary.
    const rows = [
      { record_type: 'turtle_survey_event', record_id: 7, action: 'created', stored_summary: 'stale text',
        occurred_at: '2026-10-24T06:10:00.000Z', tse_event_type: 'RE-SIGHTING', tse_turtle_id: 21,
        tse_location: 'Loggos 2', turtle_name: 'TG-4021', ne_event_type: null, ne_hatched_count: null,
        ne_total_eggs: null, ne_tracks_to_sea: null, ne_tracks_lost: null, ne_stored_nest_code: null, nest_code: null },
      { record_type: 'nest_event', record_id: 3, action: 'created', stored_summary: 'stale text',
        occurred_at: '2026-10-24T05:50:00.000Z', tse_event_type: null, tse_turtle_id: null, tse_location: null,
        turtle_name: null, ne_event_type: 'INVENTORY', ne_hatched_count: 98, ne_total_eggs: 100,
        ne_tracks_to_sea: null, ne_tracks_lost: null, ne_stored_nest_code: 'VA-3', nest_code: 'VA-3' },
    ];
    const spy = vi.spyOn(db, 'query').mockResolvedValue({ rows });

    // No role restriction, same as /nests and /emergences - every role sees
    // the Dashboard, so a Field Volunteer token must also succeed.
    const res = await auth(request(app).get('/audit/recent'));

    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([
      { record_type: 'turtle_survey_event', record_id: 7, action: 'created',
        summary: 'RE-SIGHTING of "TG-4021" at Loggos 2', occurred_at: '2026-10-24T06:10:00.000Z' },
      { record_type: 'nest_event', record_id: 3, action: 'created',
        summary: 'Inventory recorded: 98 hatched of 100 eggs (VA-3)', occurred_at: '2026-10-24T05:50:00.000Z' },
    ]);

    const [sql] = spy.mock.calls[0];
    expect(String(sql)).toMatch(/record_type IN \('nest_event', 'turtle_survey_event'\)/);
    expect(String(sql)).toMatch(/ORDER BY occurred_at DESC/);
    expect(String(sql)).toMatch(/LIMIT 20/);
    // QA-150: deleted-record audit trail entries and rows whose underlying
    // event has since been deleted are excluded from this feed.
    expect(String(sql)).toMatch(/action != 'deleted'/);
    expect(String(sql)).toMatch(/LEFT JOIN turtle_survey_events/);
    expect(String(sql)).toMatch(/LEFT JOIN turtle_nest_events/);
  });

  it('requires authentication, like every other non-public route', async () => {
    const res = await request(app).get('/audit/recent');
    expect(res.status).toBe(401);
  });
});
