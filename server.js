require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const bcrypt = require("bcrypt");

const app = express();
app.use(cors());
app.use(express.json());

// Connect to MySQL
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT
});

db.connect((err) => {
  if (err) {
    console.error("Database connection failed:", err);
    return;
  }
  console.log("Connected to MySQL database!");
});

// Test endpoint
app.get("/test", (req, res) => {
  console.log("Test endpoint hit!"); // <-- add this
  res.json({ message: "Backend is working!" });
});
// Login user
app.post("/users/login", (req, res) => {
  const { Email, Password } = req.body;

  if (!Email || !Password) {
    return res.status(400).json({ error: "Email and Password are required." });
  }

  const sql = "SELECT * FROM User WHERE Email = ? LIMIT 1";

  db.query(sql, [Email], (err, results) => {
    if (err) {
      console.error("MySQL select error:", err);
      return res.status(500).json({ error: err.message });
    }

    if (results.length === 0) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const user = results[0];

    // Check password
    if (user.Password !== Password) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    // Optional: check if user is active
    if (user.isActive === 0) {
      return res.status(403).json({ error: "Account is inactive." });
    }

    // Return user info (excluding password)
    res.json({
      message: "Login successful",
      user: {
        UserID: user.UserID,
        FirstName: user.FirstName,
        LastName: user.LastName,
        Email: user.Email,
        Role: user.Role,
        isEmailVerifyed: user.isEmailVerifyed,
        isActive: user.isActive
      }
    });
  });
});



// Register a new user (plain password)
app.post("/users/register", (req, res) => {
  const { FirstName, LastName, Email, Password, Role } = req.body;

  // Validate input
  if (!FirstName || !LastName || !Email || !Password || !Role) {
    return res.status(400).json({ error: "All fields are required." });
  }

  // SQL query
  const sql = `
    INSERT INTO User
      (FirstName, LastName, Email, Password, Role, isEmailVerifyed, isActive)
    VALUES (?, ?, ?, ?, ?, 0, 1)
  `;

  db.query(sql, [FirstName, LastName, Email, Password, Role], (err, result) => {
    if (err) {
      console.error("MySQL insert error:", err);
      return res.status(500).json({ error: err.message });
    }
    res.json({
      message: "User registered successfully",
      user_id: result.insertId
    });
  });
});


app.post("/test-post", (req, res) => {
  console.log("Received POST:", req.body);
  res.json({ message: "POST received", data: req.body });
});


// Start server
app.listen(process.env.PORT, () => {
  console.log(`Server running on http://localhost:${process.env.PORT}`);
});
