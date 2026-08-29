import { describe, it, expect } from 'vitest';
import {
  auditNest, auditTurtle, auditEmergence, looksLikePlaceholderCoord,
} from '../scripts/lib/plausibility.mjs';

// These rules decide which records a cleanup run offers to delete, so the thing
// they must never do is flag a real record. Every "good" case below is taken
// from data already in the database.
const beaches = [
  { name: 'Lepeda', code: 'LP' },
  { name: 'Xi', code: 'XI' },
];

const goodNest = {
  nest_code: 'XI-1', beach: 'Xi', total_num_eggs: 104, current_num_eggs: 20,
  depth_top_egg_h: '18.00', depth_bottom_chamber_h: '62.00', distance_to_sea_s: 15,
  width_w: '22.00', status: 'hatching', date_found: '2026-08-11T00:00:00.000Z',
  gps_lat: '38.1732100', gps_long: '20.6627100',
};
const goodTurtle = {
  name: 'Calypso', species: 'Caretta caretta', sex: 'female',
  scl_max: '91.20', scl_min: '89.50', scw: '68.40',
  ccl_max: '93.00', ccl_min: '91.00', ccw: '69.10',
};
const severities = (findings) => findings.map((f) => `${f.severity}:${f.field}`);

describe('auditNest', () => {
  it('passes a real nest untouched', () => {
    expect(auditNest(goodNest, { beaches })).toEqual([]);
  });

  it('tolerates the fields the app leaves blank', () => {
    const sparse = { ...goodNest, current_num_eggs: null, depth_bottom_chamber_h: null, width_w: null };
    expect(auditNest(sparse, { beaches })).toEqual([]);
  });

  it('calls a negative clutch impossible', () => {
    const f = auditNest({ ...goodNest, total_num_eggs: -1 }, { beaches });
    expect(severities(f)).toContain('impossible:total_num_eggs');
  });

  it('flags more eggs remaining than were ever laid', () => {
    const f = auditNest({ ...goodNest, total_num_eggs: 90, current_num_eggs: 120 }, { beaches });
    expect(severities(f)).toContain('impossible:current_num_eggs');
  });

  it('flags a chamber floor above its ceiling', () => {
    const f = auditNest({ ...goodNest, depth_top_egg_h: '50.00', depth_bottom_chamber_h: '20.00' }, { beaches });
    expect(severities(f)).toContain('impossible:depth_bottom_chamber_h');
  });

  it('flags a nest found outside the nesting season', () => {
    const f = auditNest({ ...goodNest, date_found: '2026-03-11T00:00:00.000Z' }, { beaches });
    expect(severities(f)).toContain('suspect:date_found');
  });

  it('accepts the shoulders of the season', () => {
    // Past dates: a date in the future is a separate (impossible) finding, and
    // hard-coding this year's October would start failing every August.
    for (const d of ['2025-05-28T00:00:00.000Z', '2025-10-02T00:00:00.000Z']) {
      expect(auditNest({ ...goodNest, date_found: d }, { beaches })).toEqual([]);
    }
  });

  it('flags a nest code that does not match its beach', () => {
    const f = auditNest({ ...goodNest, nest_code: 'LP-9', beach: 'Xi' }, { beaches });
    expect(severities(f)).toContain('suspect:nest_code');
  });

  it('accepts the relocated-nest suffix', () => {
    const f = auditNest({ ...goodNest, nest_code: 'XI-1R', beach: 'Xi' }, { beaches });
    expect(f).toEqual([]);
  });

  it('does not check the beach when no beach list is supplied', () => {
    const f = auditNest({ ...goodNest, beach: 'Somewhere Else' }, {});
    expect(severities(f)).not.toContain('suspect:beach');
  });

  it('flags coordinates outside the survey area', () => {
    const f = auditNest({ ...goodNest, gps_lat: '51.5074000', gps_long: '-0.1278000' }, { beaches });
    expect(severities(f)).toContain('suspect:gps');
  });
});

describe('auditTurtle', () => {
  it('passes a real turtle untouched', () => {
    expect(auditTurtle(goodTurtle)).toEqual([]);
  });

  it('flags a curved length shorter than the straight one', () => {
    // Geometry: the curved tape follows the dome, so it can never read shorter.
    const f = auditTurtle({ ...goodTurtle, scl_max: '93.00', ccl_max: '89.00' });
    expect(severities(f)).toContain('impossible:ccl_max');
  });

  it('flags a minimum larger than its maximum', () => {
    const f = auditTurtle({ ...goodTurtle, scl_min: '99.00', scl_max: '91.20' });
    expect(severities(f)).toContain('impossible:scl_min');
  });

  it('sizes a green turtle against green turtle ranges', () => {
    const green = { ...goodTurtle, species: 'Chelonia mydas', scl_max: '102.30', scl_min: '99.00',
      ccl_max: '105.60', ccl_min: '103.00', scw: '80.00', ccw: '86.20' };
    expect(auditTurtle(green)).toEqual([]);
    // The same measurements on a loggerhead would be out of range.
    expect(severities(auditTurtle({ ...green, species: 'Caretta caretta' }))).toContain('suspect:scl_max');
  });

  it('flags placeholder names', () => {
    for (const name of ['test', 'asdf', 'TEST turtle', 'xxxx']) {
      expect(severities(auditTurtle({ ...goodTurtle, name }))).toContain('suspect:name');
    }
  });

  it('does not mistake a real name for a placeholder', () => {
    for (const name of ['Athena', 'Barbara', 'Foxtrot', 'Testudo']) {
      expect(severities(auditTurtle({ ...goodTurtle, name }))).not.toContain('suspect:name');
    }
  });
});

describe('auditEmergence', () => {
  it('passes a real emergence untouched', () => {
    expect(auditEmergence({
      distance_to_sea_s: 15, gps_lat: '38.1732100', gps_long: '20.6627100',
      event_date: '2026-08-11T00:00:00.000Z',
    })).toEqual([]);
  });

  it('flags keypad-walk coordinates', () => {
    const f = auditEmergence({
      distance_to_sea_s: 45, gps_lat: '38.1234500', gps_long: '20.5432100',
      event_date: '2026-08-13T00:00:00.000Z',
    });
    expect(severities(f)).toContain('suspect:gps');
  });

  it('flags a record dated in the future', () => {
    const next = new Date(Date.now() + 86400000).toISOString();
    expect(severities(auditEmergence({ distance_to_sea_s: 10, event_date: next })))
      .toContain('impossible:event_date');
  });
});

describe('looksLikePlaceholderCoord', () => {
  it('catches sequential and repeated digits', () => {
    expect(looksLikePlaceholderCoord('38.1234500', '20.5432100')).toBe(true);
    expect(looksLikePlaceholderCoord('38.1111100', '20.5270400')).toBe(true);
  });

  it('leaves real readings alone', () => {
    expect(looksLikePlaceholderCoord('38.1732100', '20.6627100')).toBe(false);
    expect(looksLikePlaceholderCoord('38.1693000', '20.5861000')).toBe(false);
  });
});
