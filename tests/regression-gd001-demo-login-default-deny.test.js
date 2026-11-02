// GD-001: DEMO_LOGIN used to default to on, so a brand-new customer
// deployment nobody had configured yet handed out signed Coordinator /
// Leader / Assistant / Volunteer tokens to anyone who found /demo/login -
// no password required. DEMO_LOGIN_ENABLED is computed once at module load,
// so each scenario here resets the module registry and re-imports server.js
// with a fresh process.env.DEMO_LOGIN, the same way `vitest.config.mjs`'s
// global `DEMO_LOGIN: 'on'` makes every other test file's demo login work.
import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';

const ORIGINAL_DEMO_LOGIN = process.env.DEMO_LOGIN;

async function loadServerWith(demoLogin) {
  vi.resetModules();
  if (demoLogin === undefined) delete process.env.DEMO_LOGIN;
  else process.env.DEMO_LOGIN = demoLogin;
  const mod = await import('../server.js');
  return mod.default;
}

afterEach(() => {
  if (ORIGINAL_DEMO_LOGIN === undefined) delete process.env.DEMO_LOGIN;
  else process.env.DEMO_LOGIN = ORIGINAL_DEMO_LOGIN;
});

describe('GD-001: demo login defaults to off, not on', () => {
  it('DEMO_LOGIN unset disables /demo/accounts and /demo/login', async () => {
    const { app, db } = await loadServerWith(undefined);
    const accounts = await request(app).get('/demo/accounts');
    expect(accounts.body).toEqual({ enabled: false, roles: [] });

    const login = await request(app).post('/demo/login').send({ role: 'Coordinator' });
    expect(login.status).toBe(403);
    await db.end().catch(() => {});
  });

  it('DEMO_LOGIN=off explicitly disables it too', async () => {
    const { app, db } = await loadServerWith('off');
    const accounts = await request(app).get('/demo/accounts');
    expect(accounts.body).toEqual({ enabled: false, roles: [] });

    const login = await request(app).post('/demo/login').send({ role: 'Coordinator' });
    expect(login.status).toBe(403);
    await db.end().catch(() => {});
  });

  it('DEMO_LOGIN=on explicitly enables the four demo roles and a working login', async () => {
    const { app, db } = await loadServerWith('on');
    vi.spyOn(db, 'query').mockResolvedValue({
      rows: [{
        id: 1, first_name: 'Sofia', last_name: 'Manthou',
        email: 'sofia.manthou@turtleguard.demo', role: 'Project Coordinator',
        station: null, is_active: true, is_email_verified: true,
        is_password_reset_needed: false,
      }],
    });

    const accounts = await request(app).get('/demo/accounts');
    expect(accounts.body.enabled).toBe(true);
    expect(accounts.body.roles).toEqual(
      expect.arrayContaining(['Coordinator', 'Field Leader', 'Field Assistant', 'Volunteer']),
    );

    const login = await request(app).post('/demo/login').send({ role: 'Coordinator' });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();
    await db.end().catch(() => {});
  });

  it('a near-miss value like DEMO_LOGIN=true stays disabled - only exactly "on" enables it', async () => {
    const { app, db } = await loadServerWith('true');
    const accounts = await request(app).get('/demo/accounts');
    expect(accounts.body).toEqual({ enabled: false, roles: [] });

    const login = await request(app).post('/demo/login').send({ role: 'Coordinator' });
    expect(login.status).toBe(403);
    await db.end().catch(() => {});
  });
});
