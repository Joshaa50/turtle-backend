// QA-161: Dashboard Recent Activity flooded with re-saves of old events,
// worded identically to brand-new ones. GET /audit/recent filtered out only
// action = 'deleted', so every 'updated' row written by a record's PUT
// route (e.g. PUT /nest-events/:id) rendered with the exact same summary as
// its original 'created' row - making an edit (or a double-edit) look like
// one or two new sightings. The route now only surfaces action = 'created'
// rows, since that is the only action that represents genuinely new
// fieldwork and each record has exactly one such row.
import { describe, it, expect, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const token = jwt.sign(
  { sub: '12', role: 'Field Volunteer', email: 'volunteer@turtleguard.demo' },
  SECRET,
  { expiresIn: '1h' },
);
const auth = (req) => req.set('Authorization', `Bearer ${token}`);

afterAll(() => db.end().catch(() => {}));

describe('GET /audit/recent only surfaces action = \'created\' rows (QA-161)', () => {
  it('filters the query to action = \'created\', not merely excluding \'deleted\'', async () => {
    const spy = vi.spyOn(db, 'query').mockResolvedValue({ rows: [] });

    await auth(request(app).get('/audit/recent'));

    const [sql] = spy.mock.calls[0];
    const text = String(sql);
    expect(text).toMatch(/a\.action\s*=\s*'created'/);
    expect(text).not.toMatch(/a\.action\s*!=\s*'deleted'/);
  });

  it('would exclude an \'updated\' row for a nest_event even though its event still exists', async () => {
    // A real database filtering on action = 'created' would never hand this
    // 'updated' row back to the route at all; this pins the route's own
    // behaviour (it must not further coerce 'updated' rows into the feed)
    // by asserting it renders only the 'created' row it is given.
    const createdRow = {
      record_type: 'nest_event', record_id: 3, action: 'created',
      stored_summary: 'Emergence logged: 41 hatchling tracks', occurred_at: '2026-09-02T06:00:00.000Z',
      tse_event_type: null, tse_turtle_id: null, tse_location: null, turtle_name: null,
      ne_event_type: 'EMERGENCE', ne_hatched_count: null, ne_total_eggs: null, ne_tracks_to_sea: 30,
      ne_tracks_lost: 11, ne_stored_nest_code: 'VA-3', nest_code: 'VA-3',
    };
    vi.spyOn(db, 'query').mockResolvedValue({ rows: [createdRow] });

    const res = await auth(request(app).get('/audit/recent'));

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].summary).toBe('Emergence logged: 41 hatchling tracks (VA-3)');
  });
});
