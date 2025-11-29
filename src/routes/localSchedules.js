// routes/localSchedules.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

// helper functions
const toStartOfDay = (val) => {
  const d = new Date(val);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

const resolveEmployeeId = async (client, empName) => {
  if (!empName) return null;
  const q = await client.query(
    `SELECT id FROM employees WHERE LOWER(emp_name)=LOWER($1) LIMIT 1`,
    [empName]
  );
  return q.rows[0]?.id ?? null;
};

// ====== CREATE header schedule (Draft) ======
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const { stockLevel, modelName, scheduleDate, uploadByName } = req.body || {};
    if (!stockLevel || !modelName || !scheduleDate) {
      return res.status(400).json({ message: "Missing fields" });
    }

    // Validasi schedule date tidak duplikat di database
    const existingSchedule = await client.query(
      `SELECT id, schedule_code FROM local_schedules 
       WHERE schedule_date = $1::date AND is_active = true 
       LIMIT 1`,
      [scheduleDate]
    );

    if (existingSchedule.rowCount > 0) {
      return res.status(409).json({ 
        message: "Schedule date already exists in database",
        existingSchedule: existingSchedule.rows[0] 
      });
    }

    // Validasi FE request: scheduleDate harus > today
    const sel = toStartOfDay(scheduleDate);
    if (!sel) return res.status(400).json({ message: "Invalid scheduleDate" });
    const today = toStartOfDay(new Date());
    if (sel <= today) {
      return res
        .status(400)
        .json({ message: "Schedule Date must be greater than today" });
    }

    await client.query("BEGIN");

    const uploadBy = await resolveEmployeeId(client, uploadByName);

    const ins = await client.query(
      `INSERT INTO local_schedules
        (stock_level, model_name, upload_by, schedule_date, total_vendor, total_pallet, total_item, status)
       VALUES ($1,$2,$3,$4,0,0,0,'Draft')
       RETURNING id, schedule_code, stock_level, model_name, upload_by, schedule_date,
                 total_vendor, total_pallet, total_item, status, created_at, updated_at, is_active`,
      [stockLevel, modelName, uploadBy, scheduleDate]
    );

    await client.query("COMMIT");
    res.status(201).json({ schedule: ins.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[Create Local Schedule] Error:", e.message);
    res.status(400).json({ message: e.message || "Failed to create schedule" });
  } finally {
    client.release();
  }
});

// ====== CHECK schedule date ======
router.get("/check-date", async (req, res) => {
  try {
    const { scheduleDate } = req.query;

    if (!scheduleDate) {
      return res.status(400).json({ message: "scheduleDate is required" });
    }

    // Validasi format date
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(scheduleDate)) {
      return res.status(400).json({ message: "Invalid date format. Use YYYY-MM-DD" });
    }

    const query = `
      SELECT id, schedule_code, schedule_date, stock_level, model_name
      FROM local_schedules 
      WHERE schedule_date = $1::date 
        AND is_active = true
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const { rows } = await pool.query(query, [scheduleDate]);

    if (rows.length > 0) {
      return res.json({ 
        exists: true,
        schedule: rows[0]
      });
    }

    return res.json({ 
      exists: false 
    });
  } catch (err) {
    console.error("[Check Schedule Date] Error:", err.message);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ====== DELETE header ======
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const del = await pool.query(
      `DELETE FROM local_schedules WHERE id = $1 RETURNING id`,
      [id]
    );
    if (del.rowCount === 0)
      return res.status(404).json({ message: "Schedule not found" });
    res.json({ message: "Deleted", id: del.rows[0].id });
  } catch (e) {
    console.error("[Delete Local Schedule] Error:", e.message);
    res.status(400).json({ message: e.message });
  }
});

// ====== GET all local schedules ======
router.get("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const { status } = req.query;

    console.log("[GET Local Schedules] Query params:", { status });

    // Untuk sementara, tampilkan SEMUA data aktif tanpa filter status
    const query = `
      SELECT 
        ls.id,
        ls.schedule_code,
        ls.stock_level,
        ls.model_name,
        ls.schedule_date,
        ls.total_vendor,
        ls.total_pallet,
        ls.total_item,
        ls.status,
        ls.created_at,
        e.emp_name as upload_by_name
      FROM local_schedules ls
      LEFT JOIN employees e ON e.id = ls.upload_by
      WHERE ls.is_active = true
      ORDER BY ls.schedule_date ASC, ls.created_at ASC
    `;

    console.log("[GET Local Schedules] Executing query:", query);

    const result = await client.query(query);
    
    console.log(`[GET Local Schedules] Found ${result.rows.length} schedules`);

    // Untuk setiap schedule, ambil vendor dan parts
    const schedulesWithDetails = await Promise.all(
      result.rows.map(async (schedule) => {
        // Get vendors
        const vendorsResult = await client.query(
          `SELECT 
            lsv.id,
            lsv.trip_id,
            lsv.vendor_id,
            lsv.do_numbers,
            lsv.arrival_time,
            lsv.total_pallet,
            lsv.total_item,
            t.trip_code as trip_no,
            vd.vendor_code,
            vd.vendor_name
           FROM local_schedule_vendors lsv
           LEFT JOIN trips t ON t.id = lsv.trip_id
           LEFT JOIN vendor_detail vd ON vd.id = lsv.vendor_id
           WHERE lsv.local_schedule_id = $1 AND lsv.is_active = true
           ORDER BY lsv.id ASC`,
          [schedule.id]
        );

        // Get parts untuk setiap vendor
        const vendorsWithParts = await Promise.all(
          vendorsResult.rows.map(async (vendor) => {
            const partsResult = await client.query(
              `SELECT 
                lsp.id,
                lsp.part_code,
                lsp.part_name,
                lsp.quantity as qty,
                lsp.quantity_box as qty_box,
                lsp.unit,
                lsp.do_number
               FROM local_schedule_parts lsp
               WHERE lsp.local_schedule_vendor_id = $1 AND lsp.is_active = true
               ORDER BY lsp.id ASC`,
              [vendor.id]
            );

            return {
              ...vendor,
              parts: partsResult.rows
            };
          })
        );

        return {
          ...schedule,
          vendors: vendorsWithParts
        };
      })
    );

    res.json({
      success: true,
      data: schedulesWithDetails,
      total: schedulesWithDetails.length
    });

  } catch (error) {
    console.error("[GET Local Schedules] Error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Internal server error",
      error: error.message 
    });
  } finally {
    client.release();
  }
});

module.exports = router;