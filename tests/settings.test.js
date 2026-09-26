// Coordinator-configurable settings: nesting seasons and review rules.
//
// What these cases pin down:
//   - with nothing configured the app behaves exactly as it did before: only
//     Field Volunteers are queued, and no date is ever warned about
//   - review rules decide, per record type, whose records are queued
//   - a record dated outside every season is saved with a warning, never refused
//   - seasons may cross New Year, but may not overlap or run backwards
//   - only a Project Coordinator can change either setting
//   - auto-approve only fires when configured, and never names a reviewer
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
const asAssistant = as('Field Assistant', '22');
const asVolunteer = as('Field Volunteer', '51');

let stored; // setting key -> value, as the database would hold it
let query;

beforeEach(() => {
  stored = {};
  query = vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    const text = String(sql);
    if (text.includes('FROM app_settings')) {
      return { rows: stored[params[0]] ? [{ value: stored[params[0]] }] : [] };
    }
    if (text.includes('INSERT INTO app_settings')) {
      stored[params[0]] = JSON.parse(params[1]);
      return { rows: [] };
    }
    return { rows: [{ id: 42, event_date: '2026-06-01' }] };
  });
});

afterAll(() => db.end().catch(() => {}));

const queued = () => query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO record_reviews'));
const emergence = (date) => ({ event_date: date, beach: 'Lixouri' });

const everyType = (roles) => ({
  nest: roles, turtle: roles, nest_event: roles, emergence: roles, morning_survey: roles,
});

describe('review rules', () => {
  it('defaults to holding Field Volunteers only', async () => {
    const res = await asVolunteer(request(app).get('/settings'));
    expect(res.status).toBe(200);
    expect(res.body.review_rules.record_types.emergence).toEqual(['Field Volunteer']);
    expect(res.body.review_rules.auto_approve_days).toBeNull();
  });

  it("queues a volunteer's record and not an assistant's by default", async () => {
    await asVolunteer(request(app).post('/emergences')).send(emergence('2026-06-01'));
    expect(queued()).toBe(true);

    query.mockClear();
    await asAssistant(request(app).post('/emergences')).send(emergence('2026-06-01'));
    expect(queued()).toBe(false);
  });

  it('queues a role once a coordinator adds it, for that record type only', async () => {
    stored.review_rules = {
      record_types: { ...everyType(['Field Volunteer']), emergence: ['Field Volunteer', 'Field Assistant'] },
      auto_approve_days: null,
    };
    await asAssistant(request(app).post('/emergences')).send(emergence('2026-06-01'));
    expect(queued()).toBe(true);
  });

  it('stops queueing a role once a coordinator removes it', async () => {
    stored.review_rules = { record_types: everyType([]), auto_approve_days: null };
    await asVolunteer(request(app).post('/emergences')).send(emergence('2026-06-01'));
    expect(queued()).toBe(false);
  });

  it('still saves the record when the settings cannot be read', async () => {
    query.mockImplementation(async (sql) => {
      if (String(sql).includes('app_settings')) throw new Error('relation "app_settings" does not exist');
      return { rows: [{ id: 42 }] };
    });
    const res = await asVolunteer(request(app).post('/emergences')).send(emergence('2026-06-01'));
    expect(res.status).toBe(201);
    expect(queued()).toBe(true); // falls back to the default rule
  });

  it('saves valid rules and hands back what is now in force', async () => {
    const res = await asCoordinator(request(app).put('/settings/review-rules'))
      .send({ record_types: everyType(['Field Volunteer', 'Field Assistant']), auto_approve_days: 7 });
    expect(res.status).toBe(200);
    expect(res.body.review_rules.auto_approve_days).toBe(7);
    expect(stored.review_rules.record_types.nest).toEqual(['Field Volunteer', 'Field Assistant']);
  });

  it.each([
    ['an unknown role', { record_types: everyType(['Admin']), auto_approve_days: null }],
    ['a missing record type', { record_types: { nest: [] }, auto_approve_days: null }],
    ['zero days', { record_types: everyType([]), auto_approve_days: 0 }],
    ['too many days', { record_types: everyType([]), auto_approve_days: 365 }],
    ['fractional days', { record_types: everyType([]), auto_approve_days: 1.5 }],
  ])('rejects %s', async (_name, body) => {
    const res = await asCoordinator(request(app).put('/settings/review-rules')).send(body);
    expect(res.status).toBe(400);
    expect(stored.review_rules).toBeUndefined();
  });

  it('auto-approves only when a limit is configured', async () => {
    const approved = () => query.mock.calls.some(([sql]) => String(sql).includes("SET status = 'approved'"));

    await asLeader(request(app).get('/reviews'));
    expect(approved()).toBe(false);

    stored.review_rules = { record_types: everyType(['Field Volunteer']), auto_approve_days: 5 };
    await asLeader(request(app).get('/reviews'));
    const call = query.mock.calls.find(([sql]) => String(sql).includes("SET status = 'approved'"));
    expect(call[1][0]).toBe(5);
    expect(String(call[0])).toContain('reviewed_by = NULL');
  });
});

