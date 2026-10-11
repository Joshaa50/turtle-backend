// A demo-logged-in account (demo: true JWT claim) now behaves exactly like a
// real account of that role everywhere - the two restrictions that used to
// 403 a demo Coordinator/Leader touching someone else's account (PATCH
// /users/:id, POST /users/:id/erase) were removed by request of the app
// owner, who added POST /admin/reset-demo-data as the recovery path instead.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const tokenFor = (role, sub = '7', { demo = false } = {}) =>
  jwt.sign({ sub, role, email: 'coord@example.com', ...(demo ? { demo: true } : {}) }, SECRET, { expiresIn: '1h' });

let query, connect, client;
beforeEach(() => {
  query = vi.spyOn(db, 'query').mockResolvedValue({ rows: [], rowCount: 0 });
  client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: vi.fn() };
  connect = vi.spyOn(db, 'connect').mockResolvedValue(client);
});
afterAll(() => db.end().catch(() => {}));

describe('demo accounts now behave exactly like real accounts', () => {
  it('a demo Coordinator can PATCH another user without being blocked', async () => {
    query.mockImplementation(async (sql) => {
      if (/UPDATE users/i.test(sql)) return { rows: [{ id: 12 }] };
      return { rows: [] };
    });
    const res = await request(app)
      .patch('/users/12')
      .set('Authorization', `Bearer ${tokenFor('Project Coordinator', '7', { demo: true })}`)
      .send({ station: 'Loggos 2' });
    expect(res.status).toBe(200);
  });

  it('a demo Coordinator can erase another account without being blocked', async () => {
    const person = { id: 21, first_name: 'Liam', last_name: "O'Connor", email: 'liam@example.com', role: 'Field Volunteer' };
    client.query.mockImplementation((sql) => {
      if (/FROM users WHERE id/i.test(sql)) return Promise.resolve({ rows: [person], rowCount: 1 });
      if (/COUNT\(\*\)/i.test(sql)) return Promise.resolve({ rows: [{ n: 3 }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const res = await request(app)
      .post('/users/21/erase')
      .set('Authorization', `Bearer ${tokenFor('Project Coordinator', '7', { demo: true })}`)
      .send({ confirm_email: person.email });
    expect(res.status).toBe(200);
  });
});

describe('POST /admin/reset-demo-data', () => {
  const resetAs = (role, confirm, demo = false) =>
    request(app)
      .post('/admin/reset-demo-data')
      .set('Authorization', `Bearer ${tokenFor(role, '7', { demo })}`)
      .send({ confirm });

  it('is closed to a non-coordinator', async () => {
    const res = await resetAs('Field Leader', 'RESET DEMO DATA');
    expect(res.status).toBe(403);
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuses without the exact confirm phrase', async () => {
    const res = await resetAs('Project Coordinator', 'please reset');
    expect(res.status).toBe(400);
    expect(connect).not.toHaveBeenCalled();
  });

  it('is reachable by a demo Coordinator token too (not blocked, same as any other route now)', async () => {
    const res = await resetAs('Project Coordinator', 'RESET DEMO DATA', true);
    expect(res.status).toBe(200);
  });

  it('wipes every activity table, excludes @turtleguard.demo emails from the user delete, and commits', async () => {
    const res = await resetAs('Project Coordinator', 'RESET DEMO DATA');
    expect(res.status).toBe(200);

    const calls = client.query.mock.calls.map(([sql]) => sql);
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('COMMIT');
    expect(calls.some((sql) => /DELETE FROM turtle_nest_events/i.test(sql))).toBe(true);
    expect(calls.some((sql) => /DELETE FROM turtles/i.test(sql))).toBe(true);
    expect(calls.some((sql) => /DELETE FROM turtle_nests/i.test(sql))).toBe(true);
    expect(calls.some((sql) => /DELETE FROM Timetable/i.test(sql))).toBe(true);

    const userDelete = calls.find((sql) => /DELETE FROM users/i.test(sql));
    expect(userDelete).toMatch(/NOT LIKE '%@turtleguard\.demo'/);

    expect(res.body.deleted).toBeTypeOf('object');
  });

  it('wipes users last, after every activity table', async () => {
    await resetAs('Project Coordinator', 'RESET DEMO DATA');
    const calls = client.query.mock.calls.map(([sql]) => sql);
    const userIdx = calls.findIndex((sql) => /DELETE FROM users/i.test(sql));
    const commitIdx = calls.findIndex((sql) => sql === 'COMMIT');
    const otherDeleteIdxs = calls
      .map((sql, i) => (/^DELETE FROM (?!users)/i.test(sql) ? i : -1))
      .filter((i) => i >= 0);
    expect(userIdx).toBeGreaterThan(Math.max(...otherDeleteIdxs));
    expect(userIdx).toBeLessThan(commitIdx);
  });

  it('rolls back and changes nothing if a wipe query fails', async () => {
    client.query.mockImplementation((sql) => {
      if (sql === 'BEGIN') return Promise.resolve({});
      if (/DELETE FROM turtles/i.test(sql)) return Promise.reject(new Error('boom'));
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const res = await resetAs('Project Coordinator', 'RESET DEMO DATA');
    expect(res.status).toBe(500);
    const calls = client.query.mock.calls.map(([sql]) => sql);
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });

});
