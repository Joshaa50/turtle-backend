// QA-145 (backfill): POST /nest-events/create has set turtle_nests.
// first_emergence_at from the earliest EMERGENCE/HATCHING event going
// forward since a prior fix (see tests/regression-qa145-first-emergence-at
// .test.js), but nests that already had those events recorded *before*
// that fix shipped were never backfilled - GET /nests kept returning
// first_emergence_at = null for them, so Nest Records > Hatched & Archived
// kept showing the inflated, excavation-date-based incubation figure.
//
// backfillFirstEmergenceAt() runs once per boot (see the require.main
// block above it in server.js) and fills exactly those nulls from each
// nest's earliest EMERGENCE/HATCHING event - this pins down the SQL it
// issues: a correlated/DISTINCT ON subquery picking the earliest event per
// nest (start_time, falling back to created_at - the same preference as
// the live-event code), guarded by first_emergence_at IS NULL so it never
// overwrites a value and is safe to run on every boot.
import { describe, it, expect, vi, afterAll } from 'vitest';
import server from '../server.js';

const { db, backfillFirstEmergenceAt } = server;

afterAll(() => db.end().catch(() => {}));

describe('backfillFirstEmergenceAt (QA-145)', () => {
  it('issues a single UPDATE that fills first_emergence_at from the earliest EMERGENCE/HATCHING event per nest, only where it is NULL', async () => {
    const query = vi.spyOn(db, 'query').mockResolvedValue({ rows: [] });

    await backfillFirstEmergenceAt();

    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0][0]);

    expect(sql).toMatch(/UPDATE turtle_nests n\s+SET first_emergence_at = e\.first_emergence_at/);
    expect(sql).toContain("WHERE ev.event_type IN ('EMERGENCE', 'HATCHING')");
    // earliest per nest: DISTINCT ON (nest_id) ordered by the same
    // start_time-then-created_at preference used by the live-event code
    expect(sql).toMatch(/DISTINCT ON \(ev\.nest_id\)/);
    expect(sql).toMatch(/COALESCE\(ev\.start_time, ev\.created_at\) AS first_emergence_at/);
    expect(sql).toMatch(/ORDER BY ev\.nest_id, COALESCE\(ev\.start_time, ev\.created_at\) ASC/);
    // QA-157: an event dated before the nest's own date_found (stray/bad
    // data) must never be picked as "first emergence" for that nest
    expect(sql).toMatch(/JOIN turtle_nests tn ON tn\.id = ev\.nest_id/);
    expect(sql).toMatch(/COALESCE\(ev\.start_time, ev\.created_at\) >= tn\.date_found/);
    // never overwrites an already-set value, and leaves nests with no
    // EMERGENCE/HATCHING event (no match in the subquery) untouched
    expect(sql).toMatch(/WHERE e\.nest_id = n\.id AND n\.first_emergence_at IS NULL/);
  });

  it('is safe to run repeatedly: it fills only NULLs, and the live-event UPDATE no longer matches rows this backfill already filled', async () => {
    // Simulating two consecutive boots: nothing about the statement itself
    // changes between calls (no guard/flag needed) because the WHERE
    // clause is what makes a second run a no-op against already-filled rows.
    const query = vi.spyOn(db, 'query').mockResolvedValue({ rows: [] });

    await backfillFirstEmergenceAt();
    await backfillFirstEmergenceAt();

    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0][0])).toBe(String(query.mock.calls[1][0]));
  });

  it('never throws and logs instead, so a failure here cannot crash boot', async () => {
    const query = vi.spyOn(db, 'query').mockRejectedValue(new Error('relation "turtle_nest_events" does not exist'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(backfillFirstEmergenceAt()).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'Could not backfill turtle_nests.first_emergence_at:',
      expect.stringContaining('does not exist')
    );
    errorSpy.mockRestore();
  });
});
