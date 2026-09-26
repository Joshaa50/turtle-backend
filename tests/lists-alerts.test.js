// Coordinator-editable lists (species, health condition) and review alerts.
//
// What these cases pin down:
//   - with no lists configured the API accepts what it always did
//   - once configured, a NEW species/health value must come from the list, but
//     a value the record already holds stays editable
//   - leaders/coordinators are alerted to what waits for review; anyone who
//     submitted a record is alerted when it is approved or sent back
//   - acknowledging is shared, and cannot be done on someone else's alert by a
//     non-reviewer
//   - only a coordinator can change the lists or the alert settings
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const as = (role, sub) => (req) =>
  req.set('Authorization', `Bearer ${jwt.sign({ sub, role, email: `${sub}@turtleguard.demo` }, SECRET, { expiresIn: '1h' })}`);
const asCoordinator = as('Project Coordinator', '1');
const asLeader = as('Field Leader', '7');
const asVolunteer = as('Field Volunteer', '51');

let stored;
let query;
let reviewRows; // what the review queries return
let existingTurtle;

const review = (over = {}) => ({
  id: 5, record_type: 'nest', record_id: 9, status: 'pending', submitted_by: 51,
  submitted_at: '2026-06-01T05:00:00Z', reviewed_by: null, reviewed_at: null, review_note: null,
  submitted_by_first_name: 'Maria', submitted_by_last_name: 'Karydi',
  reviewed_by_first_name: null, reviewed_by_last_name: null, ...over,
});

beforeEach(() => {
  stored = {};
  reviewRows = [];
  existingTurtle = { species: 'Legacy free text', health_condition: 'Deceased' };
  query = vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    const text = String(sql);
    if (text.includes('FROM app_settings')) {
      return { rows: stored[params[0]] ? [{ value: stored[params[0]] }] : [] };
    }
    if (text.includes('INSERT INTO app_settings')) {
      stored[params[0]] = JSON.parse(params[1]);
      return { rows: [] };
    }
    if (text.includes('FROM record_reviews r')) return { rows: reviewRows };
    if (text.includes('SELECT id, nest_code AS label') ) return { rows: [{ id: 9, label: 'LG2-9' }] };
    if (text.includes('AS label FROM')) return { rows: [{ id: 9, label: 'LG2-9' }] };
    if (text.includes('SELECT species, health_condition FROM turtles')) return { rows: [existingTurtle] };
    return { rows: [{ id: 42 }] };
  });
});

afterAll(() => db.end().catch(() => {}));

const turtle = (over = {}) => ({
  name: 'T', species: 'Caretta caretta', sex: 'female', health_condition: 'Healthy',
  scl_max: 80, scl_min: 70, scw: 60, ccl_max: 82, ccl_min: 75, ccw: 65,
  tail_extension: 20, vent_to_tail_tip: 15, total_tail_length: 35, ...over,
});

const configured = {
  species: [{ value: 'Caretta caretta', label: 'Loggerhead', active: true }, { value: 'Old sp', label: 'Old', active: false }],
  health_conditions: [{ value: 'Healthy', concerning: false, active: true }, { value: 'Injured', concerning: true, active: true }],
};

