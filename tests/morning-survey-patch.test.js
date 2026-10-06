// Regression: a morning survey's corner GPS had no way to be corrected after
// submission (no PATCH route existed), and POST /morning-surveys stored
// tl_lat/tl_long/tr_lat/tr_long with no range check at all - a QA pass found
// real demo records sitting on London coordinates (51.75, -0.34) that nothing
// in the API would have refused on the way in, and nothing let a coordinator
// fix on the way out.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const tokenFor = (role) =>
  jwt.sign({ sub: '48', role, email: 'sofia.manthou@turtleguard.demo' }, SECRET, { expiresIn: '1h' });

const coordinatorToken = tokenFor('Project Coordinator');
const strangerToken = tokenFor('Beach Visitor');

let query;

beforeEach(() => {
  query = vi.spyOn(db, 'query').mockResolvedValue({
    rows: [{ id: 35, beach: 'Vrakhinari', tl_lat: '38.16200', tl_long: '20.37760' }],
    rowCount: 1,
  });
});

afterAll(() => db.end().catch(() => {}));

describe('PATCH /morning-surveys/:id', () => {
  it('corrects a submitted survey\'s corner GPS', async () => {
    const res = await request(app)
      .patch('/morning-surveys/35')
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ tl_lat: '38.16200', tl_long: '20.37760', tr_lat: '38.16213', tr_long: '20.37755' });

    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE morning_surveys'),
      expect.arrayContaining(['38.16200', '20.37760', '38.16213', '20.37755']),
    );
  });

  it('leaves fields the caller did not send untouched (COALESCE, not overwrite)', async () => {
    await request(app)
      .patch('/morning-surveys/35')
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ tl_lat: '38.16200' });

    const [, params] = query.mock.calls[0];
    // Only tl_lat was sent - everything else should be the null that COALESCE skips.
    expect(params[1]).toBeNull(); // tl_long
    expect(params[2]).toBeNull(); // tr_lat
  });

  it('rejects an out-of-range latitude instead of storing it', async () => {
    const res = await request(app)
      .patch('/morning-surveys/35')
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ tl_lat: '900' });

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('404s when the survey does not exist', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .patch('/morning-surveys/999999')
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ tl_lat: '38.16200' });

    expect(res.status).toBe(404);
  });

  it('refuses a caller with no recognised role, without touching the table', async () => {
    const res = await request(app)
      .patch('/morning-surveys/35')
      .set('Authorization', `Bearer ${strangerToken}`)
      .send({ tl_lat: '38.16200' });

    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  // QA-031: a send-back for "times look too short" was previously impossible
  // to act on - the edit form had no time fields because this route silently
  // ignored them. Covers the fix end to end on the route itself.
  it('corrects a submitted survey\'s start/end time', async () => {
    const res = await request(app)
      .patch('/morning-surveys/35')
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ start_time: '06:10', end_time: '07:45' });

    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE morning_surveys'),
      expect.arrayContaining(['06:10', '07:45']),
    );
  });

  it('rejects an end time that is not after the start time', async () => {
    const res = await request(app)
      .patch('/morning-surveys/35')
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ start_time: '07:45', end_time: '06:10' });

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('POST /morning-surveys range validation', () => {
  const baseSurvey = {
    survey_date: '2026-08-30',
    start_time: '10:25',
    end_time: '11:45',
    beach_id: 1,
    protected_nest_count: 0,
  };

  it('rejects a corner latitude outside -90..90', async () => {
    const res = await request(app)
      .post('/morning-surveys')
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ ...baseSurvey, tl_lat: '900', tl_long: '20.6' });

    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO morning_surveys'), expect.anything());
  });

  it('still accepts a survey with plausible coordinates', async () => {
    const res = await request(app)
      .post('/morning-surveys')
      .set('Authorization', `Bearer ${coordinatorToken}`)
      .send({ ...baseSurvey, tl_lat: '38.16200', tl_long: '20.37760' });

    expect(res.status).toBe(201);
  });
});
