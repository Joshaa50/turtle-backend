// Three bugs found in the 2026-10-13 nightly QA run.
import { describe, it, expect, vi, afterAll } from 'vitest';
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

afterAll(() => db.end().catch(() => {}));

// QA-101: a nest is created with its own 1:1 emergence row, which copies the
// nest's GPS at creation time rather than deriving it. Correcting the nest's
// position must also correct that copy, or the emergence list/CSV/map keep
// showing the old, wrong coordinate forever.
describe('PUT /nests/:id/update syncs the linked emergence GPS (QA-101)', () => {
  const validNest = {
    nest_code: 'LG4-2', beach: 'Loggos 4', date_found: '2026-10-13',
    depth_top_egg_h: 36, distance_to_sea_s: 19,
    gps_lat: 38.18412, gps_long: 20.44031,
  };

  it('updates turtle_emergences GPS when the nest has an emergence_id', async () => {
    const calls = [];
    vi.spyOn(db, 'query').mockImplementation((sql, params) => {
      const text = String(sql);
      calls.push({ text, params });
      if (text.includes('SELECT nest_code, status, relocated, beach')) {
        return Promise.resolve({ rows: [{ nest_code: 'LG4-2', status: 'incubating', relocated: false, beach: 'Loggos 4', total_num_eggs: null, current_num_eggs: null, is_archived: false }] });
      }
      if (text.includes('UPDATE turtle_nests')) {
        return Promise.resolve({ rows: [{ id: 94, emergence_id: 154, nest_code: 'LG4-2', status: 'incubating' }] });
      }
      if (text.includes('UPDATE turtle_emergences SET gps_lat')) {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes('INSERT INTO record_audit')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await auth(request(app).put('/nests/94/update')).send(validNest);

    expect(res.status).toBe(200);
    const emergenceSync = calls.find((c) => c.text.includes('UPDATE turtle_emergences SET gps_lat'));
    expect(emergenceSync).toBeTruthy();
    expect(emergenceSync.params).toEqual([38.18412, 20.44031, 154]);
  });

  it('does not touch turtle_emergences when the nest has no emergence_id', async () => {
    const calls = [];
    vi.spyOn(db, 'query').mockImplementation((sql, params) => {
      const text = String(sql);
      calls.push({ text, params });
      if (text.includes('SELECT nest_code, status, relocated, beach')) {
        return Promise.resolve({ rows: [{ nest_code: 'LG4-2', status: 'incubating', relocated: false, beach: 'Loggos 4', total_num_eggs: null, current_num_eggs: null, is_archived: false }] });
      }
      if (text.includes('UPDATE turtle_nests')) {
        return Promise.resolve({ rows: [{ id: 94, emergence_id: null, nest_code: 'LG4-2', status: 'incubating' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await auth(request(app).put('/nests/94/update')).send(validNest);

    expect(res.status).toBe(200);
    expect(calls.some((c) => c.text.includes('UPDATE turtle_emergences'))).toBe(false);
  });
});

// QA-102: the curved carapace length (CCL) is always at least the straight
// length (SCL), for every species - SCL > CCL is two fields swapped or a
// misread tape, never a real turtle.
describe('POST /turtles/create rejects SCL greater than CCL (QA-102)', () => {
  const baseTurtle = { species: 'Caretta caretta', sex: 'female', health_condition: 'Healthy' };

  it('rejects scl_max greater than ccl_max', async () => {
    vi.spyOn(db, 'query').mockResolvedValue({ rows: [] });
    const res = await auth(request(app).post('/turtles/create')).send({
      ...baseTurtle, scl_max: 150, scl_min: 76.1, ccl_max: 83, ccl_min: 81.2, scw: 59.4, ccw: 70.3,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/SCL MAX.*cannot be greater than CCL MAX/i);
  });

  it('accepts a plausible loggerhead where CCL exceeds SCL as usual', async () => {
    vi.spyOn(db, 'query').mockResolvedValue({ rows: [{ id: 1, ...baseTurtle }] });
    const res = await auth(request(app).post('/turtles/create')).send({
      ...baseTurtle, scl_max: 80, scl_min: 78, ccl_max: 83, ccl_min: 81, scw: 60, ccw: 64,
    });
    expect(res.status).toBe(200);
  });
});

// QA-103: the same volunteer could be booked onto two different shifts that
// overlap in time on the same day - only an exact duplicate (same shift_id)
// was ever caught, via the unique constraint.
describe('POST /timetable/create rejects an overlapping shift for the same person (QA-103)', () => {
  it('409s when the new shift overlaps one the person already has that day', async () => {
    vi.spyOn(db, 'query').mockImplementation((sql, params) => {
      const text = String(sql);
      if (text.includes('SELECT start_time, end_time FROM shifts WHERE shift_id = $1')) {
        return Promise.resolve({ rows: [{ start_time: '06:00:00', end_time: '08:00:00' }] });
      }
      if (text.includes('FROM Timetable t JOIN shifts s')) {
        return Promise.resolve({
          rows: [{ shift_id: 2, shift_name: 'Vatsa Beach Survey', start_time: '06:00:00', end_time: '08:00:00' }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await auth(request(app).post('/timetable/create')).send({
      user_id: 10, shift_id: 5, work_date: '2026-10-21',
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Vatsa Beach Survey/);
  });

  it('allows a non-overlapping shift on the same day', async () => {
    vi.spyOn(db, 'query').mockImplementation((sql, params) => {
      const text = String(sql);
      if (text.includes('SELECT start_time, end_time FROM shifts WHERE shift_id = $1')) {
        return Promise.resolve({ rows: [{ start_time: '18:00:00', end_time: '20:00:00' }] });
      }
      if (text.includes('FROM Timetable t JOIN shifts s')) {
        return Promise.resolve({
          rows: [{ shift_id: 2, shift_name: 'Vatsa Beach Survey', start_time: '06:00:00', end_time: '08:00:00' }],
        });
      }
      if (text.includes('INSERT INTO Timetable')) {
        return Promise.resolve({ rows: [{ assignment_id: 1, user_id: 10, shift_id: 5, work_date: '2026-10-21' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await auth(request(app).post('/timetable/create')).send({
      user_id: 10, shift_id: 5, work_date: '2026-10-21',
    });

    expect(res.status).toBe(201);
  });
});
