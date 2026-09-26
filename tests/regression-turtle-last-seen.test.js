import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const token = () =>
  jwt.sign({ sub: '1', role: 'Field Leader', email: 'l@example.com' }, SECRET, { expiresIn: '1h' });

let query;
beforeEach(() => {
  query = vi.spyOn(db, 'query').mockRejectedValue(new Error('unstubbed db.query'));
});
afterAll(() => db.end().catch(() => {}));

// "Last seen" used to be the row's updated_at, so correcting a turtle's name
// moved the date it was last observed - and that date reached the CSV export
// and was read as fieldwork. It must come from the encounter history.
describe('GET /turtles last_seen_at', () => {
  it('reports the newest encounter date, not the row timestamp', async () => {
    query.mockResolvedValue({
      rows: [{
        id: 7,
        name: 'Phoebe',
        updated_at: '2026-09-26T09:00:00.000Z',   // edited today
        last_seen_at: '2026-08-30T00:00:00.000Z', // actually seen in August
        sighting_count: 3,
      }],
    });

    const res = await request(app).get('/turtles').set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    const t = res.body.turtles[0];
    expect(t.last_seen_at).toBe('2026-08-30T00:00:00.000Z');
    expect(t.last_seen_at).not.toBe(t.updated_at);
    expect(t.sighting_count).toBe(3);
  });

  it('leaves last_seen_at null for a turtle with no encounters', async () => {
    query.mockResolvedValue({
      rows: [{ id: 8, name: 'Iris', updated_at: '2026-09-26T09:00:00.000Z', last_seen_at: null, sighting_count: 0 }],
    });

    const res = await request(app).get('/turtles').set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(200);
    // Null, not a fallback to updated_at - "never encountered" is a fact worth
    // stating, and a date here would be a claim the data does not support.
    expect(res.body.turtles[0].last_seen_at).toBeNull();
    expect(res.body.turtles[0].sighting_count).toBe(0);
  });

  it('derives the date from turtle_survey_events, not the turtles row', async () => {
    query.mockResolvedValue({ rows: [] });
    await request(app).get('/turtles').set('Authorization', `Bearer ${token()}`);
    const sql = query.mock.calls[0][0];
    expect(sql).toMatch(/turtle_survey_events/);
    expect(sql).toMatch(/MAX\(event_date\)/i);
  });
});
