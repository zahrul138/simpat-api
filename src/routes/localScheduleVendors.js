// routes/localScheduleVendors.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

router.post("/:scheduleId/vendors/bulk", async (req, res) => {
  const client = await pool.connect();
  try {
    const { scheduleId } = req.params;
    const { items } = req.body; 

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "No vendor items provided" });
    }

    await client.query("BEGIN");

    // Validasi schedule exists
    const scheduleCheck = await client.query(
      `SELECT id FROM local_schedules WHERE id = $1 AND is_active = true`,
      [scheduleId]
    );

    if (scheduleCheck.rowCount === 0) {
      throw new Error(`Schedule with ID ${scheduleId} not found`);
    }

    const results = [];
    for (const it of items) {
      const { trip_id, vendor_id, do_numbers } = it;

      // Validasi field required
      if (!trip_id || !vendor_id || !Array.isArray(do_numbers)) {
        throw new Error("Missing required fields: trip_id, vendor_id, or do_numbers array");
      }

      if (do_numbers.length === 0) {
        throw new Error("do_numbers array cannot be empty");
      }

      // Validasi trip exists
      const tripCheck = await client.query(
        `SELECT id, arv_to FROM trips WHERE id = $1 AND COALESCE(is_active, true) = true`,
        [trip_id]
      );

      if (tripCheck.rowCount === 0) {
        throw new Error(`Trip with ID ${trip_id} not found`);
      }

      // Validasi vendor exists
      const vendorCheck = await client.query(
        `SELECT id FROM vendor_detail WHERE id = $1 AND COALESCE(is_active, true) = true`,
        [vendor_id]
      );

      if (vendorCheck.rowCount === 0) {
        throw new Error(`Vendor with ID ${vendor_id} not found`);
      }

      const arrivalTime = tripCheck.rows[0].arv_to;
      const doJoined = do_numbers.map(d => String(d || "").trim()).filter(Boolean).join(" | ");

      const ins = await client.query(
        `INSERT INTO local_schedule_vendors
         (local_schedule_id, trip_id, vendor_id, do_numbers, arrival_time, total_pallet, total_item)
         VALUES ($1, $2, $3, $4, $5, 0, 0)
         RETURNING id, local_schedule_id, trip_id, vendor_id, do_numbers, arrival_time, total_pallet, total_item`,
        [scheduleId, trip_id, vendor_id, doJoined, arrivalTime]
      );
      
      results.push(ins.rows[0]);
    }

    // Update total_vendor di header
    await client.query(
      `UPDATE local_schedules
         SET total_vendor = (
           SELECT COUNT(*) FROM local_schedule_vendors WHERE local_schedule_id = $1
         ),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
       [scheduleId]
    );

    await client.query("COMMIT");
    
    res.status(201).json({ vendors: results });
    
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[Create Local Schedule Vendors] Error:", e.message);
    res.status(400).json({ message: e.message || "Failed to add vendors" });
  } finally {
    client.release();
  }
});

module.exports = router;