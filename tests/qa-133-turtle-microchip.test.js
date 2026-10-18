// QA-133: Tag a Turtle already sent microchip_number/microchip_location to
// POST /turtles/create-with-event, but neither insertTurtle nor
// insertTurtleSurveyEvent destructured those fields, so they were silently
// dropped before any SQL ran - the save succeeded (201) but the chip number
// was never stored, and Turtle Details then showed "NO CHIP DETECTED".
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

beforeEach(() => {
  vi.spyOn(db, 'query').mockResolvedValue({ rows: [] });

  let nextId = 900;
  clientQuery = vi.fn(async (sql) => {
    const text = String(sql);
    if (text.includes('BEGIN') || text.includes('COMMIT') || text.includes('ROLLBACK')) return { rows: [] };
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

describe('POST /turtles/create-with-event stores the microchip number (QA-133)', () => {
  it('binds microchip_number/microchip_location into the turtles INSERT', async () => {
    const res = await auth(request(app).post('/turtles/create-with-event')).send({
      ...validTurtle,
      ...validEventFields,
      microchip_number: '985141002387761',
      microchip_location: 'Left front flipper, proximal',
    });

    expect(res.status).toBe(200);

    const [sql, params] = clientQuery.mock.calls.find(([s]) => String(s).includes('INSERT INTO turtles'));
    expect(sql).toContain('microchip_number');
    expect(sql).toContain('microchip_location');
    expect(params).toContain('985141002387761');
    expect(params).toContain('Left front flipper, proximal');
  });

  it('binds microchip_number/microchip_location into the turtle_survey_events INSERT', async () => {
    await auth(request(app).post('/turtles/create-with-event')).send({
      ...validTurtle,
      ...validEventFields,
      microchip_number: '985141002387761',
      microchip_location: 'Left front flipper, proximal',
    });

    const [sql, params] = clientQuery.mock.calls.find(([s]) => String(s).includes('INSERT INTO turtle_survey_events'));
    expect(sql).toContain('microchip_number');
    expect(sql).toContain('microchip_location');
    expect(params).toContain('985141002387761');
    expect(params).toContain('Left front flipper, proximal');
  });

  it('binds null, not undefined, when no microchip was recorded', async () => {
    const res = await auth(request(app).post('/turtles/create-with-event')).send({
      ...validTurtle,
      ...validEventFields,
    });

    expect(res.status).toBe(200);
    const [, turtleParams] = clientQuery.mock.calls.find(([s]) => String(s).includes('INSERT INTO turtles'));
    const [, eventParams] = clientQuery.mock.calls.find(([s]) => String(s).includes('INSERT INTO turtle_survey_events'));
    // Last two bound params on each INSERT are microchip_number, microchip_location.
    expect(turtleParams.slice(-2)).toEqual([null, null]);
    expect(eventParams.slice(-2)).toEqual([null, null]);
  });
});
