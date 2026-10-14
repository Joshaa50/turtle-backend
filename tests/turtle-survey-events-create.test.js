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
const volunteerToken = jwt.sign(
  { sub: '50', role: 'Field Volunteer', email: 'volunteer@turtleguard.demo' },
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
  vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    const text = String(sql);
    if (text.includes('INSERT INTO turtle_survey_events')) {
      return { rows: [{ id: 901, turtle_id: 42, event_type: 'Nesting' }] };
    }
    if (text.includes('FROM turtles')) {
      if (params?.[0] === 999999) return { rows: [] };
      return { rows: [{ id: params?.[0] ?? 42 }] };
    }
    if (text.includes('INSERT INTO record_reviews')) {
      return { rows: [{ id: 1, record_type: 'turtle', record_id: params?.[1], status: 'pending', submitted_at: new Date() }] };
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

  // QA-082: an unknown turtle_id must 404, not 500.
  it('404s for an unknown turtle_id', async () => {
    const res = await auth(request(app).post('/turtle_survey_events/create')).send({
      ...validEvent, turtle_id: 999999,
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('400s for a non-numeric turtle_id', async () => {
    const res = await auth(request(app).post('/turtle_survey_events/create')).send({
      ...validEvent, turtle_id: 'abc',
    });
    expect(res.status).toBe(400);
  });

  // QA-082: a Volunteer's submission must be held for review, not go live
  // silently with nothing in the Review Queue.
  it('queues a Field Volunteer submission for review', async () => {
    const res = await request(app)
      .post('/turtle_survey_events/create')
      .set('Authorization', `Bearer ${volunteerToken}`)
      .send(validEvent);
    expect(res.status).toBe(200);
    expect(res.body.review).toBeTruthy();
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO record_reviews'),
      expect.anything(),
    );
  });

  // A reviewer role's own submission is not held for review.
  it('does not queue a Field Leader submission for review', async () => {
    const res = await auth(request(app).post('/turtle_survey_events/create')).send(validEvent);
    expect(res.status).toBe(200);
    expect(res.body.review).toBeFalsy();
  });

  // QA-089: a NIGHT_SURVEY body with any timing field set 500'd in
  // production, because insertTurtleSurveyEvent always inserts
  // time_first_seen/time_start_egg_laying/time_covering/time_end_camouflage/
  // time_reach_sea but no boot migration had ever added those columns to
  // turtle_survey_events - only reachable against the real database, not
  // the mocked one below, so this is a source-level check that each column
  // insertTurtleSurveyEvent writes has a matching migration, same pattern as
  // the audit-trail "creates record_audit only after the pool it uses
  // exists" test.
  it('migrates every time_* column that insertTurtleSurveyEvent inserts', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    const timeColumns = [
      'time_first_seen', 'time_start_egg_laying', 'time_covering',
      'time_end_camouflage', 'time_reach_sea',
    ];
    for (const column of timeColumns) {
      const pattern = new RegExp(
        `ALTER TABLE turtle_survey_events ADD COLUMN IF NOT EXISTS ${column}\\b`,
      );
      expect(src).toMatch(pattern);
    }
  });

  // Endpoint-level happy path: a NIGHT_SURVEY body with a timing field set
  // must still reach the (mocked) INSERT and return 200, not fail earlier
  // validation - the 500 this bug caused only shows up against a real
  // database missing the column, covered by the migration check above.
  it('saves a night survey event with a timing field set', async () => {
    const res = await auth(request(app).post('/turtle_survey_events/create')).send({
      ...validEvent, event_type: 'NIGHT_SURVEY', time_first_seen: '21:15',
    });
    expect(res.status).toBe(200);
  });
});
