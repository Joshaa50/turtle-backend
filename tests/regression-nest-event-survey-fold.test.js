// QA-072: a hatchling track logged mid-walk is created before the morning
// survey row that will carry it exists, so it could not be folded into the
// survey's review the way a linked nest/emergence is - today it still
// queues as its own, separate review item even when it belongs to a survey
// a Field Leader is about to confirm as one form.
//
// What these cases pin down:
//   - POST /nest-events/create with survey_id folds the new event's own
//     pending review into the survey's, same as the nest/emergence linking
//     routes already do (foldIntoSurveyReview, reused unchanged)
//   - without survey_id, a nest_event keeps queuing its own standalone
//     review row exactly as before (no regression for every other caller
//     of this route - relocation events, inventory events, etc.)
//   - approving a morning_survey review applies the same nest-status side
//     effects as approving each folded nest_event directly would
//   - the same holds through /reviews/bulk-approve for a mixed batch
//   - the survey's review detail payload surfaces its folded tracks as
//     linked_tracks, so they are not invisible to the reviewer
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const tokenFor = (role, sub) =>
  jwt.sign({ sub, role, email: `${sub}@turtleguard.demo` }, SECRET, { expiresIn: '1h' });

const VOLUNTEER = tokenFor('Field Volunteer', '51');
const LEADER = tokenFor('Field Leader', '7');
const asVolunteer = (req) => req.set('Authorization', `Bearer ${VOLUNTEER}`);
const asLeader = (req) => req.set('Authorization', `Bearer ${LEADER}`);

afterAll(() => db.end().catch(() => {}));

const validNestEvent = { event_type: 'EMERGENCE', nest_code: 'LG2-9', tracks_to_sea: 1, tracks_lost: 0 };

describe('POST /nest-events/create folding into a survey review', () => {
  let query;

  beforeEach(() => {
    query = vi.spyOn(db, 'query').mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('SELECT n.id, n.total_num_eggs')) {
        return { rows: [{ id: 90, total_num_eggs: 100, emerged_so_far: 0 }] };
      }
      if (text.includes('INSERT INTO turtle_nest_events')) {
        return { rows: [{ id: 11, event_type: 'EMERGENCE', nest_id: 90, nest_code: 'LG2-9' }] };
      }
      // app_settings (field requirements / review rules), record_reviews
      // insert/delete, record_audit - none of these need a specific row.
      return { rows: [] };
    });
  });

  const folded = () => query.mock.calls.filter(([s]) => String(s).includes('DELETE FROM record_reviews'));

  it('drops the new nest_event\'s own pending review, only while the survey is under review', async () => {
    const res = await asVolunteer(request(app).post('/nest-events/create'))
      .send({ ...validNestEvent, survey_id: 7 });

    expect(res.status).toBe(200);
    const [call] = folded();
    expect(call).toBeDefined();
    expect(String(call[0])).toContain("status = 'pending'");
    expect(String(call[0])).toContain("s.record_type = 'morning_survey'");
    expect(call[1]).toEqual([7, 'nest_event', 11]);
  });

  it('keeps its own standalone pending review when no survey_id is given', async () => {
    const res = await asVolunteer(request(app).post('/nest-events/create')).send(validNestEvent);

    expect(res.status).toBe(200);
    expect(folded()).toHaveLength(0);
    expect(
      query.mock.calls.some(([s]) => String(s).includes('INSERT INTO record_reviews'))
    ).toBe(true);
  });
});

