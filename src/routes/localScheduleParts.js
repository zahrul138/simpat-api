// src/routes/localScheduleParts.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

// POST /api/local-schedules/:vendorId/parts/bulk
router.post("/:vendorId/parts/bulk", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId } = req.params;
    const { items } = req.body; 
    // items = [{ part_code, part_name, qty, qty_box, unit, do_number }]

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "No part items" });
    }

    await client.query("BEGIN");

    // Validasi vendor exists
    const vendorCheck = await client.query(
      `SELECT id FROM local_schedule_vendors WHERE id = $1 AND is_active = true`,
      [vendorId]
    );

    if (vendorCheck.rowCount === 0) {
      throw new Error("Vendor schedule not found");
    }

    const results = [];
    for (const it of items) {
      const { part_code, part_name, qty, qty_box, unit, do_number } = it;

      if (!part_code) {
        throw new Error("Missing part_code in part item");
      }

      // Cari part_id dari part_detail berdasarkan part_code
      let partId = null;
      const partRes = await client.query(
        `SELECT id FROM part_detail WHERE part_code = $1 AND is_active = true LIMIT 1`,
        [part_code.trim()]
      );

      if (partRes.rows[0]) {
        partId = partRes.rows[0].id;
      }

      const ins = await client.query(
        `INSERT INTO local_schedule_parts
         (local_schedule_vendor_id, part_id, part_code, part_name, quantity, quantity_box, unit, do_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, local_schedule_vendor_id, part_id, part_code, part_name, quantity, quantity_box, unit, do_number`,
        [vendorId, partId, part_code, part_name || '', 
         Number(qty || 0), Number(qty_box || 0), unit || 'PCS', do_number || '']
      );
      results.push(ins.rows[0]);
    }

    // Update total_item di local_schedule_vendors
    await client.query(
      `UPDATE local_schedule_vendors
         SET total_item = (
           SELECT COUNT(*) FROM local_schedule_parts WHERE local_schedule_vendor_id = $1
         ),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
       [vendorId]
    );

    await client.query("COMMIT");
    res.status(201).json({ parts: results });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[Create Local Schedule Parts] Error:", e.message);
    res.status(400).json({ message: e.message || "Failed to add parts" });
  } finally {
    client.release();
  }
});

module.exports = router;