// Coordinator-configurable field requirements.
//
// What these cases pin down:
//   - defaults reproduce exactly what the API already accepted, so shipping
//     this never starts rejecting a request that used to succeed
//   - only the allowlisted fields can be configured; structural ones
//     (nest_code, dates, event_type, beach...) are never touched by this
//   - turning a field to "required" blocks a request missing it, and back to
//     "recommended" un-blocks it
//   - reburied measurements are only enforced when eggs were reburied, and
//     that gate itself is not configurable
//   - a value omitted under "recommended" saves as null, not a crash
//   - only a coordinator can change the settings, and the schema rejects an
//     unlisted key rather than silently storing it
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const as = (role, sub) => (req) =>
  req.set('Authorization', `Bearer ${jwt.sign({ sub, role, email: `${sub}@turtleguard.demo` }, SECRET, { expiresIn: '1h' })}`);
const asLeader = as('Field Leader', '7');
const asCoordinator = as('Project Coordinator', '1');
const asVolunteer = as('Field Volunteer', '51');

let stored;
let query;
let clientQuery;

const setLevel = (form, field, level) => {
  stored.field_requirements = stored.field_requirements || {};
  stored.field_requirements[form] = { ...(stored.field_requirements[form] || {}), [field]: level };
};

beforeEach(() => {
  stored = {};
  clientQuery = vi.fn().mockResolvedValue({ rows: [{ id: 1, nest_code: 'LG2-9' }] });
  vi.spyOn(db, 'connect').mockResolvedValue({ query: clientQuery, release: vi.fn() });
  query = vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    const text = String(sql);
    if (text.includes('FROM app_settings')) {
      return { rows: stored[params[0]] ? [{ value: stored[params[0]] }] : [] };
    }
    if (text.includes('INSERT INTO app_settings')) {
      stored[params[0]] = JSON.parse(params[1]);
      return { rows: [] };
    }
    if (text.includes('SELECT n.id, n.total_num_eggs')) return { rows: [{ id: 1, total_num_eggs: 100, emerged_so_far: 0 }] };
    return { rows: [{ id: 1, nest_code: 'LG2-9', beach: 'Loggos 2' }] };
  });
});

afterAll(() => db.end().catch(() => {}));

const validNest = {
  nest_code: 'QA-FR-1', beach: 'Loggos 2', date_found: '2026-08-30', depth_top_egg_h: 30,
};
const validEmergence = { event_date: '2026-08-30' };
const validNestEvent = { event_type: 'PARTIAL_INVENTORY', nest_code: 'LG2-9', total_eggs: 90, eggs_reburied: 0 };
const validTurtle = { species: 'Caretta caretta', health_condition: 'Healthy' };
const validSurvey = { survey_date: '2026-08-30', start_time: '06:00', end_time: '07:00', beach_id: 1 };

describe('defaults match current API behaviour', () => {
  it('nest still needs GPS and distance to sea, as it always has', async () => {
    const res = await asVolunteer(request(app).post('/nests/create')).send(validNest);
    expect(res.status).toBe(400);
  });

  it('saves a nest with GPS and distance to sea, and omitted optional fields do not crash the save', async () => {
    const res = await asVolunteer(request(app).post('/nests/create'))
      .send({ ...validNest, gps_lat: 38.1, gps_long: 20.5, distance_to_sea_s: 12 });
    expect(res.status).toBe(200);
  });

  it('emergence still saves without GPS, as the API always allowed - only the screen enforced it', async () => {
    const res = await asVolunteer(request(app).post('/emergences')).send(validEmergence);
    expect(res.status).toBe(201);
  });

  it('a nest event still saves without an observer', async () => {
    const res = await asVolunteer(request(app).post('/nest-events/create')).send(validNestEvent);
    expect(res.status).toBeLessThan(400);
  });

  it('a nest event with eggs reburied still saves without reburied measurements', async () => {
    const res = await asVolunteer(request(app).post('/nest-events/create'))
      .send({ ...validNestEvent, eggs_reburied: 20 });
    expect(res.status).toBeLessThan(400);
  });

  it('a turtle still needs every measurement, as it always has', async () => {
    const res = await asVolunteer(request(app).post('/turtles/create')).send(validTurtle);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/measurement/i);
  });

  it('a survey still saves without corner GPS', async () => {
    const res = await asVolunteer(request(app).post('/morning-surveys')).send(validSurvey);
    expect(res.status).toBe(201);
  });

  it('GET /settings reports the same defaults', async () => {
    const res = await asVolunteer(request(app).get('/settings'));
    expect(res.body.field_requirements.nest.gps).toBe('required');
    expect(res.body.field_requirements.emergence.gps).toBe('recommended');
    expect(res.body.field_requirements.turtle.measurements).toBe('required');
    expect(res.body.field_requirements.nest_event.observer).toBe('recommended');
  });
});

