// QA-070: a hatchling track (an EMERGENCE/HATCHING nest_event) logged by a
// Volunteer must move its nest from incubating to hatching - but only once a
// Field Leader approves the review, never when the event is merely created
// (an unreviewed submission must not change what a nest shows).
//
// These cases pin down:
//   - approving an emergence/hatching nest_event flips its nest to hatching,
//     and only when the nest is currently incubating (idempotent otherwise)
//   - approving a non-emergence nest_event (e.g. an inventory check) never
//     touches turtle_nests
//   - the same holds through /reviews/bulk-approve for a mixed batch
//   - a rejection never triggers the side effect, regardless of record type
//   - the transition is recorded in record_audit
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
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

// Builds a query mock that answers each statement shape the approval path
// touches, parameterised by the nest_event row and the nest's starting status.
const mockApprovalFlow = ({
  eventType = 'EMERGENCE',
  nestId = 90,
  nestStatus = 'incubating',
  nestCode = 'LG2-9',
} = {}) => {
  const calls = [];
  const impl = (sql, params) => {
    const text = String(sql);
    calls.push({ text, params });

    if (text.includes('UPDATE record_reviews') && params?.[0] === 'approved') {
      return Promise.resolve({ rows: [{ id: 5, record_type: 'nest_event', record_id: 11 }] });
    }
    if (text.includes('SELECT event_type, nest_id FROM turtle_nest_events')) {
      return Promise.resolve({ rows: [{ event_type: eventType, nest_id: nestId }] });
    }
    if (text.includes("SELECT nest_code, status FROM turtle_nests") && text.includes("status = 'incubating'")) {
      return nestStatus === 'incubating'
        ? Promise.resolve({ rows: [{ nest_code: nestCode, status: 'incubating' }] })
        : Promise.resolve({ rows: [] });
    }
    if (text.includes("UPDATE turtle_nests SET status = 'hatching'")) {
      return Promise.resolve({ rows: [{ nest_code: nestCode }] });
    }
    if (text.includes('INSERT INTO record_audit')) {
      return Promise.resolve({ rows: [{ id: 1 }] });
    }
    // REVIEW_SELECT, describeReviewedRecords label lookups, etc.
    return Promise.resolve({ rows: [] });
  };
  const query = vi.spyOn(db, 'query').mockImplementation(impl);
  return { query, calls };
};

const wroteNestHatching = (calls) =>
  calls.some((c) => c.text.includes("UPDATE turtle_nests SET status = 'hatching'"));

const wroteNestAudit = (calls) =>
  calls.some(
    (c) =>
      c.text.includes('INSERT INTO record_audit') &&
      c.params?.[0] === 'nest' &&
      c.params?.[2] === 'updated'
  );

describe('approving a nest_event side effect (QA-070)', () => {
  it('moves an incubating nest to hatching when an EMERGENCE review is approved', async () => {
    const { calls } = mockApprovalFlow({ eventType: 'EMERGENCE', nestStatus: 'incubating' });

    const res = await asLeader(request(app).post('/reviews/5/approve')).send({});

    expect(res.status).toBe(200);
    expect(wroteNestHatching(calls)).toBe(true);
    expect(wroteNestAudit(calls)).toBe(true);
  });

  it('moves an incubating nest to hatching when a HATCHING review is approved', async () => {
    const { calls } = mockApprovalFlow({ eventType: 'HATCHING', nestStatus: 'incubating' });

    const res = await asLeader(request(app).post('/reviews/5/approve')).send({});

    expect(res.status).toBe(200);
    expect(wroteNestHatching(calls)).toBe(true);
  });

  it('does not touch turtle_nests for a non-emergence nest_event (e.g. INVENTORY)', async () => {
    const { calls } = mockApprovalFlow({ eventType: 'INVENTORY', nestStatus: 'incubating' });

    const res = await asLeader(request(app).post('/reviews/5/approve')).send({});

    expect(res.status).toBe(200);
    expect(wroteNestHatching(calls)).toBe(false);
    expect(wroteNestAudit(calls)).toBe(false);
  });

  it('is idempotent: a nest already hatching is not re-updated or re-audited', async () => {
    const { calls } = mockApprovalFlow({ eventType: 'EMERGENCE', nestStatus: 'hatching' });

    const res = await asLeader(request(app).post('/reviews/5/approve')).send({});

    expect(res.status).toBe(200);
    expect(wroteNestHatching(calls)).toBe(false);
    expect(wroteNestAudit(calls)).toBe(false);
  });

  it('never triggers the side effect on a rejection, regardless of record type', async () => {
    const calls = [];
    vi.spyOn(db, 'query').mockImplementation((sql, params) => {
      const text = String(sql);
      calls.push({ text, params });
      if (text.includes('UPDATE record_reviews') && params?.[0] === 'rejected') {
        return Promise.resolve({ rows: [{ id: 5, record_type: 'nest_event', record_id: 11 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await asLeader(request(app).post('/reviews/5/reject')).send({ note: 'Wrong beach.' });

    expect(res.status).toBe(200);
    expect(calls.some((c) => c.text.includes('SELECT event_type, nest_id FROM turtle_nest_events'))).toBe(false);
    expect(wroteNestHatching(calls)).toBe(false);
  });

  describe('via /reviews/bulk-approve', () => {
    it('applies the transition only for the emergence row in a mixed batch', async () => {
      const calls = [];
      vi.spyOn(db, 'query').mockImplementation((sql, params) => {
        const text = String(sql);
        calls.push({ text, params });

        if (text.includes('UPDATE record_reviews') && text.includes("'approved'")) {
          return Promise.resolve({
            rows: [
              { id: 5, record_type: 'nest_event', record_id: 11 }, // emergence
              { id: 6, record_type: 'nest_event', record_id: 12 }, // inventory
            ],
          });
        }
        if (text.includes('SELECT event_type, nest_id FROM turtle_nest_events')) {
          const id = params[0];
          if (id === 11) return Promise.resolve({ rows: [{ event_type: 'EMERGENCE', nest_id: 90 }] });
          return Promise.resolve({ rows: [{ event_type: 'INVENTORY', nest_id: 91 }] });
        }
        if (text.includes("SELECT nest_code, status FROM turtle_nests") && text.includes("status = 'incubating'")) {
          return Promise.resolve({ rows: [{ nest_code: 'LG2-9', status: 'incubating' }] });
        }
        if (text.includes("UPDATE turtle_nests SET status = 'hatching'")) {
          return Promise.resolve({ rows: [{ nest_code: 'LG2-9' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const res = await asLeader(request(app).post('/reviews/bulk-approve')).send({ ids: [5, 6] });

      expect(res.status).toBe(200);
      const hatchingUpdates = calls.filter((c) => c.text.includes("UPDATE turtle_nests SET status = 'hatching'"));
      expect(hatchingUpdates).toHaveLength(1);
      expect(hatchingUpdates[0].params[0]).toBe(90);
    });
  });
});
