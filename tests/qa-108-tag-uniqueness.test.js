// QA-108: a flipper tag already on an ACTIVE turtle could be assigned again by
// POST /turtles/create and POST /turtles/create-with-event. Both now answer 409
// with the same wording the Tagging form uses. Archived turtles do not hold a
// tag, so they never block one.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const token = jwt.sign({ sub: '49', role: 'Field Leader', email: 'x@turtleguard.demo' }, SECRET, { expiresIn: '1h' });
const auth = (r) => r.set('Authorization', `Bearer ${token}`);

const validTurtle = {
  species: 'Caretta caretta', sex: 'female', health_condition: 'Healthy',
  scl_max: 80, scl_min: 78, scw: 60, ccl_max: 83, ccl_min: 81, ccw: 64,
  tail_extension: 10, vent_to_tail_tip: 14, total_tail_length: 24,
};
const validEvent = {
  event_type: 'Nesting', location: 'Xi',
  scl_max: 80, scl_min: 78, scw: 60,
  ccl_max: 83, ccl_min: 81, ccw: 64,
  tail_extension: 10, vent_to_tail_tip: 14, total_tail_length: 24,
  health_condition: 'Healthy', observer: 'E. Papadaki',
};

// The tag-ownership lookup: the only query that reads turtles.front/rear tags.
const isTagLookup = (sql) => /FROM turtles\s+WHERE is_archived = FALSE/i.test(sql);

let owners;      // rows the tag lookup returns (what SQL would match)
let query;
let clientQuery;
let rolledBack;
let committed;

beforeEach(() => {
  owners = [];
  rolledBack = false;
  committed = false;

  query = vi.spyOn(db, 'query').mockImplementation(async (sql) => {
    if (isTagLookup(sql)) return { rows: owners, rowCount: owners.length };
    if (/INSERT INTO turtles/i.test(sql)) return { rows: [{ id: 50, name: null, ...validTurtle }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });

  let nextId = 900;
  clientQuery = vi.fn(async (sql) => {
    const text = String(sql);
    if (text.includes('BEGIN')) return { rows: [] };
    if (text.includes('COMMIT')) { committed = true; return { rows: [] }; }
    if (text.includes('ROLLBACK')) { rolledBack = true; return { rows: [] }; }
    if (isTagLookup(text)) return { rows: owners, rowCount: owners.length };
    if (text.includes('INSERT INTO turtles')) return { rows: [{ id: nextId++, name: null, ...validTurtle }] };
    if (text.includes('INSERT INTO turtle_survey_events')) return { rows: [{ id: nextId++, turtle_id: 900 }] };
    return { rows: [] };
  });
  vi.spyOn(db, 'connect').mockResolvedValue({ query: clientQuery, release: vi.fn() });
});

afterAll(() => db.end().catch(() => {}));

const insertCalls = () => query.mock.calls.filter(([sql]) => /INSERT INTO turtles/i.test(sql));

describe('POST /turtles/create — tag already on an active turtle (QA-108)', () => {
  it('refuses a front-left tag held by an active turtle with 409 and the form wording', async () => {
    owners = [{ id: 9, name: 'Maria', front_left_tag: 'KF-1234', front_right_tag: null, rear_left_tag: null, rear_right_tag: null }];

    const res = await auth(request(app).post('/turtles/create')).send({ ...validTurtle, front_left_tag: 'KF-1234' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Tag KF-1234 (Front Left) is already assigned to Maria.');
    expect(insertCalls()).toHaveLength(0);
  });

  it('names the position of the new tag and the owner it clashes with', async () => {
    owners = [{ id: 14, name: null, front_left_tag: null, front_right_tag: 'KF-5555', rear_left_tag: null, rear_right_tag: null }];

    const res = await auth(request(app).post('/turtles/create')).send({ ...validTurtle, rear_right_tag: 'KF-5555' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Tag KF-5555 (Rear Right) is already assigned to Turtle #14.');
  });

  it('checks every tag position and the KF- prefix as stored', async () => {
    await auth(request(app).post('/turtles/create')).send({ ...validTurtle, front_left_tag: 'KF-1234', rear_left_tag: 'KF-77' });

    const lookup = query.mock.calls.find(([sql]) => isTagLookup(sql));
    expect(lookup[1][0]).toEqual(['KF-1234', 'KF-77']);
  });

  it('lets a turtle be created when its tag is free (no active owner)', async () => {
    owners = [];
    const res = await auth(request(app).post('/turtles/create')).send({ ...validTurtle, front_left_tag: 'KF-4242' });

    expect(res.status).toBe(200);
    expect(insertCalls()).toHaveLength(1);
  });

  it('only looks at active turtles, so an archived holder cannot block the tag', async () => {
    await auth(request(app).post('/turtles/create')).send({ ...validTurtle, front_left_tag: 'KF-1234' });

    const lookup = query.mock.calls.find(([sql]) => isTagLookup(sql));
    expect(lookup[0]).toMatch(/is_archived = FALSE/);
  });
});

describe('POST /turtles/create-with-event — tag already on an active turtle (QA-108)', () => {
  it('returns 409, rolls back, and inserts neither the turtle nor the event', async () => {
    owners = [{ id: 9, name: 'Maria', front_left_tag: 'KF-1234', front_right_tag: null, rear_left_tag: null, rear_right_tag: null }];

    const res = await auth(request(app).post('/turtles/create-with-event'))
      .send({ ...validTurtle, ...validEvent, front_left_tag: 'KF-1234' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Tag KF-1234 (Front Left) is already assigned to Maria.');
    expect(rolledBack).toBe(true);
    expect(committed).toBe(false);
    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql));
    expect(sqls.some((s) => s.includes('INSERT INTO turtles'))).toBe(false);
    expect(sqls.some((s) => s.includes('INSERT INTO turtle_survey_events'))).toBe(false);
  });

  it('takes the tag-assignment lock before checking, inside the transaction', async () => {
    await auth(request(app).post('/turtles/create-with-event'))
      .send({ ...validTurtle, ...validEvent, front_left_tag: 'KF-4242' });

    const sqls = clientQuery.mock.calls.map(([sql]) => String(sql));
    const lock = sqls.findIndex((s) => s.includes('pg_advisory_xact_lock'));
    const begin = sqls.findIndex((s) => s.includes('BEGIN'));
    const check = sqls.findIndex((s) => isTagLookup(s));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(begin);
    expect(check).toBeGreaterThan(lock);
  });

  it('creates the turtle and event when the tag is free', async () => {
    owners = [];
    const res = await auth(request(app).post('/turtles/create-with-event'))
      .send({ ...validTurtle, ...validEvent, front_left_tag: 'KF-4242' });

    expect(res.status).toBe(200);
    expect(committed).toBe(true);
  });
});
