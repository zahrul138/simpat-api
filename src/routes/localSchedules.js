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

// ====== CREATE header schedule (New) ======
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const { stockLevel, modelName, scheduleDate, uploadByName } =
      req.body || {};
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
        existingSchedule: existingSchedule.rows[0],
      });
    }

    await client.query("BEGIN");

    const uploadBy = await resolveEmployeeId(client, uploadByName);

    const ins = await client.query(
      `INSERT INTO local_schedules
    (stock_level, model_name, upload_by, schedule_date, total_vendor, total_pallet, total_item, status)
   VALUES ($1,$2,$3,$4::date,0,0,0,'New')
   RETURNING id, schedule_code, stock_level, model_name, upload_by, 
             TO_CHAR(schedule_date, 'YYYY-MM-DD') as schedule_date,
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
      return res
        .status(400)
        .json({ message: "Invalid date format. Use YYYY-MM-DD" });
    }

    const query = `
      SELECT id, schedule_code, TO_CHAR(schedule_date, 'YYYY-MM-DD') as schedule_date, stock_level, model_name
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
        schedule: rows[0],
      });
    }

    return res.json({
      exists: false,
    });
  } catch (err) {
    console.error("[Check Schedule Date] Error:", err.message);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ====== GET all local schedules ======
router.get("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const { status, date_from, date_to, vendor_name, part_code, part_name } =
      req.query;

    console.log("[GET Local Schedules] Query params:", req.query);

    // Mapping status untuk frontend tabs
    const statusMapping = {
      New: "New",
      Schedule: "Scheduled",
      Today: "Today",
      Received: "Received",
      "IQC Progress": "IQC Progress",
      Sample: "Sample",
      Complete: "Complete",
      History: "History",
    };

    let query = `
      SELECT 
        ls.id,
        ls.schedule_code,
        ls.stock_level,
        ls.model_name,
        TO_CHAR(ls.schedule_date, 'YYYY-MM-DD') as schedule_date,
        ls.total_vendor,
        ls.total_pallet,
        ls.total_item,
        ls.status,
        ls.created_at,
        ls.updated_at,
        ls.upload_by,
        e.emp_name as upload_by_name
      FROM local_schedules ls
      LEFT JOIN employees e ON e.id = ls.upload_by
      WHERE ls.is_active = true
    `;

    const params = [];
    let paramCount = 0;

    // Filter berdasarkan status yang dipetakan
    if (status && statusMapping[status]) {
      paramCount++;
      query += ` AND ls.status = $${paramCount}`;
      params.push(statusMapping[status]);
    }

    // Filter berdasarkan tanggal
    if (date_from) {
      paramCount++;
      query += ` AND ls.schedule_date >= $${paramCount}`;
      params.push(date_from);
    }

    if (date_to) {
      paramCount++;
      query += ` AND ls.schedule_date <= $${paramCount}`;
      params.push(date_to);
    }

    query += ` ORDER BY ls.schedule_date DESC, ls.created_at DESC`;

    console.log("[GET Local Schedules] Executing query:", query);
    console.log("[GET Local Schedules] Parameters:", params);

    const result = await client.query(query, params);

    console.log(`[GET Local Schedules] Found ${result.rows.length} schedules`);

    // Untuk setiap schedule, ambil vendor dan parts
    const schedulesWithDetails = await Promise.all(
      result.rows.map(async (schedule) => {
        // Get vendors (dengan vendor_status, move_by, move_at)
        const vendorsResult = await client.query(
          `SELECT 
            lsv.id,
            lsv.trip_id,
            lsv.vendor_id,
            lsv.do_numbers,
            lsv.arrival_time,
            lsv.total_pallet,
            lsv.total_item,
            lsv.vendor_status,
            lsv.move_by,
            lsv.move_at,
            lsv.schedule_date_ref,
            lsv.stock_level_ref,
            lsv.model_name_ref,
            t.trip_code as trip_no,
            vd.vendor_code,
            vd.vendor_name,
            em.emp_name as move_by_name
           FROM local_schedule_vendors lsv
           LEFT JOIN trips t ON t.id = lsv.trip_id
           LEFT JOIN vendor_detail vd ON vd.id = lsv.vendor_id
           LEFT JOIN employees em ON em.id = lsv.move_by
           WHERE lsv.local_schedule_id = $1 AND lsv.is_active = true
           ORDER BY lsv.id ASC`,
          [schedule.id]
        );

        // Filter vendor berdasarkan nama jika ada filter
        let filteredVendors = vendorsResult.rows;
        if (vendor_name) {
          filteredVendors = filteredVendors.filter(
            (vendor) =>
              vendor.vendor_name
                ?.toLowerCase()
                .includes(vendor_name.toLowerCase()) ||
              vendor.vendor_code
                ?.toLowerCase()
                .includes(vendor_name.toLowerCase())
          );
        }

        // Get parts untuk setiap vendor (dengan remark dan prod_date)
        const vendorsWithParts = await Promise.all(
          filteredVendors.map(async (vendor) => {
            const partsResult = await client.query(
              `SELECT 
                lsp.id,
                lsp.part_code,
                lsp.part_name,
                lsp.quantity as qty,
                lsp.quantity_box as qty_box,
                lsp.unit,
                lsp.do_number,
                lsp.remark,
                TO_CHAR(lsp.prod_date, 'YYYY-MM-DD') as prod_date,
                COALESCE(lsp.prod_dates::jsonb, '[]'::jsonb) as prod_dates
               FROM local_schedule_parts lsp
               WHERE lsp.local_schedule_vendor_id = $1 AND lsp.is_active = true
               ORDER BY lsp.id ASC`,
              [vendor.id]
            );

            // Parse prod_dates from JSON
            const partsWithParsedDates = partsResult.rows.map(part => ({
              ...part,
              prod_dates: typeof part.prod_dates === 'string' 
                ? JSON.parse(part.prod_dates) 
                : (Array.isArray(part.prod_dates) ? part.prod_dates : [])
            }));

            // Filter parts jika ada filter
            let filteredParts = partsWithParsedDates;
            if (part_code) {
              filteredParts = filteredParts.filter((part) =>
                part.part_code?.toLowerCase().includes(part_code.toLowerCase())
              );
            }

            if (part_name) {
              filteredParts = filteredParts.filter((part) =>
                part.part_name?.toLowerCase().includes(part_name.toLowerCase())
              );
            }

            return {
              ...vendor,
              parts: filteredParts,
            };
          })
        );

        // Hanya return schedule jika ada vendor setelah filter
        // atau jika tidak ada filter vendor/part
        if (vendor_name || part_code || part_name) {
          const hasVendorsWithParts = vendorsWithParts.some(
            (vendor) => vendor.parts.length > 0
          );
          if (!hasVendorsWithParts && vendorsWithParts.length === 0) {
            return null; // Skip schedule ini
          }
        }

        return {
          ...schedule,
          vendors: vendorsWithParts.filter((v) => v), // Hapus null jika ada
        };
      })
    );

    // Filter out null schedules
    const filteredSchedules = schedulesWithDetails.filter(
      (schedule) => schedule !== null
    );

    res.json({
      success: true,
      data: filteredSchedules,
      total: filteredSchedules.length,
    });
  } catch (error) {
    console.error("[GET Local Schedules] Error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== GET vendors for Received tab (flat list without schedule header) ======
router.get("/received-vendors", async (req, res) => {
  const client = await pool.connect();
  try {
    console.log("[GET Received Vendors] Fetching vendors with Received status");

    // Get all vendors with vendor_status = 'Received'
    const vendorsResult = await client.query(
      `SELECT 
        lsv.id,
        lsv.local_schedule_id,
        lsv.trip_id,
        lsv.vendor_id,
        lsv.do_numbers,
        lsv.arrival_time,
        lsv.total_pallet,
        lsv.total_item,
        lsv.vendor_status,
        lsv.move_by,
        lsv.move_at,
        TO_CHAR(lsv.schedule_date_ref, 'YYYY-MM-DD') as schedule_date,
        lsv.stock_level_ref as stock_level,
        lsv.model_name_ref as model_name,
        t.trip_code as trip_no,
        vd.vendor_code,
        vd.vendor_name,
        em.emp_name as move_by_name
       FROM local_schedule_vendors lsv
       LEFT JOIN trips t ON t.id = lsv.trip_id
       LEFT JOIN vendor_detail vd ON vd.id = lsv.vendor_id
       LEFT JOIN employees em ON em.id = lsv.move_by
       WHERE lsv.vendor_status = 'Received' AND lsv.is_active = true
       ORDER BY lsv.move_at DESC, lsv.id ASC`
    );

    console.log(`[GET Received Vendors] Found ${vendorsResult.rows.length} vendors`);

    // Get parts for each vendor
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
            lsp.do_number,
            lsp.remark,
            TO_CHAR(lsp.prod_date, 'YYYY-MM-DD') as prod_date,
            COALESCE(lsp.prod_dates::jsonb, '[]'::jsonb) as prod_dates
           FROM local_schedule_parts lsp
           WHERE lsp.local_schedule_vendor_id = $1 AND lsp.is_active = true
           ORDER BY lsp.id ASC`,
          [vendor.id]
        );

        // Parse prod_dates from JSON
        const partsWithParsedDates = partsResult.rows.map(part => ({
          ...part,
          prod_dates: typeof part.prod_dates === 'string' 
            ? JSON.parse(part.prod_dates) 
            : (Array.isArray(part.prod_dates) ? part.prod_dates : [])
        }));

        return {
          ...vendor,
          parts: partsWithParsedDates,
        };
      })
    );

    res.json({
      success: true,
      data: vendorsWithParts,
      total: vendorsWithParts.length,
    });
  } catch (error) {
    console.error("[GET Received Vendors] Error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== GET all vendors with IQC Progress status ======
router.get("/iqc-progress-vendors", async (req, res) => {
  const client = await pool.connect();
  try {
    console.log("[GET IQC Progress Vendors] Fetching vendors with IQC Progress status");

    // Get all vendors with vendor_status = 'IQC Progress'
    const vendorsResult = await client.query(
      `SELECT 
        lsv.id,
        lsv.local_schedule_id,
        lsv.trip_id,
        lsv.vendor_id,
        lsv.do_numbers,
        lsv.arrival_time,
        lsv.total_pallet,
        lsv.total_item,
        lsv.vendor_status,
        lsv.approve_by,
        lsv.approve_at,
        TO_CHAR(lsv.schedule_date_ref, 'YYYY-MM-DD') as schedule_date,
        lsv.stock_level_ref as stock_level,
        lsv.model_name_ref as model_name,
        t.trip_code as trip_no,
        vd.vendor_code,
        vd.vendor_name,
        em.emp_name as approve_by_name
       FROM local_schedule_vendors lsv
       LEFT JOIN trips t ON t.id = lsv.trip_id
       LEFT JOIN vendor_detail vd ON vd.id = lsv.vendor_id
       LEFT JOIN employees em ON em.id = lsv.approve_by
       WHERE lsv.vendor_status = 'IQC Progress' AND lsv.is_active = true
       ORDER BY lsv.approve_at DESC, lsv.id ASC`
    );

    console.log(`[GET IQC Progress Vendors] Found ${vendorsResult.rows.length} vendors`);

    // Get parts for each vendor
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
            lsp.do_number,
            lsp.remark,
            lsp.status,
            TO_CHAR(lsp.prod_date, 'YYYY-MM-DD') as prod_date,
            COALESCE(lsp.prod_dates::jsonb, '[]'::jsonb) as prod_dates
           FROM local_schedule_parts lsp
           WHERE lsp.local_schedule_vendor_id = $1 AND lsp.is_active = true
           ORDER BY lsp.id ASC`,
          [vendor.id]
        );

        // Parse prod_dates from JSON
        const partsWithParsedDates = partsResult.rows.map(part => ({
          ...part,
          prod_dates: typeof part.prod_dates === 'string' 
            ? JSON.parse(part.prod_dates) 
            : (Array.isArray(part.prod_dates) ? part.prod_dates : [])
        }));

        return {
          ...vendor,
          parts: partsWithParsedDates,
        };
      })
    );

    res.json({
      success: true,
      data: vendorsWithParts,
      total: vendorsWithParts.length,
    });
  } catch (error) {
    console.error("[GET IQC Progress Vendors] Error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== GET all vendors with Sample status ======
router.get("/sample-vendors", async (req, res) => {
  const client = await pool.connect();
  try {
    console.log("[GET Sample Vendors] Fetching vendors with Sample status");

    // Get all vendors with vendor_status = 'Sample'
    const vendorsResult = await client.query(
      `SELECT 
        lsv.id,
        lsv.local_schedule_id,
        lsv.trip_id,
        lsv.vendor_id,
        lsv.do_numbers,
        lsv.arrival_time,
        lsv.total_pallet,
        lsv.total_item,
        lsv.vendor_status,
        lsv.sample_by,
        lsv.sample_at,
        TO_CHAR(lsv.schedule_date_ref, 'YYYY-MM-DD') as schedule_date,
        lsv.stock_level_ref as stock_level,
        lsv.model_name_ref as model_name,
        t.trip_code as trip_no,
        vd.vendor_code,
        vd.vendor_name,
        em.emp_name as sample_by_name
       FROM local_schedule_vendors lsv
       LEFT JOIN trips t ON t.id = lsv.trip_id
       LEFT JOIN vendor_detail vd ON vd.id = lsv.vendor_id
       LEFT JOIN employees em ON em.id = lsv.sample_by
       WHERE lsv.vendor_status = 'Sample' AND lsv.is_active = true
       ORDER BY lsv.sample_at DESC, lsv.id ASC`
    );

    console.log(`[GET Sample Vendors] Found ${vendorsResult.rows.length} vendors`);

    // Get parts for each vendor
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
            lsp.do_number,
            lsp.remark,
            lsp.status,
            TO_CHAR(lsp.prod_date, 'YYYY-MM-DD') as prod_date,
            lsp.prod_dates
           FROM local_schedule_parts lsp
           WHERE lsp.local_schedule_vendor_id = $1 AND lsp.is_active = true
           ORDER BY lsp.id ASC`,
          [vendor.id]
        );

        // Parse prod_dates for each part
        const partsWithParsedDates = partsResult.rows.map((part) => {
          let parsedProdDates = [];
          if (part.prod_dates) {
            try {
              if (typeof part.prod_dates === "string") {
                parsedProdDates = JSON.parse(part.prod_dates);
              } else if (Array.isArray(part.prod_dates)) {
                parsedProdDates = part.prod_dates;
              }
            } catch (e) {
              console.error("[GET Sample Vendors] Error parsing prod_dates:", e);
            }
          }
          return {
            ...part,
            prod_dates: parsedProdDates,
          };
        });

        return {
          ...vendor,
          parts: partsWithParsedDates,
        };
      })
    );

    res.json({
      success: true,
      data: vendorsWithParts,
      total: vendorsWithParts.length,
    });
  } catch (error) {
    console.error("[GET Sample Vendors] Error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== GET all vendors with Complete status ======
router.get("/complete-vendors", async (req, res) => {
  const client = await pool.connect();
  try {
    console.log("[GET Complete Vendors] Fetching vendors with Complete status");

    const vendorsResult = await client.query(
      `SELECT 
        lsv.id,
        lsv.local_schedule_id,
        lsv.trip_id,
        lsv.vendor_id,
        lsv.do_numbers,
        lsv.arrival_time,
        lsv.total_pallet,
        lsv.total_item,
        lsv.vendor_status,
        lsv.complete_by,
        lsv.complete_at,
        TO_CHAR(lsv.schedule_date_ref, 'YYYY-MM-DD') as schedule_date,
        lsv.stock_level_ref as stock_level,
        lsv.model_name_ref as model_name,
        t.trip_code as trip_no,
        vd.vendor_code,
        vd.vendor_name,
        em.emp_name as complete_by_name
       FROM local_schedule_vendors lsv
       LEFT JOIN trips t ON t.id = lsv.trip_id
       LEFT JOIN vendor_detail vd ON vd.id = lsv.vendor_id
       LEFT JOIN employees em ON em.id = lsv.complete_by
       WHERE lsv.vendor_status = 'Complete' AND lsv.is_active = true
       ORDER BY lsv.complete_at DESC, lsv.id ASC`
    );

    console.log(`[GET Complete Vendors] Found ${vendorsResult.rows.length} vendors`);

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
            lsp.do_number,
            lsp.remark,
            lsp.status,
            TO_CHAR(lsp.prod_date, 'YYYY-MM-DD') as prod_date,
            lsp.prod_dates
           FROM local_schedule_parts lsp
           WHERE lsp.local_schedule_vendor_id = $1 AND lsp.is_active = true
           ORDER BY lsp.id ASC`,
          [vendor.id]
        );

        // Parse prod_dates for each part
        const partsWithParsedDates = partsResult.rows.map((part) => {
          let parsedProdDates = [];
          if (part.prod_dates) {
            try {
              if (typeof part.prod_dates === "string") {
                parsedProdDates = JSON.parse(part.prod_dates);
              } else if (Array.isArray(part.prod_dates)) {
                parsedProdDates = part.prod_dates;
              }
            } catch (e) {
              console.error("[GET Complete Vendors] Error parsing prod_dates:", e);
            }
          }
          return {
            ...part,
            prod_dates: parsedProdDates,
          };
        });

        return {
          ...vendor,
          parts: partsWithParsedDates,
        };
      })
    );

    res.json({
      success: true,
      data: vendorsWithParts,
      total: vendorsWithParts.length,
    });
  } catch (error) {
    console.error("[GET Complete Vendors] Error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== GET all local schedules dengan filter status ======
router.get("/with-status", async (req, res) => {
  const client = await pool.connect();
  try {
    const { status = "Draft" } = req.query;

    console.log("[GET Local Schedules with Status] Query params:", { status });

    let query = `
      SELECT 
        ls.id,
        ls.schedule_code,
        ls.stock_level,
        ls.model_name,
        TO_CHAR(ls.schedule_date, 'YYYY-MM-DD') as schedule_date,
        ls.total_vendor,
        ls.total_pallet,
        ls.total_item,
        ls.status,
        ls.created_at,
        ls.updated_at,
        ls.upload_by,
        e.emp_name as upload_by_name
      FROM local_schedules ls
      LEFT JOIN employees e ON e.id = ls.upload_by
      WHERE ls.is_active = true
    `;

    const params = [];

    // Filter berdasarkan status
    if (status && status !== "All") {
      query += ` AND ls.status = $1`;
      params.push(status);
    }

    query += ` ORDER BY ls.schedule_date ASC, ls.created_at ASC`;

    console.log("[GET Local Schedules] Executing query:", query, params);

    const result = await client.query(query, params);

    console.log(`[GET Local Schedules] Found ${result.rows.length} schedules`);

    // Untuk setiap schedule, ambil vendor dan parts
    const schedulesWithDetails = await Promise.all(
      result.rows.map(async (schedule) => {
        // Get vendors (dengan vendor_status)
        const vendorsResult = await client.query(
          `SELECT 
            lsv.id,
            lsv.trip_id,
            lsv.vendor_id,
            lsv.do_numbers,
            lsv.arrival_time,
            lsv.total_pallet,
            lsv.total_item,
            lsv.vendor_status,
            lsv.move_by,
            lsv.move_at,
            t.trip_code as trip_no,
            vd.vendor_code,
            vd.vendor_name,
            em.emp_name as move_by_name
           FROM local_schedule_vendors lsv
           LEFT JOIN trips t ON t.id = lsv.trip_id
           LEFT JOIN vendor_detail vd ON vd.id = lsv.vendor_id
           LEFT JOIN employees em ON em.id = lsv.move_by
           WHERE lsv.local_schedule_id = $1 AND lsv.is_active = true
           ORDER BY lsv.id ASC`,
          [schedule.id]
        );

        // Get parts untuk setiap vendor (dengan remark dan prod_date)
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
                lsp.do_number,
                lsp.remark,
                TO_CHAR(lsp.prod_date, 'YYYY-MM-DD') as prod_date
               FROM local_schedule_parts lsp
               WHERE lsp.local_schedule_vendor_id = $1 AND lsp.is_active = true
               ORDER BY lsp.id ASC`,
              [vendor.id]
            );

            return {
              ...vendor,
              parts: partsResult.rows,
            };
          })
        );

        return {
          ...schedule,
          vendors: vendorsWithParts,
        };
      })
    );

    res.json({
      success: true,
      data: schedulesWithDetails,
      total: schedulesWithDetails.length,
    });
  } catch (error) {
    console.error("[GET Local Schedules with Status] Error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== GET qty_per_box from kanban_master ======
router.get("/parts/qty-per-box/:partCode", async (req, res) => {
  try {
    const { partCode } = req.params;
    
    const result = await pool.query(
      `SELECT qty_per_box FROM kanban_master WHERE part_code = $1 AND is_active = true LIMIT 1`,
      [partCode]
    );

    if (result.rowCount > 0) {
      res.json({
        success: true,
        qty_per_box: result.rows[0].qty_per_box || 1,
      });
    } else {
      res.json({
        success: true,
        qty_per_box: 1, // Default value
      });
    }
  } catch (error) {
    console.error("[GET Qty Per Box] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get qty_per_box",
      error: error.message,
    });
  }
});

// ====== UPDATE multiple schedules status (BULK) ======
router.put("/bulk/status", async (req, res) => {
  const client = await pool.connect();
  try {
    const { scheduleIds, targetTab } = req.body;

    console.log(`[BULK UPDATE] Request received:`, {
      scheduleIds,
      targetTab,
      body: req.body,
    });

    // Validasi input
    if (
      !scheduleIds ||
      !Array.isArray(scheduleIds) ||
      scheduleIds.length === 0
    ) {
      console.log("[BULK UPDATE] Error: scheduleIds is missing or invalid");
      return res.status(400).json({
        success: false,
        message: "scheduleIds array is required",
      });
    }

    if (!targetTab) {
      console.log("[BULK UPDATE] Error: targetTab is missing");
      return res.status(400).json({
        success: false,
        message: "targetTab is required",
      });
    }

    // Mapping tab ke status database
    const tabToStatusMapping = {
      New: "New",
      Schedule: "Scheduled",
      Today: "Today",
      Received: "Received",
      "IQC Progress": "IQC Progress",
      Sample: "Sample",
      Complete: "Complete",
      History: "History",
    };

    const finalStatus = tabToStatusMapping[targetTab];

    if (!finalStatus) {
      console.log("[BULK UPDATE] Error: Invalid targetTab:", targetTab);
      return res.status(400).json({
        success: false,
        message: `Invalid targetTab: ${targetTab}. Valid values: ${Object.keys(
          tabToStatusMapping
        ).join(", ")}`,
      });
    }

    console.log(
      `[BULK UPDATE] Converting: "${targetTab}" → DB status: "${finalStatus}"`
    );

    await client.query("BEGIN");

    // Cek schedules yang akan diupdate
    const checkResult = await client.query(
      `SELECT id, schedule_code, status 
       FROM local_schedules 
       WHERE id = ANY($1::int[]) AND is_active = true`,
      [scheduleIds]
    );

    console.log(
      `[BULK UPDATE] Found ${checkResult.rowCount} schedules to update`
    );
    console.log(`[BULK UPDATE] Schedules before update:`, checkResult.rows);

    if (checkResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "No schedules found with provided IDs",
      });
    }

    const updateResult = await client.query(
      `UPDATE local_schedules 
      SET status = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ANY($2::int[]) AND is_active = true
      RETURNING id, schedule_code, status, TO_CHAR(schedule_date, 'YYYY-MM-DD') as schedule_date`,
      [finalStatus, scheduleIds]
    );

    console.log(
      `[BULK UPDATE] Successfully updated ${updateResult.rowCount} schedules`
    );
    console.log(`[BULK UPDATE] Updated schedules:`, updateResult.rows);

    await client.query("COMMIT");

    res.json({
      success: true,
      message: `Successfully moved ${updateResult.rowCount} schedule(s) to ${targetTab} tab`,
      data: {
        updatedCount: updateResult.rowCount,
        updatedSchedules: updateResult.rows,
        targetTab: targetTab,
        targetStatus: finalStatus,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[BULK UPDATE] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update schedules",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// PUT /api/local-schedules/parts/:id
// Update untuk menerima prod_dates (array)
router.put('/parts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      part_code,
      part_name,
      quantity,
      quantity_box,
      unit,
      remark,
      prod_date,
      prod_dates,  // NEW: Array of dates
      status
    } = req.body;

    const updateFields = [];
    const values = [];
    let paramIndex = 1;

    if (part_code !== undefined) {
      updateFields.push(`part_code = $${paramIndex++}`);
      values.push(part_code);
    }
    if (part_name !== undefined) {
      updateFields.push(`part_name = $${paramIndex++}`);
      values.push(part_name);
    }
    if (quantity !== undefined) {
      updateFields.push(`quantity = $${paramIndex++}`);
      values.push(quantity);
    }
    if (quantity_box !== undefined) {
      updateFields.push(`quantity_box = $${paramIndex++}`);
      values.push(quantity_box);
    }
    if (unit !== undefined) {
      updateFields.push(`unit = $${paramIndex++}`);
      values.push(unit);
    }
    if (remark !== undefined) {
      updateFields.push(`remark = $${paramIndex++}`);
      values.push(remark);
    }
    if (prod_date !== undefined) {
      updateFields.push(`prod_date = $${paramIndex++}`);
      values.push(prod_date);
    }
    // NEW: Handle prod_dates array
    if (prod_dates !== undefined) {
      updateFields.push(`prod_dates = $${paramIndex++}`);
      values.push(JSON.stringify(prod_dates));
    }
    if (status !== undefined) {
      updateFields.push(`status = $${paramIndex++}`);
      values.push(status);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    values.push(id);
    const query = `
      UPDATE local_schedule_parts 
      SET ${updateFields.join(', ')}, updated_at = NOW()
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Part not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error updating part:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ====== UPDATE VENDOR STATUS (untuk move per vendor ke Received) ======
router.put("/vendors/:vendorId/status", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId } = req.params;
    const { status, moveByName } = req.body;

    console.log(`[UPDATE Vendor Status] Request:`, { vendorId, status, moveByName });

    if (!status) {
      return res.status(400).json({
        success: false,
        message: "Status is required",
      });
    }

    await client.query("BEGIN");

    // Cek apakah vendor exists dan dapatkan schedule_id
    const vendorCheck = await client.query(
      `SELECT lsv.id, lsv.local_schedule_id, lsv.vendor_status,
              ls.schedule_date, ls.stock_level, ls.model_name
       FROM local_schedule_vendors lsv
       JOIN local_schedules ls ON ls.id = lsv.local_schedule_id
       WHERE lsv.id = $1 AND lsv.is_active = true`,
      [vendorId]
    );

    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    const scheduleId = vendorCheck.rows[0].local_schedule_id;
    const scheduleDate = vendorCheck.rows[0].schedule_date;
    const stockLevel = vendorCheck.rows[0].stock_level;
    const modelName = vendorCheck.rows[0].model_name;

    // Resolve move_by employee ID
    let moveById = null;
    if (moveByName) {
      moveById = await resolveEmployeeId(client, moveByName);
    }

    // Update vendor status with move_by, move_at, and reference fields
    let vendorResult;
    if (status === 'Received') {
      vendorResult = await client.query(
        `UPDATE local_schedule_vendors 
         SET vendor_status = $1, 
             move_by = $2,
             move_at = CURRENT_TIMESTAMP,
             schedule_date_ref = $3::date,
             stock_level_ref = $4,
             model_name_ref = $5,
             updated_at = CURRENT_TIMESTAMP 
         WHERE id = $6 AND is_active = true 
         RETURNING id, local_schedule_id, vendor_status, move_by, move_at`,
        [status, moveById, scheduleDate, stockLevel, modelName, vendorId]
      );
    } else {
      vendorResult = await client.query(
        `UPDATE local_schedule_vendors 
         SET vendor_status = $1, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $2 AND is_active = true 
         RETURNING id, local_schedule_id, vendor_status`,
        [status, vendorId]
      );
    }

    console.log(`[UPDATE Vendor Status] Vendor updated:`, vendorResult.rows[0]);

    // Cek apakah semua vendor di schedule sudah status yang sama
    const allVendorsCheck = await client.query(
      `SELECT COUNT(*) as total, 
              SUM(CASE WHEN vendor_status = $1 THEN 1 ELSE 0 END) as matched_count
       FROM local_schedule_vendors 
       WHERE local_schedule_id = $2 AND is_active = true`,
      [status, scheduleId]
    );

    const { total, matched_count } = allVendorsCheck.rows[0];

    console.log(`[UPDATE Vendor Status] Vendor counts:`, {
      total: parseInt(total),
      matched_count: parseInt(matched_count),
    });

    // Jika semua vendor sudah status yang sama, update schedule status juga
    if (parseInt(total) > 0 && parseInt(total) === parseInt(matched_count)) {
      // Map vendor status ke schedule status
      const scheduleStatusMapping = {
        Received: "Received",
        "IQC Progress": "IQC Progress",
        Sample: "Sample",
        Complete: "Complete",
      };

      const newScheduleStatus = scheduleStatusMapping[status] || status;

      const scheduleResult = await client.query(
        `UPDATE local_schedules 
         SET status = $1, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $2 AND is_active = true 
         RETURNING id, schedule_code, status`,
        [newScheduleStatus, scheduleId]
      );

      console.log(
        `[UPDATE Vendor Status] Schedule auto-updated:`,
        scheduleResult.rows[0]
      );
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: `Vendor status updated to ${status}`,
      data: {
        vendor: vendorResult.rows[0],
        scheduleId: scheduleId,
        allVendorsMatched: parseInt(total) === parseInt(matched_count),
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[UPDATE Vendor Status] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update vendor status",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== APPROVE VENDOR (move from Received to IQC Progress) ======
router.put("/vendors/:vendorId/approve", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId } = req.params;
    const { approveByName } = req.body;

    console.log(`[APPROVE Vendor] Request:`, { vendorId, approveByName });

    await client.query("BEGIN");

    // Cek apakah vendor exists
    const vendorCheck = await client.query(
      `SELECT id, local_schedule_id, vendor_status 
       FROM local_schedule_vendors 
       WHERE id = $1 AND is_active = true`,
      [vendorId]
    );

    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    const scheduleId = vendorCheck.rows[0].local_schedule_id;

    // Get employee ID from name
    let approveById = null;
    if (approveByName) {
      const empResult = await client.query(
        `SELECT id FROM employees WHERE emp_name = $1 LIMIT 1`,
        [approveByName]
      );
      if (empResult.rowCount > 0) {
        approveById = empResult.rows[0].id;
      }
    }

    // Update vendor status to IQC Progress with approve_by and approve_at
    const vendorResult = await client.query(
      `UPDATE local_schedule_vendors 
       SET vendor_status = 'IQC Progress', 
           approve_by = $2,
           approve_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND is_active = true 
       RETURNING id, local_schedule_id, vendor_status, approve_by, approve_at`,
      [vendorId, approveById]
    );

    console.log(`[APPROVE Vendor] Vendor approved:`, vendorResult.rows[0]);

    // Cek apakah semua vendor di schedule sudah IQC Progress
    const allVendorsCheck = await client.query(
      `SELECT COUNT(*) as total, 
              SUM(CASE WHEN vendor_status = 'IQC Progress' THEN 1 ELSE 0 END) as matched_count
       FROM local_schedule_vendors 
       WHERE local_schedule_id = $1 AND is_active = true`,
      [scheduleId]
    );

    const { total, matched_count } = allVendorsCheck.rows[0];

    // Jika semua vendor sudah IQC Progress, update schedule status
    if (parseInt(total) > 0 && parseInt(total) === parseInt(matched_count)) {
      await client.query(
        `UPDATE local_schedules 
         SET status = 'IQC Progress', updated_at = CURRENT_TIMESTAMP 
         WHERE id = $1 AND is_active = true`,
        [scheduleId]
      );
      console.log(`[APPROVE Vendor] Schedule auto-updated to IQC Progress`);
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Vendor approved and moved to IQC Progress",
      data: {
        vendor: vendorResult.rows[0],
        scheduleId: scheduleId,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[APPROVE Vendor] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to approve vendor",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== MOVE VENDOR TO SAMPLE (from IQC Progress to Sample) ======
router.put("/vendors/:vendorId/move-to-sample", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId } = req.params;
    const { moveByName } = req.body;

    console.log(`[MOVE TO SAMPLE] Request:`, { vendorId, moveByName });

    await client.query("BEGIN");

    // Cek apakah vendor exists
    const vendorCheck = await client.query(
      `SELECT id, local_schedule_id, vendor_status 
       FROM local_schedule_vendors 
       WHERE id = $1 AND is_active = true`,
      [vendorId]
    );

    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    const scheduleId = vendorCheck.rows[0].local_schedule_id;

    // Get employee ID from name
    let sampleById = null;
    if (moveByName) {
      const empResult = await client.query(
        `SELECT id FROM employees WHERE emp_name = $1 LIMIT 1`,
        [moveByName]
      );
      if (empResult.rowCount > 0) {
        sampleById = empResult.rows[0].id;
      }
    }

    // Update vendor status to Sample with sample_by and sample_at
    const vendorResult = await client.query(
      `UPDATE local_schedule_vendors 
       SET vendor_status = 'Sample', 
           sample_by = $2,
           sample_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND is_active = true 
       RETURNING id, local_schedule_id, vendor_status, sample_by, sample_at`,
      [vendorId, sampleById]
    );

    console.log(`[MOVE TO SAMPLE] Vendor moved:`, vendorResult.rows[0]);

    // Cek apakah semua vendor di schedule sudah Sample
    const allVendorsCheck = await client.query(
      `SELECT COUNT(*) as total, 
              SUM(CASE WHEN vendor_status = 'Sample' THEN 1 ELSE 0 END) as matched_count
       FROM local_schedule_vendors 
       WHERE local_schedule_id = $1 AND is_active = true`,
      [scheduleId]
    );

    const { total, matched_count } = allVendorsCheck.rows[0];

    // Jika semua vendor sudah Sample, update schedule status
    if (parseInt(total) > 0 && parseInt(total) === parseInt(matched_count)) {
      await client.query(
        `UPDATE local_schedules 
         SET status = 'Sample', updated_at = CURRENT_TIMESTAMP 
         WHERE id = $1 AND is_active = true`,
        [scheduleId]
      );
      console.log(`[MOVE TO SAMPLE] Schedule auto-updated to Sample`);
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Vendor moved to Sample",
      data: {
        vendor: vendorResult.rows[0],
        scheduleId: scheduleId,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[MOVE TO SAMPLE] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to move vendor to Sample",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== MOVE VENDOR TO COMPLETE (from Sample to Complete) ======
router.put("/vendors/:vendorId/move-to-complete", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId } = req.params;
    const { moveByName } = req.body;

    console.log(`[MOVE TO COMPLETE] Request:`, { vendorId, moveByName });

    await client.query("BEGIN");

    // Cek apakah vendor exists
    const vendorCheck = await client.query(
      `SELECT id, local_schedule_id, vendor_status 
       FROM local_schedule_vendors 
       WHERE id = $1 AND is_active = true`,
      [vendorId]
    );

    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    const scheduleId = vendorCheck.rows[0].local_schedule_id;

    // Get employee ID from name
    let completeById = null;
    if (moveByName) {
      const empResult = await client.query(
        `SELECT id FROM employees WHERE emp_name = $1 LIMIT 1`,
        [moveByName]
      );
      if (empResult.rowCount > 0) {
        completeById = empResult.rows[0].id;
      }
    }

    // Update vendor status to Complete with complete_by and complete_at
    const vendorResult = await client.query(
      `UPDATE local_schedule_vendors 
       SET vendor_status = 'Complete', 
           complete_by = $2,
           complete_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND is_active = true 
       RETURNING id, local_schedule_id, vendor_status, complete_by, complete_at`,
      [vendorId, completeById]
    );

    console.log(`[MOVE TO COMPLETE] Vendor moved:`, vendorResult.rows[0]);

    // Cek apakah semua vendor di schedule sudah Complete
    const allVendorsCheck = await client.query(
      `SELECT COUNT(*) as total, 
              SUM(CASE WHEN vendor_status = 'Complete' THEN 1 ELSE 0 END) as matched_count
       FROM local_schedule_vendors 
       WHERE local_schedule_id = $1 AND is_active = true`,
      [scheduleId]
    );

    const { total, matched_count } = allVendorsCheck.rows[0];

    // Jika semua vendor sudah Complete, update schedule status
    if (parseInt(total) > 0 && parseInt(total) === parseInt(matched_count)) {
      await client.query(
        `UPDATE local_schedules 
         SET status = 'Complete', updated_at = CURRENT_TIMESTAMP 
         WHERE id = $1 AND is_active = true`,
        [scheduleId]
      );
      console.log(`[MOVE TO COMPLETE] Schedule auto-updated to Complete`);
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Vendor moved to Complete",
      data: {
        vendor: vendorResult.rows[0],
        scheduleId: scheduleId,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[MOVE TO COMPLETE] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to move vendor to Complete",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== RETURN VENDOR (move from Received back to Today) ======
router.put("/vendors/:vendorId/return", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId } = req.params;

    console.log(`[RETURN Vendor] Request:`, { vendorId });

    await client.query("BEGIN");

    // Cek apakah vendor exists
    const vendorCheck = await client.query(
      `SELECT id, local_schedule_id, vendor_status 
       FROM local_schedule_vendors 
       WHERE id = $1 AND is_active = true`,
      [vendorId]
    );

    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    const scheduleId = vendorCheck.rows[0].local_schedule_id;

    // Update vendor status back to Today (clear move_by and move_at)
    const vendorResult = await client.query(
      `UPDATE local_schedule_vendors 
       SET vendor_status = NULL, 
           move_by = NULL, 
           move_at = NULL,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND is_active = true 
       RETURNING id, local_schedule_id, vendor_status`,
      [vendorId]
    );

    console.log(`[RETURN Vendor] Vendor returned to Today:`, vendorResult.rows[0]);

    // Update schedule status back to Today
    await client.query(
      `UPDATE local_schedules 
       SET status = 'Today', updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND is_active = true`,
      [scheduleId]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Vendor returned to Today tab",
      data: {
        vendor: vendorResult.rows[0],
        scheduleId: scheduleId,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[RETURN Vendor] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to return vendor",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== UPDATE SCHEDULE (untuk edit schedule di tab Schedule) ======
router.put("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { scheduleDate, stockLevel, modelName, uploadByName } = req.body;

    console.log(`[UPDATE Schedule] Request:`, {
      id,
      scheduleDate,
      stockLevel,
      modelName,
      uploadByName,
    });

    // Validasi input
    if (!scheduleDate || !stockLevel || !modelName) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: scheduleDate, stockLevel, modelName",
      });
    }

    await client.query("BEGIN");

    // Cek apakah schedule exists
    const scheduleCheck = await client.query(
      `SELECT id, schedule_code, status FROM local_schedules 
       WHERE id = $1 AND is_active = true`,
      [id]
    );

    if (scheduleCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Schedule not found",
      });
    }

    // Resolve employee ID dari nama
    const uploadBy = await resolveEmployeeId(client, uploadByName);

    // Update schedule
    const result = await client.query(
      `UPDATE local_schedules 
       SET schedule_date = $1::date, 
           stock_level = $2, 
           model_name = $3, 
           upload_by = $4,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $5 AND is_active = true 
       RETURNING id, schedule_code, TO_CHAR(schedule_date, 'YYYY-MM-DD') as schedule_date, stock_level, model_name, 
                 upload_by, status, updated_at`,
      [scheduleDate, stockLevel, modelName, uploadBy, id]
    );

    await client.query("COMMIT");

    console.log(`[UPDATE Schedule] Success:`, result.rows[0]);

    res.json({
      success: true,
      message: "Schedule updated successfully",
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[UPDATE Schedule] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update schedule",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== UPDATE schedule status ======
router.put("/:id/status", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { status } = req.body;

    console.log(`[UPDATE SINGLE STATUS] Request:`, { id, status });

    if (!status) {
      return res.status(400).json({
        success: false,
        message: "Status is required",
      });
    }

    const validStatuses = [
      "New",
      "Scheduled",
      "Today",
      "Received",
      "IQC Progress",
      "Sample",
      "Complete",
      "History",
    ];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status value",
      });
    }

    const result = await client.query(
      `UPDATE local_schedules 
       SET status = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 AND is_active = true 
       RETURNING id, schedule_code, status`,
      [status, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Schedule not found",
      });
    }

    console.log(`[UPDATE SINGLE STATUS] Success:`, result.rows[0]);

    res.json({
      success: true,
      message: "Status updated successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("[UPDATE SINGLE STATUS] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update status",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== ADD VENDOR to existing schedule ======
router.post("/:scheduleId/vendors", async (req, res) => {
  const client = await pool.connect();
  try {
    const { scheduleId } = req.params;
    const { trip_id, vendor_id, do_numbers } = req.body;

    console.log(`[ADD Vendor] Request:`, { scheduleId, trip_id, vendor_id, do_numbers });

    if (!trip_id || !vendor_id || !do_numbers) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: trip_id, vendor_id, do_numbers",
      });
    }

    await client.query("BEGIN");

    // Cek schedule exists
    const scheduleCheck = await client.query(
      `SELECT id, schedule_date, stock_level, model_name FROM local_schedules WHERE id = $1 AND is_active = true`,
      [scheduleId]
    );

    if (scheduleCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Schedule not found",
      });
    }

    // Get trip arrival time
    const tripCheck = await client.query(
      `SELECT id, arv_to FROM trips WHERE id = $1`,
      [trip_id]
    );

    if (tripCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Trip not found",
      });
    }

    const arrivalTime = tripCheck.rows[0].arv_to;
    const doJoined = Array.isArray(do_numbers) ? do_numbers.join(" | ") : do_numbers;

    // Insert vendor
    const result = await client.query(
      `INSERT INTO local_schedule_vendors
       (local_schedule_id, trip_id, vendor_id, do_numbers, arrival_time, total_pallet, total_item)
       VALUES ($1, $2, $3, $4, $5, 0, 0)
       RETURNING id, local_schedule_id, trip_id, vendor_id, do_numbers, arrival_time`,
      [scheduleId, trip_id, vendor_id, doJoined, arrivalTime]
    );

    // Update total_vendor di schedule
    await client.query(
      `UPDATE local_schedules
       SET total_vendor = (
         SELECT COUNT(*) FROM local_schedule_vendors WHERE local_schedule_id = $1 AND is_active = true
       ),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [scheduleId]
    );

    await client.query("COMMIT");

    console.log(`[ADD Vendor] Success:`, result.rows[0]);

    res.status(201).json({
      success: true,
      message: "Vendor added successfully",
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[ADD Vendor] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to add vendor",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== ADD PART to existing vendor ======
router.post("/vendors/:vendorId/parts", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId } = req.params;
    const { part_code, part_name, quantity, quantity_box, unit, do_number } = req.body;

    console.log(`[ADD Part] Request:`, { vendorId, part_code, part_name, quantity, quantity_box, unit });

    if (!part_code) {
      return res.status(400).json({
        success: false,
        message: "Missing required field: part_code",
      });
    }

    await client.query("BEGIN");

    // Cek vendor exists
    const vendorCheck = await client.query(
      `SELECT id, local_schedule_id FROM local_schedule_vendors WHERE id = $1 AND is_active = true`,
      [vendorId]
    );

    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    const scheduleId = vendorCheck.rows[0].local_schedule_id;

    // Get part_id from kanban_master if exists
    let partId = null;
    const partRes = await client.query(
      `SELECT id FROM kanban_master WHERE part_code = $1 AND is_active = true LIMIT 1`,
      [part_code.trim()]
    );
    if (partRes.rows[0]) {
      partId = partRes.rows[0].id;
    }

    // Insert part
    const result = await client.query(
      `INSERT INTO local_schedule_parts
       (local_schedule_vendor_id, part_id, part_code, part_name, quantity, quantity_box, unit, do_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, part_code, part_name, quantity as qty, quantity_box as qty_box, unit`,
      [vendorId, partId, part_code, part_name || "", Number(quantity) || 0, Number(quantity_box) || 0, unit || "PCS", do_number || ""]
    );

    // Update total_item di vendor
    await client.query(
      `UPDATE local_schedule_vendors
       SET total_item = (
         SELECT COUNT(*) FROM local_schedule_parts WHERE local_schedule_vendor_id = $1 AND is_active = true
       ),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [vendorId]
    );

    // Update total_item di schedule
    await client.query(
      `UPDATE local_schedules
       SET total_item = (
         SELECT COUNT(*) 
         FROM local_schedule_parts lsp
         JOIN local_schedule_vendors lsv ON lsp.local_schedule_vendor_id = lsv.id
         WHERE lsv.local_schedule_id = $1 AND lsp.is_active = true
       ),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [scheduleId]
    );

    await client.query("COMMIT");

    console.log(`[ADD Part] Success:`, result.rows[0]);

    res.status(201).json({
      success: true,
      message: "Part added successfully",
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[ADD Part] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to add part",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== DELETE SCHEDULE (CASCADE) ======
router.delete("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    console.log(`[DELETE Schedule] Deleting schedule ID: ${id}`);

    await client.query("BEGIN");

    // 1. Cek apakah schedule exists
    const scheduleCheck = await client.query(
      `SELECT id, schedule_code, status FROM local_schedules 
       WHERE id = $1 AND is_active = true`,
      [id]
    );

    if (scheduleCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      console.log(`[DELETE Schedule] Schedule ${id} not found`);
      return res.status(404).json({
        success: false,
        message: "Schedule not found or already deleted"
      });
    }

    const schedule = scheduleCheck.rows[0];
    console.log(`[DELETE Schedule] Found schedule:`, schedule);

    // 2. Dapatkan semua vendor IDs dari schedule ini
    const vendorIdsResult = await client.query(
      `SELECT id FROM local_schedule_vendors 
       WHERE local_schedule_id = $1 AND is_active = true`,
      [id]
    );

    const vendorIds = vendorIdsResult.rows.map(row => row.id);
    console.log(`[DELETE Schedule] Found ${vendorIds.length} vendors to delete`);

    let deletedParts = 0;
    let deletedVendors = 0;

    // 3. Delete semua parts dari vendors ini
    if (vendorIds.length > 0) {
      const partsDeleteResult = await client.query(
        `DELETE FROM local_schedule_parts 
         WHERE local_schedule_vendor_id = ANY($1::int[])
         RETURNING id`,
        [vendorIds]
      );
      deletedParts = partsDeleteResult.rowCount;
      console.log(`[DELETE Schedule] Deleted ${deletedParts} parts`);
    }

    // 4. Delete semua vendors
    const vendorsDeleteResult = await client.query(
      `DELETE FROM local_schedule_vendors 
       WHERE local_schedule_id = $1
       RETURNING id`,
      [id]
    );
    deletedVendors = vendorsDeleteResult.rowCount;
    console.log(`[DELETE Schedule] Deleted ${deletedVendors} vendors`);

    // 5. Delete schedule header
    const scheduleDeleteResult = await client.query(
      `DELETE FROM local_schedules 
       WHERE id = $1 
       RETURNING id, schedule_code, status, schedule_date`,
      [id]
    );

    console.log(`[DELETE Schedule] Deleted schedule:`, scheduleDeleteResult.rows[0]);

    await client.query("COMMIT");

    console.log(`[DELETE Schedule] Successfully deleted schedule ${id}`);

    res.json({
      success: true,
      message: "Schedule and all related data deleted successfully",
      data: {
        schedule: scheduleDeleteResult.rows[0],
        deletedVendors: deletedVendors,
        deletedParts: deletedParts
      }
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[DELETE Schedule] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete schedule",
      error: error.message
    });
  } finally {
    client.release();
  }
});

// ====== DELETE VENDOR (CASCADE) ======
router.delete("/vendors/:vendorId", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId } = req.params;

    console.log(`[DELETE Vendor] Deleting vendor ID: ${vendorId}`);

    await client.query("BEGIN");

    // 1. Cek apakah vendor exists dan ambil schedule_id
    const vendorCheck = await client.query(
      `SELECT id, local_schedule_id FROM local_schedule_vendors 
       WHERE id = $1 AND is_active = true`,
      [vendorId]
    );

    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      console.log(`[DELETE Vendor] Vendor ${vendorId} not found`);
      return res.status(404).json({
        success: false,
        message: "Vendor not found or already deleted",
      });
    }

    const vendor = vendorCheck.rows[0];
    const scheduleId = vendor.local_schedule_id;
    console.log(`[DELETE Vendor] Found vendor:`, vendor);

    // 2. Delete semua parts dari vendor ini
    const partsDeleteResult = await client.query(
      `DELETE FROM local_schedule_parts 
       WHERE local_schedule_vendor_id = $1
       RETURNING id`,
      [vendorId]
    );
    const deletedParts = partsDeleteResult.rowCount;
    console.log(`[DELETE Vendor] Deleted ${deletedParts} parts`);

    // 3. Delete vendor
    const vendorDeleteResult = await client.query(
      `DELETE FROM local_schedule_vendors 
       WHERE id = $1 
       RETURNING id`,
      [vendorId]
    );
    console.log(`[DELETE Vendor] Deleted vendor:`, vendorDeleteResult.rows[0]);

    // 4. Update total_vendor di schedule header
    const updateResult = await client.query(
      `UPDATE local_schedules
       SET total_vendor = (
         SELECT COUNT(*) FROM local_schedule_vendors 
         WHERE local_schedule_id = $1 AND is_active = true
       ),
       total_item = (
         SELECT COUNT(*) 
         FROM local_schedule_parts lsp
         JOIN local_schedule_vendors lsv ON lsp.local_schedule_vendor_id = lsv.id
         WHERE lsv.local_schedule_id = $1 AND lsp.is_active = true
       ),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING total_vendor, total_item`,
      [scheduleId]
    );
    console.log(
      `[DELETE Vendor] Updated schedule totals:`,
      updateResult.rows[0]
    );

    await client.query("COMMIT");

    console.log(
      `[DELETE Vendor] Successfully deleted vendor ${vendorId} with all parts`
    );

    res.json({
      success: true,
      message: "Vendor and all related parts deleted successfully",
      data: {
        deletedVendorId: vendorId,
        deletedParts: deletedParts,
        scheduleId: scheduleId,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[DELETE Vendor] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete vendor",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== DELETE PART ======
router.delete("/parts/:partId", async (req, res) => {
  const client = await pool.connect();
  try {
    const { partId } = req.params;

    console.log(`[DELETE Part] Deleting part ID: ${partId}`);

    await client.query("BEGIN");

    // 1. Cek apakah part exists dan ambil vendor_id
    const partCheck = await client.query(
      `SELECT id, local_schedule_vendor_id FROM local_schedule_parts 
       WHERE id = $1 AND is_active = true`,
      [partId]
    );

    if (partCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      console.log(`[DELETE Part] Part ${partId} not found`);
      return res.status(404).json({
        success: false,
        message: "Part not found or already deleted",
      });
    }

    const part = partCheck.rows[0];
    const vendorId = part.local_schedule_vendor_id;
    console.log(`[DELETE Part] Found part:`, part);

    // 2. Delete part
    const partDeleteResult = await client.query(
      `DELETE FROM local_schedule_parts 
       WHERE id = $1 
       RETURNING id`,
      [partId]
    );
    console.log(`[DELETE Part] Deleted part:`, partDeleteResult.rows[0]);

    // 3. Update total_item di vendor
    const updateVendorResult = await client.query(
      `UPDATE local_schedule_vendors
       SET total_item = (
         SELECT COUNT(*) FROM local_schedule_parts 
         WHERE local_schedule_vendor_id = $1 AND is_active = true
       ),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING total_item, local_schedule_id`,
      [vendorId]
    );

    const scheduleId = updateVendorResult.rows[0].local_schedule_id;
    console.log(
      `[DELETE Part] Updated vendor total_item:`,
      updateVendorResult.rows[0]
    );

    // 4. Update total_item di schedule header
    const updateScheduleResult = await client.query(
      `UPDATE local_schedules
       SET total_item = (
         SELECT COUNT(*)
         FROM local_schedule_parts lsp
         JOIN local_schedule_vendors lsv ON lsp.local_schedule_vendor_id = lsv.id
         WHERE lsv.local_schedule_id = $1 AND lsp.is_active = true
       ),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING total_item`,
      [scheduleId]
    );
    console.log(
      `[DELETE Part] Updated schedule total_item:`,
      updateScheduleResult.rows[0]
    );

    await client.query("COMMIT");

    console.log(`[DELETE Part] Successfully deleted part ${partId}`);

    res.json({
      success: true,
      message: "Part deleted successfully",
      data: {
        deletedPartId: partId,
        vendorId: vendorId,
        scheduleId: scheduleId,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[DELETE Part] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete part",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== DELETE VENDOR dari route lama (untuk kompatibilitas) ======
router.delete("/:scheduleId/vendors/:vendorId", async (req, res) => {
  const client = await pool.connect();
  try {
    const { scheduleId, vendorId } = req.params;

    console.log(
      `[DELETE Vendor Alt] Deleting vendor ${vendorId} from schedule ${scheduleId}`
    );

    await client.query("BEGIN");

    // 1. Cek vendor exists
    const vendorCheck = await client.query(
      `SELECT id FROM local_schedule_vendors 
       WHERE id = $1 AND local_schedule_id = $2 AND is_active = true`,
      [vendorId, scheduleId]
    );

    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Vendor not found in this schedule",
      });
    }

    // 2. Delete parts
    const partsDeleteResult = await client.query(
      `DELETE FROM local_schedule_parts 
       WHERE local_schedule_vendor_id = $1
       RETURNING id`,
      [vendorId]
    );
    const deletedParts = partsDeleteResult.rowCount;
    console.log(`[DELETE Vendor Alt] Deleted ${deletedParts} parts`);

    // 3. Delete vendor
    await client.query(
      `DELETE FROM local_schedule_vendors 
       WHERE id = $1`,
      [vendorId]
    );
    console.log(`[DELETE Vendor Alt] Deleted vendor ${vendorId}`);

    // 4. Update totals
    await client.query(
      `UPDATE local_schedules
       SET total_vendor = (
         SELECT COUNT(*) FROM local_schedule_vendors 
         WHERE local_schedule_id = $1 AND is_active = true
       ),
       total_item = (
         SELECT COUNT(*) 
         FROM local_schedule_parts lsp
         JOIN local_schedule_vendors lsv ON lsp.local_schedule_vendor_id = lsv.id
         WHERE lsv.local_schedule_id = $1 AND lsp.is_active = true
       ),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [scheduleId]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Vendor and all parts deleted successfully",
      data: {
        vendorId: vendorId,
        deletedParts: deletedParts,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[DELETE Vendor Alt] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete vendor",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== DELETE PART dari vendor (route lama untuk kompatibilitas) ======
router.delete("/vendors/:vendorId/parts/:partId", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId, partId } = req.params;

    console.log(
      `[DELETE Part Alt] Deleting part ${partId} from vendor ${vendorId}`
    );

    await client.query("BEGIN");

    // 1. Cek part exists
    const partCheck = await client.query(
      `SELECT id FROM local_schedule_parts 
       WHERE id = $1 AND local_schedule_vendor_id = $2 AND is_active = true`,
      [partId, vendorId]
    );

    if (partCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Part not found in this vendor",
      });
    }

    // 2. Delete part
    await client.query(
      `DELETE FROM local_schedule_parts 
       WHERE id = $1`,
      [partId]
    );
    console.log(`[DELETE Part Alt] Deleted part ${partId}`);

    // 3. Update vendor total
    const vendorUpdate = await client.query(
      `UPDATE local_schedule_vendors
       SET total_item = (
         SELECT COUNT(*) FROM local_schedule_parts 
         WHERE local_schedule_vendor_id = $1 AND is_active = true
       ),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING local_schedule_id`,
      [vendorId]
    );

    const scheduleId = vendorUpdate.rows[0].local_schedule_id;

    // 4. Update schedule total
    await client.query(
      `UPDATE local_schedules
       SET total_item = (
         SELECT COUNT(*)
         FROM local_schedule_parts lsp
         JOIN local_schedule_vendors lsv ON lsp.local_schedule_vendor_id = lsv.id
         WHERE lsv.local_schedule_id = $1 AND lsp.is_active = true
       ),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [scheduleId]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Part deleted successfully",
      data: { partId: partId },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[DELETE Part Alt] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete part",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

module.exports = router;