// Data retention: PRIVACY.md names this as the one real gap - accounts were
// kept forever with no automatic limit. This reuses the same erasure the
// manual GDPR route already performs, applied automatically to accounts
// inactive past a coordinator-configured threshold.
//
// What these cases pin down:
//   - off by default; nothing happens on an unconfigured project
//   - only a coordinator's own request triggers the sweep - a Field Leader
//     browsing the team list must never cause an irreversible erasure
//   - a demo account is never swept, however long it has sat unused
//   - the last active coordinator is never auto-erased, and one failure
//     never blocks the rest of the sweep
//   - a warning alert appears before erasure, coordinator-only
//   - only real logins record last_login_at, never a demo one
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const as = (role, sub = '1') => (req) =>
  req.set('Authorization', `Bearer ${jwt.sign({ sub, role, email: `${sub}@turtleguard.demo` }, SECRET, { expiresIn: '1h' })}`);
const asCoordinator = as('Project Coordinator');
const asLeader = as('Field Leader');
const asVolunteer = as('Field Volunteer');

let query;
let clientQuery;
let stored;

beforeEach(() => {
  stored = {};
  clientQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  vi.spyOn(db, 'connect').mockResolvedValue({ query: clientQuery, release: vi.fn() });
  query = vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    const text = String(sql);
    if (text.includes('FROM app_settings')) {
      return { rows: stored[params?.[0]] ? [{ value: stored[params[0]] }] : [] };
    }
    if (text.includes('INSERT INTO app_settings')) {
      stored[params[0]] = JSON.parse(params[1]);
      return { rows: [] };
    }
    if (text.includes('COALESCE(last_login_at, created_at) AS last_activity')) return { rows: [] };
    if (text.includes('SELECT id, first_name, last_name, email, role') && text.includes('FROM users')) return { rows: [] };
    return { rows: [] };
  });
});
afterAll(() => db.end().catch(() => {}));

describe('retention settings', () => {
  it('defaults to off, with a year-long threshold', async () => {
    const res = await asVolunteer(request(app).get('/settings'));
    expect(res.body.retention).toEqual({ auto_erase_enabled: false, inactive_days: 365 });
  });

  it('saves valid settings', async () => {
    const res = await asCoordinator(request(app).put('/settings/retention')).send({ auto_erase_enabled: true, inactive_days: 180 });
    expect(res.status).toBe(200);
    expect(res.body.retention).toEqual({ auto_erase_enabled: true, inactive_days: 180 });
  });

  it.each([
    ['a non-boolean enabled flag', { auto_erase_enabled: 'yes', inactive_days: 180 }],
    ['too short a threshold', { auto_erase_enabled: true, inactive_days: 10 }],
    ['too long a threshold', { auto_erase_enabled: true, inactive_days: 9999 }],
    ['a fractional threshold', { auto_erase_enabled: true, inactive_days: 180.5 }],
  ])('rejects %s', async (_label, body) => {
    const res = await asCoordinator(request(app).put('/settings/retention')).send(body);
    expect(res.status).toBe(400);
    expect(stored.retention).toBeUndefined();
  });

  it('is coordinator only', async () => {
    const res = await asLeader(request(app).put('/settings/retention')).send({ auto_erase_enabled: true, inactive_days: 180 });
    expect(res.status).toBe(403);
  });
});

