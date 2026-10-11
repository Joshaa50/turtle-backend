// QA-091: a re-sighting of an existing turtle used to overwrite her profile
// via PUT /turtles/:id/update, called unconditionally from the frontend
// before the sighting's own turtle_survey_event even existed - with no
// review gate, and no rollback if the sighting was later rejected.
//
// The fix routes the profile update through the same review machinery
// nest_event status transitions already use (QA-090): applyApprovalSideEffects
// now has a "turtle" branch that copies the latest turtle_survey_events row
// onto the turtle, triggered only on review approval - or immediately, same
// as QA-090, when the submitter's role needs no review at all.
//
// These cases pin down:
//   - creating a survey event as a Field Volunteer (review required) never
//     touches the turtles table at submission time
//   - rejecting a "turtle" review never touches the turtles table
//   - approving a "turtle" review copies the latest survey event's
//     measurements onto the turtle
//   - creating a survey event as a Field Leader (no review required) applies
//     the profile update immediately
import { describe, it, expect, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const tokenFor = (role, sub) =>
  jwt.sign({ sub, role, email: `${sub}@turtleguard.demo` }, SECRET, { expiresIn: '1h' });

const VOLUNTEER = tokenFor('Field Volunteer', '11');
const LEADER = tokenFor('Field Leader', '7');
const asVolunteer = (req) => req.set('Authorization', `Bearer ${VOLUNTEER}`);
const asLeader = (req) => req.set('Authorization', `Bearer ${LEADER}`);

afterAll(() => db.end().catch(() => {}));

const wroteTurtleUpdate = (calls) =>
  calls.some((c) => c.text.includes('UPDATE turtles SET'));

const surveyEventBody = {
  event_type: 'SIGHTING',
  location: 'Loggos 2',
  turtle_id: 56,
  scl_max: 82, scl_min: 80, scw: 60,
  ccl_max: 85, ccl_min: 83, ccw: 62,
  health_condition: 'Good',
  observer: 'Nikos Floros',
};

describe('turtle profile updates go through review, not the sighting save (QA-091)', () => {
  it('does not touch turtles when a Field Volunteer (review required) creates a survey event', async () => {
    const calls = [];
    vi.spyOn(db, 'query').mockImplementation((sql, params) => {
      const text = String(sql);
      calls.push({ text, params });

      if (text.includes('SELECT id FROM turtles WHERE id = $1')) {
        return Promise.resolve({ rows: [{ id: 56 }] });
      }
      if (text.includes('INSERT INTO turtle_survey_events')) {
        return Promise.resolve({ rows: [{ id: 21, turtle_id: 56 }] });
      }
      if (text.includes('SELECT value FROM app_settings')) {
        return Promise.resolve({ rows: [] }); // default rules: Volunteer needs review
      }
      if (text.includes('INSERT INTO record_reviews')) {
        return Promise.resolve({ rows: [{ id: 9, record_type: 'turtle', record_id: 56, status: 'pending' }] });
      }
      if (text.includes('INSERT INTO record_audit')) {
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await asVolunteer(request(app).post('/turtle_survey_events/create')).send(surveyEventBody);

    expect(res.status).toBe(200);
    expect(res.body.review).toBeTruthy();
    expect(wroteTurtleUpdate(calls)).toBe(false);
  });

  it('applies the profile update immediately when a Field Leader (no review required) creates a survey event', async () => {
    const calls = [];
    vi.spyOn(db, 'query').mockImplementation((sql, params) => {
      const text = String(sql);
      calls.push({ text, params });

      if (text.includes('SELECT id FROM turtles WHERE id = $1')) {
        return Promise.resolve({ rows: [{ id: 56 }] });
      }
      if (text.includes('INSERT INTO turtle_survey_events')) {
        return Promise.resolve({ rows: [{ id: 22, turtle_id: 56 }] });
      }
      if (text.includes('SELECT value FROM app_settings')) {
        return Promise.resolve({ rows: [] }); // default rules: Field Leader needs no review
      }
      if (text.includes('INSERT INTO record_reviews')) {
        // Must never be reached: queueReviewSafely short-circuits on needsReview === false.
        return Promise.resolve({ rows: [{ id: 9, record_type: 'turtle', record_id: 56, status: 'pending' }] });
      }
      if (text.includes('SELECT * FROM turtle_survey_events WHERE turtle_id = $1')) {
        return Promise.resolve({
          rows: [{
            health_condition: 'Good',
            front_left_tag: 'KF-56', front_left_address: null,
            front_right_tag: null, front_right_address: null,
            rear_left_tag: null, rear_left_address: null,
            rear_right_tag: null, rear_right_address: null,
            scl_max: 82, scl_min: 80, scw: 60,
            ccl_max: 85, ccl_min: 83, ccw: 62,
            tail_extension: null, vent_to_tail_tip: null, total_tail_length: null,
          }],
        });
      }
      if (text.includes('UPDATE turtles SET')) {
        return Promise.resolve({ rows: [{ name: 'Amanda' }] });
      }
      if (text.includes('INSERT INTO record_audit')) {
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await asLeader(request(app).post('/turtle_survey_events/create')).send(surveyEventBody);

    expect(res.status).toBe(200);
    expect(res.body.review).toBeFalsy();
    expect(calls.some((c) => c.text.includes('INSERT INTO record_reviews'))).toBe(false);
    expect(wroteTurtleUpdate(calls)).toBe(true);
  });

  it('never touches turtles when a "turtle" review is rejected', async () => {
    const calls = [];
    vi.spyOn(db, 'query').mockImplementation((sql, params) => {
      const text = String(sql);
      calls.push({ text, params });
      if (text.includes('UPDATE record_reviews') && params?.[0] === 'rejected') {
        return Promise.resolve({ rows: [{ id: 9, record_type: 'turtle', record_id: 56 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await asLeader(request(app).post('/reviews/9/reject')).send({ note: 'Measurements look off.' });

    expect(res.status).toBe(200);
    expect(wroteTurtleUpdate(calls)).toBe(false);
    expect(calls.some((c) => c.text.includes('SELECT * FROM turtle_survey_events WHERE turtle_id = $1'))).toBe(false);
  });

  it('copies the latest survey event measurements onto the turtle when a "turtle" review is approved', async () => {
    const calls = [];
    vi.spyOn(db, 'query').mockImplementation((sql, params) => {
      const text = String(sql);
      calls.push({ text, params });

      if (text.includes('UPDATE record_reviews') && params?.[0] === 'approved') {
        return Promise.resolve({ rows: [{ id: 9, record_type: 'turtle', record_id: 56 }] });
      }
      if (text.includes('SELECT * FROM turtle_survey_events WHERE turtle_id = $1')) {
        return Promise.resolve({
          rows: [{
            health_condition: 'Good',
            front_left_tag: 'KF-56', front_left_address: 'left front',
            front_right_tag: null, front_right_address: null,
            rear_left_tag: null, rear_left_address: null,
            rear_right_tag: null, rear_right_address: null,
            scl_max: 82, scl_min: 80, scw: 60,
            ccl_max: 85, ccl_min: 83, ccw: 62,
            tail_extension: 5, vent_to_tail_tip: 10, total_tail_length: 15,
          }],
        });
      }
      if (text.includes('UPDATE turtles SET')) {
        return Promise.resolve({ rows: [{ name: 'Amanda' }] });
      }
      if (text.includes('INSERT INTO record_audit')) {
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await asLeader(request(app).post('/reviews/9/approve')).send({});

    expect(res.status).toBe(200);
    const update = calls.find((c) => c.text.includes('UPDATE turtles SET'));
    expect(update).toBeTruthy();
    expect(update.params[0]).toBe('Good'); // health_condition
    expect(update.params[9]).toBe(82); // scl_max
    expect(update.params[18]).toBe(56); // recordId / turtle id in WHERE
  });
});
