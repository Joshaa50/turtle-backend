// What a believable Turtle Guard record looks like.
//
// One source of truth, used by two scripts that must agree: the auditor flags
// records outside these bounds, and the seeder generates records inside them.
// If they drifted apart, the seeder would produce data its own auditor deletes.
//
// The ranges are field-realistic for Mediterranean loggerheads on Kefalonia, but
// they are conventions, not laws of nature - widen one and the audit softens with
// it. They are deliberately generous: the aim is to catch -1 eggs and a nest laid
// in March, not to second-guess a real outlier a volunteer actually measured.

export const SITE = {
  // Kefalonia, west coast survey areas. Anything outside this box is not a
  // beach this project surveys, whatever the record says.
  bbox: { latMin: 38.05, latMax: 38.42, lonMin: 20.40, lonMax: 20.85 },
};

// Nesting runs late May to August here; hatching continues into October. A nest
// "found" in February is a seeded row that took today's date, not fieldwork.
export const SEASON = { firstMonth: 5, lastMonth: 10 };

export const NEST = {
  eggs: { min: 40, max: 160 },            // Med loggerhead clutches average ~115
  depthTopEgg: { min: 12, max: 55 },      // cm to the top of the egg chamber
  depthBottomChamber: { min: 30, max: 80 },
  distanceToSea: { min: 1, max: 120 },    // m
  width: { min: 15, max: 40 },            // cm
  statuses: ['incubating', 'hatching', 'hatched', 'predated', 'inundated', 'unknown'],
};

export const TURTLE = {
  species: {
    // Mediterranean loggerheads run smaller than the global range for the
    // species (which reaches ~110cm): mature females here are typically 66-85,
    // and the largest animal in this database is 94.5. A 102cm "loggerhead" is
    // far more likely a mis-keyed number or a misidentified green turtle.
    'Caretta caretta': { scl: { min: 55, max: 100 } },
    'Chelonia mydas': { scl: { min: 75, max: 125 } },
    'Dermochelys coriacea': { scl: { min: 120, max: 180 } },
  },
  sexes: ['male', 'female', 'unknown'],
};

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const inRange = (v, r) => v !== null && !Number.isNaN(v) && v >= r.min && v <= r.max;

// Coordinates like 38.12345 / 20.54321 are someone walking up the keypad, not a
// GPS reading. Checked on the digits after the decimal point.
export const looksLikePlaceholderCoord = (lat, lon) => {
  const digits = (v) => String(v ?? '').split('.')[1]?.replace(/0+$/, '') ?? '';
  const sequential = (d) => d.length >= 4 && /^(?:0?1?2?3?4?5?6?7?8?9?)$/.test(d);
  const repeated = (d) => d.length >= 4 && /^(\d)\1+$/.test(d);
  return [digits(lat), digits(lon)].some((d) => sequential(d) || repeated(d));
};

const issue = (severity, field, message) => ({ severity, field, message });

/** Findings for one nest. `impossible` = cannot be true; `suspect` = probably wrong. */
export const auditNest = (n, { beaches = [] } = {}) => {
  const out = [];
  const eggs = num(n.total_num_eggs);
  const top = num(n.depth_top_egg_h);
  const bottom = num(n.depth_bottom_chamber_h);
  const current = num(n.current_num_eggs);

  if (eggs !== null && eggs < 0) out.push(issue('impossible', 'total_num_eggs', `${eggs} eggs`));
  else if (eggs !== null && !inRange(eggs, NEST.eggs))
    out.push(issue('suspect', 'total_num_eggs', `${eggs} eggs is outside ${NEST.eggs.min}-${NEST.eggs.max}`));

  if (current !== null && eggs !== null && eggs >= 0 && current > eggs)
    out.push(issue('impossible', 'current_num_eggs', `${current} remaining of ${eggs} laid`));

  if (top !== null && bottom !== null && bottom < top)
    out.push(issue('impossible', 'depth_bottom_chamber_h', `chamber floor (${bottom}cm) above its ceiling (${top}cm)`));

  if (top !== null && !inRange(top, NEST.depthTopEgg))
    out.push(issue('suspect', 'depth_top_egg_h', `${top}cm to the top egg is outside ${NEST.depthTopEgg.min}-${NEST.depthTopEgg.max}`));
  if (bottom !== null && !inRange(bottom, NEST.depthBottomChamber))
    out.push(issue('suspect', 'depth_bottom_chamber_h', `${bottom}cm chamber depth is outside ${NEST.depthBottomChamber.min}-${NEST.depthBottomChamber.max}`));

  const found = n.date_found ? new Date(n.date_found) : null;
  if (found && !Number.isNaN(found.valueOf())) {
    const m = found.getUTCMonth() + 1;
    if (m < SEASON.firstMonth || m > SEASON.lastMonth)
      out.push(issue('suspect', 'date_found', `found in ${found.toISOString().slice(0, 7)}, outside the nesting season`));
    if (found > new Date()) out.push(issue('impossible', 'date_found', 'found in the future'));
  }

  const lat = num(n.gps_lat), lon = num(n.gps_long);
  if (lat !== null && lon !== null) {
    if (lat < SITE.bbox.latMin || lat > SITE.bbox.latMax || lon < SITE.bbox.lonMin || lon > SITE.bbox.lonMax)
      out.push(issue('suspect', 'gps', `${lat}, ${lon} is outside the survey area`));
    if (looksLikePlaceholderCoord(n.gps_lat, n.gps_long))
      out.push(issue('suspect', 'gps', `${lat}, ${lon} looks like a placeholder, not a reading`));
  }

  if (n.status && !NEST.statuses.includes(String(n.status).toLowerCase()))
    out.push(issue('suspect', 'status', `unknown status "${n.status}"`));

  // A nest code should start with its beach's code: LP-2 on Lepeda, not on Xi.
  const beach = beaches.find((b) => b.name === n.beach);
  if (beach && n.nest_code && !String(n.nest_code).toUpperCase().startsWith(beach.code.toUpperCase()))
    out.push(issue('suspect', 'nest_code', `${n.nest_code} does not match ${n.beach} (expected ${beach.code}-*)`));
  if (n.beach && beaches.length && !beach)
    out.push(issue('suspect', 'beach', `"${n.beach}" is not a surveyed beach`));

  return out;
};

