// QA-106: a FULL/PARTIAL_INVENTORY nest_event hit the same gap QA-092 closed
// for hatchling tracks - nothing checked the nest's date_found before an
// excavation event was created, so a final inventory logged minutes after a
// nest was laid flipped it straight to "hatched" (for a role that needs no
// review) and counted its hatchlings in /public/stats and the season report.
// hatchlingTrackTooEarlyError now covers excavation types too (not just
// EMERGENCE/HATCHING); these cases pin:
//   - POST /nest-events/create rejects a FULL_INVENTORY logged too soon
//     after the nest's date_found, before any INSERT runs
//   - POST /nest-events/create still succeeds for a plausible timeline
//   - PUT /nest-events/:id rejects the same implausible timing on an edit
//   - applyApprovalSideEffects refuses to flip nest status for an
//     already-existing too-early inventory event that somehow reaches approval
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

describe('nest inventory timing plausibility (QA-106)', () => {
  it('rejects a POST creating a FULL_INVENTORY on a nest laid today, without inserting', async () => {
    const calls = [];
    vi.spyOn(db, 'query').mockImplementation((sql) => {
      const text = String(sql);
      calls.push(text);
      if (text.includes('FROM turtle_nests n') && text.includes('WHERE n.nest_code')) {
        return Promise.resolve({
          rows: [{ id: 96, date_found: daysAgo(0), total_num_eggs: null, emerged_so_far: 0 }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await asLeader(request(app).post('/nest-events/create')).send({
      event_type: 'FULL_INVENTORY', nest_code: 'LG3-4', alive_above: 80, helped_to_sea: 80,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not plausible/i);
    expect(calls.some((t) => t.includes('INSERT INTO turtle_nest_events'))).toBe(false);
  });

  it('still succeeds creating a FULL_INVENTORY on a nest laid 50 days ago', async () => {
    vi.spyOn(db, 'query').mockImplementation((sql) => {
      const text = String(sql);
      if (text.includes('FROM turtle_nests n') && text.includes('WHERE n.nest_code')) {
        return Promise.resolve({
          rows: [{ id: 96, date_found: daysAgo(50), total_num_eggs: 100, emerged_so_far: 0 }],
        });
      }
      if (text.includes('INSERT INTO turtle_nest_events')) {
        return Promise.resolve({
          rows: [{ id: 12, event_type: 'FULL_INVENTORY', nest_id: 96, nest_code: 'LG3-4' }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await asLeader(request(app).post('/nest-events/create')).send({
      event_type: 'FULL_INVENTORY', nest_code: 'LG3-4', alive_above: 80, helped_to_sea: 80,
    });

    expect(res.status).toBe(200);
  });

  it('rejects a PUT changing a PARTIAL_INVENTORY on an event tied to a nest laid today', async () => {
    vi.spyOn(db, 'query').mockImplementation((sql) => {
      const text = String(sql);
      if (text.includes('FROM turtle_nests n') && text.includes('WHERE n.id')) {
        return Promise.resolve({
          rows: [{ date_found: daysAgo(0), total_num_eggs: 100, emerged_so_far: 0 }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await asLeader(request(app).put('/nest-events/96')).send({
      event_type: 'PARTIAL_INVENTORY', nest_id: 96, nest_code: 'LG3-4', eggs_reburied: 50, total_eggs: 100,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not plausible/i);
  });

  it('refuses the hatched transition on approval when the inventory event is already too early (defensive guard)', async () => {
    const calls = [];
    vi.spyOn(db, 'query').mockImplementation((sql, params) => {
      const text = String(sql);
      calls.push({ text, params });

      if (text.includes('UPDATE record_reviews') && params?.[0] === 'approved') {
        return Promise.resolve({ rows: [{ id: 6, record_type: 'nest_event', record_id: 12 }] });
      }
      if (text.includes('FROM turtle_nest_events e')) {
        return Promise.resolve({
          rows: [{
            event_type: 'FULL_INVENTORY',
            nest_id: 96,
            eggs_reburied: 0,
            total_eggs: 0,
            created_at: new Date(),
            date_found: daysAgo(0),
          }],
        });
      }
      if (text.includes('SELECT nest_code, status FROM turtle_nests') && text.includes('status = ANY')) {
        return Promise.resolve({ rows: [{ nest_code: 'LG3-4', status: 'incubating' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await asLeader(request(app).post('/reviews/6/approve')).send({});

    expect(res.status).toBe(200);
    expect(calls.some((c) => c.text.includes('UPDATE turtle_nests SET status = $2'))).toBe(false);
  });
});