describe('lists', () => {
  it('defaults to today\'s options and accepts anything until configured', async () => {
    const settings = await asVolunteer(request(app).get('/settings'));
    expect(settings.body.lists.species.map((s) => s.value)).toEqual(['Caretta caretta', 'Chelonia mydas']);
    expect(settings.body.lists.health_conditions.find((h) => h.value === 'Injured').concerning).toBe(true);

    const res = await asLeader(request(app).post('/turtles/create')).send(turtle({ species: 'Anything', health_condition: 'Whatever' }));
    expect(res.status).toBeLessThan(400);
  });

  it('rejects a new value that is not in the configured list', async () => {
    stored.lists = configured;
    const res = await asLeader(request(app).post('/turtles/create')).send(turtle({ species: 'Dermochelys coriacea' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Dermochelys coriacea');
  });

  it('rejects a retired value for a new record', async () => {
    stored.lists = configured;
    const res = await asLeader(request(app).post('/turtles/create')).send(turtle({ species: 'Old sp' }));
    expect(res.status).toBe(400);
  });

  it('accepts a listed value regardless of case', async () => {
    stored.lists = configured;
    const res = await asLeader(request(app).post('/turtles/create')).send(turtle({ species: 'caretta caretta', health_condition: 'injured' }));
    expect(res.status).toBeLessThan(400);
  });

  it('lets an update keep a value the turtle already holds', async () => {
    stored.lists = configured;
    const res = await asLeader(request(app).put('/turtles/3/update'))
      .send(turtle({ species: 'Legacy free text', health_condition: 'Deceased' }));
    expect(res.status).toBeLessThan(400);
  });

  it('rejects an update that changes to an unlisted value', async () => {
    stored.lists = configured;
    const res = await asLeader(request(app).put('/turtles/3/update')).send(turtle({ health_condition: 'Sleepy' }));
    expect(res.status).toBe(400);
  });

  it('saves lists, keeping retired items', async () => {
    const res = await asCoordinator(request(app).put('/settings/lists')).send(configured);
    expect(res.status).toBe(200);
    expect(res.body.lists.species.find((s) => s.value === 'Old sp').active).toBe(false);
  });

  it.each([
    ['a list with no option in use', { ...configured, species: [{ value: 'A', active: false }] }],
    ['a duplicate option', { ...configured, health_conditions: [{ value: 'Healthy' }, { value: 'healthy' }] }],
    ['a blank option', { ...configured, species: [{ value: ' ' }] }],
    ['a missing list', { species: configured.species }],
  ])('rejects %s', async (_n, body) => {
    const res = await asCoordinator(request(app).put('/settings/lists')).send(body);
    expect(res.status).toBe(400);
    expect(stored.lists).toBeUndefined();
  });

  it('is coordinator only', async () => {
    expect((await asLeader(request(app).put('/settings/lists')).send(configured)).status).toBe(403);
    expect((await asVolunteer(request(app).put('/settings/alerts')).send({})).status).toBe(403);
  });
});

describe('alerts', () => {
  it('tells a leader what is waiting for review', async () => {
    reviewRows = [review()];
    const res = await asLeader(request(app).get('/alerts'));
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0]).toMatchObject({ kind: 'review_pending', can_acknowledge: false });
    expect(res.body.alerts[0].message).toContain('Maria Karydi');
  });

  it('does not show a volunteer the queue', async () => {
    reviewRows = [review({ submitted_by: 99 })];
    const res = await asVolunteer(request(app).get('/alerts'));
    const pendingQuery = query.mock.calls.find(([sql]) => String(sql).includes("r.status = 'pending'") && String(sql).includes('INTERVAL \'1 hour\''));
    expect(pendingQuery).toBeUndefined();
    expect(res.body.alerts.every((a) => a.kind !== 'review_pending')).toBe(true);
  });

  it('tells a volunteer their record was sent back, with the reason', async () => {
    reviewRows = [review({ status: 'rejected', reviewed_by: 7, reviewed_at: '2026-06-02T05:00:00Z', review_note: 'Wrong marker' })];
    const res = await asVolunteer(request(app).get('/alerts'));
    const alert = res.body.alerts.find((a) => a.kind === 'review_rejected');
    expect(alert.message).toContain('Wrong marker');
    expect(alert.can_acknowledge).toBe(true);
  });

  it('tells a volunteer their record was approved, saying when it was automatic', async () => {
    reviewRows = [
      review({ id: 6, status: 'approved', reviewed_by: 7, reviewed_at: '2026-06-02T05:00:00Z' }),
      review({ id: 7, status: 'approved', reviewed_by: null, reviewed_at: '2026-06-03T05:00:00Z' }),
    ];
    const res = await asVolunteer(request(app).get('/alerts'));
    const messages = res.body.alerts.map((a) => a.message);
    expect(messages.some((m) => m.endsWith('was approved.'))).toBe(true);
    expect(messages.some((m) => m.includes('approved automatically'))).toBe(true);
  });

  it('only asks for the caller\'s own decided reviews, and not ones already cleared', async () => {
    await asVolunteer(request(app).get('/alerts'));
    const call = query.mock.calls.find(([sql]) => String(sql).includes('acknowledged_at IS NULL') && String(sql).includes('r.submitted_by = $1'));
    expect(call).toBeDefined();
    expect(call[1]).toEqual(['51']);
  });

  it('respects the alert settings', async () => {
    reviewRows = [review()];
    stored.alerts = { reviewer_pending: { enabled: false, after_hours: 0 }, submitter_feedback: { enabled: true } };
    const off = await asLeader(request(app).get('/alerts'));
    expect(off.body.alerts.filter((a) => a.kind === 'review_pending')).toHaveLength(0);

    stored.alerts = { reviewer_pending: { enabled: true, after_hours: 24 }, submitter_feedback: { enabled: true } };
    await asLeader(request(app).get('/alerts'));
    const call = query.mock.calls.filter(([sql]) => String(sql).includes("INTERVAL '1 hour'")).pop();
    expect(call[1]).toEqual([24]);
  });

  it('skips an alert whose record was deleted', async () => {
    reviewRows = [review({ record_id: 404 })];
    query.mockImplementation(async (sql, params) => {
      const text = String(sql);
      if (text.includes('FROM app_settings')) return { rows: [] };
      if (text.includes('FROM record_reviews r')) return { rows: reviewRows };
      if (text.includes('AS label FROM')) return { rows: [] };
      return { rows: [] };
    });
    const res = await asLeader(request(app).get('/alerts'));
    expect(res.body.alerts).toEqual([]);
  });

  it('acknowledges a decision on your own record', async () => {
    query.mockImplementation(async (sql) =>
      String(sql).includes('SET acknowledged_at') ? { rows: [{ id: 5 }] } : { rows: [] });
    const res = await asVolunteer(request(app).post('/alerts/review-5/acknowledge'));
    expect(res.status).toBe(200);
    const call = query.mock.calls.find(([sql]) => String(sql).includes('SET acknowledged_at'));
    expect(call[1]).toEqual([5, '51', false]);
  });

  it('lets a reviewer acknowledge on behalf of the team (shared)', async () => {
    query.mockImplementation(async () => ({ rows: [{ id: 5 }] }));
    await asLeader(request(app).post('/alerts/5/acknowledge'));
    const call = query.mock.calls.find(([sql]) => String(sql).includes('SET acknowledged_at'));
    expect(call[1]).toEqual([5, '7', true]);
  });

  it('reports 404 when it is already cleared or not theirs', async () => {
    query.mockImplementation(async () => ({ rows: [] }));
    expect((await asVolunteer(request(app).post('/alerts/5/acknowledge'))).status).toBe(404);
  });

  it('rejects a malformed alert id', async () => {
    expect((await asVolunteer(request(app).post('/alerts/banana/acknowledge'))).status).toBe(400);
  });

  it('needs a token', async () => {
    expect((await request(app).get('/alerts')).status).toBe(401);
    expect((await request(app).post('/alerts/5/acknowledge')).status).toBe(401);
  });

  it('saves alert settings and validates them', async () => {
    const ok = await asCoordinator(request(app).put('/settings/alerts'))
      .send({ reviewer_pending: { enabled: true, after_hours: 12 }, submitter_feedback: { enabled: false } });
    expect(ok.status).toBe(200);
    expect(ok.body.alerts.reviewer_pending.after_hours).toBe(12);
    const bad = await asCoordinator(request(app).put('/settings/alerts'))
      .send({ reviewer_pending: { enabled: true, after_hours: -1 }, submitter_feedback: { enabled: true } });
    expect(bad.status).toBe(400);
  });
});
