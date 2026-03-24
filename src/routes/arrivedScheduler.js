const express = require("express");
const router = express.Router();
const pool = require("../db");

const checkAndMoveToArrived = async () => {
  try {
    const { rows } = await pool.query(`
      SELECT pe.id, pe.trip
      FROM request_parts pe
      JOIN trips t ON LOWER(t.trip_code) = LOWER(pe.trip)
      WHERE pe.status = 'InTransit'
        AND pe.is_active = true
        AND t.is_active = true
        AND CURRENT_TIME >= t.arv_to
    `);

    if (rows.length === 0) return;

    const ids = rows.map((r) => r.id);

    await pool.query(
      `UPDATE request_parts
       SET status = 'Arrived', updated_at = CURRENT_TIMESTAMP
       WHERE id = ANY($1::int[])`,
      [ids]
    );

    console.log(
      `[ArrivedScheduler] ${new Date().toLocaleTimeString("id-ID")} — Moved ${ids.length} item(s) to Arrived:`,
      ids
    );
  } catch (error) {
    console.error("[ArrivedScheduler] Error:", error.message);
  }
};

router.post("/trigger-arrived", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT pe.id
      FROM request_parts pe
      JOIN trips t ON LOWER(t.trip_code) = LOWER(pe.trip)
      WHERE pe.status = 'InTransit'
        AND pe.is_active = true
        AND t.is_active = true
        AND CURRENT_TIME >= t.arv_to
    `);

    if (rows.length === 0) {
      return res.json({ success: true, message: "No items to move", moved: 0 });
    }

    const ids = rows.map((r) => r.id);
    await pool.query(
      `UPDATE request_parts
       SET status = 'Arrived', updated_at = CURRENT_TIMESTAMP
       WHERE id = ANY($1::int[])`,
      [ids]
    );

    console.log(`[Scheduler] Moved ${ids.length} item(s) to Arrived`);
    res.json({ success: true, message: `${ids.length} items moved to Arrived`, moved: ids.length });
  } catch (error) {
    console.error("[Trigger Arrived] Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

const startArrivedScheduler = () => {
  console.log("[ArrivedScheduler] Started — checking every 30 seconds");
  checkAndMoveToArrived();
  setInterval(checkAndMoveToArrived, 30 * 1000);
};

module.exports = { router, startArrivedScheduler, checkAndMoveToArrived };