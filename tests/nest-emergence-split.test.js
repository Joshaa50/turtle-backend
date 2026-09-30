// PATCH /nests/:id/emergence - gives a nest its own emergence record instead
// of sharing one with other nests (the bug found in the demo data: ten nests
// were all pointed at the same emergence row). Coordinator-only, since it
// rewrites how a record links to its own history rather than doing fieldwork.
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

const NEST = { id: 12, nest_code: 'MA-1', emergence_id: 1, beach: 'Megas Lakkos' };
const SOURCE_EMERGENCE = {
  id: 1, gps_lat: '38.14', gps_long: '20.52', distance_to_sea_s: 20,
  beach: 'Loggos 2', event_date: '2026-05-20T00:00:00.000Z', track_sketch: null,
};
const NEW_EMERGENCE = { ...SOURCE_EMERGENCE, id: 88, beach: 'Megas Lakkos' };

let query;
let clientQuery;
beforeEach(() => {
  clientQuery = vi.fn().mockImplementation(async (sql, params) => {
    const text = String(sql);
    if (text.startsWith('BEGIN') || text.startsWith('COMMIT') || text.startsWith('ROLLBACK')) return { rows: [] };
    if (text.includes('INSERT INTO turtle_emergences')) return { rows: [NEW_EMERGENCE] };
    if (text.includes('UPDATE turtle_nests SET emergence_id')) {
      return { rows: [{ id: NEST.id, nest_code: NEST.nest_code, emergence_id: NEW_EMERGENCE.id }] };
    }
    return { rows: [] };
  });
  vi.spyOn(db, 'connect').mockResolvedValue({ query: clientQuery, release: vi.fn() });
  query = vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    const text = String(sql);
    if (text.includes('FROM turtle_nests WHERE id')) return { rows: [NEST] };
    if (text.includes('FROM turtle_emergences WHERE id')) return { rows: [SOURCE_EMERGENCE] };
    return { rows: [] };
  });
});
afterAll(() => db.end().catch(() => {}));

describe('PATCH /nests/:id/emergence', () => {
  it('creates a new emergence cloned from the current one and repoints the nest to it', async () => {
    const res = await asCoordinator(request(app).patch(`/nests/${NEST.id}/emergence`)).send({});
    expect(res.status).toBe(200);
    expect(res.body.nest.emergence_id).toBe(NEW_EMERGENCE.id);
    expect(res.body.emergence.id).toBe(NEW_EMERGENCE.id);
    // The original emergence row was read, not mutated.
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE turtle_emergences'))).toBe(false);
  });

  it('applies overrides (e.g. the nest\'s real beach) onto the cloned emergence', async () => {
    await asCoordinator(request(app).patch(`/nests/${NEST.id}/emergence`)).send({ beach: 'Megas Lakkos' });
    const insertCall = clientQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO turtle_emergences'));
    expect(insertCall[1]).toContain('Megas Lakkos');
  });

  it('is coordinator only', async () => {
    const res = await asLeader(request(app).patch(`/nests/${NEST.id}/emergence`)).send({});
    expect(res.status).toBe(403);
  });

  it('404s for a nest that does not exist', async () => {
    query.mockImplementation(async () => ({ rows: [] }));
    const res = await asCoordinator(request(app).patch('/nests/999/emergence')).send({});
    expect(res.status).toBe(404);
  });

  it('rolls back and reports an error if the update fails', async () => {
    clientQuery.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.startsWith('BEGIN')) return { rows: [] };
      if (text.includes('INSERT INTO turtle_emergences')) return { rows: [NEW_EMERGENCE] };
      if (text.includes('UPDATE turtle_nests')) throw new Error('db down');
      return { rows: [] };
    });
    const res = await asCoordinator(request(app).patch(`/nests/${NEST.id}/emergence`)).send({});
    expect(res.status).toBe(500);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).startsWith('ROLLBACK'))).toBe(true);
  });
});
