import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

// One real hash, computed once - login must actually verify a password, so
// stubbing bcrypt here would test nothing.
const PASSWORD = 'correct horse battery staple';
let hash;
beforeEach(async () => {
  hash ??= await bcrypt.hash(PASSWORD, 10);
});

const userRow = (over = {}) => ({
  id: 42,
  first_name: 'Elena',
  last_name: 'Papadaki',
  email: 'elena@example.com',
  role: 'Field Leader',
  password_hash: hash,
  is_active: true,
  is_email_verified: true,
  is_password_reset_needed: false,
  ...over,
});

const login = (body) => request(app).post('/users/login').send(body);
const stubUser = (over) => vi.spyOn(db, 'query').mockResolvedValue({ rows: [userRow(over)] });

afterAll(() => db.end().catch(() => {}));

describe('POST /users/login', () => {
  it('requires both fields', async () => {
    const query = vi.spyOn(db, 'query');
    const res = await login({ email: 'elena@example.com' });
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an unknown email', async () => {
    vi.spyOn(db, 'query').mockResolvedValue({ rows: [] });
    const res = await login({ email: 'nobody@example.com', password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong password', async () => {
    stubUser();
    const res = await login({ email: 'elena@example.com', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('gives the same message for a bad password as for a bad email', async () => {
    vi.spyOn(db, 'query').mockResolvedValue({ rows: [] });
    const unknown = await login({ email: 'nobody@example.com', password: PASSWORD });
    vi.restoreAllMocks();
    stubUser();
    const wrongPw = await login({ email: 'elena@example.com', password: 'wrong' });
    // Differing messages would let anyone enumerate which addresses have accounts.
    expect(wrongPw.body.error).toBe(unknown.body.error);
  });

  it('refuses an inactive account even with the right password', async () => {
    stubUser({ is_active: false });
    const res = await login({ email: 'elena@example.com', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('INACTIVE');
    expect(res.body.token).toBeUndefined();
  });

  it('refuses an unverified account even with the right password', async () => {
    stubUser({ is_email_verified: false });
    const res = await login({ email: 'elena@example.com', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('UNVERIFIED');
    expect(res.body.token).toBeUndefined();
  });

  it('issues a usable token on success', async () => {
    stubUser();
    const res = await login({ email: 'elena@example.com', password: PASSWORD });
    expect(res.status).toBe(200);

    const payload = jwt.verify(res.body.token, SECRET);
    expect(payload.sub).toBe('42');
    expect(payload.role).toBe('Field Leader');
    expect(payload.exp - payload.iat).toBe(12 * 60 * 60); // a full field day
  });

  it('never returns the password hash', async () => {
    stubUser();
    const res = await login({ email: 'elena@example.com', password: PASSWORD });
    expect(res.body.user.password_hash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(hash);
  });

  it('parameterises the lookup instead of interpolating the email', async () => {
    const query = stubUser();
    await login({ email: "elena@example.com' OR 1=1 --", password: PASSWORD });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('$1');
    expect(sql).not.toContain('OR 1=1');
    expect(params).toEqual(["elena@example.com' OR 1=1 --"]);
  });

  it('answers 500, not a stack trace, when the database is down', async () => {
    vi.spyOn(db, 'query').mockRejectedValue(new Error('ECONNREFUSED 10.0.0.1:5432'));
    const res = await login({ email: 'elena@example.com', password: PASSWORD });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.1/);
  });
});
