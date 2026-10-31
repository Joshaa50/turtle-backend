// QA-150 (continuation): GET /audit/recent kept two problems after the
// first pass (backend commit a2886bf).
//
// 1) Rows written before that commit still had an old raw-ID summary
//    ("TAGGING of turtle 59 at Xi") baked into record_audit.summary. Fixing
//    the write-time code can't touch what is already stored, so the route
//    now joins to turtles/turtle_nests at read time and rebuilds the
//    name/code portion of the summary from the current data instead of
//    trusting the stored text - which fixes historical rows for free.
// 2) A single tagging event (POST /turtles/create-with-event) produced two
//    Dashboard feed rows: this route's own turtle_survey_event entry, plus
//    a second "Turtle X identified" row the Dashboard built straight from
//    the turtles table. That de-duplication lives in the frontend
//    (screens/Dashboard.tsx no longer reads turtlesData into the feed), but
//    this file still asserts the backend side of "one event, one row": the
//    EXISTS/JOIN guard only lets a record_audit row through once per
//    underlying event id, never twice.
import { describe, it, expect, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;

const SECRET = process.env.JWT_SECRET;
const token = jwt.sign(
  { sub: '12', role: 'Field Volunteer', email: 'volunteer@turtleguard.demo' },
  SECRET,
  { expiresIn: '1h' },
);
const auth = (req) => req.set('Authorization', `Bearer ${token}`);

afterAll(() => db.end().catch(() => {}));

describe('GET /audit/recent (QA-150 continuation)', () => {
  it('rebuilds a historical raw-ID summary using the turtle\'s current name, phrased as a first tagging', async () => {
    // As stored before commit a2886bf: a plain id, no name. record_id matches
    // first_event_id, so this is this turtle's first ever survey event - a tagging.
    const rows = [
      { record_type: 'turtle_survey_event', record_id: 59, action: 'created',
        stored_summary: 'TAGGING of turtle 59 at Xi', occurred_at: '2026-09-01T06:00:00.000Z',
        tse_event_type: 'TAGGING', tse_turtle_id: 59, tse_location: 'Xi', turtle_name: 'Nefeli',
        ne_event_type: null, ne_hatched_count: null, ne_total_eggs: null, ne_tracks_to_sea: null,
        ne_tracks_lost: null, ne_stored_nest_code: null, nest_code: null, first_event_id: 59 },
    ];
    vi.spyOn(db, 'query').mockResolvedValue({ rows });

    const res = await auth(request(app).get('/audit/recent'));

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    // The old raw id never appears in the rendered summary.
    expect(res.body.entries[0].summary).not.toMatch(/turtle 59/);
    expect(res.body.entries[0].summary).toBe('Nefeli tagged on Xi');
  });

  it('phrases a later survey event for the same turtle as a re-sighting, not a tagging', async () => {
    // record_id (104) is not the turtle's lowest turtle_survey_events id (59),
    // so this is a later encounter with an already-tagged turtle.
    const rows = [
      { record_type: 'turtle_survey_event', record_id: 104, action: 'created',
        stored_summary: 'TAGGING of "Ariadne" at Megas Lakkos', occurred_at: '2026-10-31T06:00:00.000Z',
        tse_event_type: 'TAGGING', tse_turtle_id: 7, tse_location: 'Megas Lakkos', turtle_name: 'Ariadne',
        ne_event_type: null, ne_hatched_count: null, ne_total_eggs: null, ne_tracks_to_sea: null,
        ne_tracks_lost: null, ne_stored_nest_code: null, nest_code: null, first_event_id: 59 },
    ];
    vi.spyOn(db, 'query').mockResolvedValue({ rows });

    const res = await auth(request(app).get('/audit/recent'));

    expect(res.status).toBe(200);
    expect(res.body.entries[0].summary).toBe('Ariadne re-sighted on Megas Lakkos');
  });

  it('rebuilds a historical nest-event summary with the nest\'s current code', async () => {
    const rows = [
      { record_type: 'nest_event', record_id: 3, action: 'created',
        stored_summary: 'Emergence logged: 41 hatchling tracks', occurred_at: '2026-09-02T06:00:00.000Z',
        tse_event_type: null, tse_turtle_id: null, tse_location: null, turtle_name: null,
        ne_event_type: 'EMERGENCE', ne_hatched_count: null, ne_total_eggs: null, ne_tracks_to_sea: 30,
        ne_tracks_lost: 11, ne_stored_nest_code: 'VA-3', nest_code: 'VA-3' },
    ];
    vi.spyOn(db, 'query').mockResolvedValue({ rows });

    const res = await auth(request(app).get('/audit/recent'));

    expect(res.status).toBe(200);
    expect(res.body.entries[0].summary).toBe('Emergence logged: 41 hatchling tracks (VA-3)');
  });

  it('only lets a nest_event/turtle_survey_event row through when its own event still exists, so one event cannot surface twice', async () => {
    const spy = vi.spyOn(db, 'query').mockResolvedValue({ rows: [] });

    await auth(request(app).get('/audit/recent'));

    const [sql] = spy.mock.calls[0];
    // Each branch is guarded by its own join on the event's own id, not a
    // broader match that could pull in more than one row per event.
    expect(String(sql)).toMatch(/tse\.id = a\.record_id/);
    expect(String(sql)).toMatch(/ne\.id = a\.record_id/);
    expect(String(sql)).toMatch(/record_type = 'nest_event' AND ne\.id IS NOT NULL/);
    expect(String(sql)).toMatch(/record_type = 'turtle_survey_event' AND tse\.id IS NOT NULL/);
  });
});
