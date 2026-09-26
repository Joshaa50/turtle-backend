import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const tokenFor = (over = {}) =>
  jwt.sign({ sub: '1', role: 'Project Coordinator', email: 'c@example.com', ...over }, SECRET, {
    expiresIn: '1h',
  });

beforeEach(() => {
  vi.spyOn(db, 'query').mockRejectedValue(
    new Error('db.query called without a stub in this test'),
  );
});
afterAll(() => db.end().catch(() => {}));

// A deployment with no GEMINI_API_KEY used to answer 500 "Failed to process
// query" — indistinguishable from Gemini itself being down, so the demo looked
// broken rather than un-configured. These pin the 503 + code that lets the UI
// say "this feature isn't switched on here" instead.
describe('AI endpoints with no GEMINI_API_KEY', () => {
  const saved = process.env.GEMINI_API_KEY;
  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
  });

  it('/ai/nest-query reports itself unavailable rather than failed', async () => {
    const res = await request(app)
      .post('/ai/nest-query')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ query: 'how many nests hatched?', nests: [] });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AI_NOT_CONFIGURED');
  });

  it('/ai/analyze-audio reports itself unavailable rather than failed', async () => {
    const res = await request(app)
      .post('/ai/analyze-audio')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ audioBase64: 'AAAA', mimeType: 'audio/webm' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AI_NOT_CONFIGURED');
  });

  it('still requires a token — the 503 is not a way around auth', async () => {
    const res = await request(app).post('/ai/nest-query').send({ query: 'x' });
    expect(res.status).toBe(401);
  });
});
