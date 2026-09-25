// The Field Leader approval flow.
//
// A Field Volunteer records like anyone else and the record is stored
// immediately - a volunteer on a beach at dawn must never lose an observation
// waiting for a reviewer. What the queue adds is a Field Leader's confirmation
// on top of a record that already exists, so nothing here may gate the write
// itself.
//
// What these cases pin down:
//   - a volunteer's create enrols the record in the queue, and everyone else's
//     does not (their record is reviewed fieldwork by virtue of who made it)
//   - only Coordinators and Field Leaders can read the queue or decide on it
//   - a volunteer can see their own submissions and nobody else's
//   - a rejection carries a reason, and a decision cannot be made twice
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const tokenFor = (role, sub) =>
  jwt.sign({ sub, role, email: `${sub}@turtleguard.demo` }, SECRET, { expiresIn: '1h' });

const VOLUNTEER = tokenFor('Field Volunteer', '51');
const LEADER = tokenFor('Field Leader', '7');
const COORDINATOR = tokenFor('Project Coordinator', '1');
const ASSISTANT = tokenFor('Field Assistant', '22');

const as = (token) => (req) => req.set('Authorization', `Bearer ${token}`);
const asVolunteer = as(VOLUNTEER);
const asLeader = as(LEADER);
const asCoordinator = as(COORDINATOR);
const asAssistant = as(ASSISTANT);

let query;
let clientQuery;

beforeEach(() => {
  query = vi.spyOn(db, 'query').mockResolvedValue({
    rows: [{ id: 42, nest_code: 'LG2-9', status: 'pending', record_type: 'nest', record_id: 42 }],
  });
  clientQuery = vi.fn().mockResolvedValue({ rows: [{ id: 42, nest_code: 'LG2-9' }] });
  vi.spyOn(db, 'connect').mockResolvedValue({ query: clientQuery, release: vi.fn() });
});

afterAll(() => db.end().catch(() => {}));

const turtleBody = {
  name: 'QA-Review',
  species: 'Caretta caretta',
  sex: 'female',
  health_condition: 'Healthy',
  scl_max: 80, scl_min: 70, scw: 60,
  ccl_max: 82, ccl_min: 75, ccw: 65,
  tail_extension: 20, vent_to_tail_tip: 15, total_tail_length: 35,
};

const wroteReviewRow = (spy) =>
  spy.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO record_reviews'));

describe('enrolling a record in the queue', () => {
  it("queues a volunteer's turtle record", async () => {
    const res = await asVolunteer(request(app).post('/turtles/create')).send(turtleBody);

    expect(res.status).toBeLessThan(400);
    expect(wroteReviewRow(query)).toBe(true);
  });

  it("does not queue a Field Assistant's record", async () => {
    const res = await asAssistant(request(app).post('/turtles/create')).send(turtleBody);

    expect(res.status).toBeLessThan(400);
    expect(wroteReviewRow(query)).toBe(false);
  });

  it("does not queue a Field Leader's record", async () => {
    await asLeader(request(app).post('/turtles/create')).send(turtleBody);

    expect(wroteReviewRow(query)).toBe(false);
  });

  it('still saves the record when queueing it fails', async () => {
    // The record is committed before the queue insert on this route, so a
    // failure there must not tell a field worker their save failed.
    query.mockImplementation((sql) =>
      String(sql).includes('INSERT INTO record_reviews')
        ? Promise.reject(new Error('queue unavailable'))
        : Promise.resolve({ rows: [{ id: 42 }] }),
    );

    const res = await asVolunteer(request(app).post('/turtles/create')).send(turtleBody);

    expect(res.status).toBeLessThan(400);
    expect(res.body.turtle).toBeDefined();
  });
});

describe('reading the queue', () => {
  it('lets a Field Leader read it', async () => {
    const res = await asLeader(request(app).get('/reviews'));
    expect(res.status).toBe(200);
  });

  it('lets a Coordinator read it', async () => {
    const res = await asCoordinator(request(app).get('/reviews'));
    expect(res.status).toBe(200);
  });

  it('refuses a Field Volunteer', async () => {
    const res = await asVolunteer(request(app).get('/reviews'));
    expect(res.status).toBe(403);
  });

  it('refuses a Field Assistant', async () => {
    const res = await asAssistant(request(app).get('/reviews'));
    expect(res.status).toBe(403);
  });

  it('refuses a caller with no token', async () => {
    const res = await request(app).get('/reviews');
    expect(res.status).toBe(401);
  });

  it('rejects an unknown status filter', async () => {
    const res = await asLeader(request(app).get('/reviews?status=banana'));
    expect(res.status).toBe(400);
  });

  it('scopes /reviews/mine to the caller', async () => {
    const res = await asVolunteer(request(app).get('/reviews/mine'));

    expect(res.status).toBe(200);
    // The submitter filter must be the caller's own id, not a value from the
    // request - otherwise "mine" would read anyone's.
    const call = query.mock.calls.find(([sql]) => String(sql).includes('r.submitted_by = $1'));
    expect(call).toBeDefined();
    expect(call[1]).toEqual(['51']);
  });
});

