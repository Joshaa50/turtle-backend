// Extends the "deleted" audit entry already written by DELETE /emergences/:id
// (QA-042) to DELETE /nests/:id and DELETE /turtles/:id - neither wrote one
// at all, so the trail for either went silent after "created" with no record
// of who removed it.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const asLeader = (req) =>
  req.set('Authorization', `Bearer ${jwt.sign({ sub: '7', role: 'Field Leader', email: 'leader@turtleguard.demo' }, SECRET, { expiresIn: '1h' })}`);

let query;

afterAll(() => db.end().catch(() => {}));

describe('DELETE /nests/:id records a "deleted" audit entry', () => {
  beforeEach(() => {
    query = vi.spyOn(db, 'query').mockResolvedValue({ rows: [] });
    const clientQuery = vi.fn().mockImplementation((sql) => {
      const text = String(sql);
      if (text.includes('SELECT id, nest_code, emergence_id FROM turtle_nests')) {
        return Promise.resolve({ rows: [{ id: 50, nest_code: 'LG2-9', emergence_id: null }], rowCount: 1 });
      }
      if (text.includes('DELETE FROM turtle_nests WHERE id')) {
        return Promise.resolve({ rows: [{ id: 50, nest_code: 'LG2-9', beach: 'Loggos 2' }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [] });
    });
    vi.spyOn(db, 'connect').mockResolvedValue({ query: clientQuery, release: vi.fn() });
  });

  it('writes the audit entry after a successful delete', async () => {
    const res = await asLeader(request(app).delete('/nests/50'));

    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO record_audit'),
      expect.arrayContaining(['nest', 50, 'deleted']),
    );
  });
});

describe('DELETE /turtles/:id records a "deleted" audit entry', () => {
  beforeEach(() => {
    query = vi.spyOn(db, 'query').mockResolvedValue({ rows: [] });
    const clientQuery = vi.fn().mockImplementation((sql) => {
      const text = String(sql);
      if (text.includes('SELECT is_archived FROM turtles')) {
        return Promise.resolve({ rows: [{ is_archived: true }], rowCount: 1 });
      }
      if (text.includes('DELETE FROM turtles WHERE id')) {
        return Promise.resolve({ rows: [{ id: 32, name: 'Phoebe' }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [] });
    });
    vi.spyOn(db, 'connect').mockResolvedValue({ query: clientQuery, release: vi.fn() });
  });

  it('writes the audit entry after a successful delete', async () => {
    const res = await asLeader(request(app).delete('/turtles/32'));

    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO record_audit'),
      expect.arrayContaining(['turtle', 32, 'deleted']),
    );
  });
});
