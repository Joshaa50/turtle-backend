require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");

const app = express();
app.use(cors());
app.use(express.json());

// Connect to Neon
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon requires SSL
  family: 4 // Force IPv4 for Render
});

// Test DB connection
(async () => {
  try {
    const res = await db.query("SELECT NOW()");
    console.log("Connected to Neon Postgres! Time:", res.rows[0].now);
  } catch (err) {
    console.error("Database connection error:", err);
  }
})();

// Test endpoint
app.get("/test", (req, res) => {
  res.json({ message: "Backend is working!" });
});

// Users table 
//--------------------------------------------------------------
// Register endpoint
app.post("/users/register", async (req, res) => {
  try {
    const { first_name, last_name, email, password, role } = req.body;

    if (!first_name || !last_name || !email || !password) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const userRole = role || "volunteer";

    const password_hash = await bcrypt.hash(password, 10);

    const sql = `
      INSERT INTO users
        (first_name, last_name, email, password_hash, role)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, first_name, last_name, email, role, is_email_verified, is_active, created_at;
    `;

    const result = await db.query(sql, [
      first_name,
      last_name,
      email,
      password_hash,
      userRole
    ]);

    res.json({
      message: "User registered successfully",
      user: result.rows[0]
    });
  } catch (err) {
    console.error("Register error:", err);

    if (err.code === "23505") {
      return res.status(400).json({ error: "Email already exists." });
    }

    res.status(500).json({ error: "Server error." });
  }
});

