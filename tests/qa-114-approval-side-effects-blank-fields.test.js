// QA-114 (run 3): the previous fix COALESCE'd scl/ccl/tail fields in
// PUT /turtles/:id/update, but a Field Leader's re-sighting never goes through
// that route - it goes through POST /turtle_survey_events/create, which (for
// roles that need no review) pushes the new event straight onto the turtle's
// profile via applyApprovalSideEffects. That UPDATE used plain assignment for
// scl/ccl/tail, so a re-sighting that left tail measurements blank still wiped
// the stored values on the live profile.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const token = jwt.sign({ sub: '49', role: 'Field Leader', email: 'x@turtleguard.demo' }, SECRET, { expiresIn: '1h' });

let query;
beforeEach(() => {
  query = vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (/SELECT id FROM turtles WHERE id/i.test(sql)) return { rows: [{ id: 48 }], rowCount: 1 };
    if (/INSERT INTO turtle_survey_events/i.test(sql)) {
      return { rows: [{ id: 999, tail_extension: null, vent_to_tail_tip: null, total_tail_length: null }], rowCount: 1 };
    }
    // Field Leader submissions of a "turtle" record need no review (QA-091 path).
    if (/INSERT INTO record_reviews/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/FROM turtle_survey_events WHERE turtle_id/i.test(sql)) {
      return {
        rows: [{
          health_condition: 'Healthy',
          front_left_tag: null, front_left_address: null,
          front_right_tag: null, front_right_address: null,
          rear_left_tag: null, rear_left_address: null,
          rear_right_tag: null, rear_right_address: null,
          scl_max: 78.50, scl_min: 75.00, scw: 60.00,
          ccl_max: 82.00, ccl_min: 79.00, ccw: 61.00,
          tail_extension: null, vent_to_tail_tip: null, total_tail_length: null,
        }],
        rowCount: 1,
      };
    }
    if (/UPDATE turtles SET/i.test(sql)) return { rows: [{ name: 'Kassiani' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
});
afterAll(() => db.end().catch(() => {}));

describe('POST /turtle_survey_events/create -> applyApprovalSideEffects keeps stored tail values (QA-114)', () => {
  it('COALESCEs scl/ccl/tail instead of overwriting them with NULL', async () => {
    const res = await request(app)
      .post('/turtle_survey_events/create')
      .set('Authorization', `Bearer ${token}`)
      .send({
        event_type: 'TAGGING', location: 'Kounopas', turtle_id: 48,
        scl_max: 78.50, scl_min: 75.00, scw: 60.00,
        ccl_max: 82.00, ccl_min: 79.00, ccw: 61.00,
        tail_extension: null, vent_to_tail_tip: null, total_tail_length: null,
        health_condition: 'Healthy', observer: 'Elena Papadaki',
      });

    expect(res.status).toBe(200);
    const [sql] = query.mock.calls.find(([s]) => /UPDATE turtles SET/i.test(s));
    expect(sql).toContain('scl_max = COALESCE($10, scl_max)');
    expect(sql).toContain('tail_extension = COALESCE($16, tail_extension)');
    expect(sql).toContain('vent_to_tail_tip = COALESCE($17, vent_to_tail_tip)');
    expect(sql).toContain('total_tail_length = COALESCE($18, total_tail_length)');
  });
});
