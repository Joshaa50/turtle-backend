import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import server from '../server.js';

const { app, db } = server;
const SECRET = process.env.JWT_SECRET;
const tokenFor = (role) =>
  jwt.sign({ sub: '5', role, email: 'r@example.com' }, SECRET, { expiresIn: '1h' });

// A 1x1 PNG, small enough to be a real payload without being a real photo.
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let query;
beforeEach(() => {
  query = vi.spyOn(db, 'query').mockResolvedValue({ rows: [{ id: 1, nest_code: 'LG2-1', nest_id: 4 }], rowCount: 1 });
});
afterAll(() => db.end().catch(() => {}));

const post = (body, role = 'Field Volunteer') =>
  request(app).post('/nests/4/photos').set('Authorization', `Bearer ${tokenFor(role)}`).send(body);

describe('nest photos', () => {
  it('creates record_photos only after the pool exists', async () => {
    // Same trap the audit table fell into: a migration above `const db` runs in
    // the pool's temporal dead zone, throws into its own catch, and the table
    // is silently never created.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    expect(src.indexOf('CREATE TABLE IF NOT EXISTS nest_photos'))
      .toBeGreaterThan(src.indexOf('const db = new Pool'));
  });

  describe('uploading', () => {
    it('accepts a photo from anyone who records fieldwork', async () => {
      const res = await post({ image: TINY_PNG, mime_type: 'image/png', caption: 'Cage in place' });
      expect(res.status).toBe(201);
      expect(res.body.photo.size_bytes).toBeGreaterThan(0);
    });

    it('refuses an unauthenticated upload', async () => {
      expect((await request(app).post('/nests/4/photos').send({ image: TINY_PNG, mime_type: 'image/png' })).status).toBe(401);
    });

    it('refuses a file type that is not an image', async () => {
      const res = await post({ image: TINY_PNG, mime_type: 'application/pdf' });
      expect(res.status).toBe(400);
      expect(query).not.toHaveBeenCalled();
    });

    it('refuses a photo over the size cap rather than bloating the row', async () => {
      const tooBig = Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64');
      const res = await post({ image: tooBig, mime_type: 'image/jpeg' });
      expect(res.status).toBe(413);
      expect(res.body.error).toMatch(/under 2MB/i);
    });

    it('accepts a data URL as well as bare base64', async () => {
      const res = await post({ image: `data:image/png;base64,${TINY_PNG}`, mime_type: 'image/png' });
      expect(res.status).toBe(201);
    });

    it('404s for a nest that does not exist', async () => {
      query.mockResolvedValue({ rows: [] });
      expect((await post({ image: TINY_PNG, mime_type: 'image/png' })).status).toBe(404);
    });

    it('records the upload in the audit trail', async () => {
      await post({ image: TINY_PNG, mime_type: 'image/png' });
      const audit = query.mock.calls.find(([s]) => /INSERT INTO record_audit/i.test(s));
      expect(audit).toBeTruthy();
      expect(audit[1][6]).toMatch(/Photo added/);
    });
  });

  describe('listing', () => {
    it('returns metadata and sizes, never the image bytes', async () => {
      query.mockResolvedValue({ rows: [{ id: 1, caption: 'Cage', size_bytes: 4211 }] });
      const res = await request(app).get('/nests/4/photos').set('Authorization', `Bearer ${tokenFor('Field Volunteer')}`);
      expect(res.status).toBe(200);
      // Opening a nest with a season of photos must not download all of them.
      expect(query.mock.calls[0][0]).toMatch(/octet_length\(image\)/);
      expect(query.mock.calls[0][0]).not.toMatch(/SELECT image|, image/);
    });

    it('rejects a non-numeric nest id before touching the database', async () => {
      const res = await request(app).get('/nests/abc/photos').set('Authorization', `Bearer ${tokenFor('Field Leader')}`);
      expect(res.status).toBe(400);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('serving one photo', () => {
    it('sends bytes with the stored content type, not base64 JSON', async () => {
      query.mockResolvedValue({ rows: [{ image: Buffer.from(TINY_PNG, 'base64'), mime_type: 'image/png' }] });
      const res = await request(app).get('/nest-photos/9').set('Authorization', `Bearer ${tokenFor('Field Volunteer')}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/image\/png/);
      expect(res.body).toBeInstanceOf(Buffer);
    });

    it('404s for a photo that does not exist', async () => {
      query.mockResolvedValue({ rows: [] });
      expect((await request(app).get('/nest-photos/999').set('Authorization', `Bearer ${tokenFor('Field Leader')}`)).status).toBe(404);
    });
  });

  describe('deleting', () => {
    it('is closed to a volunteer — removing evidence is a reviewer decision', async () => {
      const res = await request(app).delete('/nest-photos/9').set('Authorization', `Bearer ${tokenFor('Field Volunteer')}`);
      expect(res.status).toBe(403);
      expect(query).not.toHaveBeenCalled();
    });

    it('lets a reviewer delete, and records it', async () => {
      query.mockResolvedValue({ rows: [{ id: 9, nest_id: 4, caption: 'Blurred' }] });
      const res = await request(app).delete('/nest-photos/9').set('Authorization', `Bearer ${tokenFor('Field Leader')}`);
      expect(res.status).toBe(200);
      const audit = query.mock.calls.find(([s]) => /INSERT INTO record_audit/i.test(s));
      expect(audit[1][6]).toMatch(/Photo removed/);
    });
  });
});
