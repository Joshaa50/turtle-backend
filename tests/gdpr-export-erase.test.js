import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const tokenFor = (role) =>
  jwt.sign({ sub: '48', role, email: 'coord@example.com' }, SECRET, { expiresIn: '1h' });

const PERSON = { id: 21, first_name: 'Liam', last_name: "O'Connor", email: 'liam@example.com', role: 'Field Volunteer' };

let query, connect, client;
beforeEach(() => {
  query = vi.spyOn(db, 'query').mockResolvedValue({ rows: [], rowCount: 0 });
  client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: vi.fn() };
  connect = vi.spyOn(db, 'connect').mockResolvedValue(client);
});
afterAll(() => db.end().catch(() => {}));

/** Makes the transaction find PERSON and answer the coordinator-count check. */
const stubEraseFlow = ({ person = PERSON, otherCoordinators = 3 } = {}) => {
  client.query.mockImplementation((sql) => {
    if (/FROM users WHERE id/i.test(sql)) return Promise.resolve({ rows: [person], rowCount: 1 });
    if (/COUNT\(\*\)/i.test(sql)) return Promise.resolve({ rows: [{ n: otherCoordinators }], rowCount: 1 });
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
};

describe('subject access export', () => {
  it('is closed to everyone but a coordinator', async () => {
    for (const role of ['Field Volunteer', 'Field Assistant', 'Field Leader']) {
      const res = await request(app).get('/users/21/data-export').set('Authorization', `Bearer ${tokenFor(role)}`);
      expect(res.status, role).toBe(403);
    }
  });

  it('is closed without a token', async () => {
    expect((await request(app).get('/users/21/data-export')).status).toBe(401);
  });

  it('404s for an account that does not exist', async () => {
    query.mockResolvedValue({ rows: [] });
    const res = await request(app).get('/users/999/data-export').set('Authorization', `Bearer ${tokenFor('Project Coordinator')}`);
    expect(res.status).toBe(404);
  });

  it('never includes the password hash', async () => {
    query.mockResolvedValue({ rows: [PERSON] });
    const res = await request(app).get('/users/21/data-export').set('Authorization', `Bearer ${tokenFor('Project Coordinator')}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
  });

  it('searches the observer columns by name, not only by user id', async () => {
    // Observer is a typed name, so an export keyed only on user_id would miss
    // the records the person is actually named on.
    query.mockResolvedValue({ rows: [PERSON] });
    await request(app).get('/users/21/data-export').set('Authorization', `Bearer ${tokenFor('Project Coordinator')}`);
    const byName = query.mock.calls.filter(([sql, params]) =>
      /observer = \$1/.test(sql) && params?.[0] === "Liam O'Connor"
    );
    expect(byName.length).toBeGreaterThan(0);
  });
});

describe('erasure', () => {
  const erase = (body, role = 'Project Coordinator') =>
    request(app).post('/users/21/erase').set('Authorization', `Bearer ${tokenFor(role)}`).send(body);

  it('is closed to a field leader — erasure is a coordinator decision', async () => {
    expect((await erase({ confirm_email: PERSON.email }, 'Field Leader')).status).toBe(403);
  });

  it('refuses without the confirmation email', async () => {
    const res = await erase({});
    expect(res.status).toBe(400);
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuses when the confirmation email does not match, and changes nothing', async () => {
    stubEraseFlow();
    const res = await erase({ confirm_email: 'someone.else@example.com' });
    expect(res.status).toBe(400);
    const sqls = client.query.mock.calls.map(([s]) => s).join(' ');
    expect(sqls).toMatch(/ROLLBACK/);
    expect(sqls).not.toMatch(/UPDATE users\s+SET first_name/i);
  });

  it('refuses to erase the last active coordinator', async () => {
    stubEraseFlow({ person: { ...PERSON, role: 'Project Coordinator' }, otherCoordinators: 0 });
    const res = await erase({ confirm_email: PERSON.email });
    expect(res.status).toBe(409);
    expect(client.query.mock.calls.map(([s]) => s).join(' ')).toMatch(/ROLLBACK/);
  });

  it('replaces the identifiers and makes the account unusable', async () => {
    stubEraseFlow();
    const res = await erase({ confirm_email: PERSON.email });
    expect(res.status).toBe(200);

    const update = client.query.mock.calls.find(([s]) => /UPDATE users\s+SET first_name/i.test(s));
    expect(update).toBeTruthy();
    const [, params] = update;
    expect(params[0]).toBe('Removed');
    // Reserved invalid TLD: it can never route if something later tries to mail it.
    expect(params[1]).toBe('erased-21@removed.invalid');
    expect(params[2]).not.toBe(PERSON.email);
    expect(client.query.mock.calls.map(([s]) => s).join(' ')).toMatch(/COMMIT/);
  });

  it('blanks the station rather than nulling it — the column is NOT NULL', async () => {
    // Setting it to NULL failed the whole transaction against the real schema,
    // and the rollback meant an erasure silently did nothing at all.
    stubEraseFlow();
    await erase({ confirm_email: PERSON.email });
    const update = client.query.mock.calls.find(([s]) => /UPDATE users\s+SET first_name/i.test(s));
    expect(update[0]).toMatch(/station = ''/);
    expect(update[0]).not.toMatch(/station = NULL/i);
  });

  it('does not ask Timetable for a column it does not have', async () => {
    // Its key is assignment_id. RETURNING id aborted the transaction, so every
    // erasure rolled back while reporting a server error - a failure that
    // looks identical to the database being down.
    stubEraseFlow();
    await erase({ confirm_email: PERSON.email });
    const del = client.query.mock.calls.find(([s]) => /DELETE FROM Timetable/i.test(s));
    expect(del[0]).not.toMatch(/RETURNING id/i);
  });

  it('keeps the fieldwork and deletes only the rota', async () => {
    stubEraseFlow();
    await erase({ confirm_email: PERSON.email });
    const sqls = client.query.mock.calls.map(([s]) => s);

    // A nest is an observation about an animal. Erasing a volunteer must not
    // destroy a season of it.
    expect(sqls.some((s) => /DELETE FROM turtle_nests/i.test(s))).toBe(false);
    expect(sqls.some((s) => /DELETE FROM turtle_survey_events/i.test(s))).toBe(false);
    expect(sqls.some((s) => /DELETE FROM Timetable WHERE user_id/i.test(s))).toBe(true);
  });

  it('de-identifies the audit trail without erasing that something happened', async () => {
    stubEraseFlow();
    await erase({ confirm_email: PERSON.email });
    const sqls = client.query.mock.calls.map(([s]) => s);
    expect(sqls.some((s) => /UPDATE record_audit SET actor_email = NULL/i.test(s))).toBe(true);
    expect(sqls.some((s) => /DELETE FROM record_audit/i.test(s))).toBe(false);
  });

  it('replaces the typed observer name in field records', async () => {
    stubEraseFlow();
    await erase({ confirm_email: PERSON.email });
    const observerUpdates = client.query.mock.calls.filter(([s]) => /SET observer = \$1/i.test(s));
    expect(observerUpdates.length).toBe(2);
    expect(observerUpdates[0][1]).toEqual(['Removed', "Liam O'Connor"]);
  });

  it('rolls back and reports nothing changed when a step fails', async () => {
    client.query.mockImplementation((sql) => {
      if (/FROM users WHERE id/i.test(sql)) return Promise.resolve({ rows: [PERSON], rowCount: 1 });
      if (/UPDATE users\s+SET first_name/i.test(sql)) return Promise.reject(new Error('db down'));
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const res = await erase({ confirm_email: PERSON.email });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/nothing was changed/i);
    expect(client.release).toHaveBeenCalled();
  });
});
