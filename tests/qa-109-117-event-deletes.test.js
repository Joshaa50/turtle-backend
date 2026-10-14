// QA-109 / QA-117: there was no way to void a nest event or a turtle survey
// event entered in error. DELETE /nest-events/:id and
// DELETE /turtle_survey_events/:id are coordinator-only, return 404 for an
// unknown id, and record a 'deleted' entry in record_audit inside the same
// transaction. Nothing here touches a real database.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const tokenFor = (role, sub = '1') =>
  jwt.sign({ sub, role, email: 'c@turtleguard.demo' }, SECRET, { expiresIn: '1h' });

let clientQuery;
let found;      // what the DELETE ... RETURNING finds: a row, or none
let committed;
let rolledBack;
let released;

const sqlsOf = () => clientQuery.mock.calls.map(([sql]) => String(sql));

beforeEach(() => {
  committed = false;
  rolledBack = false;
  released = false;
  found = { id: 77, nest_code: 'KF-18', event_type: 'Hatched', turtle_id: 4, location: 'Xi' };

  clientQuery = vi.fn(async (sql) => {
    const text = String(sql);
    if (text.includes('BEGIN')) return { rows: [] };
    if (text.includes('COMMIT')) { committed = true; return { rows: [] }; }
    if (text.includes('ROLLBACK')) { rolledBack = true; return { rows: [] }; }
    if (/^\s*DELETE FROM (turtle_nest_events|turtle_survey_events)/.test(text)) {
      return found ? { rows: [found], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO record_audit/i.test(text)) {
      return { rows: [{ id: 1 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  vi.spyOn(db, 'connect').mockResolvedValue({ query: clientQuery, release: () => { released = true; } });
  vi.spyOn(db, 'query').mockResolvedValue({ rows: [], rowCount: 0 });
});

afterAll(() => db.end().catch(() => {}));

describe('DELETE /nest-events/:id (QA-109)', () => {
  it('lets a coordinator void a nest event, deletes its review, and audits it in the same transaction', async () => {
    const res = await request(app)
      .delete('/nest-events/77')
      .set('Authorization', `Bearer ${tokenFor('Project Coordinator')}`);

    expect(res.status).toBe(200);
    expect(res.body.deleted_nest_event.id).toBe(77);
    expect(committed).toBe(true);
    expect(released).toBe(true);

    const sqls = sqlsOf();
    expect(sqls.some((s) => /DELETE FROM turtle_nest_events WHERE id = \$1/.test(s))).toBe(true);
    expect(sqls.some((s) => /DELETE FROM record_reviews WHERE record_type = 'nest_event'/.test(s))).toBe(true);

    const audit = clientQuery.mock.calls.find(([sql]) => /INSERT INTO record_audit/i.test(String(sql)));
    expect(audit[1]).toEqual(expect.arrayContaining(['nest_event', 77, 'deleted']));
  });

  it('returns 404 and rolls back when the nest event does not exist', async () => {
    found = null;
    const res = await request(app)
      .delete('/nest-events/999999')
      .set('Authorization', `Bearer ${tokenFor('Project Coordinator')}`);

    expect(res.status).toBe(404);
    expect(rolledBack).toBe(true);
    expect(committed).toBe(false);
  });

  it('refuses to delete when the audit entry cannot be written, and rolls back', async () => {
    clientQuery.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('BEGIN')) return { rows: [] };
      if (text.includes('COMMIT')) { committed = true; return { rows: [] }; }
      if (text.includes('ROLLBACK')) { rolledBack = true; return { rows: [] }; }
      if (/^\s*DELETE FROM turtle_nest_events/.test(text)) return { rows: [found], rowCount: 1 };
      if (/INSERT INTO record_audit/i.test(text)) throw new Error('audit table down');
      return { rows: [], rowCount: 0 };
    });
    const res = await request(app)
      .delete('/nest-events/77')
      .set('Authorization', `Bearer ${tokenFor('Project Coordinator')}`);

    expect(res.status).toBe(500);
    expect(rolledBack).toBe(true);
    expect(committed).toBe(false);
  });

  it('refuses a Field Leader (coordinator only)', async () => {
    const res = await request(app)
      .delete('/nest-events/77')
      .set('Authorization', `Bearer ${tokenFor('Field Leader', '5')}`);

    expect(res.status).toBe(403);
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('refuses a Field Volunteer', async () => {
    const res = await request(app)
      .delete('/nest-events/77')
      .set('Authorization', `Bearer ${tokenFor('Field Volunteer', '12')}`);

    expect(res.status).toBe(403);
  });
});

