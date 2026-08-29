import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const tokenFor = (over = {}) =>
  jwt.sign({ sub: '1', role: 'Volunteer', email: 'v@example.com', ...over }, SECRET, {
    expiresIn: '1h',
  });

// The pool is real but never connects as long as nothing calls through to it.
// Any test that reaches a DB route must stub this, so an unstubbed route
// failing loudly is the intended behaviour, not a gap.
let query;
beforeEach(() => {
  query = vi.spyOn(db, 'query').mockRejectedValue(
    new Error('db.query called without a stub in this test'),
  );
});
afterAll(() => db.end().catch(() => {}));

describe('requireAuth — closed by default', () => {
  it('rejects a protected route with no token', async () => {
    const res = await request(app).get('/turtles');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/authentication required/i);
    expect(query).not.toHaveBeenCalled(); // rejected before touching the DB
  });

  it('rejects a garbage token', async () => {
    const res = await request(app).get('/turtles').set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
    expect(res.body.expired).toBe(false);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const forged = jwt.sign({ sub: '1', role: 'Project Coordinator' }, 'wrong-secret');
    const res = await request(app).get('/turtles').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('tells an expired session apart from an invalid one', async () => {
    const stale = jwt.sign({ sub: '1', role: 'Volunteer' }, SECRET, { expiresIn: '-1s' });
    const res = await request(app).get('/turtles').set('Authorization', `Bearer ${stale}`);
    expect(res.status).toBe(401);
    expect(res.body.expired).toBe(true);
    expect(res.body.error).toMatch(/sign in again/i);
  });

  it('ignores a token that is not sent as a Bearer scheme', async () => {
    const res = await request(app).get('/turtles').set('Authorization', tokenFor());
    expect(res.status).toBe(401);
  });

  it('accepts a valid token', async () => {
    query.mockResolvedValue({ rows: [] });
    const res = await request(app).get('/turtles').set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
  });

  it('lets the CORS preflight through without a token', async () => {
    const res = await request(app).options('/turtles').set('Origin', 'http://localhost:3000');
    expect(res.status).toBeLessThan(400);
  });
});

describe('PUBLIC_ROUTES — only these are open', () => {
  it('serves /test unauthenticated', async () => {
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
  });

  it('serves /demo/accounts unauthenticated, with labels only', async () => {
    const res = await request(app).get('/demo/accounts');
    expect(res.status).toBe(200);
    expect(res.body.roles).toContain('Field Leader');
    // The whole point of the endpoint: no address may appear in the payload.
    expect(JSON.stringify(res.body)).not.toMatch(/@/);
  });

  it('does not treat a lookalike path as public', async () => {
    // "GET /test" is public; nothing that merely starts with it should be.
    const res = await request(app).get('/test/../turtles');
    expect(res.status).toBe(401);
  });
});

describe('requireRole', () => {
  it('refuses a Volunteer deleting a turtle', async () => {
    const res = await request(app)
      .delete('/turtles/7')
      .set('Authorization', `Bearer ${tokenFor({ role: 'Volunteer' })}`);
    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses a Field Assistant deleting a nest', async () => {
    const res = await request(app)
      .delete('/nests/3')
      .set('Authorization', `Bearer ${tokenFor({ role: 'Field Assistant' })}`);
    expect(res.status).toBe(403);
  });

  it('allows a Project Coordinator through the same guard', async () => {
    // This route takes a pooled client rather than querying the pool directly,
    // so the guard having passed shows up as a connect(), not a query().
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
    const connect = vi.spyOn(db, 'connect').mockResolvedValue(client);

    const res = await request(app)
      .delete('/turtles/7')
      .set('Authorization', `Bearer ${tokenFor({ role: 'Project Coordinator' })}`);

    expect(res.status).not.toBe(403);
    expect(connect).toHaveBeenCalled();
    expect(res.status).toBe(404); // no such turtle, having got past the guard
    expect(client.release).toHaveBeenCalled(); // and the client is handed back
  });
});
