// QA-064: a Field Assistant could archive or restore any turtle via the API
// even though the UI never offers it to them - the same class of gap as
// QA-001/QA-030 (nests/emergence edits) and QA-042 (emergence delete), and
// inconsistent with FA already getting 403 on DELETE /turtles/:id.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;

const tokenFor = (role) =>
  jwt.sign({ sub: '22', role, email: 'nikos.floros@turtleguard.demo' }, SECRET, { expiresIn: '1h' });

const asAssistant = (req) => req.set('Authorization', `Bearer ${tokenFor('Field Assistant')}`);
const asLeader = (req) => req.set('Authorization', `Bearer ${tokenFor('Field Leader')}`);

let query;

beforeEach(() => {
  query = vi.spyOn(db, 'query').mockResolvedValue({
    rows: [{ id: 32, name: 'Phoebe', is_archived: true }],
  });
});

afterAll(() => db.end().catch(() => {}));

describe('PUT /turtles/:id/archive role guard (QA-064)', () => {
  it('refuses a Field Assistant, matching DELETE /turtles/:id', async () => {
    const res = await asAssistant(request(app).put('/turtles/32/archive').send({ archived: true }));

    expect(res.status).toBe(403);
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE turtles SET is_archived'),
      expect.anything(),
    );
  });

  it('still lets a Field Leader archive', async () => {
    const res = await asLeader(request(app).put('/turtles/32/archive').send({ archived: true }));

    expect(res.status).toBe(200);
  });
});