describe('approving a morning_survey propagates to its folded nest_events (QA-072 / QA-070)', () => {
  const mockSurveyApprovalFlow = () => {
    const calls = [];
    const impl = (sql, params) => {
      const text = String(sql);
      calls.push({ text, params });

      if (text.includes('UPDATE record_reviews') && params?.[0] === 'approved') {
        return Promise.resolve({ rows: [{ id: 9, record_type: 'morning_survey', record_id: 70 }] });
      }
      if (text.includes('SELECT id FROM turtle_nest_events WHERE survey_id')) {
        return Promise.resolve({ rows: [{ id: 11 }] });
      }
      if (text.includes('SELECT event_type, nest_id, eggs_reburied, total_eggs FROM turtle_nest_events')) {
        return Promise.resolve({ rows: [{ event_type: 'EMERGENCE', nest_id: 90, eggs_reburied: null, total_eggs: null }] });
      }
      if (text.includes('SELECT nest_code, status FROM turtle_nests') && text.includes('status = ANY')) {
        return Promise.resolve({ rows: [{ nest_code: 'LG2-9', status: 'incubating' }] });
      }
      if (text.includes('UPDATE turtle_nests SET status = $2')) {
        return Promise.resolve({ rows: [{ nest_code: 'LG2-9' }] });
      }
      return Promise.resolve({ rows: [] });
    };
    vi.spyOn(db, 'query').mockImplementation(impl);
    return calls;
  };

  it('moves the folded nest_event\'s nest from incubating to hatching, same as a direct nest_event approval', async () => {
    const calls = mockSurveyApprovalFlow();

    const res = await asLeader(request(app).post('/reviews/9/approve')).send({});

    expect(res.status).toBe(200);
    const statusUpdate = calls.find((c) => c.text.includes('UPDATE turtle_nests SET status = $2'));
    expect(statusUpdate).toBeDefined();
    expect(statusUpdate.params).toEqual([90, 'hatching']);
  });

  it('fires the transition once per folded event via /reviews/bulk-approve, not duplicated or skipped', async () => {
    const calls = [];
    vi.spyOn(db, 'query').mockImplementation((sql, params) => {
      const text = String(sql);
      calls.push({ text, params });

      if (text.includes('UPDATE record_reviews') && text.includes("'approved'")) {
        return Promise.resolve({
          rows: [
            { id: 9, record_type: 'morning_survey', record_id: 70 },
            { id: 6, record_type: 'nest_event', record_id: 12 }, // a standalone, non-folded event
          ],
        });
      }
      if (text.includes('SELECT id FROM turtle_nest_events WHERE survey_id')) {
        return Promise.resolve({ rows: [{ id: 11 }] });
      }
      if (text.includes('SELECT event_type, nest_id, eggs_reburied, total_eggs FROM turtle_nest_events')) {
        const id = params[0];
        if (id === 11) {
          return Promise.resolve({ rows: [{ event_type: 'EMERGENCE', nest_id: 90, eggs_reburied: null, total_eggs: null }] });
        }
        return Promise.resolve({ rows: [{ event_type: 'FULL_INVENTORY', nest_id: 91, eggs_reburied: 0, total_eggs: 50 }] });
      }
      if (text.includes('SELECT nest_code, status FROM turtle_nests') && text.includes('status = ANY')) {
        return Promise.resolve({ rows: [{ nest_code: 'LG2-9', status: 'incubating' }] });
      }
      if (text.includes('UPDATE turtle_nests SET status = $2')) {
        return Promise.resolve({ rows: [{ nest_code: 'LG2-9' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await asLeader(request(app).post('/reviews/bulk-approve')).send({ ids: [9, 6] });

    expect(res.status).toBe(200);
    const statusUpdates = calls.filter((c) => c.text.includes('UPDATE turtle_nests SET status = $2'));
    expect(statusUpdates).toHaveLength(2);

    const foldedUpdate = statusUpdates.find((c) => c.params[0] === 90);
    expect(foldedUpdate.params[1]).toBe('hatching');

    const standaloneUpdate = statusUpdates.find((c) => c.params[0] === 91);
    expect(standaloneUpdate.params[1]).toBe('hatched');
  });
});

describe('review detail for a morning_survey surfaces its folded tracks', () => {
  it('includes linked_tracks in the review detail payload', async () => {
    vi.spyOn(db, 'query').mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('FROM record_reviews')) {
        return {
          rows: [
            {
              id: 9, record_type: 'morning_survey', record_id: 70, status: 'pending',
              submitted_by: 51, submitted_at: new Date().toISOString(), reviewed_by: null, reviewed_at: null, review_note: null,
            },
          ],
        };
      }
      if (text.includes('ms.id = ANY')) {
        return {
          rows: [
            {
              id: 70,
              detail: {
                beach: 'Loggos 2',
                linked_nests: [],
                linked_emergences: [],
                linked_tracks: [{ id: 11, event_type: 'EMERGENCE', nest_code: 'LG2-9' }],
              },
            },
          ],
        };
      }
      return { rows: [] };
    });

    const res = await asLeader(request(app).get('/reviews'));

    expect(res.status).toBe(200);
    const row = res.body.reviews.find((r) => r.record_type === 'morning_survey' && r.record_id === 70);
    expect(row.record_detail.linked_tracks).toEqual([{ id: 11, event_type: 'EMERGENCE', nest_code: 'LG2-9' }]);
  });
});
