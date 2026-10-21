// QA-139: QA-132 added date_found editing to PUT /nests/:id/update, but
// never synced the correction onto the nest's 1:1 emergence row (the same
// gap QA-101 already fixed for GPS) - so the Emergences tab kept showing
// the nesting event on the night before the correction.
import { describe, it, expect, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';
import { stubTxClient } from './support/txClient.js';

const { app, db } = server;

const SECRET = process.env.JWT_SECRET;
const leaderToken = jwt.sign(
  { sub: '49', role: 'Field Leader', email: 'elena.papadaki@turtleguard.demo' },
  SECRET,
  { expiresIn: '1h' },
);
const auth = (req) => req.set('Authorization', `Bearer ${leaderToken}`);

afterAll(() => db.end().catch(() => {}));

describe('PUT /nests/:id/update syncs the linked emergence event_date (QA-139)', () => {
  const validNest = {
    nest_code: 'MG-2', beach: 'Makris Gialos', date_found: '2026-10-19',
    depth_top_egg_h: 36, distance_to_sea_s: 19,
    gps_lat: 38.18412, gps_long: 20.44031,
  };

  it('updates turtle_emergences event_date when the nest has an emergence_id', async () => {
    stubTxClient(db);
    const calls = [];
    vi.spyOn(db, 'query').mockImplementation((sql, params) => {
      const text = String(sql);
      calls.push({ text, params });
      if (text.includes('SELECT nest_code, status, relocated, beach')) {
        return Promise.resolve({ rows: [{ nest_code: 'MG-2', status: 'incubating', relocated: false, beach: 'Makris Gialos', total_num_eggs: null, current_num_eggs: null, is_archived: false }] });
      }
      if (text.includes('UPDATE turtle_nests')) {
        return Promise.resolve({ rows: [{ id: 116, emergence_id: 195, nest_code: 'MG-2', status: 'incubating' }] });
      }
      if (text.includes('UPDATE turtle_emergences SET gps_lat') || text.includes('UPDATE turtle_emergences SET event_date')) {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes('INSERT INTO record_audit')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await auth(request(app).put('/nests/116/update')).send(validNest);

    expect(res.status).toBe(200);
    const emergenceDateSync = calls.find((c) => c.text.includes('UPDATE turtle_emergences SET event_date'));
    expect(emergenceDateSync).toBeTruthy();
    expect(emergenceDateSync.params).toEqual(['2026-10-19', 195]);
  });

  it('does not touch turtle_emergences when the nest has no emergence_id', async () => {
    stubTxClient(db);
    const calls = [];
    vi.spyOn(db, 'query').mockImplementation((sql, params) => {
      const text = String(sql);
      calls.push({ text, params });
      if (text.includes('SELECT nest_code, status, relocated, beach')) {
        return Promise.resolve({ rows: [{ nest_code: 'MG-2', status: 'incubating', relocated: false, beach: 'Makris Gialos', total_num_eggs: null, current_num_eggs: null, is_archived: false }] });
      }
      if (text.includes('UPDATE turtle_nests')) {
        return Promise.resolve({ rows: [{ id: 116, emergence_id: null, nest_code: 'MG-2', status: 'incubating' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await auth(request(app).put('/nests/116/update')).send(validNest);

    expect(res.status).toBe(200);
    expect(calls.some((c) => c.text.includes('UPDATE turtle_emergences'))).toBe(false);
  });
});
