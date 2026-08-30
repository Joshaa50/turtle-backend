// Regression: numeric fields are stored exactly as sent, with no range check.
//
// Observed against the live QA backend as Field Leader (demo account
// elena.papadaki@turtleguard.demo):
//
//   POST /nests/create {total_num_eggs:-500, current_num_eggs:-999,
//                       depth_top_egg_h:-25, distance_to_sea_s:-40, width_w:-5}
//   -> 200, nest id 41 "QA-NEG-1" persisted with every one of those negatives,
//      and the Dashboard's "TOTAL EGGS" tile fell from 2,097 to 1,597.
//
//   POST /nest-events/create {tracks_to_sea:-75, tracks_lost:999999}
//   -> 200, event id 57 persisted (reached through the Nest Records
//      "Log Hatchling Tracks" modal, so this is a real user path).
//
//   POST /turtles/create {scl_max:-80, ccl_min:-1} -> 200, turtle id 19.
//   POST /turtles/create {ccl_max:99999}           -> 500 "Server error."
//      (an out-of-range value surfaces as an opaque server error rather than
//      a validation message; reached through Tagging Entry in the UI.)
//
// These tests assert the validation that does not exist yet, so they fail on
// the current server for exactly that reason.
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

let query;
let connect;
let clientQuery;

beforeEach(() => {
  query = vi.spyOn(db, 'query').mockRejectedValue(
    new Error('db.query called without a stub in this test'),
  );
  clientQuery = vi.fn().mockResolvedValue({ rows: [{ id: 1 }] });
  connect = vi.spyOn(db, 'connect').mockResolvedValue({
    query: clientQuery,
    release: vi.fn(),
  });
});

afterAll(() => db.end().catch(() => {}));

const validNest = {
  nest_code: 'QA-RANGE-1',
  beach: 'Loggos 2',
  date_found: '2026-08-30',
  gps_lat: 38.175,
  gps_long: 20.569,
  distance_to_sea_s: 12,
  depth_top_egg_h: 30,
};

describe('POST /nests/create — numeric ranges', () => {
  it('rejects a negative egg count instead of storing it', async () => {
    const res = await auth(request(app).post('/nests/create')).send({
      ...validNest,
      total_num_eggs: -500,
      current_num_eggs: -999,
    });

    expect(res.status).toBe(400);
    // Nothing should have been written.
    expect(clientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO turtle_nests'),
      expect.anything(),
    );
  });

  it('rejects negative depths and a negative distance to sea', async () => {
    const res = await auth(request(app).post('/nests/create')).send({
      ...validNest,
      depth_top_egg_h: -25,
      depth_bottom_chamber_h: -10,
      width_w: -5,
      distance_to_sea_s: -40,
    });

    expect(res.status).toBe(400);
  });

  it('rejects an egg count that cannot be true (current > total)', async () => {
    const res = await auth(request(app).post('/nests/create')).send({
      ...validNest,
      total_num_eggs: 80,
      current_num_eggs: 500,
    });

    expect(res.status).toBe(400);
  });
});

describe('POST /nest-events/create — hatchling track counts', () => {
  it('rejects negative and absurd track counts', async () => {
    query.mockResolvedValue({ rows: [{ id: 41, nest_code: 'QA-NEG-1' }] });

    const res = await auth(request(app).post('/nest-events/create')).send({
      event_type: 'EMERGENCE',
      nest_code: 'QA-NEG-1',
      start_time: '2026-08-30 12:00:00',
      tracks_to_sea: -75,
      tracks_lost: 999999,
    });

    expect(res.status).toBe(400);
  });
});

describe('POST /turtles/create — measurement ranges', () => {
  const validTurtle = {
    name: 'QA-Ranger',
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

  it('rejects a negative carapace measurement', async () => {
    query.mockResolvedValue({ rows: [{ id: 19 }] });

    const res = await auth(request(app).post('/turtles/create')).send({
      ...validTurtle,
      scl_max: -80,
      ccl_min: -1,
    });

    expect(res.status).toBe(400);
  });

  it('answers an out-of-range measurement with a validation error, not a 500', async () => {
    // The live server answers 500 "Server error." here: 99999 overflows the
    // column, so the field worker is told nothing useful about what was wrong.
    query.mockResolvedValue({ rows: [{ id: 20 }] });

    const res = await auth(request(app).post('/turtles/create')).send({
      ...validTurtle,
      ccl_max: 99999,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ccl|measurement|range/i);
  });
});
