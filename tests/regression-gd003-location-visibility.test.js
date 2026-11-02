// GD-003: PRIVACY.md's "Who can see it" section admitted every signed-in
// role, including Field Volunteer, could read exact nest/emergence GPS and
// the triangulation/relocation photos - the one thing worth protecting for a
// project with poaching risk. `nest_location_visibility` ("restricted", the
// default, or "open") gates that: "restricted" nulls the coordinate fields
// and blocks the photo routes for anyone outside AI_ROLES (Coordinator,
// Field Leader, Field Assistant); "open" shows everyone everything, same as
// before this setting existed.
//
// What these cases pin down:
//   - unconfigured ("restricted" by default) hides coordinates from a Field
//     Volunteer, including that volunteer's own submission - no self-exception
//   - AI_ROLES (Coordinator/Field Leader/Field Assistant) always see everything
//   - "open" mode shows everyone everything
//   - the photo routes 403 a Field Volunteer in restricted mode rather than
//     returning a redacted response
//   - the setting is coordinator-only to change, and persists
//   - nest-events (original/reburied GPS) and morning-surveys (corner GPS,
//     and their linked nests/emergences) follow the same rule
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
const asAssistant = as('Field Assistant');
const asVolunteer = as('Field Volunteer', '42');

const NEST_ROW = {
  id: 1, nest_code: 'LG2-1', gps_lat: '37.1', gps_long: '21.5',
  tri_tl_lat: '37.11', tri_tl_long: '21.51', tri_tl_desc: 'Rock', tri_tl_distance: '3',
  tri_tr_lat: '37.12', tri_tr_long: '21.52', tri_tr_desc: 'Tree', tri_tr_distance: '4',
  submitted_by: 42,
};

let query;
let stored;

beforeEach(() => {
  stored = {};
  query = vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    const text = String(sql);
    if (text.includes('FROM app_settings')) {
      return { rows: stored[params?.[0]] ? [{ value: stored[params[0]] }] : [] };
    }
    if (text.includes('INSERT INTO app_settings')) {
      stored[params[0]] = JSON.parse(params[1]);
      return { rows: [] };
    }
    if (text.includes('FROM turtle_nests n') || text.includes('WITH excavation')) {
      return { rows: [{ ...NEST_ROW }] };
    }
    if (text === 'SELECT n.*, e.track_sketch\n      FROM turtle_nests n\n      LEFT JOIN turtle_emergences e ON e.id = n.emergence_id\n      WHERE n.nest_code = $1\n      LIMIT 1;' ||
        (text.includes('FROM turtle_nests n') && text.includes('LEFT JOIN turtle_emergences e'))) {
      return { rows: [{ ...NEST_ROW }] };
    }
    if (text.includes('FROM turtle_emergences e') && text.includes('LEFT JOIN turtle_nests n')) {
      return { rows: [{ id: 5, gps_lat: '37.1', gps_long: '21.5', emergence_type: 'Nesting' }] };
    }
    if (text === 'SELECT * FROM turtle_emergences WHERE id = $1 LIMIT 1;') {
      return { rows: [{ id: 5, gps_lat: '37.1', gps_long: '21.5' }] };
    }
    if (text.includes('FROM turtle_nest_events WHERE nest_code = ANY')) {
      return { rows: [{ nest_code: 'LG2-1', original_gps_lat: '37.2', original_gps_long: '21.6', reburied_gps_lat: '37.3', reburied_gps_long: '21.7' }] };
    }
    if (text.includes('FROM turtle_nests WHERE nest_code = $1 LIMIT 1')) {
      return { rows: [{ id: 1, nest_code: 'LG2-1' }] };
    }
    if (text.includes('FROM turtle_nest_events') && text.includes('WHERE nest_code = $1')) {
      return { rows: [{ nest_code: 'LG2-1', original_gps_lat: '37.2', original_gps_long: '21.6', reburied_gps_lat: '37.3', reburied_gps_long: '21.7' }] };
    }
    if (text.includes('FROM morning_surveys ms')) {
      return { rows: [{ id: 9, beach_name: 'Gerani', tl_lat: '37.4', tl_long: '21.8', tr_lat: '37.5', tr_long: '21.9' }] };
    }
    if (text.includes('FROM morning_survey_nests')) {
      return { rows: [{ ...NEST_ROW }] };
    }
    if (text.includes('FROM morning_survey_emergences')) {
      return { rows: [{ id: 5, gps_lat: '37.1', gps_long: '21.5' }] };
    }
    if (text.includes('SELECT image, mime_type FROM nest_photos')) {
      return { rows: [{ image: Buffer.from('fake'), mime_type: 'image/png' }] };
    }
    if (text.includes('FROM nest_photos WHERE nest_id')) {
      return { rows: [{ id: 2, nest_id: 1, mime_type: 'image/png' }] };
    }
    return { rows: [] };
  });
});
afterAll(() => db.end().catch(() => {}));

