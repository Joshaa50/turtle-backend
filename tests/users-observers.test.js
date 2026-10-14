// QA-043: GET /users is Coordinator/Field Leader only (QA-002), which left
// a Field Assistant's Observer dropdown on Tag a Turtle / Record Inventory
// empty - the record couldn't be saved at all. GET /users/observers is a
// names-only directory any recording role can call instead.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const tokenFor = (role) =>
  jwt.sign({ sub: '22', role, email: 'u@turtleguard.demo' }, SECRET, { expiresIn: '1h' });

const as = (role) => (req) => req.set('Authorization', `Bearer ${tokenFor(role)}`);

let query;

beforeEach(() => {
  query = vi.spyOn(db, 'query').mockResolvedValue({
    rows: [
      { id: 1, first_name: 'Sofia', last_name: 'Manthou', role: 'Project Coordinator', station: 'Lix' },
      { id: 22, first_name: 'Nikos', last_name: 'Floros', role: 'Field Assistant', station: 'Lix' },
    ],
  });
});

afterAll(() => db.end().catch(() => {}));

describe('GET /users/observers', () => {
  it('lets a Field Assistant read it', async () => {
    const res = await as('Field Assistant')(request(app).get('/users/observers'));

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
  });

  it('lets a Field Volunteer read it too', async () => {
    const res = await as('Field Volunteer')(request(app).get('/users/observers'));

    expect(res.status).toBe(200);
  });

  it('refuses a caller with no recognised role', async () => {
    const res = await as('Beach Visitor')(request(app).get('/users/observers'));

    expect(res.status).toBe(403);
  });

  it('refuses a caller with no token', async () => {
    const res = await request(app).get('/users/observers');

    expect(res.status).toBe(401);
  });

  it('never returns email or other directory-only fields', async () => {
    const res = await as('Field Assistant')(request(app).get('/users/observers'));

    const call = query.mock.calls.find(([sql]) => String(sql).includes('FROM users'));
    expect(call[0]).not.toMatch(/email/i);
    expect(call[0]).not.toMatch(/password/i);
    for (const user of res.body.users) {
      expect(user).not.toHaveProperty('email');
    }
  });
});