// Get all users endpoint
app.get("/users", async (req, res) => {
  try {
    const sql = `
      SELECT id, first_name, last_name, email, role, email_verified, is_active, created_at, updated_at
      FROM users
      ORDER BY id ASC;
    `;

    const result = await db.query(sql);

    res.json({
      message: "Users fetched successfully",
      users: result.rows
    });
  } catch (err) {
    console.error("Get users error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Login endpoint
app.post("/users/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password are required." });

    const sql = "SELECT * FROM users WHERE email = $1 LIMIT 1";
    const result = await db.query(sql, [email]);

    if (result.rows.length === 0) return res.status(401).json({ error: "Invalid email or password." });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: "Invalid email or password." });

    if (!user.is_active) return res.status(403).json({ error: "Account is inactive." });

    res.json({
      message: "Login successful",
      user: {
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        role: user.role,
        is_email_verified: user.is_email_verified,
        is_active: user.is_active
      }
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Turtles table
//--------------------------------------------------------------
// Create Turtle endpoint
app.post("/turtles/create", async (req, res) => {
  try {
    let {
      name,
      species,
      sex,
      health_condition,

      front_left_tag,
      front_left_address,

      front_right_tag,
      front_right_address,

      rear_left_tag,
      rear_left_address,

      rear_right_tag,
      rear_right_address,

      scl_max,
      scl_min,
      scw,

      ccl_max,
      ccl_min,
      ccw,

      tail_extension,
      vent_to_tail_tip,
      total_tail_length
    } = req.body;

    // Normalize sex to satisfy CHECK constraint
    sex = sex ? sex.toLowerCase() : "unknown";

    // Validate sex
    if (!["male", "female", "unknown"].includes(sex)) {
      return res.status(400).json({
        error: "sex must be 'male', 'female', or 'unknown'"
      });
    }

    // Validate required fields
    if (
      !species ||
      !health_condition ||
      scl_max == null ||
      scl_min == null ||
      scw == null ||
      ccl_max == null ||
      ccl_min == null ||
      ccw == null ||
      tail_extension == null ||
      vent_to_tail_tip == null ||
      total_tail_length == null
    ) {
      return res.status(400).json({
        error: "Missing required fields."
      });
    }

    const sql = `
      INSERT INTO turtles (
        name,
        species,
        sex,
        health_condition,

        front_left_tag,
        front_left_address,

        front_right_tag,
        front_right_address,

        rear_left_tag,
        rear_left_address,

        rear_right_tag,
        rear_right_address,

        scl_max,
        scl_min,
        scw,

        ccl_max,
        ccl_min,
        ccw,

        tail_extension,
        vent_to_tail_tip,
        total_tail_length
      )
      VALUES (
        $1, $2, $3, $4,
        $5, $6,
        $7, $8,
        $9, $10,
        $11, $12,
        $13, $14, $15,
        $16, $17, $18,
        $19, $20, $21
      )
      RETURNING *;
    `;

    const result = await db.query(sql, [
      name || null,
      species,
      sex,
      health_condition,

      front_left_tag || null,
      front_left_address || null,

      front_right_tag || null,
      front_right_address || null,

      rear_left_tag || null,
      rear_left_address || null,

      rear_right_tag || null,
      rear_right_address || null,

      scl_max,
      scl_min,
      scw,

      ccl_max,
      ccl_min,
      ccw,

      tail_extension,
      vent_to_tail_tip,
      total_tail_length
    ]);

    res.json({
      message: "Turtle record created successfully",
      turtle: result.rows[0]
    });
  } catch (err) {
    console.error("Create turtle error:", err);

    res.status(500).json({ error: "Server error." });
  }
});

// Get all turtles endpoint
app.get("/turtles", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM turtles ORDER BY created_at DESC;");

    res.json({
      message: "Turtles fetched successfully",
      turtles: result.rows
    });
  } catch (err) {
    console.error("Get turtles error:", err);
    res.status(500).json({ error: "Server error." });
  }
});
// Get all survey events for a specific turtle
app.get("/turtles/:turtle_id/survey_events", async (req, res) => {
  try {
    const { turtle_id } = req.params;

    if (!turtle_id) {
      return res.status(400).json({ error: "turtle_id is required" });
    }

    const sql = `
      SELECT tse.*, t.name AS turtle_name, t.species
      FROM turtle_survey_events tse
      JOIN turtles t ON tse.turtle_id = t.id
      WHERE tse.turtle_id = $1
      ORDER BY tse.event_date DESC;
    `;

    const result = await db.query(sql, [turtle_id]);

    res.json({
      message: "Survey events fetched successfully",
      turtle_id,
      turtle_name: result.rows[0]?.turtle_name || null,
      species: result.rows[0]?.species || null,
      events: result.rows
    });
  } catch (err) {
    console.error("Get turtle survey events error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Update turtle tags + measurements + health condition endpoint
app.put("/turtles/:id/update", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      health_condition,

      front_left_tag,
      front_left_address,

      front_right_tag,
      front_right_address,

      rear_left_tag,
      rear_left_address,

      rear_right_tag,
      rear_right_address,

      scl_max,
      scl_min,
      scw,

      ccl_max,
      ccl_min,
      ccw,

      tail_extension,
      vent_to_tail_tip,
      total_tail_length
    } = req.body;

    // Validation (health + all measurement fields required)
    if (
      !health_condition ||
      scl_max == null ||
      scl_min == null ||
      scw == null ||
      ccl_max == null ||
      ccl_min == null ||
      ccw == null ||
      tail_extension == null ||
      vent_to_tail_tip == null ||
      total_tail_length == null
    ) {
      return res.status(400).json({
        error: "health_condition and all measurement fields are required."
      });
    }

    const sql = `
      UPDATE turtles
      SET
        health_condition = $1,

        front_left_tag = $2,
        front_left_address = $3,

        front_right_tag = $4,
        front_right_address = $5,

        rear_left_tag = $6,
        rear_left_address = $7,

        rear_right_tag = $8,
        rear_right_address = $9,

        scl_max = $10,
        scl_min = $11,
        scw = $12,

        ccl_max = $13,
        ccl_min = $14,
        ccw = $15,

        tail_extension = $16,
        vent_to_tail_tip = $17,
        total_tail_length = $18,

        updated_at = NOW()
      WHERE id = $19
      RETURNING *;
    `;

    const result = await db.query(sql, [
      health_condition,

      front_left_tag || null,
      front_left_address || null,

      front_right_tag || null,
      front_right_address || null,

      rear_left_tag || null,
      rear_left_address || null,

      rear_right_tag || null,
      rear_right_address || null,

      scl_max,
      scl_min,
      scw,

      ccl_max,
      ccl_min,
      ccw,

      tail_extension,
      vent_to_tail_tip,
      total_tail_length,

      id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Turtle not found." });
    }

    res.json({
      message: "Turtle updated successfully",
      turtle: result.rows[0]
    });
  } catch (err) {
    console.error("Update turtle error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Get turtle by ID
app.get("/turtles/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const sql = `SELECT * FROM turtles WHERE id = $1;`;
    const result = await db.query(sql, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Turtle not found." });
    }

    res.json({
      message: "Turtle fetched successfully",
      turtle: result.rows[0]
    });
  } catch (err) {
    console.error("Get turtle by ID error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Turtle Survey events table
//--------------------------------------------------------------
// Create Turtle Survey Event endpoint
app.post("/turtle_survey_events/create", async (req, res) => {
  try {
    const {
      event_date,
      event_type,
      location,
      turtle_id,

      front_left_tag,
      front_left_address,
      front_right_tag,
      front_right_address,
      rear_left_tag,
      rear_left_address,
      rear_right_tag,
      rear_right_address,

      scl_max,
      scl_min,
      scw,
      ccl_max,
      ccl_min,
      ccw,
      tail_extension,
      vent_to_tail_tip,
      total_tail_length,

      health_condition,
      observer,
      notes,

      time_first_seen,
      time_start_egg_laying,
      time_covering,
      time_end_camouflage,
      time_reach_sea
    } = req.body;

    // Required field validation
    const requiredFields = [
      "event_type", "location", "turtle_id",
      "scl_max", "scl_min", "scw",
      "ccl_max", "ccl_min", "ccw",
      "tail_extension", "vent_to_tail_tip", "total_tail_length",
      "health_condition", "observer"
    ];

    for (const field of requiredFields) {
      if (req.body[field] === undefined || req.body[field] === null) {
        return res.status(400).json({ error: `${field} is required` });
      }
    }

    const sql = `
      INSERT INTO turtle_survey_events (
        event_date,
        event_type,
        location,
        turtle_id,

        front_left_tag,
        front_left_address,
        front_right_tag,
        front_right_address,
        rear_left_tag,
        rear_left_address,
        rear_right_tag,
        rear_right_address,

        scl_max,
        scl_min,
        scw,
        ccl_max,
        ccl_min,
        ccw,
        tail_extension,
        vent_to_tail_tip,
        total_tail_length,

        health_condition,
        observer,
        notes,

        time_first_seen,
        time_start_egg_laying,
        time_covering,
        time_end_camouflage,
        time_reach_sea
      )
      VALUES (
        $1,$2,$3,$4,
        $5,$6,$7,$8,$9,$10,$11,$12,
        $13,$14,$15,$16,$17,$18,$19,$20,$21,
        $22,$23,$24,$25,$26,$27,$28,$29
      )
      RETURNING *;
    `;

    const values = [
      event_date || new Date(),
      event_type,
      location,
      turtle_id,

      front_left_tag || null,
      front_left_address || null,
      front_right_tag || null,
      front_right_address || null,
      rear_left_tag || null,
      rear_left_address || null,
      rear_right_tag || null,
      rear_right_address || null,

      scl_max,
      scl_min,
      scw,
      ccl_max,
      ccl_min,
      ccw,
      tail_extension,
      vent_to_tail_tip,
      total_tail_length,

      health_condition,
      observer,
      notes || null,

      time_first_seen || null,
      time_start_egg_laying || null,
      time_covering || null,
      time_end_camouflage || null,
      time_reach_sea || null
    ];

    const result = await db.query(sql, values);

    res.json({
      message: "Turtle survey event created successfully",
      event: result.rows[0]
    });
  } catch (err) {
    console.error("Create turtle survey event error:", err);
    res.status(500).json({ error: "Server error." });
  }
});


// Turtle nests 
//--------------------------------------------------------------
// Create Nest endpoint
app.post("/nests/create", async (req, res) => {
  try {
    const {
      nest_code,
      total_num_eggs,
      current_num_eggs,

      depth_top_egg_h,
      depth_bottom_chamber_h,
      distance_to_sea_s,
      width_w,
      gps_long,
      gps_lat,

      tri_tl_desc,
      tri_tl_lat,
      tri_tl_long,
      tri_tl_distance,

      tri_tr_desc,
      tri_tr_lat,
      tri_tr_long,
      tri_tr_distance,

      status,
      relocated,
      is_archived,
      date_found,
      beach,
      notes
    } = req.body;

    // Required fields validation
    if (
      !nest_code ||
      depth_top_egg_h == null ||
      distance_to_sea_s == null ||
      gps_long == null ||
      gps_lat == null ||
      !date_found ||
      !beach
    ) {
      return res.status(400).json({
        error: "Missing required fields."
      });
    }

    // Validate status if provided
    const validStatuses = ["incubating", "hatching", "hatched"];
    const nestStatus = status ? status.toLowerCase() : "incubating";

    if (!validStatuses.includes(nestStatus)) {
      return res.status(400).json({
        error: "status must be 'incubating', 'hatching', or 'hatched'"
      });
    }

    // Default current_num_eggs to total_num_eggs if not provided
    const currentEggs =
      current_num_eggs != null ? current_num_eggs : total_num_eggs;

    const sql = `
      INSERT INTO turtle_nests (
        nest_code,
        total_num_eggs,
        current_num_eggs,
        depth_top_egg_h,
        depth_bottom_chamber_h,
        distance_to_sea_s,
        width_w,
        gps_long,
        gps_lat,

        tri_tl_desc,
        tri_tl_lat,
        tri_tl_long,
        tri_tl_distance,

        tri_tr_desc,
        tri_tr_lat,
        tri_tr_long,
        tri_tr_distance,

        status,
        relocated,
        is_archived,
        date_found,
        beach,
        notes
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,
        $10,$11,$12,$13,
        $14,$15,$16,$17,
        $18,$19,$20,$21,$22,$23
      )
      RETURNING *;
    `;

    const result = await db.query(sql, [
      nest_code,
      total_num_eggs || null,
      currentEggs || null,
      depth_top_egg_h,
      depth_bottom_chamber_h || null,
      distance_to_sea_s,
      width_w || null,
      gps_long,
      gps_lat,

      tri_tl_desc || null,
      tri_tl_lat || null,
      tri_tl_long || null,
      tri_tl_distance || null,

      tri_tr_desc || null,
      tri_tr_lat || null,
      tri_tr_long || null,
      tri_tr_distance || null,

      nestStatus,
      relocated ?? false,
      is_archived ?? false,
      date_found,
      beach,
      notes || null
    ]);

    res.json({
      message: "Nest created successfully",
      nest: result.rows[0]
    });
  } catch (err) {
    console.error("Create nest error:", err);

    if (err.code === "23505") {
      return res.status(400).json({
        error: "Nest code already exists."
      });
    }

    res.status(500).json({ error: "Server error." });
  }
});

// Update Nest endpoint
app.put("/nests/:id/update", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      nest_code,
      total_num_eggs,
      current_num_eggs,

      depth_top_egg_h,
      depth_bottom_chamber_h,
      distance_to_sea_s,
      width_w,
      gps_long,
      gps_lat,

      tri_tl_desc,
      tri_tl_lat,
      tri_tl_long,
      tri_tl_distance,

      tri_tr_desc,
      tri_tr_lat,
      tri_tr_long,
      tri_tr_distance,

      status,
      relocated,
      is_archived,
      date_found,
      beach,
      notes
    } = req.body;

    // Required fields validation
    if (
      !nest_code ||
      depth_top_egg_h == null ||
      distance_to_sea_s == null ||
      gps_long == null ||
      gps_lat == null ||
      !date_found ||
      !beach
    ) {
      return res.status(400).json({
        error: "Missing required fields."
      });
    }

    // Validate status
    const validStatuses = ["incubating", "hatching", "hatched"];
    const nestStatus = status ? status.toLowerCase() : "incubating";

    if (!validStatuses.includes(nestStatus)) {
      return res.status(400).json({
        error: "status must be 'incubating', 'hatching', or 'hatched'"
      });
    }

    const sql = `
      UPDATE turtle_nests
      SET
        nest_code = $1,
        total_num_eggs = $2,
        current_num_eggs = $3,

        depth_top_egg_h = $4,
        depth_bottom_chamber_h = $5,
        distance_to_sea_s = $6,
        width_w = $7,
        gps_long = $8,
        gps_lat = $9,

        tri_tl_desc = $10,
        tri_tl_lat = $11,
        tri_tl_long = $12,
        tri_tl_distance = $13,

        tri_tr_desc = $14,
        tri_tr_lat = $15,
        tri_tr_long = $16,
        tri_tr_distance = $17,

        status = $18,
        relocated = $19,
        is_archived = $20,
        date_found = $21,
        beach = $22,
        notes = $23,

        updated_at = NOW()
      WHERE id = $24
      RETURNING *;
    `;

    const result = await db.query(sql, [
      nest_code,
      total_num_eggs || null,
      current_num_eggs || null,

      depth_top_egg_h,
      depth_bottom_chamber_h || null,
      distance_to_sea_s,
      width_w || null,
      gps_long,
      gps_lat,

      tri_tl_desc || null,
      tri_tl_lat || null,
      tri_tl_long || null,
      tri_tl_distance || null,

      tri_tr_desc || null,
      tri_tr_lat || null,
      tri_tr_long || null,
      tri_tr_distance || null,

      nestStatus,
      relocated ?? false,
      is_archived ?? false,
      date_found,
      beach,
      notes || null,

      id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Nest not found." });
    }

    res.json({
      message: "Nest updated successfully",
      nest: result.rows[0]
    });
  } catch (err) {
    console.error("Update nest error:", err);

    if (err.code === "23505") {
      return res.status(400).json({
        error: "Nest code already exists."
      });
    }

    res.status(500).json({ error: "Server error." });
  }
});


// Get all nests endpoint
app.get("/nests", async (req, res) => {
  try {
    const sql = `
      SELECT *
      FROM turtle_nests
      ORDER BY date_found DESC, id DESC;
    `;

    const result = await db.query(sql);

    res.json({
      message: "Nests fetched successfully",
      nests: result.rows
    });
  } catch (err) {
    console.error("Get all nests error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Get nest by nest_code endpoint
app.get("/nests/:nest_code", async (req, res) => {
  try {
    const { nest_code } = req.params;

    const sql = `
      SELECT *
      FROM turtle_nests
      WHERE nest_code = $1
      LIMIT 1;
    `;

    const result = await db.query(sql, [nest_code]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Nest not found" });
    }

    res.json({
      message: "Nest found",
      nest: result.rows[0]
    });
  } catch (err) {
    console.error("Get nest error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Turtle nest events
//---------------------------------------------------------------
// Create Turtle Nest Event endpoint
app.post("/nest-events/create", async (req, res) => {
  try {
    const {
      event_type,
      nest_code,
      
      // The two new fields you wanted
      tracks_to_sea,
      tracks_lost,

      original_depth_top_egg_h,
      original_depth_bottom_chamber_h,
      original_width_w,
      original_distance_to_sea_s,
      original_gps_lat,
      original_gps_long,

      total_eggs,
      helped_to_sea,
      eggs_reburied,

      hatched_count,
      hatched_black_fungus_count,
      hatched_green_bacteria_count,
      hatched_pink_bacteria_count,

      non_viable_count,
      non_viable_black_fungus_count,
      non_viable_green_bacteria_count,
      non_viable_pink_bacteria_count,

      eye_spot_count,
      eye_spot_black_fungus_count,
      eye_spot_green_bacteria_count,
      eye_spot_pink_bacteria_count,

      early_count,
      early_black_fungus_count,
      early_green_bacteria_count,
      early_pink_bacteria_count,

      middle_count,
      middle_black_fungus_count,
      middle_green_bacteria_count,
      middle_pink_bacteria_count,

      late_count,
      late_black_fungus_count,
      late_green_bacteria_count,
      late_pink_bacteria_count,

      piped_dead_count,
      piped_dead_black_fungus_count,
      piped_dead_green_bacteria_count,
      piped_dead_pink_bacteria_count,

      piped_alive_count,
      alive_within,
      dead_within,
      alive_above,
      dead_above,

      reburied_depth_top_egg_h,
      reburied_depth_bottom_chamber_h,
      reburied_width_w,
      reburied_distance_to_sea_s,
      reburied_gps_lat,
      reburied_gps_long,

      notes,
      start_time,
      end_time,
      observer
    } = req.body;

    if (!event_type || !nest_code) {
      return res.status(400).json({ error: "event_type and nest_code are required." });
    }

    // 1. Find the nest to get the ID (Fixed the scope issue here)
    const nestResult = await db.query(
      `SELECT id FROM turtle_nests WHERE nest_code = $1 LIMIT 1;`,
      [nest_code]
    );

    if (nestResult.rows.length === 0) {
      return res.status(404).json({ error: "Nest not found." });
    }

    const nest_id = nestResult.rows[0].id; // nest_id is now defined in this scope

    // 2. Insert the event with the new fields
    const sql = `
      INSERT INTO turtle_nest_events (
        event_type, nest_id, nest_code,
        tracks_to_sea, tracks_lost,
        original_depth_top_egg_h, original_depth_bottom_chamber_h, original_width_w,
        original_distance_to_sea_s, original_gps_lat, original_gps_long,
        total_eggs, helped_to_sea, eggs_reburied,
        hatched_count, hatched_black_fungus_count, hatched_green_bacteria_count, hatched_pink_bacteria_count,
        non_viable_count, non_viable_black_fungus_count, non_viable_green_bacteria_count, non_viable_pink_bacteria_count,
        eye_spot_count, eye_spot_black_fungus_count, eye_spot_green_bacteria_count, eye_spot_pink_bacteria_count,
        early_count, early_black_fungus_count, early_green_bacteria_count, early_pink_bacteria_count,
        middle_count, middle_black_fungus_count, middle_green_bacteria_count, middle_pink_bacteria_count,
        late_count, late_black_fungus_count, late_green_bacteria_count, late_pink_bacteria_count,
        piped_dead_count, piped_dead_black_fungus_count, piped_dead_green_bacteria_count, piped_dead_pink_bacteria_count,
        piped_alive_count, alive_within, dead_within, alive_above, dead_above,
        reburied_depth_top_egg_h, reburied_depth_bottom_chamber_h, reburied_width_w,
        reburied_distance_to_sea_s, reburied_gps_lat, reburied_gps_long,
        notes, start_time, end_time, observer
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,
        $41,$42,$43,$44,$45,$46,$47,$48,$49,$50,$51,$52,$53,$54,$55,$56,$57
      )
      RETURNING *;
    `;

    const values = [
      event_type, nest_id, nest_code,
      tracks_to_sea || 0, tracks_lost || 0,
      original_depth_top_egg_h || null, original_depth_bottom_chamber_h || null, original_width_w || null,
      original_distance_to_sea_s || null, original_gps_lat || null, original_gps_long || null,
      total_eggs || null, helped_to_sea || null, eggs_reburied || null,
      hatched_count || null, hatched_black_fungus_count || null, hatched_green_bacteria_count || null, hatched_pink_bacteria_count || null,
      non_viable_count || null, non_viable_black_fungus_count || null, non_viable_green_bacteria_count || null, non_viable_pink_bacteria_count || null,
      eye_spot_count || null, eye_spot_black_fungus_count || null, eye_spot_green_bacteria_count || null, eye_spot_pink_bacteria_count || null,
      early_count || null, early_black_fungus_count || null, early_green_bacteria_count || null, early_pink_bacteria_count || null,
      middle_count || null, middle_black_fungus_count || null, middle_green_bacteria_count || null, middle_pink_bacteria_count || null,
      late_count || null, late_black_fungus_count || null, late_green_bacteria_count || null, late_pink_bacteria_count || null,
      piped_dead_count || null, piped_dead_black_fungus_count || null, piped_dead_green_bacteria_count || null, piped_dead_pink_bacteria_count || null,
      piped_alive_count || null, alive_within || null, dead_within || null, alive_above || null, dead_above || null,
      reburied_depth_top_egg_h || null, reburied_depth_bottom_chamber_h || null, reburied_width_w || null,
      reburied_distance_to_sea_s || null, reburied_gps_lat || null, reburied_gps_long || null,
      notes || null, start_time || null, end_time || null, observer || null
    ];

    const result = await db.query(sql, values);
    res.json({ message: "Turtle nest event created successfully", event: result.rows[0] });

  } catch (err) {
    console.error("Create turtle nest event error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Get all turtle nest events for a given nest_code
app.get("/nest-events/:nest_code", async (req, res) => {
  try {
    const { nest_code } = req.params;

    if (!nest_code) {
      return res.status(400).json({ error: "nest_code is required." });
    }

    // Confirm nest exists
    const nestResult = await db.query(
      `SELECT id, nest_code FROM turtle_nests WHERE nest_code = $1 LIMIT 1;`,
      [nest_code]
    );

    if (nestResult.rows.length === 0) {
      return res.status(404).json({ error: "Nest not found." });
    }

    const sql = `
      SELECT *
      FROM turtle_nest_events
      WHERE nest_code = $1
      ORDER BY created_at DESC;
    `;

    const result = await db.query(sql, [nest_code]);

    res.json({
      message: "Nest events retrieved successfully",
      nest_code,
      total_events: result.rows.length,
      events: result.rows
    });
  } catch (err) {
    console.error("Get nest events error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Update Nest Event endpoint
app.put("/nest-events/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      event_type,
      nest_id,
      nest_code,
      // Physical measurements
      original_depth_top_egg_h,
      original_depth_bottom_chamber_h,
      original_width_w,
      original_distance_to_sea_s,
      original_gps_lat,
      original_gps_long,
      // Primary counts
      total_eggs,
      helped_to_sea,
      eggs_reburied,
      // Success/Failure categories
      hatched_count,
      hatched_black_fungus_count,
      hatched_green_bacteria_count,
      hatched_pink_bacteria_count,
      non_viable_count,
      non_viable_black_fungus_count,
      non_viable_green_bacteria_count,
      non_viable_pink_bacteria_count,
      // Developmental stages
      eye_spot_count,
      eye_spot_black_fungus_count,
      eye_spot_green_bacteria_count,
      eye_spot_pink_bacteria_count,
      early_count,
      early_black_fungus_count,
      early_green_bacteria_count,
      early_pink_bacteria_count,
      middle_count,
      middle_black_fungus_count,
      middle_green_bacteria_count,
      middle_pink_bacteria_count,
      late_count,
      late_black_fungus_count,
      late_green_bacteria_count,
      late_pink_bacteria_count,
      // Piped states
      piped_dead_count,
      piped_dead_black_fungus_count,
      piped_dead_green_bacteria_count,
      piped_dead_pink_bacteria_count,
      piped_alive_count,
      // Reburial data
      reburied_depth_top_egg_h,
      reburied_depth_bottom_chamber_h,
      reburied_width_w,
      reburied_distance_to_sea_s,
      reburied_gps_lat,
      reburied_gps_long,
      // Metadata
      notes,
      start_time,
      end_time,
      observer,
      // Tracks & Location counts
      alive_within,
      dead_within,
      alive_above,
      dead_above,
      tracks_to_sea,
      tracks_lost
    } = req.body;

    // Required fields validation
    if (!event_type || !nest_id || !nest_code) {
      return res.status(400).json({
        error: "Missing required fields: event_type, nest_id, and nest_code are mandatory."
      });
    }

    const sql = `
      UPDATE turtle_nest_events
      SET
        event_type = $1, nest_id = $2, nest_code = $3,
        original_depth_top_egg_h = $4, original_depth_bottom_chamber_h = $5,
        original_width_w = $6, original_distance_to_sea_s = $7,
        original_gps_lat = $8, original_gps_long = $9,
        total_eggs = $10, helped_to_sea = $11, eggs_reburied = $12,
        hatched_count = $13, hatched_black_fungus_count = $14, hatched_green_bacteria_count = $15, hatched_pink_bacteria_count = $16,
        non_viable_count = $17, non_viable_black_fungus_count = $18, non_viable_green_bacteria_count = $19, non_viable_pink_bacteria_count = $20,
        eye_spot_count = $21, eye_spot_black_fungus_count = $22, eye_spot_green_bacteria_count = $23, eye_spot_pink_bacteria_count = $24,
        early_count = $25, early_black_fungus_count = $26, early_green_bacteria_count = $27, early_pink_bacteria_count = $28,
        middle_count = $29, middle_black_fungus_count = $30, middle_green_bacteria_count = $31, middle_pink_bacteria_count = $32,
        late_count = $33, late_black_fungus_count = $34, late_green_bacteria_count = $35, late_pink_bacteria_count = $36,
        piped_dead_count = $37, piped_dead_black_fungus_count = $38, piped_dead_green_bacteria_count = $39, piped_dead_pink_bacteria_count = $40,
        piped_alive_count = $41,
        reburied_depth_top_egg_h = $42, reburied_depth_bottom_chamber_h = $43, reburied_width_w = $44,
        reburied_distance_to_sea_s = $45, reburied_gps_lat = $46, reburied_gps_long = $47,
        notes = $48, start_time = $49, end_time = $50, observer = $51,
        alive_within = $52, dead_within = $53, alive_above = $54, dead_above = $55,
        tracks_to_sea = $56, tracks_lost = $57,
        updated_at = NOW()
      WHERE id = $58
      RETURNING *;
    `;

    const values = [
      event_type, nest_id, nest_code,
      original_depth_top_egg_h || null, original_depth_bottom_chamber_h || null,
      original_width_w || null, original_distance_to_sea_s || null,
      original_gps_lat || null, original_gps_long || null,
      total_eggs ?? 0, helped_to_sea ?? 0, eggs_reburied ?? 0,
      hatched_count ?? 0, hatched_black_fungus_count ?? 0, hatched_green_bacteria_count ?? 0, hatched_pink_bacteria_count ?? 0,
      non_viable_count ?? 0, non_viable_black_fungus_count ?? 0, non_viable_green_bacteria_count ?? 0, non_viable_pink_bacteria_count ?? 0,
      eye_spot_count ?? 0, eye_spot_black_fungus_count ?? 0, eye_spot_green_bacteria_count ?? 0, eye_spot_pink_bacteria_count ?? 0,
      early_count ?? 0, early_black_fungus_count ?? 0, early_green_bacteria_count ?? 0, early_pink_bacteria_count ?? 0,
      middle_count ?? 0, middle_black_fungus_count ?? 0, middle_green_bacteria_count ?? 0, middle_pink_bacteria_count ?? 0,
      late_count ?? 0, late_black_fungus_count ?? 0, late_green_bacteria_count ?? 0, late_pink_bacteria_count ?? 0,
      piped_dead_count ?? 0, piped_dead_black_fungus_count ?? 0, piped_dead_green_bacteria_count ?? 0, piped_dead_pink_bacteria_count ?? 0,
      piped_alive_count ?? 0,
      reburied_depth_top_egg_h || null, reburied_depth_bottom_chamber_h || null, reburied_width_w || null,
      reburied_distance_to_sea_s || null, reburied_gps_lat || null, reburied_gps_long || null,
      notes || null, start_time || null, end_time || null, observer || null,
      alive_within ?? 0, dead_within ?? 0, alive_above ?? 0, dead_above ?? 0,
      tracks_to_sea ?? 0, tracks_lost ?? 0,
      id
    ];

    const result = await db.query(sql, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Event not found." });
    }

    res.json({
      message: "Nest event updated successfully",
      event: result.rows[0]
    });
  } catch (err) {
    console.error("Update nest event error:", err);
    res.status(500).json({ error: "Server error." });
  }
});








// Start server
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
