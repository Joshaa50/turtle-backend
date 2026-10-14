// QA-114: saving a re-sighting with tail measurements left blank overwrote the
// turtle's stored tail_extension / vent_to_tail_tip / total_tail_length with
// NULL, and the empty microchip/tag/identity strings the frontend sends on
// every re-sighting were written over stored values. A blank now means "not
// provided" on the profile update. The event row itself is not changed.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const token = jwt.sign({ sub: '49', role: 'Field Leader', email: 'x@turtleguard.demo' }, SECRET, { expiresIn: '1h' });

let query;
beforeEach(() => {
  query = vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    if (/UPDATE turtles/i.test(sql)) return { rows: [{ id: 7, name: 'Maria' }], rowCount: 1 };
    // The turtle Measurements group is required by default; a re-sighting that
    // leaves tail blank only gets this far once a coordinator has relaxed it.
    if (/FROM app_settings/i.test(sql) && params?.[0] === 'field_requirements') {
      return { rows: [{ value: { turtle: { measurements: 'recommended' } } }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
});
afterAll(() => db.end().catch(() => {}));

const updateCall = () => query.mock.calls.find(([sql]) => /UPDATE turtles/i.test(sql));

// Positional params of PUT /turtles/:id/update's UPDATE, in SQL order.
const P = { tail: 15, vent: 16, total: 17, id: 18, name: 19, species: 20, sex: 21 };

describe('PUT /turtles/:id/update — re-sighting does not wipe stored values (QA-114)', () => {
  it('keeps the stored tail measurements when they are left blank (absent)', async () => {
    const res = await request(app)
      .put('/turtles/7/update')
      .set('Authorization', `Bearer ${token}`)
      .send({ health_condition: 'Healthy', scl_max: 80, scl_min: 78, scw: 60 });

    expect(res.status).toBe(200);
    const [sql, params] = updateCall();
    expect(sql).toContain('tail_extension = COALESCE($16, tail_extension)');
    expect(sql).toContain('vent_to_tail_tip = COALESCE($17, vent_to_tail_tip)');
    expect(sql).toContain('total_tail_length = COALESCE($18, total_tail_length)');
    expect(params[P.tail]).toBeNull();
    expect(params[P.vent]).toBeNull();
    expect(params[P.total]).toBeNull();
  });

  it('treats empty-string tail measurements as not provided', async () => {
    await request(app)
      .put('/turtles/7/update')
      .set('Authorization', `Bearer ${token}`)
      .send({ health_condition: 'Healthy', tail_extension: '', vent_to_tail_tip: '  ', total_tail_length: '' });

    const [, params] = updateCall();
    expect(params[P.tail]).toBeNull();
    expect(params[P.vent]).toBeNull();
    expect(params[P.total]).toBeNull();
  });

  it('still writes a measured tail value through', async () => {
    await request(app)
      .put('/turtles/7/update')
      .set('Authorization', `Bearer ${token}`)
      .send({ health_condition: 'Healthy', tail_extension: 10, vent_to_tail_tip: 14, total_tail_length: 24 });

    const [, params] = updateCall();
    expect(params[P.tail]).toBe(10);
    expect(params[P.vent]).toBe(14);
    expect(params[P.total]).toBe(24);
  });

  it('does not overwrite stored name, species or sex with empty strings', async () => {
    await request(app)
      .put('/turtles/7/update')
      .set('Authorization', `Bearer ${token}`)
      .send({ health_condition: 'Healthy', name: '', species: '', sex: '' });

    const [sql, params] = updateCall();
    expect(sql).toContain('name = COALESCE($20, name)');
    expect(params[P.name]).toBeNull();
    expect(params[P.species]).toBeNull();
    expect(params[P.sex]).toBeNull();
  });

  it('keeps stored flipper tags when the re-sighting sends them empty', async () => {
    await request(app)
      .put('/turtles/7/update')
      .set('Authorization', `Bearer ${token}`)
      .send({ health_condition: 'Healthy', front_left_tag: '', front_right_tag: '' });

    const [sql, params] = updateCall();
    expect(sql).toContain("front_left_tag = COALESCE(NULLIF($2, ''), front_left_tag)");
    expect(params[1]).toBe('');
    expect(params[3]).toBe('');
  });

  it('does not touch the survey event row on a profile update', async () => {
    await request(app)
      .put('/turtles/7/update')
      .set('Authorization', `Bearer ${token}`)
      .send({ health_condition: 'Healthy', tail_extension: '' });

    expect(query.mock.calls.some(([sql]) => /turtle_survey_events/i.test(sql))).toBe(false);
  });
});
