// GD-007: no login rate limiting or account lockout, no security headers, no
// `trust proxy` despite running behind Render's proxy, and ALLOWED_ORIGINS
// hard-coded a single deployment's frontend into the source. This covers all
// five: trust proxy, helmet headers, x-powered-by removed, per-account login
// lockout (independent of the IP-based rate limiter), and ALLOWED_ORIGINS
// now reading from the environment.
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import server from '../server.js';

const { app, db } = server;

afterAll(() => db.end().catch(() => {}));

describe('GD-007: trust proxy, helmet, x-powered-by', () => {
  it('trusts exactly one proxy hop, as Render requires', () => {
    expect(app.get('trust proxy')).toBe(1);
  });

  it('removes the X-Powered-By header', async () => {
    const res = await request(app).get('/test');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sets a helmet security header', async () => {
    const res = await request(app).get('/test');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('GD-007: rate limiters are wired up', () => {
  it('login responses carry RateLimit headers', async () => {
    vi.spyOn(db, 'query').mockResolvedValue({ rows: [] });
    const res = await request(app)
      .post('/users/login')
      .send({ email: 'nobody@example.com', password: 'whatever' });
    expect(res.headers['ratelimit-limit'] ?? res.headers['x-ratelimit-limit']).toBeTruthy();
  });

  it('demo login responses carry RateLimit headers', async () => {
    vi.spyOn(db, 'query').mockResolvedValue({ rows: [] });
    const res = await request(app)
      .post('/demo/login')
      .send({ role: 'Coordinator' });
    expect(res.headers['ratelimit-limit'] ?? res.headers['x-ratelimit-limit']).toBeTruthy();
  });
});

describe('GD-007: account lockout', () => {
  const PASSWORD = 'correct horse battery staple';
  let hash;

  // A closure-based fake row, standing in for the one account under test -
  // db.query is stubbed to read/write it directly instead of touching
  // Postgres, the same spirit as the rest of this suite's db.query stubs,
  // just enough state to track failed_login_count/locked_until across calls.
  // Each test uses its own email: the login rate limiter (GD-007, above) is
  // keyed on ip+email, and the suite shares one app/one limiter store across
  // tests in this file, so reusing an address would let an earlier test's
  // attempts count against this one and mask the lockout behaviour under test.
  let nextId = 100;
  function makeFakeAccount() {
    const id = nextId++;
    const row = {
      id,
      first_name: 'Nikos',
      last_name: 'Floros',
      email: `nikos+${id}@example.com`,
      password_hash: hash,
      is_active: true,
      is_email_verified: true,
      is_password_reset_needed: false,
      failed_login_count: 0,
      locked_until: null,
    };

    const query = vi.fn(async (sql, params = []) => {
      if (sql.startsWith('SELECT * FROM users WHERE email')) {
        return { rows: [{ ...row }] };
      }
      if (sql.includes('UPDATE users SET failed_login_count = $1, locked_until')) {
        row.failed_login_count = params[0];
        row.locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        return { rows: [] };
      }
      if (sql.includes('UPDATE users SET failed_login_count = $1 WHERE id')) {
        row.failed_login_count = params[0];
        return { rows: [] };
      }
      if (sql.includes('failed_login_count = 0, locked_until = NULL')) {
        row.failed_login_count = 0;
        row.locked_until = null;
        return { rows: [] };
      }
      return { rows: [] };
    });

    vi.spyOn(db, 'query').mockImplementation(query);
    return row;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const login = (body) => request(app).post('/users/login').send(body);

  it('locks the account after 10 consecutive failed logins, even with the right password on the 11th', async () => {
    hash ??= await bcrypt.hash(PASSWORD, 10);
    const row = makeFakeAccount();

    for (let i = 0; i < 10; i++) {
      const res = await login({ email: row.email, password: 'wrong' });
      expect(res.status).toBe(i < 9 ? 401 : 429);
    }
    expect(row.locked_until).toBeTruthy();

    const res = await login({ email: row.email, password: PASSWORD });
    expect(res.status).toBe(429);
    expect(res.body.token).toBeUndefined();
  });

  it('never logs the password or email on a lockout', async () => {
    hash ??= await bcrypt.hash(PASSWORD, 10);
    const row = makeFakeAccount();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    for (let i = 0; i < 10; i++) {
      await login({ email: row.email, password: 'super-secret-wrong-password' });
    }

    const allLogged = [...warnSpy.mock.calls, ...errorSpy.mock.calls].flat().join(' ');
    expect(allLogged).not.toContain('super-secret-wrong-password');
    expect(allLogged).not.toContain(row.email);
  });

  it('resets failed_login_count on a successful login', async () => {
    hash ??= await bcrypt.hash(PASSWORD, 10);
    const row = makeFakeAccount();

    await login({ email: row.email, password: 'wrong' });
    await login({ email: row.email, password: 'wrong' });
    expect(row.failed_login_count).toBe(2);

    const res = await login({ email: row.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(row.failed_login_count).toBe(0);
    expect(row.locked_until).toBeNull();
  });
});

describe('GD-007: ALLOWED_ORIGINS from the environment', () => {
  const ORIGINAL = process.env.ALLOWED_ORIGINS;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = ORIGINAL;
  });

  async function loadServerWith(allowedOrigins) {
    vi.resetModules();
    if (allowedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = allowedOrigins;
    const mod = await import('../server.js');
    return mod.default;
  }

  it('falls back to the current hard-coded list when unset', async () => {
    const { app: freshApp, db: freshDb } = await loadServerWith(undefined);
    const res = await request(freshApp)
      .get('/test')
      .set('Origin', 'https://joshaa50.github.io');
    expect(res.status).toBe(200);
    await freshDb.end().catch(() => {});
  });

  it('allows a configured origin and rejects an unconfigured one', async () => {
    const { app: freshApp, db: freshDb } = await loadServerWith('https://example.com');

    const allowed = await request(freshApp).get('/test').set('Origin', 'https://example.com');
    expect(allowed.status).toBe(200);

    const rejected = await request(freshApp)
      .get('/test')
      .set('Origin', 'https://joshaa50.github.io');
    expect(rejected.status).toBe(500); // cors() surfaces the thrown error via the default handler
    await freshDb.end().catch(() => {});
  });
});
