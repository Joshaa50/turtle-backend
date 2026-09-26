import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const tokenFor = (role) =>
  jwt.sign({ sub: '7', role, email: 'e@example.com' }, SECRET, { expiresIn: '1h' });

let query;
beforeEach(() => {
  query = vi.spyOn(db, 'query').mockRejectedValue(new Error('unstubbed db.query'));
});
afterAll(() => db.end().catch(() => {}));

const auditInsert = () =>
  query.mock.calls.find(([sql]) => /INSERT INTO record_audit/i.test(sql));

describe('audit trail', () => {
  describe('reading it', () => {
    it('is closed to a volunteer — who touched a record is staff information', async () => {
      const res = await request(app).get('/audit/nest/4').set('Authorization', `Bearer ${tokenFor('Field Volunteer')}`);
      expect(res.status).toBe(403);
      expect(query).not.toHaveBeenCalled();
    });

    it('is closed to an unauthenticated caller', async () => {
      const res = await request(app).get('/audit/nest/4');
      expect(res.status).toBe(401);
    });

    it('returns a record history to a reviewer, newest first', async () => {
      query.mockResolvedValue({
        rows: [
          { id: 2, action: 'updated', actor_email: 'b@example.com', occurred_at: '2026-09-02T00:00:00Z' },
          { id: 1, action: 'created', actor_email: 'a@example.com', occurred_at: '2026-09-01T00:00:00Z' },
        ],
      });
      const res = await request(app).get('/audit/nest/4').set('Authorization', `Bearer ${tokenFor('Field Leader')}`);
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(2);
      expect(query.mock.calls[0][0]).toMatch(/ORDER BY occurred_at DESC/i);
    });

    it('flags a trail with no creation entry as incomplete, not as proof of nothing', async () => {
      query.mockResolvedValue({ rows: [{ id: 9, action: 'updated' }] });
      const res = await request(app).get('/audit/nest/4').set('Authorization', `Bearer ${tokenFor('Project Coordinator')}`);
      expect(res.body.complete).toBe(false);
    });

    it('rejects a non-numeric record id before touching the database', async () => {
      const res = await request(app).get('/audit/nest/abc').set('Authorization', `Bearer ${tokenFor('Field Leader')}`);
      expect(res.status).toBe(400);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('writing it', () => {
    it('records who created an emergence, with their role', async () => {
      query.mockResolvedValue({ rows: [{ id: 51, beach: 'Xi' }] });

      await request(app)
        .post('/emergences')
        .set('Authorization', `Bearer ${tokenFor('Field Assistant')}`)
        .send({ event_date: '2026-09-20', beach: 'Xi' });

      const call = auditInsert();
      expect(call, 'expected an audit row for the new emergence').toBeTruthy();
      const [, params] = call;
      expect(params[0]).toBe('emergence');
      expect(params[2]).toBe('created');
      expect(params[4]).toBe('e@example.com');
      expect(params[5]).toBe('Field Assistant');
    });

    it('names the permission that changed when a user is edited', async () => {
      query.mockResolvedValue({ rows: [{ id: 12, role: 'Field Leader' }] });

      await request(app)
        .patch('/users/12')
        .set('Authorization', `Bearer ${tokenFor('Project Coordinator')}`)
        .send({ role: 'Field Leader' });

      const call = auditInsert();
      expect(call).toBeTruthy();
      // "User updated" in a permission log answers nothing.
      expect(call[1][6]).toMatch(/role -> Field Leader/);
    });

    it('does not fail the save when the audit write itself fails', async () => {
      // A gap in the trail beats telling a field worker their record was lost
      // when it was not.
      query.mockImplementation((sql) =>
        /INSERT INTO record_audit/i.test(sql)
          ? Promise.reject(new Error('audit table missing'))
          : Promise.resolve({ rows: [{ id: 77, beach: 'Vatsa' }] })
      );

      const res = await request(app)
        .post('/emergences')
        .set('Authorization', `Bearer ${tokenFor('Field Leader')}`)
        .send({ event_date: '2026-09-20', beach: 'Vatsa' });

      expect(res.status).toBe(201);
    });
  });
});
