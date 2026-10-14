// QA-076: the frontend's walk-grouping on the Review Queue merged two
// different-area morning surveys submitted by the same volunteer on the same
// day into one card, because record_detail never carried which survey area a
// beach belongs to - only its specific beach name. Grouping by beach name
// would be wrong (one area spans several beaches, and the whole point of the
// grouping feature is batching those into one card), so this pins down that
// GET /reviews' record_detail for a morning_survey actually includes
// survey_area, additively, alongside the existing beach name.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const asLeader = (req) =>
  req.set('Authorization', `Bearer ${jwt.sign({ sub: '7', role: 'Field Leader', email: 'leader@turtleguard.demo' }, SECRET, { expiresIn: '1h' })}`);

afterAll(() => db.end().catch(() => {}));

describe("GET /reviews' morning_survey detail includes survey_area (QA-076)", () => {
  let query;

  beforeEach(() => {
    query = vi.spyOn(db, 'query').mockImplementation((sql) => {
      const text = String(sql);
      if (text.includes('FROM record_reviews r')) {
        return Promise.resolve({
          rows: [{ id: 1, record_type: 'morning_survey', record_id: 9, status: 'pending' }],
        });
      }
      if (text.includes('FROM morning_surveys ms')) {
        // Confirms the query itself asks for survey_area, not just the beach
        // name - this is the fix: a merely-correct mock here would hide a
        // regression where the SQL stopped requesting it.
        expect(text).toContain("'survey_area', b.survey_area");
        return Promise.resolve({
          rows: [{ id: 9, detail: { beach: 'Loggos 2', survey_area: 'Lepeda', survey_date: '2026-10-10' } }],
        });
      }
      if (text.includes('FROM morning_surveys WHERE id')) {
        return Promise.resolve({ rows: [{ id: 9, label: 'Loggos 2 - 2026-10-10' }] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it('carries survey_area through to record_detail', async () => {
    const res = await asLeader(request(app).get('/reviews'));

    expect(res.status).toBe(200);
    const review = res.body.reviews.find((r) => r.record_type === 'morning_survey');
    expect(review.record_detail.survey_area).toBe('Lepeda');
    expect(review.record_detail.beach).toBe('Loggos 2');
  });
});
