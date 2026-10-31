// QA-150: Dashboard > Recent Activity (GET /audit/recent, QA-147) had two
// problems. (a) a turtle_survey_event's audit summary named the raw turtle
// id ("TAGGING of turtle 47") instead of the turtle, and (b) the feed kept
// showing nest_event/turtle_survey_event rows after the record they
// describe was deleted (record_audit is append-only, see its header
// comment), and surfaced action='deleted' rows - themselves just deletion
// records, not new activity - as if they were fresh events.
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

afterAll(() => db.end().catch(() => {}));

describe('GET /audit/recent (QA-150)', () => {
  it('excludes action=deleted rows and only returns rows whose underlying event still exists', async () => {
    // QA-150 (continuation): the "still exists" check moved from an EXISTS
    // subquery to a LEFT JOIN, because the join is also what lets the route
    // rebuild the summary from the current turtle/nest at read time (see
    // regression-qa150-recent-activity-dynamic-summary.test.js).
    const rows = [
      { record_type: 'turtle_survey_event', record_id: 7, action: 'created', stored_summary: 'stale',
        occurred_at: '2026-10-24T06:10:00.000Z', tse_event_type: 'TAGGING', tse_turtle_id: 47,
        tse_location: 'Makris Gialos', turtle_name: 'Thalia', ne_event_type: null,
        ne_hatched_count: null, ne_total_eggs: null, ne_tracks_to_sea: null, ne_tracks_lost: null,
        ne_stored_nest_code: null, nest_code: null, first_event_id: 7 },
    ];
    const spy = vi.spyOn(db, 'query').mockResolvedValue({ rows });

    const res = await auth(request(app).get('/audit/recent'));
    expect(res.status).toBe(200);
    expect(res.body.entries[0].summary).toBe('Thalia tagged on Makris Gialos');

    const [sql] = spy.mock.calls[0];
    const text = String(sql);
    expect(text).toMatch(/action != 'deleted'/);
    expect(text).toMatch(/LEFT JOIN turtle_nest_events ne ON a\.record_type = 'nest_event' AND ne\.id = a\.record_id/);
    expect(text).toMatch(/LEFT JOIN turtle_survey_events tse ON a\.record_type = 'turtle_survey_event' AND tse\.id = a\.record_id/);
    expect(text).toMatch(/record_type = 'nest_event' AND ne\.id IS NOT NULL/);
    expect(text).toMatch(/record_type = 'turtle_survey_event' AND tse\.id IS NOT NULL/);
  });
});

describe('POST /turtle_survey_events/create audit summary (QA-150)', () => {
  const validEvent = {
    event_type: 'TAGGING', location: 'Makris Gialos', turtle_id: 47,
    scl_max: 80, scl_min: 78, scw: 60,
    ccl_max: 83, ccl_min: 81, ccw: 64,
    health_condition: 'Healthy', observer: 'E. Papadaki',
  };

  beforeEach(() => {
    vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
      const text = String(sql);
      if (text.includes('INSERT INTO turtle_survey_events')) {
        return { rows: [{ id: 901, turtle_id: 47, event_type: 'TAGGING' }] };
      }
      if (text.includes('SELECT id, name FROM turtles')) {
        return { rows: [{ id: 47, name: 'Thalia' }] };
      }
      if (text.includes('INSERT INTO record_audit')) {
        return { rows: [{ id: 1, summary: params?.[6] }] };
      }
      return { rows: [] };
    });
  });

  it('names the turtle instead of its raw database id', async () => {
    const res = await auth(request(app).post('/turtle_survey_events/create')).send(validEvent);
    expect(res.status).toBe(200);

    const auditCall = db.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO record_audit'));
    expect(auditCall).toBeTruthy();
    const summary = auditCall[1][6];
    expect(summary).toContain('Thalia');
    expect(summary).not.toMatch(/turtle 47\b/);
  });
});