describe('a coordinator can tighten or loosen a configurable field', () => {
  it('blocks an emergence missing GPS once GPS is made required', async () => {
    setLevel('emergence', 'gps', 'required');
    const res = await asVolunteer(request(app).post('/emergences')).send(validEmergence);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/GPS/);
  });

  it('accepts a nest missing GPS once GPS is made recommended', async () => {
    setLevel('nest', 'gps', 'recommended');
    const res = await asVolunteer(request(app).post('/nests/create')).send({ ...validNest, distance_to_sea_s: 12 });
    expect(res.status).toBe(200);
  });

  it('lets a turtle save without measurements once they are made recommended', async () => {
    setLevel('turtle', 'measurements', 'recommended');
    const res = await asVolunteer(request(app).post('/turtles/create')).send(validTurtle);
    expect(res.status).toBe(200);
  });

  it('requires reburied measurements only once eggs were actually reburied', async () => {
    setLevel('nest_event', 'reburied_measurements', 'required');
    const noneReburied = await asVolunteer(request(app).post('/nest-events/create')).send(validNestEvent);
    expect(noneReburied.status).toBeLessThan(400);

    const someReburied = await asVolunteer(request(app).post('/nest-events/create'))
      .send({ ...validNestEvent, eggs_reburied: 20 });
    expect(someReburied.status).toBe(400);
    expect(someReburied.body.error).toMatch(/reburied/i);
  });

  it('requiring one tag position does not require the others', async () => {
    setLevel('turtle', 'front_left_tag', 'required');
    const measurements = {
      scl_max: 80, scl_min: 70, scw: 60, ccl_max: 82, ccl_min: 75, ccw: 65,
      tail_extension: 20, vent_to_tail_tip: 15, total_tail_length: 35,
    };
    const missing = await asVolunteer(request(app).post('/turtles/create')).send({ ...validTurtle, ...measurements });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/front-left/i);
    const ok = await asVolunteer(request(app).post('/turtles/create'))
      .send({ ...validTurtle, ...measurements, front_left_tag: 'AB1', front_left_address: 'shoulder' });
    expect(ok.status).toBe(200);
  });
});

describe('the allowlist', () => {
  it('never lets nest_code, dates or event_type become optional', async () => {
    // Not in FORM_FIELD_SCHEMA at all - readFieldRequirementsBody has nothing
    // to accept for them, so there is no setting that could loosen them.
    const res = await asCoordinator(request(app).put('/settings/field-requirements')).send({
      nest: { gps: 'recommended', distance_to_sea_s: 'recommended', track_sketch: 'recommended', triangulation: 'recommended', notes: 'recommended', nest_code: 'recommended' },
      emergence: { gps: 'recommended', distance_to_sea_s: 'recommended', track_sketch: 'recommended' },
      nest_event: { reburied_measurements: 'recommended', observer: 'recommended', notes: 'recommended', event_type: 'recommended' },
      turtle: { front_left_tag: 'recommended', front_right_tag: 'recommended', rear_left_tag: 'recommended', rear_right_tag: 'recommended', measurements: 'required' },
      morning_survey: { gps: 'recommended', protected_nest_count: 'recommended', notes: 'recommended' },
    });
    expect(res.status).toBe(200);
    expect(stored.field_requirements.nest.nest_code).toBeUndefined();

    const missingNestCode = await asVolunteer(request(app).post('/nests/create'))
      .send({ beach: 'Loggos 2', date_found: '2026-08-30', depth_top_egg_h: 30, distance_to_sea_s: 12 });
    expect(missingNestCode.status).toBe(400);
  });

  it.each([
    ['an unknown level', { nest: { gps: 'sometimes' } }],
    ['a missing form', { nest: {} }],
  ])('rejects %s', async (_name, body) => {
    const full = {
      nest: { gps: 'required', distance_to_sea_s: 'required', track_sketch: 'recommended', triangulation: 'recommended', notes: 'recommended' },
      emergence: { gps: 'recommended', distance_to_sea_s: 'recommended', track_sketch: 'recommended' },
      nest_event: { reburied_measurements: 'recommended', observer: 'recommended', notes: 'recommended' },
      turtle: { front_left_tag: 'recommended', front_right_tag: 'recommended', rear_left_tag: 'recommended', rear_right_tag: 'recommended', measurements: 'required' },
      morning_survey: { gps: 'recommended', protected_nest_count: 'recommended', notes: 'recommended' },
      ...body,
    };
    const res = await asCoordinator(request(app).put('/settings/field-requirements')).send(full);
    expect(res.status).toBe(400);
    expect(stored.field_requirements).toBeUndefined();
  });

  it('is coordinator only', async () => {
    const res = await asLeader(request(app).put('/settings/field-requirements')).send({});
    expect(res.status).toBe(403);
  });
});