describe('deciding on a submission', () => {
  it('lets a Field Leader approve', async () => {
    const res = await asLeader(request(app).post('/reviews/5/approve')).send({});
    expect(res.status).toBe(200);
  });

  it('refuses a volunteer approving their own work', async () => {
    const res = await asVolunteer(request(app).post('/reviews/5/approve')).send({});

    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE record_reviews'),
      expect.anything(),
    );
  });

  it('requires a note on a rejection', async () => {
    const res = await asLeader(request(app).post('/reviews/5/reject')).send({ note: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/note/i);
  });

  it('accepts a rejection that carries a reason', async () => {
    const res = await asLeader(request(app).post('/reviews/5/reject'))
      .send({ note: 'Distance to sea measured from the wrong marker.' });

    expect(res.status).toBe(200);
  });

  it('reports a 409 when someone else already decided it', async () => {
    // The guarded UPDATE matches nothing, and the row turns out to exist with a
    // decision already on it.
    query.mockImplementation((sql) => {
      const text = String(sql);
      if (text.includes('UPDATE record_reviews')) return Promise.resolve({ rows: [] });
      if (text.includes('SELECT status FROM record_reviews')) {
        return Promise.resolve({ rows: [{ status: 'approved' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await asLeader(request(app).post('/reviews/5/approve')).send({});

    expect(res.status).toBe(409);
    expect(res.body.status).toBe('approved');
  });

  it('reports a 404 when the review does not exist', async () => {
    query.mockResolvedValue({ rows: [] });

    const res = await asLeader(request(app).post('/reviews/999/approve')).send({});

    expect(res.status).toBe(404);
  });
});

describe('cleaning up orphaned review rows', () => {
  const wroteReviewCascade = (spy, type) =>
    spy.mock.calls.some(
      ([sql]) =>
        String(sql).includes('DELETE FROM record_reviews') &&
        String(sql).includes(`record_type = '${type}'`),
    );

  it('removes the review row when the turtle it points at is archived and deleted', async () => {
    clientQuery.mockImplementation((sql) => {
      const text = String(sql);
      if (text.includes('SELECT is_archived FROM turtles')) {
        return Promise.resolve({ rows: [{ is_archived: true }] });
      }
      if (text.includes('DELETE FROM turtles')) return Promise.resolve({ rows: [{ id: 42 }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await asLeader(request(app).delete('/turtles/42'));

    expect(res.status).toBe(200);
    expect(wroteReviewCascade(clientQuery, 'turtle')).toBe(true);
  });

  it('removes the review row when a nest is deleted', async () => {
    clientQuery.mockImplementation((sql) => {
      const text = String(sql);
      if (text.includes('SELECT id, nest_code FROM turtle_nests')) {
        return Promise.resolve({ rows: [{ id: 55, nest_code: 'LG2-9' }] });
      }
      return Promise.resolve({ rows: [{ id: 55 }] });
    });

    const res = await asLeader(request(app).delete('/nests/55'));

    expect(res.status).toBe(200);
    expect(wroteReviewCascade(clientQuery, 'nest')).toBe(true);
  });

  it('removes the review row when an emergence is deleted', async () => {
    clientQuery.mockImplementation((sql) => {
      const text = String(sql);
      if (text.includes('SELECT nest_code FROM turtle_nests WHERE emergence_id')) {
        return Promise.resolve({ rows: [] }); // not attached to a nest
      }
      return Promise.resolve({ rows: [{ id: 77 }] });
    });

    const res = await asLeader(request(app).delete('/emergences/77'));

    expect(res.status).toBe(200);
    expect(wroteReviewCascade(clientQuery, 'emergence')).toBe(true);
  });
});

describe('manually dismissing a review row', () => {
  it('lets a Field Leader remove one', async () => {
    query.mockResolvedValue({ rows: [{ id: 1 }] });

    const res = await asLeader(request(app).delete('/reviews/1'));

    expect(res.status).toBe(200);
  });

  it('refuses a Field Volunteer', async () => {
    const res = await asVolunteer(request(app).delete('/reviews/1'));
    expect(res.status).toBe(403);
  });

  it('refuses a Field Assistant', async () => {
    const res = await asAssistant(request(app).delete('/reviews/1'));
    expect(res.status).toBe(403);
  });

  it('reports 404 for a row that does not exist', async () => {
    query.mockResolvedValue({ rows: [] });

    const res = await asLeader(request(app).delete('/reviews/999'));

    expect(res.status).toBe(404);
  });

  it('does not touch the underlying record', async () => {
    query.mockResolvedValue({ rows: [{ id: 1 }] });

    await asLeader(request(app).delete('/reviews/1'));

    expect(query).not.toHaveBeenCalledWith(
      expect.stringMatching(/DELETE FROM (turtle_nests|turtles|turtle_emergences)/),
      expect.anything(),
    );
  });
});
