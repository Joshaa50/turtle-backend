// QA-027: Tagging Entry's "New Turtle" flow used to be two separate
// requests (POST /turtles/create, then POST /turtle_survey_events/create).
// A failure on the second request - most often the event's own future-date
// or measurement validation - left the turtle from the first request
// committed anyway: an orphan with no events, invisible in Turtle Records,
// and holding tag numbers that then blocked the corrected retry from
// reusing them.
//
// POST /turtles/create-with-event wraps both inserts in one transaction.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const leaderToken = jwt.sign(
  { sub: '49', role: 'Field Leader', email: 'elena.papadaki@turtleguard.demo' },
  SECRET,
  { expiresIn: '1h' },
);
const auth = (req) => req.set('Authorization', `Bearer ${leaderToken}`);

const validTurtle = { species: 'Caretta caretta', sex: 'female', health_condition: 'Healthy' };
const validEventFields = {
  event_type: 'Nesting', location: 'Xi',
  scl_max: 80, scl_min: 78, scw: 60,
  ccl_max: 83, ccl_min: 81, ccw: 64,
  tail_extension: 10, vent_to_tail_tip: 14, total_tail_length: 24,
  health_condition: 'Healthy', observer: 'E. Papadaki',
};

let clientQuery;
let committed;
let rolledBack;

beforeEach(() => {
  // Settings/list lookups (checkFieldRequirements, outOfRange's callers,
  // listError) go through the pool, not the transaction client - empty
  // rows means "nothing configured", which every one of them treats as
  // "nothing to enforce".
  vi.spyOn(db, 'query').mockResolvedValue({ rows: [] });

  committed = false;
  rolledBack = false;
  let nextId = 900;

  clientQuery = vi.fn(async (sql) => {
    const text = String(sql);
    if (text.includes('BEGIN')) return { rows: [] };
    if (text.includes('COMMIT')) { committed = true; return { rows: [] }; }
    if (text.includes('ROLLBACK')) { rolledBack = true; return { rows: [] }; }
    if (text.includes('INSERT INTO turtles')) {
      return { rows: [{ id: nextId++, ...validTurtle, name: null }] };
    }
    if (text.includes('INSERT INTO turtle_survey_events')) {
      return { rows: [{ id: nextId++, event_type: 'Nesting', turtle_id: 900, location: 'Xi' }] };
    }
    return { rows: [] };
  });
  vi.spyOn(db, 'connect').mockResolvedValue({ query: clientQuery, release: vi.fn() });
});

afterAll(() => db.end().catch(() => {}));

describe('POST /turtles/create-with-event', () => {
  it('creates the turtle and its first encounter together and commits once', async () => {
    const res = await auth(request(app).post('/turtles/create-with-event')).send({
      ...validTurtle,
      ...validEventFields,
    });

    expect(res.status).toBe(200);
    expect(res.body.turtle).toBeTruthy();
    expect(res.body.event).toBeTruthy();
    expect(committed).toBe(true);
    expect(rolledBack).toBe(false);
  });

  it('rolls back the turtle insert when the event fails validation, instead of leaving an orphan', async () => {
    const res = await auth(request(app).post('/turtles/create-with-event')).send({
      ...validTurtle,
      ...validEventFields,
      event_date: '2099-01-01', // futureDateError rejects this
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/future/i);
    expect(rolledBack).toBe(true);
    expect(committed).toBe(false);
    // The turtle INSERT ran (it's first in the transaction) but was never
    // committed - the whole point of wrapping both in one transaction.
    const turtleInsertCalls = clientQuery.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO turtles'));
    expect(turtleInsertCalls.length).toBe(1);
  });

  it('rolls back when the turtle itself fails validation, before any event insert is attempted', async () => {
    const res = await auth(request(app).post('/turtles/create-with-event')).send({
      ...validEventFields,
      // species/health_condition missing -> insertTurtle's own validation fails first.
    });

    expect(res.status).toBe(400);
    expect(rolledBack).toBe(true);
    expect(committed).toBe(false);
    const eventInsertCalls = clientQuery.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO turtle_survey_events'));
    expect(eventInsertCalls.length).toBe(0);
  });

  it('refuses a caller with no recognised role', async () => {
    const res = await request(app).post('/turtles/create-with-event').send({ ...validTurtle, ...validEventFields });
    expect(res.status).toBe(401);
  });
});
