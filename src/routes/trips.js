const express = require("express");
const router = express.Router();
const pool = require("../db");

// GET /api/trips
router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        id,
        trip_code,
        TO_CHAR(req_from, 'HH24:MI') AS req_from,
        TO_CHAR(req_to,   'HH24:MI') AS req_to,
        TO_CHAR(arv_from, 'HH24:MI') AS arv_from,
        TO_CHAR(arv_to,   'HH24:MI') AS arv_to
      FROM trips
      WHERE is_active = true
      ORDER BY req_from ASC
    `);
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error("[GET Trips] Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;