describe('nest_location_visibility setting', () => {
  it('defaults to restricted when unset', async () => {
    const res = await asVolunteer(request(app).get('/settings'));
    expect(res.body.nest_location_visibility).toBe('restricted');
  });

  it('is coordinator only to change', async () => {
    const res = await asLeader(request(app).put('/settings/nest-location-visibility')).send({ value: 'open' });
    expect(res.status).toBe(403);
  });

  it('persists a coordinator change, reflected in the next GET /settings', async () => {
    const put = await asCoordinator(request(app).put('/settings/nest-location-visibility')).send({ value: 'open' });
    expect(put.status).toBe(200);
    expect(put.body.nest_location_visibility).toBe('open');

    const get = await asVolunteer(request(app).get('/settings'));
    expect(get.body.nest_location_visibility).toBe('open');
  });

  it('rejects a value that is neither "open" nor "restricted"', async () => {
    const res = await asCoordinator(request(app).put('/settings/nest-location-visibility')).send({ value: 'sometimes' });
    expect(res.status).toBe(400);
    expect(stored.nest_location_visibility).toBeUndefined();
  });
});

describe('GET /nests — restricted by default', () => {
  it('hides GPS and triangulation fields from a Field Volunteer, even their own nest', async () => {
    const res = await asVolunteer(request(app).get('/nests'));
    expect(res.status).toBe(200);
    const nest = res.body.nests[0];
    expect(nest.gps_lat).toBeNull();
    expect(nest.gps_long).toBeNull();
    expect(nest.tri_tl_lat).toBeNull();
    expect(nest.tri_tl_long).toBeNull();
    expect(nest.tri_tl_desc).toBeNull();
    expect(nest.tri_tl_distance).toBeNull();
    expect(nest.tri_tr_lat).toBeNull();
    expect(nest.location_hidden).toBe(true);
  });

  it.each([
    ['Project Coordinator', asCoordinator],
    ['Field Leader', asLeader],
    ['Field Assistant', asAssistant],
  ])('keeps exact coordinates for %s', async (_label, asRole) => {
    const res = await asRole(request(app).get('/nests'));
    const nest = res.body.nests[0];
    expect(nest.gps_lat).toBe('37.1');
    expect(nest.location_hidden).toBeUndefined();
  });

  it('shows everyone everything once the setting is "open"', async () => {
    stored.nest_location_visibility = { value: 'open' };
    const res = await asVolunteer(request(app).get('/nests'));
    const nest = res.body.nests[0];
    expect(nest.gps_lat).toBe('37.1');
    expect(nest.location_hidden).toBeUndefined();
  });
});

describe('GET /nests/:nest_code', () => {
  it('redacts for a Field Volunteer in restricted mode', async () => {
    const res = await asVolunteer(request(app).get('/nests/LG2-1'));
    expect(res.status).toBe(200);
    expect(res.body.nest.gps_lat).toBeNull();
    expect(res.body.nest.location_hidden).toBe(true);
  });
});

