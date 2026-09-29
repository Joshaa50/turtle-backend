// Roster templates: a named, reusable weekly pattern (day of week -> shift ->
// volunteer) a coordinator builds once and applies to a real week.
//
// What these cases pin down:
//   - only a coordinator may read, build, edit, apply or delete one
//   - applying maps day_of_week onto the given Monday's week correctly
//   - a person with anything already on that date is skipped, not
//     double-booked, and applying the same template twice creates nothing
//     the second time
//   - deleting a template never touches the Timetable rows an earlier apply
//     already created
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
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
beforeEach(() => {
  query = vi.spyOn(db, 'query').mockRejectedValue(new Error('unstubbed db.query'));
  clientQuery = vi.fn().mockRejectedValue(new Error('unstubbed client.query'));
  vi.spyOn(db, 'connect').mockResolvedValue({ query: clientQuery, release: vi.fn() });
});
afterAll(() => db.end().catch(() => {}));

const validBody = {
  name: 'Standard week',
  rows: [
    { day_of_week: 1, shift_id: 1, user_id: 51 }, // Monday
    { day_of_week: 3, shift_id: 1, user_id: 52 }, // Wednesday
  ],
};

describe('who may manage roster templates', () => {
  it.each(['Field Leader', 'Field Assistant', 'Field Volunteer'])('refuses %s', async (role) => {
    for (const call of [
      () => as(role)(request(app).get('/roster-templates')),
      () => as(role)(request(app).post('/roster-templates')).send(validBody),
      () => as(role)(request(app).put('/roster-templates/1')).send(validBody),
      () => as(role)(request(app).delete('/roster-templates/1')),
      () => as(role)(request(app).post('/roster-templates/1/apply')).send({ monday_date: '2026-10-05' }),
    ]) {
      const res = await call();
      expect(res.status).toBe(403);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses a caller with no token', async () => {
    expect((await request(app).get('/roster-templates')).status).toBe(401);
  });
});

describe('creating and editing a template', () => {
  it('creates a template with its rows in one transaction', async () => {
    clientQuery.mockImplementation(async (sql) => {
      if (String(sql).startsWith('INSERT INTO roster_templates')) return { rows: [{ id: 9, name: 'Standard week' }] };
      return { rows: [] };
    });
    query.mockResolvedValue({ rows: [] }); // attachRosterTemplateRows' row lookup
    const res = await asCoordinator(request(app).post('/roster-templates')).send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.template.name).toBe('Standard week');
    const inserts = clientQuery.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO roster_template_rows'));
    expect(inserts).toHaveLength(2);
    expect(clientQuery.mock.calls.some(([sql]) => sql === 'BEGIN')).toBe(true);
    expect(clientQuery.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(true);
  });

  it('rolls back if a row insert fails partway through', async () => {
    let rowInserts = 0;
    clientQuery.mockImplementation(async (sql) => {
      if (String(sql).startsWith('INSERT INTO roster_templates')) return { rows: [{ id: 9, name: 'Standard week' }] };
      if (String(sql).startsWith('INSERT INTO roster_template_rows')) {
        rowInserts += 1;
        if (rowInserts === 2) throw new Error('boom');
        return { rows: [] };
      }
      return { rows: [] };
    });
    const res = await asCoordinator(request(app).post('/roster-templates')).send(validBody);
    expect(res.status).toBe(500);
    expect(clientQuery.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
  });

  it.each([
    ['no name', { rows: validBody.rows }],
    ['no rows', { name: 'X', rows: [] }],
    ['a day of week out of range', { name: 'X', rows: [{ day_of_week: 7, shift_id: 1, user_id: 1 }] }],
    ['a row missing a volunteer', { name: 'X', rows: [{ day_of_week: 1, shift_id: 1 }] }],
  ])('rejects %s', async (_label, body) => {
    const res = await asCoordinator(request(app).post('/roster-templates')).send(body);
    expect(res.status).toBe(400);
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('replaces a template\'s rows wholesale on edit', async () => {
    clientQuery.mockImplementation(async (sql) => {
      if (String(sql).startsWith('UPDATE roster_templates')) return { rows: [{ id: 9, name: 'Renamed' }] };
      return { rows: [] };
    });
    query.mockResolvedValue({ rows: [] });
    const res = await asCoordinator(request(app).put('/roster-templates/9')).send({ ...validBody, name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM roster_template_rows'))).toBe(true);
  });

  it('reports 404 editing a template that does not exist', async () => {
    clientQuery.mockResolvedValue({ rows: [] });
    const res = await asCoordinator(request(app).put('/roster-templates/999')).send(validBody);
    expect(res.status).toBe(404);
  });
});

describe('deleting a template', () => {
  it('deletes it outright, unlike a beach or a shift type', async () => {
    query.mockResolvedValue({ rows: [{ id: 9 }] });
    const res = await asCoordinator(request(app).delete('/roster-templates/9'));
    expect(res.status).toBe(200);
    expect(String(query.mock.calls[0][0])).toContain('DELETE FROM roster_templates');
  });

  it('reports 404 for one that does not exist', async () => {
    query.mockResolvedValue({ rows: [] });
    const res = await asCoordinator(request(app).delete('/roster-templates/999'));
    expect(res.status).toBe(404);
  });
});

describe('applying a template to a week', () => {
  const templateRow = (over = {}) => ({
    day_of_week: 1, shift_id: 1, user_id: 51, shift_name: 'Loggos Survey', first_name: 'Maria', last_name: 'Karydi', ...over,
  });

  it('maps day_of_week onto the given Monday\'s week', async () => {
    query.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.startsWith('SELECT id, name FROM roster_templates')) return { rows: [{ id: 9, name: 'Standard week' }] };
      if (text.includes('FROM roster_template_rows r')) {
        return { rows: [templateRow({ day_of_week: 1 }), templateRow({ day_of_week: 6, user_id: 52, first_name: 'Nikos' })] };
      }
      if (text.startsWith('SELECT shift_id FROM Timetable')) return { rows: [] };
      if (text.startsWith('INSERT INTO Timetable')) return { rows: [{ assignment_id: 1 }] };
      return { rows: [] };
    });
    const res = await asCoordinator(request(app).post('/roster-templates/9/apply')).send({ monday_date: '2026-10-05' });
    expect(res.status).toBe(200);
    expect(res.body.created.map((c) => c.date)).toEqual(['2026-10-05', '2026-10-10']); // Mon, Sat
    expect(res.body.skipped).toEqual([]);
  });

  it('skips a person who already has that exact shift that date, and does not insert', async () => {
    query.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.startsWith('SELECT id, name FROM roster_templates')) return { rows: [{ id: 9, name: 'Standard week' }] };
      if (text.includes('FROM roster_template_rows r')) return { rows: [templateRow()] };
      if (text.startsWith('SELECT shift_id FROM Timetable')) return { rows: [{ shift_id: 1 }] };
      return { rows: [] };
    });
    const res = await asCoordinator(request(app).post('/roster-templates/9/apply')).send({ monday_date: '2026-10-05' });
    expect(res.status).toBe(200);
    expect(res.body.created).toEqual([]);
    expect(res.body.skipped[0]).toMatchObject({ reason: 'already assigned' });
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO Timetable'))).toBe(false);
  });

  it('skips (does not double-book) a person who has a Day Off, or anything else, that date', async () => {
    query.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.startsWith('SELECT id, name FROM roster_templates')) return { rows: [{ id: 9, name: 'Standard week' }] };
      if (text.includes('FROM roster_template_rows r')) return { rows: [templateRow()] };
      if (text.startsWith('SELECT shift_id FROM Timetable')) return { rows: [{ shift_id: 7 }] }; // Day Off, a different shift
      return { rows: [] };
    });
    const res = await asCoordinator(request(app).post('/roster-templates/9/apply')).send({ monday_date: '2026-10-05' });
    expect(res.body.created).toEqual([]);
    expect(res.body.skipped[0]).toMatchObject({ reason: 'already has something that day' });
  });

  it('is safe to apply twice: the second run creates nothing new', async () => {
    let inserted = false;
    query.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.startsWith('SELECT id, name FROM roster_templates')) return { rows: [{ id: 9, name: 'Standard week' }] };
      if (text.includes('FROM roster_template_rows r')) return { rows: [templateRow()] };
      if (text.startsWith('SELECT shift_id FROM Timetable')) return { rows: inserted ? [{ shift_id: 1 }] : [] };
      if (text.startsWith('INSERT INTO Timetable')) { inserted = true; return { rows: [{ assignment_id: 1 }] }; }
      return { rows: [] };
    });
    const first = await asCoordinator(request(app).post('/roster-templates/9/apply')).send({ monday_date: '2026-10-05' });
    expect(first.body.created).toHaveLength(1);
    const second = await asCoordinator(request(app).post('/roster-templates/9/apply')).send({ monday_date: '2026-10-05' });
    expect(second.body.created).toEqual([]);
    expect(second.body.skipped[0].reason).toBe('already assigned');
  });

  it('reports 404 applying a template that does not exist', async () => {
    query.mockResolvedValue({ rows: [] });
    const res = await asCoordinator(request(app).post('/roster-templates/999/apply')).send({ monday_date: '2026-10-05' });
    expect(res.status).toBe(404);
  });

  it('rejects a missing or malformed monday_date', async () => {
    for (const body of [{}, { monday_date: 'next monday' }, { monday_date: '05-10-2026' }]) {
      const res = await asCoordinator(request(app).post('/roster-templates/9/apply')).send(body);
      expect(res.status).toBe(400);
    }
  });
});
