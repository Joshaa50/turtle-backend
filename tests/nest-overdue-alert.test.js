// A nest well past a normal incubation (see OVERDUE_DAYS in the frontend's
// lib/nestLifecycle.ts) needs a reviewer to send someone to excavate it. That
// used to only show as a badge on the nest itself - a reviewer who wasn't
// already looking at that nest had no way to know. This is the alert that
// surfaces it in the bell instead.
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const as = (role, sub = '1') => (req) =>
  req.set('Authorization', `Bearer ${jwt.sign({ sub, role, email: `${sub}@turtleguard.demo` }, SECRET, { expiresIn: '1h' })}`);
const asCoordinator = as('Project Coordinator');
const asLeader = as('Field Leader');
const asVolunteer = as('Field Volunteer');

const OVERDUE_ROW = { nest_code: 'AI-2', beach: 'Agios Ioannis', date_found: '2026-06-01T00:00:00.000Z' };

let query;
beforeEach(() => {
  query = vi.spyOn(db, 'query').mockImplementation(async (sql) => {
    const text = String(sql);
    if (text.includes('FROM turtle_nests') && text.includes('date_found <=')) {
      return { rows: [OVERDUE_ROW] };
    }
    return { rows: [] };
  });
});
afterAll(() => db.end().catch(() => {}));

describe('nest_overdue alert', () => {
  it('is shown to a coordinator', async () => {
    const res = await asCoordinator(request(app).get('/alerts')).expect(200);
    const alert = res.body.alerts.find((a) => a.kind === 'nest_overdue');
    expect(alert).toBeTruthy();
    expect(alert.id).toBe('nest-overdue-AI-2');
    expect(alert.message).toContain('AI-2');
    expect(alert.message).toContain('Agios Ioannis');
    expect(alert.can_acknowledge).toBe(false);
  });

  it('is shown to a field leader', async () => {
    const res = await asLeader(request(app).get('/alerts')).expect(200);
    expect(res.body.alerts.some((a) => a.kind === 'nest_overdue')).toBe(true);
  });

  it('is never shown to a volunteer', async () => {
    const res = await asVolunteer(request(app).get('/alerts')).expect(200);
    expect(res.body.alerts.some((a) => a.kind === 'nest_overdue')).toBe(false);
    // A volunteer's request should not even run the overdue-nest query.
    expect(query.mock.calls.some(([sql]) => String(sql).includes('date_found <='))).toBe(false);
  });

  it('is absent when nothing is overdue', async () => {
    query.mockImplementation(async () => ({ rows: [] }));
    const res = await asCoordinator(request(app).get('/alerts')).expect(200);
    expect(res.body.alerts.some((a) => a.kind === 'nest_overdue')).toBe(false);
  });
});
