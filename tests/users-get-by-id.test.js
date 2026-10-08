// QA-060: GET /users/:id passed a non-numeric id (e.g. "abc") straight into
// the query, which Postgres rejected with an invalid-integer-input error -
// caught by the generic handler as an opaque 500 "Server error.", instead of
// a 400 that actually says what was wrong with the request.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const tokenFor = (role, sub) =>
  jwt.sign({ sub, role, email: `${sub}@turtleguard.demo` }, SECRET, { expiresIn: '1h' });

const as = (role, sub) => (req) => req.set('Authorization', `Bearer ${tokenFor(role, sub)}`);

let query;

beforeEach(() => {
  query = vi.spyOn(db, 'query').mockResolvedValue({
    rows: [{ id: 1, first_name: 'Sofia', last_name: 'Manthou', role: 'Project Coordinator' }],
  });
});

afterAll(() => db.end().catch(() => {}));

describe('GET /users/:id', () => {
  it('returns 400, not 500, for a non-numeric id', async () => {
    const res = await as('Project Coordinator', '1')(request(app).get('/users/abc'));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/id must be a number/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('still works for a real numeric id', async () => {
    const res = await as('Project Coordinator', '1')(request(app).get('/users/1'));

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(1);
  });
});
