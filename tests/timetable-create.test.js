// QA-032: assigning someone to a shift they're already on used to bubble up
// as a raw 500 ("Database error. Check if user_id and shift_id exist."),
// which also masked genuinely bad user_id/shift_id values behind the same
// message. The unique-constraint violation (duplicate assignment) now gets
// its own 409 with a message a reviewer can act on; a foreign-key violation
// (bad id) stays a 400.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const asCoordinator = (req) =>
  req.set('Authorization', `Bearer ${jwt.sign({ sub: '1', role: 'Project Coordinator', email: 'u@example.com' }, SECRET, { expiresIn: '1h' })}`);

let query;
beforeEach(() => {
  query = vi.spyOn(db, 'query').mockRejectedValue(new Error('unstubbed db.query'));
});
afterAll(() => db.end().catch(() => {}));

const payload = { user_id: 5, shift_id: 3, work_date: '2026-10-10' };

describe('POST /timetable/create', () => {
  it('returns 409 with a friendly message on a duplicate assignment', async () => {
    query.mockRejectedValue({ code: '23505', message: 'duplicate key value violates unique constraint' });

    const res = await asCoordinator(request(app).post('/timetable/create')).send(payload);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already assigned/i);
  });

  it('returns 400 when user_id or shift_id does not exist (foreign key violation)', async () => {
    query.mockRejectedValue({ code: '23503', message: 'violates foreign key constraint' });

    const res = await asCoordinator(request(app).post('/timetable/create')).send(payload);

    expect(res.status).toBe(400);
  });

  it('creates the assignment on success', async () => {
    query.mockResolvedValue({ rows: [{ assignment_id: 1, ...payload }] });

    const res = await asCoordinator(request(app).post('/timetable/create')).send(payload);

    expect(res.status).toBe(201);
    expect(res.body.assignment).toEqual({ assignment_id: 1, ...payload });
  });
});
