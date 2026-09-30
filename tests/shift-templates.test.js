// Shift templates: the shifts table used to be database-only. A Field Leader
// already runs /timetable/create and /timetable/remove, so they can also
// define and retire the shift types a project uses.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const tokenFor = (role) => jwt.sign({ sub: '1', role, email: 'u@example.com' }, SECRET, { expiresIn: '1h' });
const as = (role) => (req) => req.set('Authorization', `Bearer ${tokenFor(role)}`);
const asCoordinator = as('Project Coordinator');
const asLeader = as('Field Leader');
const asAssistant = as('Field Assistant');
const asVolunteer = as('Field Volunteer');

let query;
beforeEach(() => {
  query = vi.spyOn(db, 'query').mockRejectedValue(new Error('unstubbed db.query'));
});
afterAll(() => db.end().catch(() => {}));

const valid = { shift_name: 'Evening Watch', shift_type: 'Afternoon', start_time: '21:00', end_time: '01:00' };

describe('who may manage shift types', () => {
  it.each(['Field Assistant', 'Field Volunteer'])('refuses %s', async (role) => {
    const res = await as(role)(request(app).post('/shifts')).send(valid);
    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses a caller with no token', async () => {
    const res = await request(app).post('/shifts').send(valid);
    expect(res.status).toBe(401);
  });

  it('lets a Field Leader create one', async () => {
    query.mockResolvedValue({ rows: [{ shift_id: 8, ...valid, is_active: true }] });
    const res = await asLeader(request(app).post('/shifts')).send(valid);
    expect(res.status).toBe(201);
  });

  it('lets a Coordinator create one', async () => {
    query.mockResolvedValue({ rows: [{ shift_id: 8, ...valid, is_active: true }] });
    const res = await asCoordinator(request(app).post('/shifts')).send(valid);
    expect(res.status).toBe(201);
  });
});

describe('creating a shift', () => {
  it('stores it and returns it', async () => {
    query.mockResolvedValue({ rows: [{ shift_id: 8, ...valid, is_active: true }] });
    const res = await asLeader(request(app).post('/shifts')).send(valid);
    expect(res.status).toBe(201);
    expect(res.body.shift).toMatchObject({ shift_id: 8, shift_name: 'Evening Watch' });
    const call = query.mock.calls[0];
    expect(String(call[0])).toContain('INSERT INTO shifts');
    expect(call[1]).toEqual(['Evening Watch', 'Afternoon', '21:00', '01:00']);
  });

  it('allows an open-ended shift with no end time, like a morning survey', async () => {
    query.mockResolvedValue({ rows: [{ shift_id: 9, shift_name: 'Loggos Survey', shift_type: 'Morning', start_time: '06:00', end_time: null, is_active: true }] });
    const res = await asLeader(request(app).post('/shifts')).send({ shift_name: 'Loggos Survey', shift_type: 'Morning', start_time: '06:00' });
    expect(res.status).toBe(201);
    expect(query.mock.calls[0][1]).toEqual(['Loggos Survey', 'Morning', '06:00', null]);
  });

  // The database's shift_type CHECK constraint used to reject "Night" - a
  // boot migration widens it, so this now succeeds instead of 400ing.
  it('allows a Night shift now that the database accepts it', async () => {
    query.mockResolvedValue({ rows: [{ shift_id: 10, shift_name: 'Night Patrol', shift_type: 'Night', start_time: '21:00', end_time: '23:00', is_active: true }] });
    const res = await asLeader(request(app).post('/shifts')).send({ shift_name: 'Night Patrol', shift_type: 'Night', start_time: '21:00', end_time: '23:00' });
    expect(res.status).toBe(201);
    expect(query.mock.calls[0][1]).toEqual(['Night Patrol', 'Night', '21:00', '23:00']);
  });

  it.each([
    ['no name', { shift_type: 'Morning' }],
    ['a blank name', { shift_name: '  ', shift_type: 'Morning' }],
    ['an unknown type', { shift_name: 'X', shift_type: 'Brunch' }],
    ['a malformed start time', { shift_name: 'X', shift_type: 'Morning', start_time: '6am' }],
    ['a malformed end time', { shift_name: 'X', shift_type: 'Morning', end_time: '25:99' }],
  ])('rejects %s', async (_label, body) => {
    const res = await asLeader(request(app).post('/shifts')).send(body);
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('editing and retiring a shift', () => {
  it('updates name, type and times', async () => {
    query.mockResolvedValue({ rows: [{ shift_id: 8, ...valid, is_active: true }] });
    const res = await asLeader(request(app).patch('/shifts/8')).send(valid);
    expect(res.status).toBe(200);
    expect(String(query.mock.calls[0][0])).toContain('UPDATE shifts');
  });

  it('reports 404 for a shift that does not exist', async () => {
    query.mockResolvedValue({ rows: [] });
    const res = await asLeader(request(app).patch('/shifts/999')).send(valid);
    expect(res.status).toBe(404);
  });

  it('retires a shift with is_active alone, skipping the name/type checks', async () => {
    query.mockResolvedValue({ rows: [{ shift_id: 8, ...valid, is_active: false }] });
    const res = await asLeader(request(app).patch('/shifts/8')).send({ is_active: false });
    expect(res.status).toBe(200);
    expect(res.body.shift.is_active).toBe(false);
    expect(String(query.mock.calls[0][0])).toContain('SET is_active');
  });

  it('restores a retired shift', async () => {
    query.mockResolvedValue({ rows: [{ shift_id: 8, ...valid, is_active: true }] });
    const res = await asLeader(request(app).patch('/shifts/8')).send({ is_active: true });
    expect(res.status).toBe(200);
    expect(res.body.shift.is_active).toBe(true);
  });

  it('refuses a Field Assistant', async () => {
    const res = await asAssistant(request(app).patch('/shifts/8')).send({ is_active: false });
    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('reading shifts', () => {
  it('is not gated by role - every signed-in user needs the list to build a form', async () => {
    query.mockResolvedValue({ rows: [] });
    const res = await asVolunteer(request(app).get('/shifts'));
    expect(res.status).toBe(200);
  });
});
