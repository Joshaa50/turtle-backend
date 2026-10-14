// QA-047: a wrongly-submitted turtle sighting (duplicate, wrong turtle,
// mis-keyed measurement) could never be removed, so QA/test debris that got
// typed against a real turtle just kept piling up and was visible to anyone
// trying the demo. This pins the new DELETE /turtle_survey_events/:id, which
// only a Coordinator may use (Field Leaders are refused), and that deleting the turtle's most
// recent sighting re-derives its profile from whatever sighting is now
// most recent instead of leaving it stamped with the deleted numbers.
import { describe, it, expect, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const coordinatorToken = jwt.sign(
  { sub: '49', role: 'Project Coordinator', email: 'sofia.manthou@turtleguard.demo' },
  SECRET,
  { expiresIn: '1h' },
);
const volunteerToken = jwt.sign(
  { sub: '10', role: 'Field Volunteer', email: 'maria@turtleguard.demo' },
  SECRET,
  { expiresIn: '1h' },
);
const auth = (req) => req.set('Authorization', `Bearer ${coordinatorToken}`);
const leaderToken = jwt.sign(
  { sub: '49', role: 'Field Leader', email: 'elena.papadaki@turtleguard.demo' },
  SECRET,
  { expiresIn: '1h' },
);

afterAll(() => db.end().catch(() => {}));

describe('DELETE /turtle_survey_events/:id (QA-047)', () => {
  it('deletes the event, its review row, and re-derives the turtle profile from the next-most-recent sighting', async () => {
    const calls = [];
    vi.spyOn(db, 'query').mockImplementation((sql, params) => {
      const text = String(sql);
      calls.push({ text, params });
      if (text.includes('SELECT id, turtle_id, event_type, event_date FROM turtle_survey_events')) {
        return Promise.resolve({ rows: [{ id: 73, turtle_id: 17, event_type: 'TAGGING', event_date: '2026-10-11' }] });
      }
      if (text.includes('DELETE FROM turtle_survey_events WHERE id = $1')) {
        return Promise.resolve({ rows: [{ id: 73, turtle_id: 17, event_type: 'TAGGING' }], rowCount: 1 });
      }
      if (text.includes("DELETE FROM record_reviews WHERE record_type = 'turtle_survey_event'")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      // applyApprovalSideEffects("turtle", 17, ...) re-reading the now-latest event
      if (text.includes('FROM turtle_survey_events WHERE turtle_id = $1 ORDER BY created_at DESC LIMIT 1')) {
        return Promise.resolve({ rows: [{ turtle_id: 17, health_condition: 'Healthy', scl_max: '80.60', scl_min: '78.90', scw: '58.90', ccl_max: '85.20', ccl_min: '80.80', ccw: '62.20' }] });
      }
      if (text.includes('UPDATE turtles SET')) {
        return Promise.resolve({ rows: [{ name: 'Iris' }] });
      }
      if (text.includes('INSERT INTO record_audit')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await auth(request(app).delete('/turtle_survey_events/73'));

    expect(res.status).toBe(200);
    expect(res.body.deleted_event.id).toBe(73);

    const profileUpdate = calls.find((c) => c.text.includes('UPDATE turtles SET'));
    expect(profileUpdate).toBeTruthy();
    expect(profileUpdate.params).toEqual(
      expect.arrayContaining(['80.60', '78.90', '58.90', '85.20', '80.80', '62.20'])
    );

    const reviewCleanup = calls.find((c) => c.text.includes("DELETE FROM record_reviews WHERE record_type = 'turtle_survey_event'"));
    expect(reviewCleanup).toBeTruthy();
    expect(reviewCleanup.params).toEqual(['73']);
  });

  it('404s for an event that does not exist', async () => {
    vi.spyOn(db, 'query').mockResolvedValue({ rows: [] });
    const res = await auth(request(app).delete('/turtle_survey_events/999999'));
    expect(res.status).toBe(404);
  });

  it('rejects a Field Volunteer', async () => {
    const res = await request(app)
      .delete('/turtle_survey_events/73')
      .set('Authorization', `Bearer ${volunteerToken}`);
    expect(res.status).toBe(403);
  });

  it('refuses a Field Leader - deletes are coordinator-only', async () => {
    const res = await request(app).delete('/turtle_survey_events/57')
      .set('Authorization', `Bearer ${leaderToken}`);
    expect(res.status).toBe(403);
  });
});
