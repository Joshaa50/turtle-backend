// QA-063: tail_extension/vent_to_tail_tip/total_tail_length are "recommended",
// not required - POST /turtle_survey_events/create must accept a body with
// any or all of them left out, while the fields that actually are required
// (the core carapace measurements, health_condition, observer) still block.
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

const validEvent = {
  event_type: 'Nesting', location: 'Xi', turtle_id: 42,
  scl_max: 80, scl_min: 78, scw: 60,
  ccl_max: 83, ccl_min: 81, ccw: 64,
  tail_extension: 10, vent_to_tail_tip: 14, total_tail_length: 24,
  health_condition: 'Healthy', observer: 'E. Papadaki',
};

beforeEach(() => {
  vi.spyOn(db, 'query').mockImplementation(async (sql) => {
    const text = String(sql);
    if (text.includes('INSERT INTO turtle_survey_events')) {
      return { rows: [{ id: 901, turtle_id: 42, event_type: 'Nesting' }] };
    }
    return { rows: [] };
  });
});

afterAll(() => db.end().catch(() => {}));

describe('POST /turtle_survey_events/create', () => {
  it('saves when all three tail measurements are omitted', async () => {
    const { tail_extension, vent_to_tail_tip, total_tail_length, ...rest } = validEvent;
    const res = await auth(request(app).post('/turtle_survey_events/create')).send(rest);
    expect(res.status).toBe(200);
  });

  it('saves when only one of the three tail measurements is given', async () => {
    const res = await auth(request(app).post('/turtle_survey_events/create')).send({
      ...validEvent, vent_to_tail_tip: null, total_tail_length: null,
    });
    expect(res.status).toBe(200);
  });

  it.each([
    ['scl_max'], ['ccl_max'], ['health_condition'], ['observer'],
  ])('still rejects a body missing %s', async (field) => {
    const { [field]: _omit, ...rest } = validEvent;
    const res = await auth(request(app).post('/turtle_survey_events/create')).send(rest);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(new RegExp(field));
  });
});
