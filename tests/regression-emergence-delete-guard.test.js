// QA-042: DELETE /emergences/:id let a Field Assistant delete any emergence,
// including other people's, even though the FA UI never offers a delete
// option on emergences (only "Edit record") - the same class of gap already
// closed for DELETE /nests/:id and DELETE /turtles/:id (QA-001/QA-030), and
// now inconsistent for this route to leave open. The deletion also went
// unaudited - the trail stopped at "created" with no record of who removed
// it.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const tokenFor = (role) =>
  jwt.sign({ sub: '22', role, email: 'nikos.floros@turtleguard.demo' }, SECRET, { expiresIn: '1h' });

const asAssistant = (req) => req.set('Authorization', `Bearer ${tokenFor('Field Assistant')}`);
const asLeader = (req) => req.set('Authorization', `Bearer ${tokenFor('Field Leader')}`);

let query;
let clientQuery;

beforeEach(() => {
  query = vi.spyOn(db, 'query').mockResolvedValue({ rows: [] });
  clientQuery = vi.fn().mockImplementation((sql) => {
    const text = String(sql);
    if (text.includes('SELECT nest_code FROM turtle_nests')) return Promise.resolve({ rows: [] });
    if (text.includes('DELETE FROM turtle_emergences')) {
      return Promise.resolve({ rows: [{ id: 119, beach: 'Loggos 2', event_date: '2026-10-06' }], rowCount: 1 });
    }
    return Promise.resolve({ rows: [] });
  });
  vi.spyOn(db, 'connect').mockResolvedValue({ query: clientQuery, release: vi.fn() });
});

afterAll(() => db.end().catch(() => {}));

describe('DELETE /emergences/:id role guard (QA-042)', () => {
  it('refuses a Field Assistant, matching DELETE /nests and DELETE /turtles', async () => {
    const res = await asAssistant(request(app).delete('/emergences/119'));

    expect(res.status).toBe(403);
    expect(clientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM turtle_emergences'),
      expect.anything(),
    );
  });

  it('still lets a Field Leader delete', async () => {
    const res = await asLeader(request(app).delete('/emergences/119'));

    expect(res.status).toBe(200);
  });

  it('records a "deleted" audit entry', async () => {
    await asLeader(request(app).delete('/emergences/119'));

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO record_audit'),
      expect.arrayContaining(['emergence', 119, 'deleted']),
    );
  });
});
