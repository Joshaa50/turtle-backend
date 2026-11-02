import { describe, it, expect, beforeEach, vi, afterAll, afterEach } from 'vitest';
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

// GD-002: a GEMINI_API_KEY alone used to turn these routes on for every
// deployment that happened to have one set, with no deployment-level opt-in
// and no role limit. AI_FEATURES_ENABLED and AI_ROLES are both computed once
// at module load (like DEMO_LOGIN_ENABLED), so these scenarios reset the
// module registry and re-import server.js with a fresh process.env, the same
// pattern as regression-gd001-demo-login-default-deny.test.js.
describe('GD-002: AI_FEATURES defaults off, and AI routes are role-limited', () => {
  const ORIGINAL_AI_FEATURES = process.env.AI_FEATURES;
  const ORIGINAL_GEMINI_KEY = process.env.GEMINI_API_KEY;

  async function loadServerWith(aiFeatures, geminiKey) {
    vi.resetModules();
    if (aiFeatures === undefined) delete process.env.AI_FEATURES;
    else process.env.AI_FEATURES = aiFeatures;
    if (geminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = geminiKey;
    const mod = await import('../server.js');
    return mod.default;
  }

  afterEach(() => {
    if (ORIGINAL_AI_FEATURES === undefined) delete process.env.AI_FEATURES;
    else process.env.AI_FEATURES = ORIGINAL_AI_FEATURES;
    if (ORIGINAL_GEMINI_KEY === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = ORIGINAL_GEMINI_KEY;
  });

  it('AI_FEATURES unset still 503s even when GEMINI_API_KEY IS set', async () => {
    const { app, db } = await loadServerWith(undefined, 'a-real-looking-key');
    vi.spyOn(db, 'query').mockRejectedValue(new Error('db.query called without a stub'));

    const res = await request(app)
      .post('/ai/nest-query')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ query: 'how many nests hatched?', nests: [] });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AI_NOT_CONFIGURED');
    await db.end().catch(() => {});
  });

  it('AI_FEATURES=on with no key still 503s', async () => {
    const { app, db } = await loadServerWith('on', undefined);
    vi.spyOn(db, 'query').mockRejectedValue(new Error('db.query called without a stub'));

    const res = await request(app)
      .post('/ai/analyze-audio')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ audioBase64: 'AAAA', mimeType: 'audio/webm' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AI_NOT_CONFIGURED');
    await db.end().catch(() => {});
  });

  it('a Field Volunteer is forbidden from both AI routes even when fully configured', async () => {
    const { app, db } = await loadServerWith('on', 'a-real-looking-key');
    vi.spyOn(db, 'query').mockRejectedValue(new Error('db.query called without a stub'));
    const volunteerToken = tokenFor({ role: 'Field Volunteer' });

    const nestQuery = await request(app)
      .post('/ai/nest-query')
      .set('Authorization', `Bearer ${volunteerToken}`)
      .send({ query: 'how many nests hatched?', nests: [] });
    expect(nestQuery.status).toBe(403);

    const analyzeAudio = await request(app)
      .post('/ai/analyze-audio')
      .set('Authorization', `Bearer ${volunteerToken}`)
      .send({ audioBase64: 'AAAA', mimeType: 'audio/webm' });
    expect(analyzeAudio.status).toBe(403);

    await db.end().catch(() => {});
  });

  it('rejects a nests array over the cap with a 400, before calling Gemini', async () => {
    const { app, db } = await loadServerWith(undefined, undefined);
    vi.spyOn(db, 'query').mockRejectedValue(new Error('db.query called without a stub'));

    const tooManyNests = Array.from({ length: 201 }, (_, i) => ({ id: i }));
    const res = await request(app)
      .post('/ai/nest-query')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ query: 'how many nests hatched?', nests: tooManyNests });

    expect(res.status).toBe(400);
    await db.end().catch(() => {});
  });
});
