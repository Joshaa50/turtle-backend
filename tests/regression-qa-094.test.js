// QA-094: GET /users embedded every user's base64 profile photo in the
// bulk directory response (~2.8 MB payload for Time Table / User Management,
// neither of which render it from this endpoint). The route now returns a
// cheap `has_profile_picture` boolean instead; the real photo is fetched
// lazily per-user via GET /users/:id.
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
    rows: [
      { id: 1, first_name: 'Sofia', last_name: 'Manthou', role: 'Project Coordinator', has_profile_picture: true },
      { id: 2, first_name: 'Nikos', last_name: 'Papas', role: 'Field Leader', has_profile_picture: false },
    ],
  });
});

afterAll(() => db.end().catch(() => {}));

describe('GET /users (QA-094)', () => {
  it('returns has_profile_picture as a boolean and no profile_picture blob', async () => {
    const res = await as('Project Coordinator', '1')(request(app).get('/users'));

    expect(res.status).toBe(200);
    expect(res.body.users.length).toBeGreaterThan(0);
    for (const user of res.body.users) {
      expect(user).not.toHaveProperty('profile_picture');
      expect(typeof user.has_profile_picture).toBe('boolean');
    }
    expect(res.body.users[0].has_profile_picture).toBe(true);
    expect(res.body.users[1].has_profile_picture).toBe(false);
  });
});
