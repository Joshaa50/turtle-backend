// QA-033: the sign-up form used to silently do nothing for a weak password -
// no message, and (worse) nothing stopped the account from actually being
// created with one if the request got past the client at all. This pins down
// that the server enforces the same floor the form now messages, so an
// API call or an out-of-date client can't create a weak-password account.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import server from '../server.js';

const { app, db } = server;

const baseBody = {
  first_name: 'Maria',
  last_name: 'Karydi',
  email: 'maria.karydi@example.com',
  station: 'Lix',
  privacy_notice_accepted: true,
};

let query;

beforeEach(() => {
  query = vi.spyOn(db, 'query').mockResolvedValue({
    rows: [{ id: 99, first_name: 'Maria', last_name: 'Karydi', email: baseBody.email }],
  });
});

afterAll(() => db.end().catch(() => {}));

describe('POST /users/register — password strength', () => {
  it('refuses a password under 8 characters', async () => {
    const res = await request(app).post('/users/register').send({ ...baseBody, password: 'abc' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 8 characters/i);
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO users'), expect.anything());
  });

  it('accepts a password that meets the minimum', async () => {
    const res = await request(app).post('/users/register').send({ ...baseBody, password: 'a-strong-password' });

    expect(res.status).toBe(200);
  });
});
