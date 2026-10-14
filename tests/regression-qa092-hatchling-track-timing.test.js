// QA-092: a hatchling track (EMERGENCE/HATCHING nest_event) could be logged
// against a nest laid only days ago. Nothing checked the nest's date_found
// before the event was created, so the submission alone flipped the nest to
// "hatching" (for a role that needs no review) and padded the hatchling
// counts that /public/stats and the season report sum unconditionally from
// every EMERGENCE/HATCHING row. These cases pin down:
//   - POST /nest-events/create rejects a hatchling track logged too soon
//     after the nest's date_found, before any INSERT runs
//   - POST /nest-events/create still succeeds for a plausible timeline
//   - PUT /nest-events/:id rejects the same implausible timing on an edit
//   - applyApprovalSideEffects refuses to flip nest status for an
//     already-existing too-early event that somehow reaches approval
import { describe, it, expect, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const tokenFor = (role, sub) =>
  jwt.sign({ sub, role, email: `${sub}@turtleguard.demo` }, SECRET, { expiresIn: '1h' });

const LEADER = tokenFor('Field Leader', '7');
const asLeader = (req) => req.set('Authorization', `Bearer ${LEADER}`);

afterAll(() => db.end().catch(() => {}));

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

describe('hatchling track timing plausibility (QA-092)', () => {
  it('rejects a POST creating an EMERGENCE track on a nest laid only 5 days ago, without inserting', async () => {
    const calls = [];
    vi.spyOn(db, 'query').mockImplementation((sql) => {
      const text = String(sql);
      calls.push(text);
      if (text.includes('FROM turtle_nests n') && text.includes('WHERE n.nest_code')) {
        return Promise.resolve({
          rows: [{ id: 90, date_found: daysAgo(5), total_num_eggs: 100, emerged_so_far: 0 }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await asLeader(request(app).post('/nest-events/create')).send({
      event_type: 'EMERGENCE', nest_code: 'LG2-9', tracks_to_sea: 2, tracks_lost: 0,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not plausible/i);
    expect(calls.some((t) => t.includes('INSERT INTO turtle_nest_events'))).toBe(false);
  });

  it('still succeeds creating an EMERGENCE track on a nest laid 50 days ago', async () => {
    vi.spyOn(db, 'query').mockImplementation((sql) => {
      const text = String(sql);
      if (text.includes('FROM turtle_nests n') && text.includes('WHERE n.nest_code')) {
        return Promise.resolve({
          rows: [{ id: 90, date_found: daysAgo(50), total_num_eggs: 100, emerged_so_far: 0 }],
        });
      }
      if (text.includes('INSERT INTO turtle_nest_events')) {
        return Promise.resolve({
          rows: [{ id: 11, event_type: 'EMERGENCE', nest_id: 90, nest_code: 'LG2-9' }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await asLeader(request(app).post('/nest-events/create')).send({
      event_type: 'EMERGENCE', nest_code: 'LG2-9', tracks_to_sea: 2, tracks_lost: 0,
    });

    expect(res.status).toBe(200);
  });

  it('rejects a PUT changing tracks_to_sea on an event tied to a nest laid only 5 days ago', async () => {
    vi.spyOn(db, 'query').mockImplementation((sql) => {
      const text = String(sql);
      if (text.includes('FROM turtle_nests n') && text.includes('WHERE n.id')) {
        return Promise.resolve({
          rows: [{ date_found: daysAgo(5), total_num_eggs: 100, emerged_so_far: 0 }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await asLeader(request(app).put('/nest-events/119')).send({
      event_type: 'EMERGENCE', nest_id: 90, nest_code: 'LG2-9', tracks_to_sea: 3, tracks_lost: 0,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not plausible/i);
  });

  it('refuses the hatching transition on approval when the event is already too early (defensive guard)', async () => {
    const calls = [];
    vi.spyOn(db, 'query').mockImplementation((sql, params) => {
      const text = String(sql);
      calls.push({ text, params });

      if (text.includes('UPDATE record_reviews') && params?.[0] === 'approved') {
        return Promise.resolve({ rows: [{ id: 5, record_type: 'nest_event', record_id: 11 }] });
      }
      if (text.includes('FROM turtle_nest_events e')) {
        return Promise.resolve({
          rows: [{
            event_type: 'EMERGENCE',
            nest_id: 90,
            eggs_reburied: null,
            total_eggs: null,
            created_at: new Date(),
            date_found: daysAgo(5),
          }],
        });
      }
      if (text.includes('SELECT nest_code, status FROM turtle_nests') && text.includes('status = ANY')) {
        return Promise.resolve({ rows: [{ nest_code: 'LG2-9', status: 'incubating' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await asLeader(request(app).post('/reviews/5/approve')).send({});

    expect(res.status).toBe(200);
    expect(calls.some((c) => c.text.includes('UPDATE turtle_nests SET status = $2'))).toBe(false);
  });
});
