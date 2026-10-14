// QA-085: DELETE /nests/:id already cascades to delete the nest's own
// turtle_nest_events rows, but left their record_reviews rows behind as
// orphans ("This record has since been deleted") regardless of review
// status. This mirrors the existing cleanup for record_type = 'nest' and
// 'emergence' in the same route, extended to record_type = 'nest_event'.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const asLeader = (req) =>
  req.set('Authorization', `Bearer ${jwt.sign({ sub: '7', role: 'Field Leader', email: 'leader@turtleguard.demo' }, SECRET, { expiresIn: '1h' })}`);

function mockConnect(eventRows) {
  const clientQuery = vi.fn().mockImplementation((sql) => {
    const text = String(sql);
    if (text.includes('SELECT id, nest_code, emergence_id FROM turtle_nests')) {
      return Promise.resolve({ rows: [{ id: 50, nest_code: 'LG2-9', emergence_id: null }], rowCount: 1 });
    }
    if (text.includes('DELETE FROM turtle_nest_events')) {
      return Promise.resolve({ rows: eventRows, rowCount: eventRows.length });
    }
    if (text.includes('DELETE FROM turtle_nests WHERE id')) {
      return Promise.resolve({ rows: [{ id: 50, nest_code: 'LG2-9', beach: 'Loggos 2' }], rowCount: 1 });
    }
    return Promise.resolve({ rows: [] });
  });
  vi.spyOn(db, 'connect').mockResolvedValue({ query: clientQuery, release: vi.fn() });
  return clientQuery;
}

afterAll(() => db.end().catch(() => {}));

describe('DELETE /nests/:id cleans up record_reviews for deleted nest_events', () => {
  beforeEach(() => {
    vi.spyOn(db, 'query').mockResolvedValue({ rows: [] });
  });

  it('removes the review row for a single deleted event, regardless of status', async () => {
    const clientQuery = mockConnect([{ id: 101 }]);

    const res = await asLeader(request(app).delete('/nests/50'));

    expect(res.status).toBe(200);
    const cleanupCall = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('record_reviews') && String(sql).includes("'nest_event'")
    );
    expect(cleanupCall).toBeTruthy();
    const [sql, params] = cleanupCall;
    // No status filter: deletes unconditionally, whether the review was
    // pending, approved, or rejected.
    expect(String(sql)).not.toMatch(/status/i);
    expect(params[0]).toEqual([101]);
  });

  it('removes review rows for every event on the nest, not just the first', async () => {
    const clientQuery = mockConnect([{ id: 101 }, { id: 102 }, { id: 103 }]);

    const res = await asLeader(request(app).delete('/nests/50'));

    expect(res.status).toBe(200);
    const cleanupCall = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('record_reviews') && String(sql).includes("'nest_event'")
    );
    expect(cleanupCall).toBeTruthy();
    expect(cleanupCall[1][0]).toEqual([101, 102, 103]);
  });

  it('skips the cleanup query entirely when the nest has no events', async () => {
    const clientQuery = mockConnect([]);

    const res = await asLeader(request(app).delete('/nests/50'));

    expect(res.status).toBe(200);
    const cleanupCall = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('record_reviews') && String(sql).includes("'nest_event'")
    );
    expect(cleanupCall).toBeUndefined();
  });

  it('still reports deleted_event_count equal to the events rowCount', async () => {
    mockConnect([{ id: 101 }, { id: 102 }]);

    const res = await asLeader(request(app).delete('/nests/50'));

    expect(res.status).toBe(200);
    expect(res.body.deleted_event_count).toBe(2);
  });
});
