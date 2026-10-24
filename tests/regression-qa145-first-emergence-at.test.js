// QA-145: "Incubation (final)" was being computed to the inventory/excavation
// date (turtle_nest_events.event_type LIKE INVENTORY, aliased hatched_at in
// GET /nests), inflating the figure by however many days the team waited
// before digging up a nest that had already visibly emerged. The true end
// date is the first hatchling emergence, so turtle_nests.first_emergence_at
// is now set from the earliest EMERGENCE/HATCHING event ever recorded for a
// nest, and left untouched by every event after that.
//
// What this case pins down:
//   - POST /nest-events/create with event_type EMERGENCE or HATCHING updates
//     turtle_nests.first_emergence_at via COALESCE (only fills it when unset)
//   - a second EMERGENCE/HATCHING event for the same nest does not push the
//     already-set first_emergence_at back
//   - an unrelated event_type (e.g. FULL_INVENTORY) never touches the column
import { describe, it, expect, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const tokenFor = (role, sub) =>
  jwt.sign({ sub, role, email: `${sub}@turtleguard.demo` }, SECRET, { expiresIn: '1h' });

const VOLUNTEER = tokenFor('Field Volunteer', '51');
const asVolunteer = (req) => req.set('Authorization', `Bearer ${VOLUNTEER}`);

afterAll(() => db.end().catch(() => {}));

const nestEventRow = (overrides) => ({
  id: 11, event_type: 'EMERGENCE', nest_id: 90, nest_code: 'LG2-9',
  created_at: '2025-07-01T06:00:00.000Z', ...overrides,
});

const firstEmergenceUpdates = (query) =>
  query.mock.calls.filter(([s]) => String(s).includes('SET first_emergence_at'));

describe('POST /nest-events/create sets turtle_nests.first_emergence_at (QA-145)', () => {
  it('sets first_emergence_at via COALESCE for an EMERGENCE event', async () => {
    const query = vi.spyOn(db, 'query').mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('SELECT n.id, n.date_found, n.total_num_eggs')) {
        return { rows: [{ id: 90, total_num_eggs: 100, emerged_so_far: 0 }] };
      }
      if (text.includes('INSERT INTO turtle_nest_events')) {
        return { rows: [nestEventRow()] };
      }
      return { rows: [] };
    });

    const res = await asVolunteer(request(app).post('/nest-events/create')).send({
      event_type: 'EMERGENCE', nest_code: 'LG2-9', tracks_to_sea: 1, tracks_lost: 0,
    });

    expect(res.status).toBe(200);
    const updates = firstEmergenceUpdates(query);
    expect(updates).toHaveLength(1);
    expect(String(updates[0][0])).toContain('COALESCE(first_emergence_at');
    expect(updates[0][1][0]).toBe(90);
  });

  it('also sets first_emergence_at for a HATCHING event', async () => {
    const query = vi.spyOn(db, 'query').mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('SELECT n.id, n.date_found, n.total_num_eggs')) {
        return { rows: [{ id: 90, total_num_eggs: 100, emerged_so_far: 0 }] };
      }
      if (text.includes('INSERT INTO turtle_nest_events')) {
        return { rows: [nestEventRow({ event_type: 'HATCHING' })] };
      }
      return { rows: [] };
    });

    const res = await asVolunteer(request(app).post('/nest-events/create')).send({
      event_type: 'HATCHING', nest_code: 'LG2-9', tracks_to_sea: 1, tracks_lost: 0,
    });

    expect(res.status).toBe(200);
    expect(firstEmergenceUpdates(query)).toHaveLength(1);
  });

  it('never overwrites an already-set first_emergence_at (COALESCE keeps the first one)', async () => {
    const query = vi.spyOn(db, 'query').mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('SELECT n.id, n.date_found, n.total_num_eggs')) {
        return { rows: [{ id: 90, total_num_eggs: 100, emerged_so_far: 5 }] };
      }
      if (text.includes('INSERT INTO turtle_nest_events')) {
        return { rows: [nestEventRow({ id: 12, created_at: '2025-07-05T06:00:00.000Z' })] };
      }
      return { rows: [] };
    });

    const res = await asVolunteer(request(app).post('/nest-events/create')).send({
      event_type: 'EMERGENCE', nest_code: 'LG2-9', tracks_to_sea: 1, tracks_lost: 0,
    });

    expect(res.status).toBe(200);
    const updates = firstEmergenceUpdates(query);
    // The route always issues the same COALESCE-guarded update, regardless of
    // whether a row already has a value - the DB, not the app, decides
    // whether anything actually changes.
    expect(updates).toHaveLength(1);
    expect(String(updates[0][0])).toContain('COALESCE(first_emergence_at, COALESCE($2, $3))');
  });

  // Found via a real failure: the event row above is already committed by
  // the time this UPDATE runs, so a failure here (e.g. a schema migration
  // mid-deploy, before the first_emergence_at column exists yet) must not
  // turn an otherwise-successful save into a 500 - the client would see a
  // failure for a track that was, in fact, recorded.
  it('still returns 200 and keeps the event when the first_emergence_at update itself fails', async () => {
    const query = vi.spyOn(db, 'query').mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('SELECT n.id, n.date_found, n.total_num_eggs')) {
        return { rows: [{ id: 90, total_num_eggs: 100, emerged_so_far: 0 }] };
      }
      if (text.includes('INSERT INTO turtle_nest_events')) {
        return { rows: [nestEventRow()] };
      }
      if (text.includes('SET first_emergence_at')) {
        throw new Error('column "first_emergence_at" does not exist');
      }
      return { rows: [] };
    });

    const res = await asVolunteer(request(app).post('/nest-events/create')).send({
      event_type: 'EMERGENCE', nest_code: 'LG2-9', tracks_to_sea: 1, tracks_lost: 0,
    });

    expect(res.status).toBe(200);
    expect(res.body.event).toBeTruthy();
  });

  it('does not touch first_emergence_at for a non-emergence event type', async () => {
    const query = vi.spyOn(db, 'query').mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('SELECT n.id, n.date_found, n.total_num_eggs')) {
        return { rows: [{ id: 90, total_num_eggs: 100, emerged_so_far: 0 }] };
      }
      if (text.includes('INSERT INTO turtle_nest_events')) {
        return { rows: [nestEventRow({ id: 13, event_type: 'FULL_INVENTORY' })] };
      }
      return { rows: [] };
    });

    const res = await asVolunteer(request(app).post('/nest-events/create')).send({
      event_type: 'FULL_INVENTORY', nest_code: 'LG2-9', hatched_count: 80,
    });

    expect(res.status).toBe(200);
    expect(firstEmergenceUpdates(query)).toHaveLength(0);
  });
});
