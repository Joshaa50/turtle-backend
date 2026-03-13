require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");

const app = express();
app.use(cors());
// app.use(express.json());
// // Add this near the top of your server.js
app.use(express.json({ limit: '10mb' })); 
app.use(express.urlencoded({ limit: '10mb', extended: true }));

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
    const { first_name, last_name, email, password, role, station } = req.body;

    if (!first_name || !last_name || !email || !password || !station) {
      return res.status(400).json({ error: "Missing required fields (including station)." });
    }

    const userRole = role || "volunteer";
    const password_hash = await bcrypt.hash(password, 10);

    const profile_picture = req.body.profile_picture
      ? Buffer.from(req.body.profile_picture, "base64")
      : null;

    const sql = `
      INSERT INTO users
        (first_name, last_name, email, password_hash, role, station, profile_picture)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, first_name, last_name, email, role, station, created_at;
    `;

    const result = await db.query(sql, [
      first_name,
      last_name,
      email,
      password_hash,
      userRole,
      station,
      profile_picture
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
      SELECT 
        *
      FROM users
      ORDER BY station ASC, last_name ASC;
    `;

    const result = await db.query(sql);

    const users = result.rows.map(user => ({
      ...user,
      profile_picture: user.profile_picture
        ? user.profile_picture.toString("base64")
        : null
    }));

    res.json({
      message: "Users fetched successfully",
      users
    });
  } catch (err) {
    console.error("Get users error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Get user by ID
app.get("/users/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const sql = `SELECT * FROM users WHERE id = $1 LIMIT 1;`;
    const result = await db.query(sql, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    const user = result.rows[0];

    if (user.profile_picture) {
      user.profile_picture = user.profile_picture.toString("base64");
    }

    res.json({
      message: "User fetched successfully",
      user
    });
  } catch (err) {
    console.error("Get user by ID error:", err);
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
        is_active: user.is_active,
        profile_picture: user.profile_picture
          ? user.profile_picture.toString("base64")
          : null
      }
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Update user endpoint
app.patch("/users/:id", async (req, res) => {
  const userId = req.params.id;
  const updates = { ...req.body };

  const forbiddenFields = ["id", "created_at"];

  // If a plain-text password was sent, hash it and swap it out before building keys
  if (updates.password) {
    updates.password_hash = await bcrypt.hash(updates.password, 10);
    delete updates.password;
  }

  // If a profile picture was sent, convert base64 to buffer
  if (updates.profile_picture) {
    updates.profile_picture = Buffer.from(updates.profile_picture, "base64");
  }

  const keys = Object.keys(updates).filter(key => !forbiddenFields.includes(key));

  if (keys.length === 0) {
    return res.status(400).json({ error: "No valid fields provided for update." });
  }

  try {
    const setClause = keys
      .map((key, index) => `${key} = $${index + 1}`)
      .join(", ");

    const sql = `
      UPDATE users 
      SET ${setClause} 
      WHERE id = $${keys.length + 1} 
      RETURNING id, first_name, last_name, email, role, station, is_active,
        CASE WHEN profile_picture IS NOT NULL THEN encode(profile_picture, 'base64') ELSE NULL END AS profile_picture;
    `;

    const values = keys.map(key => updates[key]);
    values.push(userId);

    const result = await db.query(sql, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    res.json({
      message: "User updated successfully",
      user: result.rows[0]
    });
  } catch (err) {
    console.error("Update error:", err);
    if (err.code === "23505") {
      return res.status(400).json({ error: "Email already in use by another account." });
    }
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

    sex = sex ? sex.toLowerCase() : "unknown";

    if (!["male", "female", "unknown"].includes(sex)) {
      return res.status(400).json({
        error: "sex must be 'male', 'female', or 'unknown'"
      });
    }

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

// NOTE: Images are accepted as base64-encoded strings in the JSON body.
// On the client side, read the file and convert it like so:
//   const base64 = await new Promise(resolve => {
//     const reader = new FileReader();
//     reader.onload = () => resolve(reader.result.split(',')[1]);
//     reader.readAsDataURL(file);
//   });
// Then include tri_tl_img and/or tri_tr_img as base64 strings in your POST/PUT body.

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

    // Convert base64 image strings to Buffers for BYTEA storage
    const tri_tl_img = req.body.tri_tl_img
      ? Buffer.from(req.body.tri_tl_img, "base64")
      : null;
    const tri_tr_img = req.body.tri_tr_img
      ? Buffer.from(req.body.tri_tr_img, "base64")
      : null;

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
        tri_tl_img,

        tri_tr_desc,
        tri_tr_lat,
        tri_tr_long,
        tri_tr_distance,
        tri_tr_img,

        status,
        relocated,
        is_archived,
        date_found,
        beach,
        notes
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,
        $10,$11,$12,$13,$14,
        $15,$16,$17,$18,$19,
        $20,$21,$22,$23,$24,$25
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
      tri_tl_img,

      tri_tr_desc || null,
      tri_tr_lat || null,
      tri_tr_long || null,
      tri_tr_distance || null,
      tri_tr_img,

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

    // Convert base64 image strings to Buffers for BYTEA storage
    const tri_tl_img = req.body.tri_tl_img
      ? Buffer.from(req.body.tri_tl_img, "base64")
      : null;
    const tri_tr_img = req.body.tri_tr_img
      ? Buffer.from(req.body.tri_tr_img, "base64")
      : null;

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
        tri_tl_img = $14,

        tri_tr_desc = $15,
        tri_tr_lat = $16,
        tri_tr_long = $17,
        tri_tr_distance = $18,
        tri_tr_img = $19,

        status = $20,
        relocated = $21,
        is_archived = $22,
        date_found = $23,
        beach = $24,
        notes = $25,

        updated_at = NOW()
      WHERE id = $26
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
      tri_tl_img,

      tri_tr_desc || null,
      tri_tr_lat || null,
      tri_tr_long || null,
      tri_tr_distance || null,
      tri_tr_img,

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
// Images excluded for performance â€” fetched individually via the single nest endpoint
app.get("/nests", async (req, res) => {
  try {
    const sql = `
      SELECT
        id, nest_code, total_num_eggs, current_num_eggs,
        depth_top_egg_h, depth_bottom_chamber_h, distance_to_sea_s, width_w,
        gps_long, gps_lat,
        tri_tl_desc, tri_tl_lat, tri_tl_long, tri_tl_distance,
        tri_tr_desc, tri_tr_lat, tri_tr_long, tri_tr_distance,
        status, relocated, is_archived, date_found, beach, notes,
        created_at, updated_at
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
// Images returned as base64 strings for use in <img src="data:image/jpeg;base64,...">
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

    const nest = result.rows[0];

    // Convert BYTEA buffers to base64 strings for JSON transport
    if (nest.tri_tl_img) {
      nest.tri_tl_img = nest.tri_tl_img.toString("base64");
    }
    if (nest.tri_tr_img) {
      nest.tri_tr_img = nest.tri_tr_img.toString("base64");
    }

    res.json({
      message: "Nest found",
      nest
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

    const nestResult = await db.query(
      `SELECT id FROM turtle_nests WHERE nest_code = $1 LIMIT 1;`,
      [nest_code]
    );

    if (nestResult.rows.length === 0) {
      return res.status(404).json({ error: "Nest not found." });
    }

    const nest_id = nestResult.rows[0].id;

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
      reburied_depth_top_egg_h,
      reburied_depth_bottom_chamber_h,
      reburied_width_w,
      reburied_distance_to_sea_s,
      reburied_gps_lat,
      reburied_gps_long,
      notes,
      start_time,
      end_time,
      observer,
      alive_within,
      dead_within,
      alive_above,
      dead_above,
      tracks_to_sea,
      tracks_lost
    } = req.body;

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


// Turtle Emergences table
//---------------------------------------------------------------

// Create a new turtle emergence
app.post("/emergences", async (req, res) => {
  try {
    const { 
      distance_to_sea_s, 
      gps_lat, 
      gps_long, 
      event_date,
      beach
    } = req.body;

    if (!event_date) {
      return res.status(400).json({ error: "event_date is required." });
    }

    const sql = `
      INSERT INTO turtle_emergences (distance_to_sea_s, gps_lat, gps_long, event_date, beach)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;

    const result = await db.query(sql, [
      distance_to_sea_s || null,
      gps_lat || null,
      gps_long || null,
      event_date,
      beach || null
    ]);

    res.status(201).json({
      message: "Emergence recorded successfully",
      emergence: result.rows[0]
    });
  } catch (err) {
    console.error("Create emergence error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Get all turtle emergences
app.get("/emergences", async (req, res) => {
  try {
    const sql = `
      SELECT id, distance_to_sea_s, gps_lat, gps_long, event_date, beach, created_at, updated_at
      FROM turtle_emergences
      ORDER BY event_date DESC;
    `;

    const result = await db.query(sql);

    res.json({
      message: "Emergences fetched successfully",
      emergences: result.rows
    });
  } catch (err) {
    console.error("Get emergences error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Shifts table
//---------------------------------------------------------------

// Get all shifts
app.get("/shifts", async (req, res) => {
  try {
    const sql = `
      SELECT *
      FROM shifts             
    `;

    const result = await db.query(sql);

    res.json({
      message: "Shifts retrieved successfully",
      total_shifts: result.rows.length,
      shifts: result.rows
    });
  } catch (err) {
    console.error("Get shifts error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Timetable table
//--------------------------------------------------------------

// Create a new shift assignment
app.post('/timetable/create', async (req, res) => {
  const { user_id, shift_id, work_date } = req.body;

  if (!user_id || !shift_id || !work_date) {
    return res.status(400).json({ error: 'Missing required fields: user_id, shift_id, work_date' });
  }

  try {
    const query = `
      INSERT INTO Timetable (user_id, shift_id, work_date)
      VALUES ($1, $2, $3)
      RETURNING *;
    `;
    const values = [user_id, shift_id, work_date];
    
    const result = await db.query(query, values);

    res.status(201).json({
      message: "Assignment created successfully",
      assignment: result.rows[0]
    });
  } catch (err) {
    console.error("Create assignment error:", err);
    res.status(500).json({ error: 'Database error. Check if user_id and shift_id exist.' });
  }
});

// Get timetable for a specific week (given the date of the Monday)
app.get("/timetable/week", async (req, res) => {
  const { monday_date } = req.query;

  if (!monday_date) {
    return res.status(400).json({ error: "monday_date is required (YYYY-MM-DD)." });
  }

  try {
    const sql = `
      SELECT 
        t.assignment_id,
        t.work_date,
        t.status,
        u.first_name,
        u.last_name,
        s.shift_name,
        s.shift_type,
        s.start_time,
        s.end_time
      FROM Timetable t
      JOIN Users u ON t.user_id = u.id
      JOIN Shifts s ON t.shift_id = s.shift_id
      WHERE t.work_date >= $1::date 
        AND t.work_date < ($1::date + INTERVAL '7 days')
      ORDER BY t.work_date ASC, s.start_time ASC;
    `;

    const result = await db.query(sql, [monday_date]);

    res.json({
      message: "Weekly timetable retrieved successfully",
      week_starting: monday_date,
      schedule: result.rows
    });
  } catch (err) {
    console.error("Get weekly timetable error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Delete a specific assignment from the timetable
app.delete("/timetable/remove", async (req, res) => {
  const { user_id, shift_id, work_date } = req.body;

  if (!user_id || !shift_id || !work_date) {
    return res.status(400).json({ error: "Missing required fields: user_id, shift_id, work_date" });
  }

  try {
    const sql = `
      DELETE FROM Timetable 
      WHERE user_id = $1 
        AND shift_id = $2 
        AND work_date = $3
      RETURNING *;
    `;

    const result = await db.query(sql, [user_id, shift_id, work_date]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Assignment not found for the given criteria." });
    }

    res.json({
      message: "Assignment deleted successfully",
      deleted_assignment: result.rows[0]
    });
  } catch (err) {
    console.error("Delete assignment error:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Beaches table
//---------------------------------------------------------------

// Get all beaches
app.get("/beaches", async (req, res) => {
  try {
    const sql = `
      SELECT 
        id, 
        name, 
        code, 
        station, 
        survey_area, 
        is_active, 
        created_at
      FROM beaches
      ORDER BY station ASC, survey_area ASC, name ASC;
    `;

    const result = await db.query(sql);

    res.json({
      message: "Beaches fetched successfully",
      count: result.rowCount,
      beaches: result.rows
    });
  } catch (err) {
    console.error("Get beaches error:", err);
    res.status(500).json({ error: "Server error while fetching beaches." });
  }
});

// Morning survey table
//-------------------------------------------------------------------

// POST: Create a new morning survey record
app.post("/morning-surveys", async (req, res) => {
  try {
    const {
      survey_date,
      start_time,
      end_time,
      beach_id,
      tl_lat,
      tl_long,
      tr_lat,
      tr_long,
      protected_nest_count,
      notes,
      nest_id,
      event_id
    } = req.body;

    if (!survey_date || !start_time || !end_time || !beach_id) {
      return res.status(400).json({ error: "Missing required survey metadata." });
    }

    const sql = `
      INSERT INTO morning_surveys (
        survey_date, start_time, end_time, beach_id, 
        tl_lat, tl_long, tr_lat, tr_long, 
        protected_nest_count, notes, nest_id, event_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *;
    `;

    const values = [
      survey_date,
      start_time,
      end_time,
      beach_id,
      tl_lat ? parseFloat(tl_lat).toFixed(5) : null,
      tl_long ? parseFloat(tl_long).toFixed(5) : null,
      tr_lat ? parseFloat(tr_lat).toFixed(5) : null,
      tr_long ? parseFloat(tr_long).toFixed(5) : null,
      protected_nest_count || 0,
      notes,
      nest_id || null,
      event_id || null
    ];

    const result = await db.query(sql, values);

    res.status(201).json({
      message: "Morning survey recorded successfully",
      survey: result.rows[0]
    });

  } catch (err) {
    console.error("Error creating survey:", err);
    
    if (err.code === '23503') {
      return res.status(400).json({ error: "Invalid Beach, Nest, or Event ID." });
    }

    res.status(500).json({ error: "Server error while saving survey." });
  }
});


// Start server
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});