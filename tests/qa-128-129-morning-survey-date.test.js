// QA-128: POST /morning-surveys accepted a survey_date in the future - every
// other date field in the app (nest found, turtle sighting, nest event)
// already rejects one server-side, and the client's own future-time check
// only applies when the date is today, so a future date skipped it entirely.
//
// QA-129: PATCH /morning-surveys/:id silently ignored survey_date, so a
// reviewer who sent a survey back specifically to get its date fixed got a
// 200 "Survey updated successfully" with nothing actually changed - there
// was no way to act on that kind of send-back at all.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const coordinatorToken = jwt.sign({ sub: '48', role: 'Project Coordinator', email: 'sofia@turtleguard.demo' }, SECRET, { expiresIn: '1h' });

const tomorrow = () => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const today = () => new Date().toISOString().slice(0, 10);

let query;
beforeEach(() => {
  query = vi.spyOn(db, 'query').mockResolvedValue({
    rows: [{ id: 151, beach: 'Makris Gialos', survey_date: today() }],
    rowCount: 1,
  });
});
afterAll(() => db.end().catch(() => {}));

describe('POST /morning-surveys rejects a future survey_date (QA-128)', () => {
  const baseSurvey = {
    start_time: '06:10',
    end_time: '06:30',
    beach_id: 14,
  };

  it('rejects a survey dated tomorrow, without writing it', async () => {
    const res = await request(app)
      .post('/morning-surveys')
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ ...baseSurvey, survey_date: tomorrow() });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/survey date.*cannot be in the future/i);
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO morning_surveys'), expect.anything());
  });

  it('still accepts a survey dated today', async () => {
    const res = await request(app)
      .post('/morning-surveys')
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ ...baseSurvey, survey_date: today() });

    expect(res.status).toBe(201);
  });
});

describe('PATCH /morning-surveys/:id can correct survey_date (QA-129)', () => {
  it('applies a corrected survey_date', async () => {
    const res = await request(app)
      .patch('/morning-surveys/151')
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ survey_date: today() });

    expect(res.status).toBe(200);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('survey_date          = COALESCE($9, survey_date)');
    expect(params[8]).toBe(today());
  });

  it('leaves survey_date untouched when not sent (COALESCE, not overwrite)', async () => {
    await request(app)
      .patch('/morning-surveys/151')
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ start_time: '06:10', end_time: '06:30' });

    const [, params] = query.mock.calls[0];
    expect(params[8]).toBeNull();
  });

  it('rejects correcting the date to one in the future', async () => {
    const res = await request(app)
      .patch('/morning-surveys/151')
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ survey_date: tomorrow() });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/survey date.*cannot be in the future/i);
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE morning_surveys'), expect.anything());
  });
});
