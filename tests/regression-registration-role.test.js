import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import server from '../server.js';

const { app, db } = server;

let query;
beforeEach(() => {
  query = vi.spyOn(db, 'query').mockResolvedValue({
    rows: [{ id: 99, first_name: 'Mal', last_name: 'Ory', email: 'm@example.com', role: 'Field Volunteer' }],
  });
});
afterAll(() => db.end().catch(() => {}));

const body = (over = {}) => ({
  first_name: 'Mal',
  last_name: 'Ory',
  email: 'm@example.com',
  password: 'a-real-password',
  station: 'Lix',
  privacy_notice_accepted: true,
  ...over,
});

// Registration used to take `role` straight from the request body, so anyone
// could sign up as a Project Coordinator and the only safeguard was an
// approver noticing before they clicked approve.
describe('POST /users/register cannot self-assign a role', () => {
  const roleWrittenToDb = () => {
    const call = query.mock.calls.find(([sql]) => /INSERT INTO\s+users/i.test(sql));
    expect(call, 'expected an INSERT into users').toBeTruthy();
    return call[1][4]; // role is the 5th bound parameter
  };

  it('stores Field Volunteer when the body asks for Project Coordinator', async () => {
    const res = await request(app).post('/users/register').send(body({ role: 'Project Coordinator' }));
    expect(res.status).toBeLessThan(500);
    expect(roleWrittenToDb()).toBe('Field Volunteer');
  });

  it('stores Field Volunteer when the body asks for Field Leader', async () => {
    await request(app).post('/users/register').send(body({ role: 'Field Leader' }));
    expect(roleWrittenToDb()).toBe('Field Volunteer');
  });

  it('stores Field Volunteer when no role is sent at all', async () => {
    await request(app).post('/users/register').send(body());
    expect(roleWrittenToDb()).toBe('Field Volunteer');
  });

  it('still refuses without the data-use notice, whatever role is claimed', async () => {
    const res = await request(app)
      .post('/users/register')
      .send(body({ role: 'Project Coordinator', privacy_notice_accepted: false }));
    expect(res.status).toBe(400);
  });
});
