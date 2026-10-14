// QA-113: a Field Volunteer could PATCH any morning survey, including approved
// ones and ones she did not submit, and the approved review stayed 'approved'.
// A volunteer may now correct a survey only when it is her own AND its review
// row is currently 'rejected' (sent back for correction).
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const tokenFor = (role, sub = '12') =>
  jwt.sign({ sub, role, email: 'someone@turtleguard.demo' }, SECRET, { expiresIn: '1h' });

const VOLUNTEER = 'Field Volunteer';
const volunteer = () => tokenFor(VOLUNTEER, '12');

// The gate query is the one that joins record_reviews; everything else
// (the UPDATE, the audit insert, the settings lookups) gets a generic reply.
let gateRow;
let query;
const stubDb = () => {
  query = vi.spyOn(db, 'query').mockImplementation(async (sql) => {
    if (/LEFT JOIN record_reviews/i.test(sql)) {
      return { rows: gateRow ? [gateRow] : [], rowCount: gateRow ? 1 : 0 };
    }
    if (/UPDATE morning_surveys/i.test(sql)) {
      return { rows: [{ id: 35, tl_lat: '38.16200' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
};

const patch = (token, id = 35) =>
  request(app)
    .patch(`/morning-surveys/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ tl_lat: '38.16200', tl_long: '20.37760' });

const wasUpdated = () => query.mock.calls.some(([sql]) => /UPDATE morning_surveys/i.test(sql));

beforeEach(() => {
  gateRow = null;
  stubDb();
});

afterAll(() => db.end().catch(() => {}));

describe('PATCH /morning-surveys/:id — Field Volunteer gate (QA-113)', () => {
  it('lets a volunteer correct her own survey while it is sent back (rejected)', async () => {
    gateRow = { id: 35, status: 'rejected', submitted_by: 12 };
    const res = await patch(volunteer());
    expect(res.status).toBe(200);
    expect(wasUpdated()).toBe(true);
  });

  it('refuses a volunteer editing her own survey once it is approved', async () => {
    gateRow = { id: 35, status: 'approved', submitted_by: 12 };
    const res = await patch(volunteer());
    expect(res.status).toBe(403);
    expect(wasUpdated()).toBe(false);
  });

  it('refuses a volunteer editing her own survey while it is still pending', async () => {
    gateRow = { id: 35, status: 'pending', submitted_by: 12 };
    const res = await patch(volunteer());
    expect(res.status).toBe(403);
    expect(wasUpdated()).toBe(false);
  });

  it('refuses a volunteer editing a rejected survey she did not submit', async () => {
    gateRow = { id: 35, status: 'rejected', submitted_by: 99 };
    const res = await patch(volunteer());
    expect(res.status).toBe(403);
    expect(wasUpdated()).toBe(false);
  });

  it('refuses a volunteer on a survey with no review row at all', async () => {
    gateRow = { id: 35, status: null, submitted_by: null };
    const res = await patch(volunteer());
    expect(res.status).toBe(403);
    expect(wasUpdated()).toBe(false);
  });

  it('still answers 404 for an unknown survey id, even for a volunteer', async () => {
    gateRow = null;
    const res = await patch(volunteer(), 999999);
    expect(res.status).toBe(404);
    expect(wasUpdated()).toBe(false);
  });

  it('does not gate a Field Leader: an approved survey is still correctable', async () => {
    gateRow = { id: 35, status: 'approved', submitted_by: 99 };
    const res = await patch(tokenFor('Field Leader', '5'));
    expect(res.status).toBe(200);
    expect(wasUpdated()).toBe(true);
  });

  it('does not gate a Project Coordinator', async () => {
    gateRow = { id: 35, status: 'approved', submitted_by: 99 };
    const res = await patch(tokenFor('Project Coordinator', '1'));
    expect(res.status).toBe(200);
    expect(wasUpdated()).toBe(true);
  });

  it('applies the same gate to a Field Assistant (not just a volunteer)', async () => {
    gateRow = { id: 35, status: 'approved', submitted_by: '12' };
    const res = await patch(tokenFor('Field Assistant', '12'));
    expect(res.status).toBe(403);
    expect(wasUpdated()).toBe(false);
  });
});
