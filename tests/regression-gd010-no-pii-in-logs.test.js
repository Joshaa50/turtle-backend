// GD-010: two routes were logging personal data straight into the server
// logs. `saveSetting` logged the editing staff member's email on every
// settings change, and `/users/register` (and other auth/account routes)
// logged the whole Postgres error object on failure - for a duplicate email
// that object's `detail` text literally reads
// "Key (email)=(someone@example.com) already exists.", so the applicant's
// email ended up in the logs even though the HTTP response never named it.
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const asCoordinator = (req) =>
  req.set('Authorization', `Bearer ${jwt.sign({ sub: '9', role: 'Project Coordinator', email: 'coord@turtleguard.demo' }, SECRET, { expiresIn: '1h' })}`);

afterEach(() => vi.restoreAllMocks());
afterAll(() => db.end().catch(() => {}));

describe('GD-010: no PII in server logs', () => {
  it('a duplicate-email registration failure never logs the submitted email', async () => {
    const email = 'applicant@example.com';
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
      code: '23505',
      constraint: 'users_email_key',
      detail: `Key (email)=(${email}) already exists.`,
    });
    vi.spyOn(db, 'query').mockRejectedValue(pgError);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app)
      .post('/users/register')
      .send({
        first_name: 'A', last_name: 'B', email,
        password: 'correct horse battery staple', role: 'Field Volunteer', station: 'Lixouri',
        privacy_notice_accepted: true, age_confirmed: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Email already exists.');

    const logged = errSpy.mock.calls.map((call) => JSON.stringify(call)).join('\n');
    expect(logged).not.toContain(email);
    expect(logged).not.toContain('already exists');
    // What IS allowed through: the code and constraint name, enough to debug by.
    expect(logged).toContain('23505');
  });

  it('settings changes log the editor\'s numeric id, not their email', async () => {
    vi.spyOn(db, 'query').mockImplementation(async (sql) => {
      if (String(sql).includes('FROM app_settings')) return { rows: [] };
      return { rows: [] };
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const season = { id: '2026', name: '2026', start: '2026-05-01', end: '2026-10-31' };
    const res = await asCoordinator(request(app).put('/settings/seasons'))
      .send({ seasons: [season], current: '2026' });

    expect(res.status).toBe(200);
    const logged = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).toContain('changed by user 9');
    expect(logged).not.toContain('@');
  });
});