/** Findings for one turtle. */
export const auditTurtle = (t) => {
  const out = [];
  const sclMax = num(t.scl_max), sclMin = num(t.scl_min);
  const cclMax = num(t.ccl_max), cclMin = num(t.ccl_min);
  const scw = num(t.scw), ccw = num(t.ccw);

  // Curved measurements follow the shell over its dome, so they are always at
  // least the straight-line ones. This is geometry, not a convention.
  if (sclMax !== null && cclMax !== null && cclMax < sclMax)
    out.push(issue('impossible', 'ccl_max', `curved length ${cclMax} is shorter than straight ${sclMax}`));
  if (sclMin !== null && cclMin !== null && cclMin < sclMin)
    out.push(issue('impossible', 'ccl_min', `curved length ${cclMin} is shorter than straight ${sclMin}`));
  if (scw !== null && ccw !== null && ccw < scw)
    out.push(issue('impossible', 'ccw', `curved width ${ccw} is narrower than straight ${scw}`));

  if (sclMax !== null && sclMin !== null && sclMin > sclMax)
    out.push(issue('impossible', 'scl_min', `minimum ${sclMin} exceeds maximum ${sclMax}`));

  const spec = TURTLE.species[t.species];
  if (t.species && !spec) out.push(issue('suspect', 'species', `unrecognised species "${t.species}"`));
  else if (spec && sclMax !== null && !inRange(sclMax, spec.scl))
    out.push(issue('suspect', 'scl_max', `${sclMax}cm is outside ${spec.scl.min}-${spec.scl.max} for ${t.species}`));

  if (t.sex && !TURTLE.sexes.includes(String(t.sex).toLowerCase()))
    out.push(issue('suspect', 'sex', `unknown sex "${t.sex}"`));

  if (!t.name || /^(test|asdf|qwerty|xxx+|aaa+|foo|bar)\b/i.test(String(t.name).trim()))
    out.push(issue('suspect', 'name', `"${t.name}" looks like placeholder text`));

  return out;
};

/** Findings for one emergence (a track, with no name to check). */
export const auditEmergence = (e) => {
  const out = [];
  const d = num(e.distance_to_sea_s);
  if (d !== null && d < 0) out.push(issue('impossible', 'distance_to_sea_s', `${d}m`));
  else if (d !== null && !inRange(d, NEST.distanceToSea))
    out.push(issue('suspect', 'distance_to_sea_s', `${d}m is outside ${NEST.distanceToSea.min}-${NEST.distanceToSea.max}`));

  const lat = num(e.gps_lat), lon = num(e.gps_long);
  if (lat !== null && lon !== null) {
    if (lat < SITE.bbox.latMin || lat > SITE.bbox.latMax || lon < SITE.bbox.lonMin || lon > SITE.bbox.lonMax)
      out.push(issue('suspect', 'gps', `${lat}, ${lon} is outside the survey area`));
    if (looksLikePlaceholderCoord(e.gps_lat, e.gps_long))
      out.push(issue('suspect', 'gps', `${lat}, ${lon} looks like a placeholder, not a reading`));
  }

  const when = e.event_date ? new Date(e.event_date) : null;
  if (when && !Number.isNaN(when.valueOf()) && when > new Date())
    out.push(issue('impossible', 'event_date', 'recorded in the future'));

  return out;
};
