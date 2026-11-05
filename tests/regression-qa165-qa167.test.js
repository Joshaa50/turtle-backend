// QA-165: the catch-all 300-per-15min-per-IP limiter was tighter than normal
// SPA traffic - a signed-in Dashboard's own polling, multiplied by a few
// people sharing one office/station IP, tripped it within 15-25 minutes and
// broke every screen with a generic 429. Raised well above realistic normal
// use while still bounding a runaway loop.
//
// QA-167: /public/stats summed every nest ever recorded while the page said
// "this season". Once the 2024/2025 demo seasons were seeded (QA-162) the
// public total silently included them and drifted from the Dashboard/Season
// Report, which are both scoped to the current season.
import { describe, it, expect, vi, afterAll } from 'vitest';
import request from 'supertest';
import server from '../server.js';

const { app, db } = server;

afterAll(() => db.end().catch(() => {}));

describe('QA-165: general rate limit headroom', () => {
  it('advertises a limit well above the old 300/15min ceiling', async () => {
    vi.spyOn(db, 'query').mockResolvedValue({ rows: [] });
    const res = await request(app).get('/test');
    const limit = Number(res.headers['ratelimit-limit'] ?? res.headers['x-ratelimit-limit']);
    expect(limit).toBeGreaterThan(300);
  });
});

describe('QA-167: /public/stats is scoped to the current season', () => {
  it('filters nests by the current season\'s date range when one is configured', async () => {
    const spy = vi.spyOn(db, 'query').mockImplementation((sql) => {
      if (sql.includes('app_settings')) {
        return Promise.resolve({
          rows: [{
            value: {
              seasons: [{ id: '2026', name: '2026 Nesting Season', start: '2026-05-01', end: '2026-12-31' }],
              current: '2026',
            },
          }],
        });
      }
      return Promise.resolve({
        rows: [{ total_nests: 91, total_eggs: 3013, nests_hatched: 0, hatchlings_released: 2242 }],
      });
    });

    const res = await request(app).get('/public/stats');

    expect(res.status).toBe(200);
    const statsCall = spy.mock.calls.find(([sql]) => sql.includes('turtle_nests'));
    expect(statsCall[0]).toContain('WHERE n.date_found BETWEEN $1 AND $2');
    expect(statsCall[1]).toEqual(['2026-05-01', '2026-12-31']);
  });

  it('falls back to all-time when no current season is configured', async () => {
    const spy = vi.spyOn(db, 'query').mockImplementation((sql) => {
      if (sql.includes('app_settings')) return Promise.resolve({ rows: [] });
      return Promise.resolve({
        rows: [{ total_nests: 5, total_eggs: 100, nests_hatched: 0, hatchlings_released: 0 }],
      });
    });

    const res = await request(app).get('/public/stats');

    expect(res.status).toBe(200);
    const statsCall = spy.mock.calls.find(([sql]) => sql.includes('turtle_nests'));
    expect(statsCall[0]).not.toContain('WHERE n.date_found');
  });
});
