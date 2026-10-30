// QA-157: MA-2 (laid 2026-06-10) and AG-1 (laid 2026-05-28) had stray/bad
// EMERGENCE events dated months before either nest existed. Both the
// backfill (QA-145) and the live POST /nest-events/create update took the
// earliest EMERGENCE/HATCHING event for a nest at face value, with no check
// that it actually happened on or after the nest's own date_found - so
// first_emergence_at ended up earlier than date_found, producing "INCUBATION
// (FINAL) -89 Days" and "(incubation 0d)" on Hatched & Archived.
//
// first_emergence_at must only ever be set from an EMERGENCE/HATCHING event
// on or after date_found. This file pins down all three parts of the fix:
//   (a) the live update is now guarded by the event's own timestamp
//   (b) the backfill query only considers events on/after date_found
//   (c) a boot-time step resets already-wrong values (set before this fix
//       shipped) back to NULL so the (now-fixed) backfill can recompute them
import { describe, it, expect, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db, backfillFirstEmergenceAt, resetBadFirstEmergenceAt } = server;
const SECRET = process.env.JWT_SECRET;

const tokenFor = (role, sub) =>
  jwt.sign({ sub, role, email: `${sub}@turtleguard.demo` }, SECRET, { expiresIn: '1h' });

const VOLUNTEER = tokenFor('Field Volunteer', '51');
const asVolunteer = (req) => req.set('Authorization', `Bearer ${VOLUNTEER}`);

afterAll(() => db.end().catch(() => {}));

const nestEventRow = (overrides) => ({
  id: 27, event_type: 'EMERGENCE', nest_id: 90, nest_code: 'MA-2',
  created_at: '2026-03-13T06:00:00.000Z', ...overrides,
});

const firstEmergenceUpdates = (query) =>
  query.mock.calls.filter(([s]) => String(s).includes('SET first_emergence_at'));

describe('first_emergence_at never predates date_found (QA-157)', () => {
  it('(a) live update: a WHERE guard compares the event timestamp against date_found', async () => {
    const query = vi.spyOn(db, 'query').mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('SELECT n.id, n.date_found, n.total_num_eggs')) {
        return { rows: [{ id: 90, date_found: '2026-06-10', total_num_eggs: 100, emerged_so_far: 0 }] };
      }
      if (text.includes('INSERT INTO turtle_nest_events')) {
        // The stray event itself: start_time absent, created_at months
        // before date_found - mirrors MA-2's event id 27.
        return { rows: [nestEventRow()] };
      }
      return { rows: [] };
    });

    const res = await asVolunteer(request(app).post('/nest-events/create')).send({
      event_type: 'EMERGENCE', nest_code: 'MA-2', tracks_to_sea: 1, tracks_lost: 0,
    });

    expect(res.status).toBe(200);
    const updates = firstEmergenceUpdates(query);
    expect(updates).toHaveLength(1);
    // The guard must be present in the SQL text itself (not a client-side
    // check) - this is what stops the UPDATE from applying when it runs.
    expect(String(updates[0][0])).toMatch(/>=\s*date_found/);
  });

  it('(b) backfill: the DISTINCT ON subquery only considers events on/after the nest\'s date_found', async () => {
    const query = vi.spyOn(db, 'query').mockResolvedValue({ rows: [] });

    await backfillFirstEmergenceAt();

    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/JOIN turtle_nests tn ON tn\.id = ev\.nest_id/);
    expect(sql).toMatch(/COALESCE\(ev\.start_time, ev\.created_at\) >= tn\.date_found/);
  });

  it('(c) boot-time reset: nulls out an already-set first_emergence_at that predates date_found', async () => {
    const query = vi.spyOn(db, 'query').mockResolvedValue({ rows: [] });

    await resetBadFirstEmergenceAt();

    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/UPDATE turtle_nests/);
    expect(sql).toMatch(/SET first_emergence_at = NULL/);
    expect(sql).toMatch(/first_emergence_at < date_found/);
  });

  it('(c) is safe to run every boot: never throws, logs instead', async () => {
    const query = vi.spyOn(db, 'query').mockRejectedValue(new Error('relation "turtle_nests" does not exist'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(resetBadFirstEmergenceAt()).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'Could not reset bad turtle_nests.first_emergence_at values:',
      expect.stringContaining('does not exist')
    );
    errorSpy.mockRestore();
  });
});
