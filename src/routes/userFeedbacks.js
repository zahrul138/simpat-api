const express = require("express");
const pool = require("../db");
const auth = require("../middleware/auth");

const router = express.Router();

router.get("/", auth(), async (req, res) => {
  try {
    const { status, date_from, date_to, emp_name, emp_id, department } =
      req.query;

    const conditions = [];
    const params = [];
    let idx = 1;

    if (status) {
      conditions.push(`status = $${idx++}`);
      params.push(status);
    }
    if (date_from) {
      conditions.push(`submitted_at >= $${idx++}`);
      params.push(date_from);
    }
    if (date_to) {
      conditions.push(`submitted_at < ($${idx++}::date + INTERVAL '1 day')`);
      params.push(date_to);
    }
    if (emp_name) {
      conditions.push(`emp_name ILIKE $${idx++}`);
      params.push(`%${emp_name}%`);
    }
    if (emp_id) {
      conditions.push(`emp_id ILIKE $${idx++}`);
      params.push(`%${emp_id}%`);
    }
    if (department) {
      conditions.push(`department ILIKE $${idx++}`);
      params.push(`%${department}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows } = await pool.query(
      `SELECT id, emp_id, emp_name, department, problem_location,
              description, photo_1, photo_2, photo_3, photo_4,
              status, submitted_at
       FROM user_feedbacks
       ${where}
       ORDER BY submitted_at DESC`,
      params,
    );

    return res.json({ ok: true, data: rows });
  } catch (err) {
    console.error("ERR GET /user-feedbacks:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/", auth(), async (req, res) => {
  try {
    const {
      emp_id,
      emp_name,
      department,
      problem_location,
      description,
      photos = [],
    } = req.body || {};

    if (!emp_id || !emp_name) {
      return res
        .status(400)
        .json({ error: "emp_id and emp_name are required" });
    }

    const [p1, p2, p3, p4] = [
      photos[0] || null,
      photos[1] || null,
      photos[2] || null,
      photos[3] || null,
    ];

    const { rows } = await pool.query(
      `INSERT INTO user_feedbacks
         (emp_id, emp_name, department, problem_location, description,
          photo_1, photo_2, photo_3, photo_4, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, submitted_at`,
      [
        String(emp_id),
        String(emp_name),
        department || null,
        problem_location || null,
        description || null,
        p1,
        p2,
        p3,
        p4,
        "New",
      ],
    );

    return res.status(201).json({
      ok: true,
      id: rows[0].id,
      submitted_at: rows[0].submitted_at,
    });
  } catch (err) {
    console.error("ERR POST /user-feedbacks:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

router.patch("/:id/status", auth(), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};

    const VALID = ["New", "In Progress", "Complete"];
    if (!VALID.includes(status)) {
      return res
        .status(400)
        .json({ error: `status must be one of: ${VALID.join(", ")}` });
    }

    const { rowCount } = await pool.query(
      `UPDATE user_feedbacks SET status = $1 WHERE id = $2`,
      [status, id],
    );

    if (rowCount === 0)
      return res.status(404).json({ error: "Feedback not found" });

    return res.json({ ok: true });
  } catch (err) {
    console.error("ERR PATCH /user-feedbacks/:id/status:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

router.delete("/:id", auth(), async (req, res) => {
  try {
    const { id } = req.params;

    const { rowCount } = await pool.query(
      `DELETE FROM user_feedbacks WHERE id = $1`,
      [id],
    );

    if (rowCount === 0)
      return res.status(404).json({ error: "Feedback not found" });

    return res.json({ ok: true });
  } catch (err) {
    console.error("ERR DELETE /user-feedbacks/:id:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

router.delete("/:id", auth(), async (req, res) => {
  try {
    const { id } = req.params;

    const { rowCount } = await pool.query(
      `DELETE FROM user_feedbacks WHERE id = $1`,
      [id],
    );

    if (rowCount === 0)
      return res.status(404).json({ error: "Feedback not found" });

    return res.json({ ok: true });
  } catch (err) {
    console.error("ERR DELETE /user-feedbacks/:id:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
