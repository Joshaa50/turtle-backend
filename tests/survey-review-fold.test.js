// A morning survey is reviewed as one form. The nests and emergences recorded
// on it are created (and queued) one by one before being linked to the survey,
// so linking must fold them into the survey's review rather than leave each as
// a separate item for the Field Leader.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const asVolunteer = (req) =>
  req.set('Authorization', `Bearer ${jwt.sign({ sub: '51', role: 'Field Volunteer', email: 'v@turtleguard.demo' }, SECRET, { expiresIn: '1h' })}`);

let query;
beforeEach(() => {
  query = vi.spyOn(db, 'query').mockResolvedValue({ rows: [{ id: 1 }] });
});
afterAll(() => db.end().catch(() => {}));

const folded = () => query.mock.calls.filter(([sql]) => String(sql).includes('DELETE FROM record_reviews'));

describe('folding survey children into the survey review', () => {
  it('drops a linked emergence\'s own pending review, only while the survey is under review', async () => {
    const res = await asVolunteer(request(app).post('/morning-surveys/7/emergences')).send({ emergence_id: 12 });
    expect(res.status).toBe(201);
    const [call] = folded();
    expect(call).toBeDefined();
    expect(String(call[0])).toContain("status = 'pending'");
    expect(String(call[0])).toContain("s.record_type = 'morning_survey'");
    expect(call[1]).toEqual(['7', 'emergence', 12]);
  });

  it('does the same for a linked nest', async () => {
    const res = await asVolunteer(request(app).post('/morning-surveys/7/nests')).send({ nest_id: 30 });
    expect(res.status).toBe(201);
    expect(folded()[0][1]).toEqual(['7', 'nest', 30]);
  });

  it('never deletes a decided review (pending only)', async () => {
    await asVolunteer(request(app).post('/morning-surveys/7/nests')).send({ nest_id: 30 });
    expect(String(folded()[0][0])).toContain("status = 'pending'");
  });

  it('still links the record when folding fails', async () => {
    query.mockImplementation(async (sql) => {
      if (String(sql).includes('DELETE FROM record_reviews')) throw new Error('boom');
      return { rows: [{ id: 1 }] };
    });
    const res = await asVolunteer(request(app).post('/morning-surveys/7/emergences')).send({ emergence_id: 12 });
    expect(res.status).toBe(201);
  });

  it('does not fold when the link itself is refused', async () => {
    const res = await asVolunteer(request(app).post('/morning-surveys/7/emergences')).send({});
    expect(res.status).toBe(400);
    expect(folded()).toHaveLength(0);
  });
});
