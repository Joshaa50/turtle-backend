// Regression: POST /morning-surveys had no requireRole guard at all, while every
// other field-record write picked up RECORDERS in the same round.
//
// The product decision is that a Field Volunteer may submit field records,
// morning surveys included - Morning Survey is in the sidebar for every role
// (components/Sidebar.tsx has no Field Volunteer gate on it) and that is
// intentional. So what this file pins is that the survey routes carry the same
// RECORDERS guard as the rest: a volunteer's survey is accepted and actually
// stored, while a caller with no token or an unrecognised role is refused
// instead of writing straight to the table.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const tokenFor = (role) =>
  jwt.sign({ sub: '51', role, email: 'someone@turtleguard.demo' }, SECRET, { expiresIn: '1h' });

const volunteerToken = tokenFor('Field Volunteer');
// A role no guard lists - stands in for a token whose role claim the server
// does not recognise.
const strangerToken = tokenFor('Beach Visitor');

let query;

beforeEach(() => {
  // Stubbed so the routes get past their own lookups and the only thing that
  // could stop them is a role guard.
  query = vi.spyOn(db, 'query').mockResolvedValue({ rows: [{ id: 28 }] });
  vi.spyOn(db, 'connect').mockResolvedValue({
    query: vi.fn().mockResolvedValue({ rows: [{ id: 28 }] }),
    release: vi.fn(),
  });
});

afterAll(() => db.end().catch(() => {}));

const survey = {
  survey_date: '2026-08-30',
  start_time: '10:25',
  end_time: '11:45',
  beach_id: 1,
  tl_lat: '38.12345',
  tl_long: '20.61234',
  tr_lat: '38.12399',
  tr_long: '20.61299',
  protected_nest_count: 0,
  notes: 'QA-volunteer-gate-check',
};

describe('Field Volunteer — morning survey writes', () => {
  it('can record a morning survey, and it is stored', async () => {
    const res = await request(app)
      .post('/morning-surveys')
      .set('Authorization', `Bearer ${volunteerToken}`)
      .send(survey);

    expect(res.status).toBe(201);
    // Accepted is not enough - the row has to have been written.
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO morning_surveys'),
      expect.arrayContaining([survey.survey_date, survey.notes]),
    );
  });

  it('can attach a nest to a morning survey', async () => {
    const res = await request(app)
      .post('/morning-surveys/28/nests')
      .set('Authorization', `Bearer ${volunteerToken}`)
      .send({ nest_id: 43 });

    expect(res.status).toBeLessThan(400);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO morning_survey_nests'),
      expect.arrayContaining([43]),
    );
  });

  it('can attach an emergence to a morning survey', async () => {
    const res = await request(app)
      .post('/morning-surveys/28/emergences')
      .set('Authorization', `Bearer ${volunteerToken}`)
      .send({ emergence_id: 59 });

    expect(res.status).toBeLessThan(400);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO morning_survey_emergences'),
      expect.arrayContaining([59]),
    );
  });
});

describe('morning survey writes still need a recognised role', () => {
  it('refuses a caller with no token, without touching the table', async () => {
    const res = await request(app).post('/morning-surveys').send(survey);

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses a role that is not one of the recorders', async () => {
    const res = await request(app)
      .post('/morning-surveys')
      .set('Authorization', `Bearer ${strangerToken}`)
      .send(survey);

    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('Field Volunteer — morning survey guard does not over-block', () => {
  for (const role of ['Project Coordinator', 'Field Leader', 'Field Assistant']) {
    it(`still lets a ${role} record a morning survey`, async () => {
      const res = await request(app)
        .post('/morning-surveys')
        .set('Authorization', `Bearer ${tokenFor(role)}`)
        .send(survey);

      expect(res.status).toBeLessThan(400);
    });
  }
});
