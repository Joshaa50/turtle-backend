// QA-170: describeNestEvent() fell through to the raw event_type string for
// RELOCATION - the one case QA-150's pass over this function missed, so
// Recent Activity and a nest's Lifecycle History both showed "RELOCATION
// (MA-10R)" instead of a sentence like every other event type gets.
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

describe('GET /audit/recent (QA-170: RELOCATION summary)', () => {
  it('phrases a RELOCATION nest_event as a sentence, not the raw event_type', async () => {
    const rows = [
      { record_type: 'nest_event', record_id: 128, action: 'created',
        stored_summary: 'RELOCATION (MA-10R)', occurred_at: '2026-11-08T06:00:00.000Z',
        tse_event_type: null, tse_turtle_id: null, tse_location: null, turtle_name: null,
        ne_event_type: 'RELOCATION', ne_hatched_count: null, ne_total_eggs: 96,
        ne_tracks_to_sea: null, ne_tracks_lost: null, ne_eggs_reburied: 96,
        ne_stored_nest_code: 'MA-10R', nest_code: 'MA-10R' },
    ];
    vi.spyOn(db, 'query').mockResolvedValue({ rows });

    const res = await auth(request(app).get('/audit/recent'));

    expect(res.status).toBe(200);
    expect(res.body.entries[0].summary).not.toBe('RELOCATION (MA-10R)');
    expect(res.body.entries[0].summary).toBe('Relocated: 96 of 96 eggs reburied (MA-10R)');
  });
});
