// QA-030: a Field Volunteer could edit ANY turtle or emergence through the
// API, bypassing the review queue - Records/TurtleDetails hide the Edit
// button for a Volunteer, so the only legitimate path through either update
// route is "My Submissions > Edit & send back for review" on their OWN
// record, the same ownership check record_audit already provides for that
// flow's resubmit guard (already enforced on PUT /emergences/:id, missing on
// PUT /turtles/:id/update until now).
//
// Along the way, PUT /emergences/:id never wrote an "updated" audit row -
// the trail showed a record as only ever "created", even after it had been
// edited. Test 6 below is the one that would have caught that.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const tokenFor = (role, sub) =>
  jwt.sign({ sub, role, email: 'maria.karydi@turtleguard.demo' }, SECRET, { expiresIn: '1h' });

const asVolunteer = (req) => req.set('Authorization', `Bearer ${tokenFor('Field Volunteer', '51')}`);
const asAssistant = (req) => req.set('Authorization', `Bearer ${tokenFor('Field Assistant', '51')}`);
const asLeader = (req) => req.set('Authorization', `Bearer ${tokenFor('Field Leader', '51')}`);
const asCoordinator = (req) => req.set('Authorization', `Bearer ${tokenFor('Project Coordinator', '51')}`);

const turtleBody = {
  health_condition: 'Healthy',
  scl_max: 80,
  scl_min: 70,
  scw: 60,
  ccl_max: 82,
  ccl_min: 75,
  ccw: 65,
  tail_extension: 20,
  vent_to_tail_tip: 15,
  total_tail_length: 35,
};

const emergenceBody = {
  distance_to_sea_s: 12,
  gps_lat: 38.175,
  gps_long: 20.569,
  event_date: '2026-08-30',
  beach: 'Loggos 2',
};

let query;

// Builds a db.query stub whose ownership lookup (the record_audit SELECT
// isOwnRecord issues) returns `ownerId`, and whose other lookups return
// whatever a successful update needs.
const stubQuery = (ownerId, { turtleRow = { id: 7, name: 'QA-Turtle', species: 'Caretta caretta', health_condition: 'Healthy' }, emergenceRow = { id: 119, beach: 'Loggos 2' } } = {}) =>
  vi.spyOn(db, 'query').mockImplementation((sql) => {
    const text = String(sql);
    if (text.includes('FROM record_audit') && text.includes("action = 'created'")) {
      return Promise.resolve({ rows: ownerId == null ? [] : [{ actor_id: ownerId }] });
    }
    if (text.includes('UPDATE turtles')) {
      return Promise.resolve({ rows: [turtleRow], rowCount: 1 });
    }
    if (text.includes('UPDATE turtle_emergences')) {
      return Promise.resolve({ rows: [emergenceRow], rowCount: 1 });
    }
    if (text.includes('SELECT species, health_condition FROM turtles')) {
      return Promise.resolve({ rows: [{ species: 'Caretta caretta', health_condition: 'Healthy' }] });
    }
    if (text.includes('SELECT beach FROM turtle_emergences')) {
      return Promise.resolve({ rows: [{ beach: 'Loggos 2' }] });
    }
    if (text.includes('INSERT INTO record_audit')) {
      return Promise.resolve({ rows: [{ id: 1 }] });
    }
    return Promise.resolve({ rows: [] });
  });

afterAll(() => db.end().catch(() => {}));

describe('PUT /turtles/:id/update ownership guard (QA-030)', () => {
  it("refuses a Volunteer editing someone else's turtle", async () => {
    query = stubQuery('999'); // owner is a different user than caller (sub '51')

    const res = await asVolunteer(request(app).put('/turtles/7/update')).send(turtleBody);

    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE turtles'),
      expect.anything(),
    );
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO record_reviews'),
      expect.anything(),
    );
  });

  it('allows a Volunteer editing their OWN turtle', async () => {
    query = stubQuery('51'); // owner matches caller's sub

    const res = await asVolunteer(request(app).put('/turtles/7/update')).send(turtleBody);

    expect(res.status).toBeLessThan(400);
  });

  it('is unaffected for non-Volunteer recorders regardless of ownership', async () => {
    query = stubQuery('999'); // owned by someone else entirely

    const faRes = await asAssistant(request(app).put('/turtles/7/update')).send(turtleBody);
    expect(faRes.status).toBeLessThan(400);

    const leaderRes = await asLeader(request(app).put('/turtles/7/update')).send(turtleBody);
    expect(leaderRes.status).toBeLessThan(400);

    const coordRes = await asCoordinator(request(app).put('/turtles/7/update')).send(turtleBody);
    expect(coordRes.status).toBeLessThan(400);
  });

  it('still records an "updated" audit entry on a legitimate update', async () => {
    query = stubQuery('51');

    await asVolunteer(request(app).put('/turtles/7/update')).send(turtleBody);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO record_audit'),
      expect.arrayContaining(['turtle', 7, 'updated']),
    );
  });
});

describe('PUT /emergences/:id (QA-030 audit gap)', () => {
  it("still refuses a Volunteer editing someone else's emergence", async () => {
    query = stubQuery('999');

    const res = await asVolunteer(request(app).put('/emergences/119')).send(emergenceBody);

    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE turtle_emergences'),
      expect.anything(),
    );
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO record_reviews'),
      expect.anything(),
    );
  });

  it('writes an "updated" audit entry on a successful update', async () => {
    query = stubQuery('51');

    await asVolunteer(request(app).put('/emergences/119')).send(emergenceBody);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO record_audit'),
      expect.arrayContaining(['emergence', 119, 'updated']),
    );
  });
});