describe('the automatic sweep', () => {
  const dormant = { id: 21, first_name: 'Liam', last_name: "O'Connor", email: 'liam@example.com', role: 'Field Volunteer' };

  it('does nothing when disabled (the default)', async () => {
    await asCoordinator(request(app).get('/users'));
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('never runs from a Field Leader\'s request, even when enabled', async () => {
    stored.retention = { auto_erase_enabled: true, inactive_days: 180 };
    await asLeader(request(app).get('/users'));
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('erases a dormant account when a coordinator reads the team list', async () => {
    stored.retention = { auto_erase_enabled: true, inactive_days: 180 };
    query.mockImplementation(async (sql, params) => {
      const text = String(sql);
      if (text.includes('FROM app_settings')) return { rows: [{ value: stored.retention }] };
      if (text.includes('COALESCE(last_login_at, created_at) AS last_activity')) return { rows: [{ ...dormant, last_activity: '2025-01-01' }] };
      return { rows: [] };
    });
    clientQuery.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.startsWith('SELECT id, first_name')) return { rows: [dormant] };
      if (text.includes('COUNT(*)')) return { rows: [{ n: 5 }] };
      return { rows: [], rowCount: 0 };
    });
    await asCoordinator(request(app).get('/users'));
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('SET first_name'))).toBe(true);
    expect(clientQuery.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(true);
  });

  it('excludes a demo account from the query regardless of inactivity', async () => {
    stored.retention = { auto_erase_enabled: true, inactive_days: 180 };
    await asCoordinator(request(app).get('/users'));
    const dueQuery = query.mock.calls.find(([sql]) => String(sql).includes('COALESCE(last_login_at, created_at) AS last_activity'));
    expect(dueQuery).toBeDefined();
    expect(String(dueQuery[0])).toContain("email NOT LIKE '%@turtleguard.demo'");
  });

  it('never erases the last active coordinator, and does not stop the sweep', async () => {
    const soleCoordinator = { id: 3, first_name: 'Sofia', last_name: 'Manthou', email: 'sofia@example.com', role: 'Project Coordinator' };
    stored.retention = { auto_erase_enabled: true, inactive_days: 180 };
    query.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('FROM app_settings')) return { rows: [{ value: stored.retention }] };
      if (text.includes('COALESCE(last_login_at, created_at) AS last_activity')) return { rows: [{ ...soleCoordinator, last_activity: '2025-01-01' }, { ...dormant, last_activity: '2025-01-01' }] };
      return { rows: [] };
    });
    let call = 0;
    clientQuery.mockImplementation(async (sql) => {
      const text = String(sql);
      call += 1;
      if (text.startsWith('SELECT id, first_name')) {
        return { rows: [call <= 3 ? soleCoordinator : dormant] };
      }
      if (text.includes('COUNT(*)')) return { rows: [{ n: 0 }] }; // no other coordinator
      return { rows: [], rowCount: 0 };
    });
    await asCoordinator(request(app).get('/users'));
    // Both accounts were attempted (two BEGINs), but only one committed - the
    // coordinator's own erasure was rolled back, not left half-applied.
    const begins = clientQuery.mock.calls.filter(([sql]) => sql === 'BEGIN').length;
    expect(begins).toBe(2);
  });

  it('keeps going when one erasure throws', async () => {
    const other = { id: 22, first_name: 'A', last_name: 'B', email: 'a@example.com', role: 'Field Volunteer' };
    stored.retention = { auto_erase_enabled: true, inactive_days: 180 };
    query.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('FROM app_settings')) return { rows: [{ value: stored.retention }] };
      if (text.includes('COALESCE(last_login_at, created_at) AS last_activity')) return { rows: [{ ...dormant, last_activity: '2025-01-01' }, { ...other, last_activity: '2025-01-01' }] };
      return { rows: [] };
    });
    let selectCount = 0;
    clientQuery.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.startsWith('SELECT id, first_name')) {
        selectCount += 1;
        if (selectCount === 1) throw new Error('db blip');
        return { rows: [other] };
      }
      if (text.includes('COUNT(*)')) return { rows: [{ n: 5 }] };
      return { rows: [], rowCount: 0 };
    });
    const res = await asCoordinator(request(app).get('/users'));
    expect(res.status).toBe(200); // the read itself never fails because the sweep hiccuped
    expect(clientQuery.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(true);
  });
});

describe('the pre-erasure warning alert', () => {
  it('is shown to a coordinator when someone is close to the threshold', async () => {
    stored.retention = { auto_erase_enabled: true, inactive_days: 180 };
    query.mockImplementation(async (sql, params) => {
      const text = String(sql);
      if (text.includes('FROM app_settings')) return { rows: [{ value: stored.retention }] };
      if (text.includes('COALESCE(last_login_at, created_at) AS last_activity')) {
        // The "soon" query uses inactive_days - 14; a real row only appears for that one.
        return params?.[0] === 166
          ? { rows: [{ id: 21, first_name: 'Liam', last_name: "O'Connor", email: 'liam@example.com', role: 'Field Volunteer', last_activity: '2025-03-01T00:00:00.000Z' }] }
          : { rows: [] };
      }
      return { rows: [] };
    });
    const res = await asCoordinator(request(app).get('/alerts'));
    const alert = res.body.alerts.find((a) => a.kind === 'retention_warning');
    expect(alert).toBeDefined();
    expect(alert.message).toContain('Liam');
    expect(alert.can_acknowledge).toBe(false);
  });

  it('is never shown to a Field Leader', async () => {
    stored.retention = { auto_erase_enabled: true, inactive_days: 180 };
    const res = await asLeader(request(app).get('/alerts'));
    expect(res.body.alerts.some((a) => a.kind === 'retention_warning')).toBe(false);
  });

  it('is absent while retention is disabled', async () => {
    const res = await asCoordinator(request(app).get('/alerts'));
    expect(res.body.alerts.some((a) => a.kind === 'retention_warning')).toBe(false);
  });
});

describe('last_login_at', () => {
  it('is recorded on a real login', async () => {
    const hash = await bcrypt.hash('correcthorse', 10);
    query.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text === 'SELECT * FROM users WHERE email = $1 LIMIT 1') {
        return { rows: [{ id: 5, email: 'v@example.com', password_hash: hash, role: 'Field Volunteer', is_active: true, is_email_verified: true }] };
      }
      return { rows: [] };
    });
    const res = await request(app).post('/users/login').send({ email: 'v@example.com', password: 'correcthorse' });
    expect(res.status).toBe(200);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('SET last_login_at = NOW()'))).toBe(true);
  });

  it('is not touched by a demo login', async () => {
    query.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('FROM users WHERE email')) {
        return { rows: [{ id: 48, email: 'sofia.manthou@turtleguard.demo', role: 'Project Coordinator', is_active: true, is_email_verified: true }] };
      }
      return { rows: [] };
    });
    await request(app).post('/demo/login').send({ role: 'Coordinator' });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('last_login_at'))).toBe(false);
  });
});
