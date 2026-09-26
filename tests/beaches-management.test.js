import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const tokenFor = (role) =>
  jwt.sign({ sub: '1', role, email: 'u@example.com' }, SECRET, { expiresIn: '1h' });

let query;
beforeEach(() => {
  query = vi.spyOn(db, 'query').mockRejectedValue(new Error('unstubbed db.query'));
});
afterAll(() => db.end().catch(() => {}));

const valid = { name: 'Skala North', code: 'SKN', station: 'East', survey_area: 'Skala' };

// Beaches were fixed rows loaded once for one project, so no other
// organisation could add its own sites without editing the database by hand.
describe('beach management', () => {
  describe('who may change the site list', () => {
    it.each(['Field Volunteer', 'Field Assistant'])('refuses %s', async (role) => {
      const res = await request(app).post('/beaches').set('Authorization', `Bearer ${tokenFor(role)}`).send(valid);
      expect(res.status).toBe(403);
      expect(query).not.toHaveBeenCalled();
    });

    it.each(['Project Coordinator', 'Field Leader'])('allows %s', async (role) => {
      query.mockResolvedValue({ rows: [{ id: 14, ...valid, is_active: true }] });
      const res = await request(app).post('/beaches').set('Authorization', `Bearer ${tokenFor(role)}`).send(valid);
      expect(res.status).toBe(201);
    });

    it('refuses an unauthenticated caller', async () => {
      const res = await request(app).post('/beaches').send(valid);
      expect(res.status).toBe(401);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('the code that prefixes every nest at the beach', () => {
    const post = (body) =>
      request(app).post('/beaches').set('Authorization', `Bearer ${tokenFor('Project Coordinator')}`).send(body);

    it.each([
      ['missing', { ...valid, code: '' }],
      ['too long', { ...valid, code: 'ABCDEFGHI' }],
      ['punctuation', { ...valid, code: 'LG-2' }],
    ])('rejects a code that is %s', async (_why, body) => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(query).not.toHaveBeenCalled();
    });

    it('upper-cases the code so lg2 and LG2 cannot both exist', async () => {
      query.mockResolvedValue({ rows: [{ id: 1 }] });
      await post({ ...valid, code: 'skn' });
      expect(query.mock.calls[0][1][1]).toBe('SKN');
    });

    it('reports a duplicate code as a conflict, not a server error', async () => {
      query.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
      const res = await post(valid);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already in use/i);
    });
  });

  it.each([['name'], ['station'], ['survey_area']])('requires %s', async (field) => {
    const res = await request(app)
      .post('/beaches')
      .set('Authorization', `Bearer ${tokenFor('Field Leader')}`)
      .send({ ...valid, [field]: '   ' });
    expect(res.status).toBe(400);
  });

  it('retires a beach with is_active alone, without demanding a full body', async () => {
    query.mockResolvedValue({ rows: [{ id: 3, ...valid, is_active: false }] });
    const res = await request(app)
      .patch('/beaches/3')
      .set('Authorization', `Bearer ${tokenFor('Field Leader')}`)
      .send({ is_active: false });
    expect(res.status).toBe(200);
    expect(res.body.beach.is_active).toBe(false);
  });

  it('will not delete a beach, because its nests reference it by name', async () => {
    const res = await request(app)
      .delete('/beaches/3')
      .set('Authorization', `Bearer ${tokenFor('Project Coordinator')}`);
    expect(res.status).toBe(405);
    expect(res.body.error).toMatch(/retired, not deleted/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('404s when patching a beach that does not exist', async () => {
    query.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .patch('/beaches/999')
      .set('Authorization', `Bearer ${tokenFor('Field Leader')}`)
      .send(valid);
    expect(res.status).toBe(404);
  });

  it('serves the stations and areas actually in use', async () => {
    query.mockResolvedValue({ rows: [{ stations: ['East', 'West'], survey_areas: ['Skala'] }] });
    const res = await request(app).get('/beaches/groupings').set('Authorization', `Bearer ${tokenFor('Field Volunteer')}`);
    expect(res.status).toBe(200);
    expect(res.body.stations).toEqual(['East', 'West']);
    expect(res.body.survey_areas).toEqual(['Skala']);
  });
});
