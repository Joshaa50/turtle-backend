// Regression: the role gates that exist in the UI had no counterpart on the API,
// so a Field Volunteer's own token reached everything - including the whole user
// directory.
//
// Observed against the live QA backend with a token from
// POST /demo/login {role:"Volunteer"} (maria.karydi@turtleguard.demo,
// role "Field Volunteer"):
//
//   GET  /users                -> 200, 46 rows including every user's email,
//                                 role, station and is_active flag
//
// That directory leak is what stays closed: GET /users is Coordinator/Field
// Leader only, and this file fails if that guard is ever widened.
//
// Field-record writes are a different question, and the product decision is that
// a Field Volunteer may make them - they do the bulk of the beach work, and a
// Field Leader confirming their submissions is a separate approval flow, built
// later. So the write routes below must accept a volunteer, while still refusing
// a caller with no token or an unrecognised role: the guard is present, it is
// simply set wider than the directory guard.
//
// (Destructive actions stay narrow for the same token: DELETE /nests/:id 403,
// POST /timetable/create 403, PATCH /users/:other 403, PATCH self {role} 403.)
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const volunteerToken = jwt.sign(
  { sub: '51', role: 'Field Volunteer', email: 'maria.karydi@turtleguard.demo' },
  SECRET,
  { expiresIn: '1h' },
);

const asVolunteer = (req) => req.set('Authorization', `Bearer ${volunteerToken}`);

// A role that is not in any guard's list - stands in for a token whose role
// claim the server does not recognise.
const strangerToken = jwt.sign(
  { sub: '99', role: 'Beach Visitor', email: 'stranger@turtleguard.demo' },
  SECRET,
  { expiresIn: '1h' },
);

const asStranger = (req) => req.set('Authorization', `Bearer ${strangerToken}`);

let query;
let clientQuery;

beforeEach(() => {
  // Stubbed generously so every route below gets past its own lookups and the
  // only thing left that could stop it is a role guard.
  query = vi.spyOn(db, 'query').mockResolvedValue({
    rows: [{ id: 42, nest_code: 'QA-VOL-1', status: 'incubating' }],
  });
  clientQuery = vi.fn().mockResolvedValue({ rows: [{ id: 1 }] });
  vi.spyOn(db, 'connect').mockResolvedValue({ query: clientQuery, release: vi.fn() });
});

afterAll(() => db.end().catch(() => {}));

describe('Field Volunteer — read access', () => {
  it('cannot list the whole user directory', async () => {
    const res = await asVolunteer(request(app).get('/users'));

    expect(res.status).toBe(403);
    // And the directory query must not even run.
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('FROM users'),
    );
  });
});

const nestBody = {
  nest_code: 'QA-VOL-GUARD',
  beach: 'Loggos 2',
  date_found: '2026-08-30',
  gps_lat: 38.175,
  gps_long: 20.569,
  distance_to_sea_s: 10,
  depth_top_egg_h: 30,
  total_num_eggs: 80,
};

const turtleBody = {
  name: 'QA-Guard',
  species: 'Caretta caretta',
  sex: 'female',
  health_condition: 'Healthy',
  scl_max: 80,
  scl_min: 70,
  scw: 60,
  ccl_max: 82,
  ccl_min: 75,
  ccw: 65,
  tail_extension: 20,
  vent_to_tail_tip: 15,
  total_tail_length: 35,
};

describe('Field Volunteer — field-record writes', () => {
  it('can create a nest', async () => {
    const res = await asVolunteer(request(app).post('/nests/create')).send(nestBody);

    expect(res.status).toBeLessThan(400);
  });

  it('can update an existing nest', async () => {
    const res = await asVolunteer(request(app).put('/nests/42/update')).send({
      nest_code: 'QA-VOL-1',
      beach: 'Loggos 2',
      date_found: '2026-08-30',
      gps_lat: 38.175,
      gps_long: 20.569,
      distance_to_sea_s: 10,
      depth_top_egg_h: 30,
      total_num_eggs: 80,
      status: 'incubating',
    });

    expect(res.status).toBeLessThan(400);
  });

  it('can create a turtle record', async () => {
    const res = await asVolunteer(request(app).post('/turtles/create')).send(turtleBody);

    expect(res.status).toBeLessThan(400);
  });
});

describe('field-record writes still need a recognised role', () => {
  it('refuses a caller with no token', async () => {
    const res = await request(app).post('/nests/create').send(nestBody);

    expect(res.status).toBe(401);
  });

  it('refuses a caller whose role is not one of the recorders', async () => {
    const res = await asStranger(request(app).post('/nests/create')).send(nestBody);

    expect(res.status).toBe(403);
  });
});
