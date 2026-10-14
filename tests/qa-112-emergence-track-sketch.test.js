// QA-112: the correction form for a sent-back emergence could not carry a track
// sketch - PUT /emergences/:id had no sketch field at all. It now accepts
// `track_sketch` (raw base64, or a data: URL whose prefix is stripped), and
// leaves the stored sketch alone when the field is absent or blank.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const coordinator = jwt.sign({ sub: '1', role: 'Project Coordinator', email: 'c@turtleguard.demo' }, SECRET, { expiresIn: '1h' });
const volunteer = jwt.sign({ sub: '12', role: 'Field Volunteer', email: 'v@turtleguard.demo' }, SECRET, { expiresIn: '1h' });

const sketchBytes = Buffer.from('fake-png-bytes-for-track');
const rawBase64 = sketchBytes.toString('base64');

let query;
beforeEach(() => {
  query = vi.spyOn(db, 'query').mockImplementation(async (sql) => {
    if (/UPDATE turtle_emergences/i.test(sql)) {
      return { rows: [{ id: 51, beach: 'Xi' }], rowCount: 1 };
    }
    if (/SELECT actor_id FROM record_audit/i.test(sql)) {
      return { rows: [{ actor_id: 12 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
});
afterAll(() => db.end().catch(() => {}));

const updateCall = () => query.mock.calls.find(([sql]) => /UPDATE turtle_emergences/i.test(sql));

describe('PUT /emergences/:id — track sketch (QA-112)', () => {
  it('stores a raw base64 sketch as bytes', async () => {
    const res = await request(app)
      .put('/emergences/51')
      .set('Authorization', `Bearer ${coordinator}`)
      .send({ track_sketch: rawBase64 });

    expect(res.status).toBe(200);
    const [sql, params] = updateCall();
    expect(sql).toContain('track_sketch      = COALESCE($7, track_sketch)');
    expect(Buffer.isBuffer(params[6])).toBe(true);
    expect(params[6].equals(sketchBytes)).toBe(true);
  });

  it('strips a data: URL prefix before decoding', async () => {
    await request(app)
      .put('/emergences/51')
      .set('Authorization', `Bearer ${coordinator}`)
      .send({ track_sketch: `data:image/png;base64,${rawBase64}` });

    const [, params] = updateCall();
    expect(params[6].equals(sketchBytes)).toBe(true);
  });

  it('leaves the stored sketch alone when no sketch is sent (absent or blank)', async () => {
    await request(app)
      .put('/emergences/51')
      .set('Authorization', `Bearer ${coordinator}`)
      .send({ has_track_sketch: false });

    const [, params] = updateCall();
    expect(params[6]).toBeNull();

    await request(app)
      .put('/emergences/51')
      .set('Authorization', `Bearer ${coordinator}`)
      .send({ track_sketch: '   ' });

    const [, blankParams] = query.mock.calls.filter(([sql]) => /UPDATE turtle_emergences/i.test(sql))[1];
    expect(blankParams[6]).toBeNull();
  });

  it('keeps the existing ownership check for a volunteer on someone else\'s emergence', async () => {
    query.mockImplementation(async (sql) => {
      if (/SELECT actor_id FROM record_audit/i.test(sql)) return { rows: [{ actor_id: 99 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(app)
      .put('/emergences/51')
      .set('Authorization', `Bearer ${volunteer}`)
      .send({ track_sketch: rawBase64 });

    expect(res.status).toBe(403);
    expect(updateCall()).toBeUndefined();
  });
});
