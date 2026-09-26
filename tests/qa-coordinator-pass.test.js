// Coordinator QA pass (26 Sep 2026): the backend half of the fixes.
//
//   #3   hatch success above 100%   -> a nest cannot hatch more than it laid
//   #4   review queue hides record  -> each review carries the record's own figures
//   #10  lifecycle history          -> status changes / inventories are audited
//   #15  emergences list            -> type (nesting / false crawl) and linked nest
//   #16  password change            -> asks for the current password
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const tokenFor = (role, sub = '7') =>
  jwt.sign({ sub, role, email: 'e@example.com' }, SECRET, { expiresIn: '1h' });
const as = (req, role, sub) => req.set('Authorization', `Bearer ${tokenFor(role, sub)}`);

let query;
beforeEach(() => {
  query = vi.spyOn(db, 'query').mockRejectedValue(new Error('unstubbed db.query'));
});
afterAll(() => db.end().catch(() => {}));

const auditInserts = () =>
  query.mock.calls.filter(([sql]) => /INSERT INTO record_audit/i.test(sql));

describe('PATCH /users/:id — changing your own password', () => {
  const CURRENT = 'correct horse battery';
  let hash;
  beforeEach(async () => {
    hash = await bcrypt.hash(CURRENT, 4);
  });

  const stub = () =>
    query.mockImplementation(async (sql) => {
      if (/SELECT password_hash/i.test(sql)) return { rows: [{ password_hash: hash }] };
      if (/UPDATE users/i.test(sql)) return { rows: [{ id: 7 }] };
      return { rows: [] };
    });

  it('refuses when no current password is given', async () => {
    stub();
    const res = await as(request(app).patch('/users/7'), 'Project Coordinator', '7')
      .send({ password: 'a-new-password' });
    expect(res.status).toBe(400);
    expect(query.mock.calls.some(([sql]) => /UPDATE users/i.test(sql))).toBe(false);
  });

  it('refuses when the current password is wrong', async () => {
    stub();
    const res = await as(request(app).patch('/users/7'), 'Project Coordinator', '7')
      .send({ password: 'a-new-password', current_password: 'not it' });
    expect(res.status).toBe(403);
    expect(query.mock.calls.some(([sql]) => /UPDATE users/i.test(sql))).toBe(false);
  });

  it('changes it when the current password is right, and never stores the current one', async () => {
    stub();
    const res = await as(request(app).patch('/users/7'), 'Project Coordinator', '7')
      .send({ password: 'a-new-password', current_password: CURRENT });
    expect(res.status).toBe(200);
    const update = query.mock.calls.find(([sql]) => /UPDATE users/i.test(sql));
    expect(update[0]).not.toMatch(/current_password/);
    expect(update[0]).toMatch(/password_hash/);
  });

  it('does not ask a coordinator for somebody else\'s current password — that is the recovery path', async () => {
    stub();
    const res = await as(request(app).patch('/users/12'), 'Project Coordinator', '7')
      .send({ password: 'a-temporary-one', is_password_reset_needed: true });
    expect(res.status).toBe(200);
  });
});

