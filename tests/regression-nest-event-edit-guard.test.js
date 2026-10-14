// QA-081: a Volunteer (and, the brief worried, a Field Assistant) could edit
// ANY nest event through the API, bypassing the review queue - nest_event is
// in the frontend's resubmit-editable set, so the only legitimate path for a
// Volunteer through this route is "My Submissions > Edit & send back for
// review" on their OWN record, the same ownership check record_audit already
// provides for turtles (QA-030) and emergences. Field Assistant/Leader/
// Coordinator stay unrestricted, matching that same precedent.
import { describe, it, expect, afterAll, vi } from 'vitest';
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

const nestEventBody = {
  event_type: 'Excavation',
  nest_id: 7,
  nest_code: 'QA-Nest-7',
  hatched_count: 10,
};

const nestEventRow = { id: 119, nest_id: 7, nest_code: 'QA-Nest-7', event_type: 'Excavation' };

// Builds a db.query stub whose ownership lookup (the record_audit SELECT
// isOwnRecord issues) returns `ownerId`, and whose other lookups return
// whatever a successful update needs. Pass `ownershipThrows` to simulate the
// lookup itself failing.
const stubQuery = (ownerId, { ownershipThrows = false, updateRows = [nestEventRow] } = {}) =>
  vi.spyOn(db, 'query').mockImplementation((sql) => {
    const text = String(sql);
    if (text.includes('FROM record_audit') && text.includes("action = 'created'")) {
      if (ownershipThrows) return Promise.reject(new Error('connection lost'));
      return Promise.resolve({ rows: ownerId == null ? [] : [{ actor_id: ownerId }] });
    }
    if (text.includes('FROM turtle_nests')) {
      return Promise.resolve({ rows: [{ total_num_eggs: 100, emerged_so_far: 0 }] });
    }
    if (text.includes('UPDATE turtle_nest_events')) {
      return Promise.resolve({ rows: updateRows, rowCount: updateRows.length });
    }
    if (text.includes('INSERT INTO record_audit')) {
      return Promise.resolve({ rows: [{ id: 1 }] });
    }
    return Promise.resolve({ rows: [] });
  });

afterAll(() => db.end().catch(() => {}));

describe('PUT /nest-events/:id ownership guard (QA-081)', () => {
  it("refuses a Volunteer editing someone else's nest event", async () => {
    const query = stubQuery('999'); // owner is a different user than caller (sub '51')

    const res = await asVolunteer(request(app).put('/nest-events/119')).send(nestEventBody);

    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE turtle_nest_events'),
      expect.anything(),
    );
  });

  it('allows a Volunteer editing their OWN nest event', async () => {
    stubQuery('51'); // owner matches caller's sub

    const res = await asVolunteer(request(app).put('/nest-events/119')).send(nestEventBody);

    expect(res.status).toBeLessThan(400);
  });

  it('is unaffected for Field Assistant regardless of ownership', async () => {
    stubQuery('999'); // owned by someone else entirely

    const res = await asAssistant(request(app).put('/nest-events/119')).send(nestEventBody);

    expect(res.status).toBeLessThan(400);
  });

  it('is unaffected for Field Leader and Project Coordinator regardless of ownership', async () => {
    stubQuery('999'); // owned by someone else entirely

    const leaderRes = await asLeader(request(app).put('/nest-events/119')).send(nestEventBody);
    expect(leaderRes.status).toBeLessThan(400);

    const coordRes = await asCoordinator(request(app).put('/nest-events/119')).send(nestEventBody);
    expect(coordRes.status).toBeLessThan(400);
  });

  it('still records an "updated" audit entry on a legitimate update', async () => {
    const query = stubQuery('51');

    await asVolunteer(request(app).put('/nest-events/119')).send(nestEventBody);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO record_audit'),
      expect.arrayContaining(['nest_event', 119, 'updated']),
    );
  });

  it('fails closed (403, not 500) when the ownership lookup itself errors', async () => {
    const query = stubQuery(null, { ownershipThrows: true });

    const res = await asVolunteer(request(app).put('/nest-events/119')).send(nestEventBody);

    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE turtle_nest_events'),
      expect.anything(),
    );
  });

  it('still 404s for a non-existent id once a Volunteer passes the ownership check', async () => {
    stubQuery('51', { updateRows: [] });

    const res = await asVolunteer(request(app).put('/nest-events/999999')).send(nestEventBody);

    expect(res.status).toBe(404);
  });
});