describe('seasons', () => {
  const season = { id: '2026', name: '2026', start: '2026-05-01', end: '2026-10-31' };

  it('never warns when no season is configured', async () => {
    const res = await asVolunteer(request(app).post('/emergences')).send(emergence('2026-01-15'));
    expect(res.status).toBe(201);
    expect(res.body.season_warning).toBeNull();
  });

  it('does not warn inside a season, boundaries included', async () => {
    stored.seasons = { seasons: [season], current: '2026' };
    for (const day of ['2026-05-01', '2026-07-04', '2026-10-31']) {
      const res = await asVolunteer(request(app).post('/emergences')).send(emergence(day));
      expect(res.body.season_warning).toBeNull();
    }
  });

  it('saves a record outside every season and says so', async () => {
    stored.seasons = { seasons: [season], current: '2026' };
    const res = await asVolunteer(request(app).post('/emergences')).send(emergence('2026-03-10'));
    expect(res.status).toBe(201);
    expect(res.body.emergence).toBeDefined();
    expect(res.body.season_warning).toContain('2026-03-10');
    expect(res.body.season_warning).toContain('outside');
  });

  it('matches a season that crosses New Year', async () => {
    stored.seasons = {
      seasons: [{ id: 's', name: '2026-27', start: '2026-11-01', end: '2027-04-30' }],
      current: 's',
    };
    const inside = await asVolunteer(request(app).post('/emergences')).send(emergence('2027-02-01'));
    expect(inside.body.season_warning).toBeNull();
  });

  it('saves valid seasons', async () => {
    const res = await asCoordinator(request(app).put('/settings/seasons')).send({ seasons: [season], current: '2026' });
    expect(res.status).toBe(200);
    expect(res.body.seasons.current).toBe('2026');
  });

  it('accepts a season that crosses New Year', async () => {
    const res = await asCoordinator(request(app).put('/settings/seasons'))
      .send({ seasons: [{ name: '2026-27', start: '2026-11-01', end: '2027-04-30' }], current: '2026-27' });
    expect(res.status).toBe(200);
  });

  it.each([
    ['a season that ends before it starts', { seasons: [{ name: 'A', start: '2026-10-01', end: '2026-05-01' }] }],
    ['a date that does not exist', { seasons: [{ name: 'A', start: '2026-02-30', end: '2026-06-01' }] }],
    ['overlapping seasons', { seasons: [
      { name: 'A', start: '2026-05-01', end: '2026-08-01' },
      { name: 'B', start: '2026-07-01', end: '2026-10-01' }] }],
    ['a nameless season', { seasons: [{ name: ' ', start: '2026-05-01', end: '2026-06-01' }] }],
    ['a duplicate name', { seasons: [
      { name: 'A', start: '2026-05-01', end: '2026-06-01' },
      { name: 'A', start: '2027-05-01', end: '2027-06-01' }] }],
    ['a current season that is not in the list', { seasons: [season], current: 'nope' }],
    ['no list at all', {}],
  ])('rejects %s', async (_name, body) => {
    const res = await asCoordinator(request(app).put('/settings/seasons')).send(body);
    expect(res.status).toBe(400);
    expect(stored.seasons).toBeUndefined();
  });
});

describe('who can change settings', () => {
  it.each([['a Field Leader', asLeader], ['a Field Assistant', asAssistant], ['a Field Volunteer', asVolunteer]])(
    'refuses %s',
    async (_name, who) => {
      for (const path of ['/settings/seasons', '/settings/review-rules']) {
        const res = await who(request(app).put(path)).send({});
        expect(res.status).toBe(403);
      }
      expect(stored).toEqual({});
    },
  );

  it('refuses a caller with no token', async () => {
    expect((await request(app).get('/settings')).status).toBe(401);
    expect((await request(app).put('/settings/seasons').send({})).status).toBe(401);
  });

  it('lets any signed-in user read them', async () => {
    expect((await asVolunteer(request(app).get('/settings'))).status).toBe(200);
  });
});