describe('nest events — a clutch cannot hatch more than it laid', () => {
  const nestRow = (over = {}) => ({ id: 5, total_num_eggs: 45, emerged_so_far: 0, ...over });

  it('rejects an excavation that counts more hatched than eggs', async () => {
    query.mockResolvedValue({ rows: [nestRow()] });
    const res = await as(request(app).post('/nest-events/create'), 'Field Leader').send({
      event_type: 'FULL_INVENTORY', nest_code: 'VA-1', total_eggs: 45, hatched_count: 46,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hatched/i);
    expect(query.mock.calls.some(([sql]) => /INSERT INTO turtle_nest_events/i.test(sql))).toBe(false);
  });

  it('rejects emergence tracks that push the running total past the clutch', async () => {
    query.mockResolvedValue({ rows: [nestRow({ emerged_so_far: 40 })] });
    const res = await as(request(app).post('/nest-events/create'), 'Field Leader').send({
      event_type: 'EMERGENCE', nest_code: 'VA-1', tracks_to_sea: 5, tracks_lost: 1,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/45 eggs/);
  });

  it('still accepts an excavation that hatched every egg', async () => {
    query.mockImplementation(async (sql) => {
      if (/FROM turtle_nests n/i.test(sql)) return { rows: [nestRow()] };
      if (/INSERT INTO turtle_nest_events/i.test(sql)) return { rows: [{ id: 9, event_type: 'FULL_INVENTORY', hatched_count: 45, total_eggs: 45, nest_id: 5, nest_code: 'VA-1' }] };
      return { rows: [{ id: 1 }] };
    });
    const res = await as(request(app).post('/nest-events/create'), 'Field Leader').send({
      event_type: 'FULL_INVENTORY', nest_code: 'VA-1', total_eggs: 45, hatched_count: 45,
    });
    expect(res.status).toBe(200);
  });

  it('records the inventory in the nest\'s own history, saying what it found', async () => {
    query.mockImplementation(async (sql) => {
      if (/FROM turtle_nests n/i.test(sql)) return { rows: [nestRow()] };
      if (/INSERT INTO turtle_nest_events/i.test(sql)) return { rows: [{ id: 9, event_type: 'FULL_INVENTORY', hatched_count: 40, total_eggs: 45, nest_id: 5, nest_code: 'VA-1' }] };
      return { rows: [{ id: 1 }] };
    });
    await as(request(app).post('/nest-events/create'), 'Field Leader').send({
      event_type: 'FULL_INVENTORY', nest_code: 'VA-1', total_eggs: 45, hatched_count: 40,
    });
    const onNest = auditInserts().find(([, params]) => params[0] === 'nest');
    expect(onNest).toBeTruthy();
    expect(onNest[1][6]).toMatch(/40 hatched of 45 eggs/);
  });
});

describe('PUT /nests/:id/update — the history says what changed', () => {
  const body = {
    nest_code: 'AI-2', beach: 'Agios Ioannis', date_found: '2026-06-20',
    gps_lat: 38.2, gps_long: 20.5, distance_to_sea_s: 12, depth_top_egg_h: 40,
    total_num_eggs: 100, status: 'hatching',
  };

  it('audits a status change with before and after', async () => {
    query.mockImplementation(async (sql) => {
      if (/SELECT nest_code, status/i.test(sql)) {
        return { rows: [{ nest_code: 'AI-2', status: 'incubating', relocated: false, beach: 'Agios Ioannis', total_num_eggs: 100, is_archived: false }] };
      }
      if (/UPDATE turtle_nests/i.test(sql)) {
        return { rows: [{ id: 3, nest_code: 'AI-2', status: 'hatching', relocated: false, beach: 'Agios Ioannis', total_num_eggs: 100, is_archived: false }] };
      }
      return { rows: [] };
    });
    const res = await as(request(app).put('/nests/3/update'), 'Field Leader').send(body);
    expect(res.status).toBe(200);
    const entry = auditInserts()[0];
    expect(entry[1][0]).toBe('nest');
    expect(entry[1][2]).toBe('updated');
    expect(entry[1][6]).toMatch(/incubating → hatching/);
  });
});

describe('GET /emergences — type and linked nest', () => {
  it('asks the database for both, and orders newest first', async () => {
    query.mockResolvedValue({ rows: [] });
    const res = await as(request(app).get('/emergences'), 'Field Volunteer');
    expect(res.status).toBe(200);
    const sql = query.mock.calls[0][0];
    expect(sql).toMatch(/emergence_type/);
    expect(sql).toMatch(/nest_code/);
    expect(sql).toMatch(/ORDER BY e\.event_date DESC/);
  });
});

describe('GET /reviews — a reviewer can see what they are approving', () => {
  it('attaches the record\'s own figures to each review', async () => {
    query.mockImplementation(async (sql) => {
      if (/FROM record_reviews/i.test(sql)) {
        return { rows: [{ id: 1, record_type: 'emergence', record_id: 83, status: 'pending' }] };
      }
      if (/AS label FROM turtle_emergences/i.test(sql)) return { rows: [{ id: 83, label: 'Lepeda' }] };
      if (/FROM turtle_emergences e/i.test(sql)) {
        return { rows: [{ id: 83, beach: 'Lepeda', event_date: '2026-09-20', gps_lat: 38.2, gps_long: 20.5, emergence_type: 'False crawl', has_track_sketch: true }] };
      }
      return { rows: [] };
    });
    const res = await as(request(app).get('/reviews'), 'Project Coordinator');
    expect(res.status).toBe(200);
    expect(res.body.reviews[0].record_detail).toMatchObject({ emergence_type: 'False crawl', beach: 'Lepeda' });
  });

  it('still lists the review when the detail lookup fails', async () => {
    query.mockImplementation(async (sql) => {
      if (/FROM record_reviews/i.test(sql)) {
        return { rows: [{ id: 1, record_type: 'emergence', record_id: 83, status: 'pending' }] };
      }
      if (/AS label FROM turtle_emergences/i.test(sql)) return { rows: [{ id: 83, label: 'Lepeda' }] };
      throw new Error('boom');
    });
    const res = await as(request(app).get('/reviews'), 'Project Coordinator');
    expect(res.status).toBe(200);
    expect(res.body.reviews[0].record_detail).toBeNull();
  });
});

describe('beaches — optional reference point', () => {
  it('rejects a latitude without a longitude', async () => {
    const res = await as(request(app).post('/beaches'), 'Project Coordinator')
      .send({ name: 'Test', code: 'TST', station: 'Lixouri', survey_area: 'Lepeda', gps_lat: 38.2 });
    expect(res.status).toBe(400);
  });

  it('stores a reference point with its radius', async () => {
    query.mockResolvedValue({ rows: [{ id: 1 }] });
    const res = await as(request(app).post('/beaches'), 'Project Coordinator')
      .send({ name: 'Test', code: 'TST', station: 'Lixouri', survey_area: 'Lepeda', gps_lat: 38.2, gps_long: 20.4, radius_m: 300 });
    expect(res.status).toBe(201);
    expect(query.mock.calls[0][1]).toEqual(['Test', 'TST', 'Lixouri', 'Lepeda', 38.2, 20.4, 300]);
  });
});

describe('PATCH /beaches/:id — editing a beach does not wipe its reference point', () => {
  const edit = { name: 'Test', code: 'TST', station: 'Lixouri', survey_area: 'Lepeda' };

  it('leaves the coordinates alone when the body does not mention them', async () => {
    query.mockResolvedValue({ rows: [{ id: 1 }] });
    await as(request(app).patch('/beaches/1'), 'Project Coordinator').send(edit);
    const params = query.mock.calls[0][1];
    expect(params[8]).toBe(false); // coordinates supplied?
    expect(params[9]).toBe(false); // radius supplied?
  });

  it('sets them when the body carries them', async () => {
    query.mockResolvedValue({ rows: [{ id: 1 }] });
    await as(request(app).patch('/beaches/1'), 'Project Coordinator')
      .send({ ...edit, gps_lat: 38.2, gps_long: 20.4, radius_m: 250 });
    const params = query.mock.calls[0][1];
    expect(params[8]).toBe(true);
    expect(params.slice(5, 8)).toEqual([38.2, 20.4, 250]);
  });
});
