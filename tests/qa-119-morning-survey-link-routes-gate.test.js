// QA-119: PATCH /morning-surveys/:id got an ownership gate (QA-113), but the
// two routes that attach a nest or emergence to a survey did not. A Field
// Volunteer could link records to any survey - someone else's, or her own
// after it was already approved - via a direct API call, even though the UI
// never exposes that path.
//
// Unlike PATCH, these routes are also used while a volunteer is still
// building her own submission (survey still 'pending', before any review
// decision, or with no review row at all if this record type needs none for
// her role) - so the gate only has to block "not her own" and "already
// approved", not require a 'rejected' status the way PATCH's correction-only
// gate does.
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

let ownerId; // actor_id record_audit reports for the survey's "created" entry
let reviewStatus; // record_reviews.status for the survey, or null for no row
let query;
const stubDb = () => {
  query = vi.spyOn(db, 'query').mockImplementation(async (sql) => {
    if (/FROM record_audit WHERE record_type/i.test(sql)) {
      return { rows: ownerId == null ? [] : [{ actor_id: ownerId }] };
    }
    if (/LEFT JOIN record_reviews/i.test(sql)) {
      return { rows: [{ id: 35, status: reviewStatus }] };
    }
    if (/FROM turtle_nests WHERE id/i.test(sql)) return { rows: [{ id: 999999 }], rowCount: 1 };
    if (/FROM turtle_emergences WHERE id/i.test(sql)) return { rows: [{ id: 174 }], rowCount: 1 };
    if (/INSERT INTO morning_survey_nests/i.test(sql)) return { rows: [{ survey_id: 35, nest_id: 999999 }], rowCount: 1 };
    if (/INSERT INTO morning_survey_emergences/i.test(sql)) return { rows: [{ survey_id: 35, emergence_id: 174 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
};

const linkNest = (token, id = 35) =>
  request(app)
    .post(`/morning-surveys/${id}/nests`)
    .set('Authorization', `Bearer ${token}`)
    .send({ nest_id: 999999 });

const linkEmergence = (token, id = 35) =>
  request(app)
    .post(`/morning-surveys/${id}/emergences`)
    .set('Authorization', `Bearer ${token}`)
    .send({ emergence_id: 174 });

const wasLinked = () => query.mock.calls.some(([sql]) => /INSERT INTO morning_survey_(nests|emergences)/i.test(sql));

beforeEach(() => {
  ownerId = null;
  reviewStatus = null;
  stubDb();
});

afterAll(() => db.end().catch(() => {}));

describe('POST /morning-surveys/:id/nests and /emergences — ownership gate (QA-119)', () => {
  it("refuses a volunteer linking a nest to a survey she did not submit", async () => {
    ownerId = '99';
    reviewStatus = 'pending';
    const res = await linkNest(volunteer());
    expect(res.status).toBe(403);
    expect(wasLinked()).toBe(false);
  });

  it('refuses a volunteer linking an emergence to her own already-approved survey', async () => {
    ownerId = '12';
    reviewStatus = 'approved';
    const res = await linkEmergence(volunteer());
    expect(res.status).toBe(403);
    expect(wasLinked()).toBe(false);
  });

  it('allows a volunteer to link a nest to her own survey while it is still pending (normal submission)', async () => {
    ownerId = '12';
    reviewStatus = 'pending';
    const res = await linkNest(volunteer());
    expect(res.status).toBe(201);
    expect(wasLinked()).toBe(true);
  });

  it('allows a volunteer to link an emergence to her own survey with no review row yet', async () => {
    ownerId = '12';
    reviewStatus = null;
    const res = await linkEmergence(volunteer());
    expect(res.status).toBe(201);
    expect(wasLinked()).toBe(true);
  });

  it('allows a volunteer to link a nest to her own sent-back (rejected) survey', async () => {
    ownerId = '12';
    reviewStatus = 'rejected';
    const res = await linkNest(volunteer());
    expect(res.status).toBe(201);
    expect(wasLinked()).toBe(true);
  });

  it('does not gate a Field Leader linking a nest to any survey', async () => {
    ownerId = '99';
    reviewStatus = 'approved';
    const res = await linkNest(tokenFor('Field Leader', '5'));
    expect(res.status).toBe(201);
    expect(wasLinked()).toBe(true);
  });

  it('does not gate a Project Coordinator linking an emergence', async () => {
    ownerId = '99';
    reviewStatus = 'approved';
    const res = await linkEmergence(tokenFor('Project Coordinator', '1'));
    expect(res.status).toBe(201);
    expect(wasLinked()).toBe(true);
  });
});
