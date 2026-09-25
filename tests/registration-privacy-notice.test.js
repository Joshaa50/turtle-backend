// The sign-up screen shows a data-use notice with a required checkbox, but a
// checkbox the client enforces is only a UI nicety - a request built by hand,
// or a client that never got the update, could skip straight past it. This
// pins down that the server refuses to create an account without an explicit
// privacy_notice_accepted: true, and records when consent was given rather
// than just accepting the client's word for it.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import server from '../server.js';

const { app, db } = server;

const baseBody = {
  first_name: 'Maria',
  last_name: 'Karydi',
  email: 'maria.karydi@example.com',
  password: 'a-strong-password',
  role: 'Field Volunteer',
  station: 'Lix',
};

let query;

beforeEach(() => {
  query = vi.spyOn(db, 'query').mockResolvedValue({
    rows: [{ id: 99, first_name: 'Maria', last_name: 'Karydi', email: baseBody.email }],
  });
});

afterAll(() => db.end().catch(() => {}));

describe('POST /users/register — consent to the data notice', () => {
  it('refuses to create an account when the notice was not accepted', async () => {
    const res = await request(app).post('/users/register').send(baseBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/data notice/i);
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO users'), expect.anything());
  });

  it('refuses a falsy or non-boolean acceptance value, not just a missing one', async () => {
    for (const value of [false, 'true', 1, null]) {
      query.mockClear();
      const res = await request(app)
        .post('/users/register')
        .send({ ...baseBody, privacy_notice_accepted: value });

      expect(res.status).toBe(400);
      expect(query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO users'), expect.anything());
    }
  });

  it('creates the account and records the acceptance timestamp when accepted', async () => {
    const res = await request(app)
      .post('/users/register')
      .send({ ...baseBody, privacy_notice_accepted: true });

    expect(res.status).toBe(200);
    const insertCall = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO users'));
    expect(insertCall).toBeDefined();
    expect(insertCall[0]).toContain('privacy_notice_accepted_at');
    expect(insertCall[0]).toContain('NOW()');
  });

  it('still enforces the existing required-fields check first', async () => {
    const res = await request(app)
      .post('/users/register')
      .send({ ...baseBody, station: undefined, privacy_notice_accepted: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required fields/i);
  });
});