describe('GET /emergences and /emergences/:id', () => {
  it('redacts the list for a Field Volunteer in restricted mode', async () => {
    const res = await asVolunteer(request(app).get('/emergences'));
    expect(res.status).toBe(200);
    expect(res.body.emergences[0].gps_lat).toBeNull();
    expect(res.body.emergences[0].location_hidden).toBe(true);
  });

  it('redacts a single emergence for a Field Volunteer in restricted mode', async () => {
    const res = await asVolunteer(request(app).get('/emergences/5'));
    expect(res.status).toBe(200);
    expect(res.body.emergence.gps_lat).toBeNull();
    expect(res.body.emergence.location_hidden).toBe(true);
  });

  it('keeps coordinates for a Field Leader', async () => {
    const res = await asLeader(request(app).get('/emergences/5'));
    expect(res.body.emergence.gps_lat).toBe('37.1');
  });
});

describe('nest-events — original/reburied GPS', () => {
  it('redacts GET /nest-events?codes=... for a Field Volunteer', async () => {
    const res = await asVolunteer(request(app).get('/nest-events').query({ codes: 'LG2-1' }));
    expect(res.status).toBe(200);
    const event = res.body.eventsByCode['LG2-1'][0];
    expect(event.original_gps_lat).toBeNull();
    expect(event.reburied_gps_lat).toBeNull();
    expect(event.location_hidden).toBe(true);
  });

  it('redacts GET /nest-events/:nest_code for a Field Volunteer', async () => {
    const res = await asVolunteer(request(app).get('/nest-events/LG2-1'));
    expect(res.status).toBe(200);
    const event = res.body.events[0];
    expect(event.original_gps_long).toBeNull();
    expect(event.reburied_gps_long).toBeNull();
    expect(event.location_hidden).toBe(true);
  });

  it('keeps original/reburied GPS for a Field Assistant', async () => {
    const res = await asAssistant(request(app).get('/nest-events/LG2-1'));
    const event = res.body.events[0];
    expect(event.original_gps_lat).toBe('37.2');
  });
});

describe('GET /morning-surveys/:id', () => {
  it('redacts the survey corner GPS and the linked nests/emergences for a Field Volunteer', async () => {
    const res = await asVolunteer(request(app).get('/morning-surveys/9'));
    expect(res.status).toBe(200);
    expect(res.body.survey.tl_lat).toBeNull();
    expect(res.body.survey.location_hidden).toBe(true);
    expect(res.body.survey.nests[0].gps_lat).toBeNull();
    expect(res.body.survey.emergences[0].gps_lat).toBeNull();
  });

  it('keeps the survey corner GPS for a Project Coordinator', async () => {
    const res = await asCoordinator(request(app).get('/morning-surveys/9'));
    expect(res.body.survey.tl_lat).toBe('37.4');
  });
});

describe('nest photo routes — blocked outright, not redacted', () => {
  it('403s GET /nests/:nestId/photos for a Field Volunteer in restricted mode', async () => {
    const res = await asVolunteer(request(app).get('/nests/1/photos'));
    expect(res.status).toBe(403);
  });

  it('403s GET /nest-photos/:photoId for a Field Volunteer in restricted mode', async () => {
    const res = await asVolunteer(request(app).get('/nest-photos/2'));
    expect(res.status).toBe(403);
  });

  it('allows a Field Leader through in restricted mode', async () => {
    const res = await asLeader(request(app).get('/nests/1/photos'));
    expect(res.status).toBe(200);
  });

  it('allows a Field Volunteer through once the setting is "open"', async () => {
    stored.nest_location_visibility = { value: 'open' };
    const listRes = await asVolunteer(request(app).get('/nests/1/photos'));
    expect(listRes.status).toBe(200);
    const photoRes = await asVolunteer(request(app).get('/nest-photos/2'));
    expect(photoRes.status).toBe(200);
  });
});
