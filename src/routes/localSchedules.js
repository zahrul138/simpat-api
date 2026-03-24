const express = require("express");
const router = express.Router();
const pool = require("../db");

const toStartOfDay = (val) => {
  const d = new Date(val);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

const resolveEmployeeId = async (client, empName) => {
  if (!empName) return null;
  const q = await client.query(
    `SELECT id FROM employees WHERE LOWER(emp_name)=LOWER($1) LIMIT 1`,
    [empName],
  );
  return q.rows[0]?.id ?? null;
};

router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const { stockLevel, modelName, scheduleDate, uploadByName } =
      req.body || {};
    if (!stockLevel || !modelName || !scheduleDate) {
      return res.status(400).json({ message: "Missing fields" });
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
      [stockLevel, modelName, uploadBy, scheduleDate],
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

router.get("/check-date", async (req, res) => {
  try {
    const { scheduleDate } = req.query;

    if (!scheduleDate) {
      return res.status(400).json({ message: "scheduleDate is required" });
    }

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

router.get("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const { status, date_from, date_to, vendor_name, part_code, part_name } =
      req.query;

    console.log("[GET Local Schedules] Query params:", req.query);

    const statusMapping = {
      New: "New",
      Schedule: "Schedule",
      Today: "Today",
      Received: "Received",
      "IQC Progress": "IQC Progress",
      Pass: "Pass",
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

    if (status && statusMapping[status]) {
      paramCount++;
      query += ` AND ls.status = $${paramCount}`;
      params.push(statusMapping[status]);
    }

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

    const schedulesWithDetails = await Promise.all(
      result.rows.map(async (schedule) => {

        const vendorsResult = await client.query(
          `SELECT 
            lsv.id,
            lsv.trip_id,
            lsv.vendor_id,
            lsv.do_number,
            lsv.arrival_time,
            lsv.total_pallet,
            lsv.total_item,
            lsv.status,
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
          [schedule.id],
        );

        const mappedStatus = statusMapping[status];
        const movedStatuses = ['Received', 'IQC Progress', 'Pass', 'Complete'];
        let filteredVendors = vendorsResult.rows;
        if (mappedStatus === 'Today') {
          filteredVendors = filteredVendors.filter(
            (v) => !movedStatuses.includes(v.status),
          );
        }

        if (vendor_name) {
          filteredVendors = filteredVendors.filter(
            (vendor) =>
              vendor.vendor_name
                ?.toLowerCase()
                .includes(vendor_name.toLowerCase()) ||
              vendor.vendor_code
                ?.toLowerCase()
                .includes(vendor_name.toLowerCase()),
          );
        }

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
                COALESCE(lsp.prod_dates::jsonb, '[]'::jsonb) as prod_dates,
                COALESCE(lsp.sample_dates::jsonb, '[]'::jsonb) as sample_dates
               FROM local_schedule_parts lsp
               WHERE lsp.local_schedule_vendor_id = $1 AND lsp.is_active = true
               ORDER BY lsp.id ASC`,
              [vendor.id],
            );

            const partsWithParsedDates = partsResult.rows.map((part) => ({
              ...part,
              prod_dates:
                typeof part.prod_dates === "string"
                  ? JSON.parse(part.prod_dates)
                  : Array.isArray(part.prod_dates)
                    ? part.prod_dates
                    : [],
              sample_dates:
                typeof part.sample_dates === "string"
                  ? JSON.parse(part.sample_dates)
                  : Array.isArray(part.sample_dates)
                    ? part.sample_dates
                    : [],
            }));

            let filteredParts = partsWithParsedDates;
            if (part_code) {
              filteredParts = filteredParts.filter((part) =>
                part.part_code?.toLowerCase().includes(part_code.toLowerCase()),
              );
            }

            if (part_name) {
              filteredParts = filteredParts.filter((part) =>
                part.part_name?.toLowerCase().includes(part_name.toLowerCase()),
              );
            }

            return {
              ...vendor,
              parts: filteredParts,
            };
          }),
        );

        if (vendor_name || part_code || part_name) {
          const hasVendorsWithParts = vendorsWithParts.some(
            (vendor) => vendor.parts.length > 0,
          );
          if (!hasVendorsWithParts && vendorsWithParts.length === 0) {
            return null;
          }
        }

        return {
          ...schedule,
          vendors: vendorsWithParts.filter((v) => v),
        };
      }),
    );

    const filteredSchedules = schedulesWithDetails.filter(
      (schedule) => schedule !== null,
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

router.get("/received-vendors", async (req, res) => {
  const client = await pool.connect();
  try {
    console.log("[GET Received Vendors] Fetching vendors with Received status");

    const vendorsResult = await client.query(
      `SELECT 
        lsv.id,
        lsv.local_schedule_id,
        lsv.trip_id,
        lsv.vendor_id,
        lsv.do_number,
        lsv.arrival_time,
        lsv.total_pallet,
        lsv.total_item,
        lsv.status,
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
       WHERE lsv.status = 'Received' AND lsv.is_active = true
       ORDER BY lsv.move_at DESC, lsv.id ASC`,
    );

    console.log(
      `[GET Received Vendors] Found ${vendorsResult.rows.length} vendors`,
    );

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
            COALESCE(lsp.prod_dates::jsonb, '[]'::jsonb) as prod_dates,
            COALESCE(lsp.sample_dates::jsonb, '[]'::jsonb) as sample_dates
           FROM local_schedule_parts lsp
           WHERE lsp.local_schedule_vendor_id = $1 AND lsp.is_active = true
           ORDER BY lsp.id ASC`,
          [vendor.id],
        );

        const partsWithParsedDates = partsResult.rows.map((part) => ({
          ...part,
          prod_dates:
            typeof part.prod_dates === "string"
              ? JSON.parse(part.prod_dates)
              : Array.isArray(part.prod_dates)
                ? part.prod_dates
                : [],
          sample_dates:
            typeof part.sample_dates === "string"
              ? JSON.parse(part.sample_dates)
              : Array.isArray(part.sample_dates)
                ? part.sample_dates
                : [],
        }));

        return {
          ...vendor,
          parts: partsWithParsedDates,
        };
      }),
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

router.get("/iqc-progress-vendors", async (req, res) => {
  const client = await pool.connect();
  try {
    console.log(
      "[GET IQC Progress Vendors] Fetching vendors with IQC Progress status",
    );

    const vendorsResult = await client.query(
      `SELECT 
        lsv.id,
        lsv.local_schedule_id,
        lsv.trip_id,
        lsv.vendor_id,
        lsv.do_number,
        lsv.arrival_time,
        lsv.total_pallet,
        lsv.total_item,
        lsv.status,
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
       WHERE lsv.status = 'IQC Progress' AND lsv.is_active = true
       ORDER BY lsv.approve_at DESC, lsv.id ASC`,
    );

    console.log(
      `[GET IQC Progress Vendors] Found ${vendorsResult.rows.length} vendors`,
    );

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
            COALESCE(lsp.prod_dates::jsonb, '[]'::jsonb) as prod_dates,
            COALESCE(lsp.sample_dates::jsonb, '[]'::jsonb) as sample_dates
           FROM local_schedule_parts lsp
           WHERE lsp.local_schedule_vendor_id = $1 AND lsp.is_active = true
           ORDER BY lsp.id ASC`,
          [vendor.id],
        );

        const partsWithParsedDates = partsResult.rows.map((part) => ({
          ...part,
          prod_dates:
            typeof part.prod_dates === "string"
              ? JSON.parse(part.prod_dates)
              : Array.isArray(part.prod_dates)
                ? part.prod_dates
                : [],
          sample_dates:
            typeof part.sample_dates === "string"
              ? JSON.parse(part.sample_dates)
              : Array.isArray(part.sample_dates)
                ? part.sample_dates
                : [],
        }));

        return {
          ...vendor,
          parts: partsWithParsedDates,
        };
      }),
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

router.get("/pass-vendors", async (req, res) => {
  const client = await pool.connect();
  try {
    console.log("[GET Pass Vendors] Fetching vendors with Pass status");

    const vendorsResult = await client.query(
      `SELECT 
        lsv.id,
        lsv.local_schedule_id,
        lsv.trip_id,
        lsv.vendor_id,
        lsv.do_number,
        lsv.arrival_time,
        lsv.total_pallet,
        lsv.total_item,
        lsv.status,
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
       WHERE lsv.status = 'Pass' AND lsv.is_active = true
       ORDER BY lsv.sample_at DESC, lsv.id ASC`,
    );

    console.log(
      `[GET Pass Vendors] Found ${vendorsResult.rows.length} vendors`,
    );

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
            COALESCE(lsp.prod_dates::jsonb, '[]'::jsonb) as prod_dates,
            COALESCE(lsp.sample_dates::jsonb, '[]'::jsonb) as sample_dates
           FROM local_schedule_parts lsp
           WHERE lsp.local_schedule_vendor_id = $1 AND lsp.is_active = true
           ORDER BY lsp.id ASC`,
          [vendor.id],
        );

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
              console.error("[GET Pass Vendors] Error parsing prod_dates:", e);
            }
          }
          let parsedPassDates = [];
          if (part.sample_dates) {
            try {
              if (typeof part.sample_dates === "string") {
                parsedPassDates = JSON.parse(part.sample_dates);
              } else if (Array.isArray(part.sample_dates)) {
                parsedPassDates = part.sample_dates;
              }
            } catch (e) {
              console.error("[GET Pass Vendors] Error parsing sample_dates:", e);
            }
          }
          return {
            ...part,
            prod_dates: parsedProdDates,
            sample_dates: parsedPassDates,
          };
        });

        return {
          ...vendor,
          parts: partsWithParsedDates,
        };
      }),
    );

    res.json({
      success: true,
      data: vendorsWithParts,
      total: vendorsWithParts.length,
    });
  } catch (error) {
    console.error("[GET Pass Vendors] Error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

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
        lsv.do_number,
        lsv.arrival_time,
        lsv.total_pallet,
        lsv.total_item,
        lsv.status,
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
       WHERE lsv.status = 'Complete' AND lsv.is_active = true
       ORDER BY lsv.complete_at DESC, lsv.id ASC`,
    );

    console.log(
      `[GET Complete Vendors] Found ${vendorsResult.rows.length} vendors`,
    );

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
            COALESCE(lsp.prod_dates::jsonb, '[]'::jsonb) as prod_dates,
            COALESCE(lsp.sample_dates::jsonb, '[]'::jsonb) as sample_dates
           FROM local_schedule_parts lsp
           WHERE lsp.local_schedule_vendor_id = $1 AND lsp.is_active = true
           ORDER BY lsp.id ASC`,
          [vendor.id],
        );

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
          let parsedPassDates = [];
          if (part.sample_dates) {
            try {
              if (typeof part.sample_dates === "string") {
                parsedPassDates = JSON.parse(part.sample_dates);
              } else if (Array.isArray(part.sample_dates)) {
                parsedPassDates = part.sample_dates;
              }
            } catch (e) {
              console.error("[GET Complete Vendors] Error parsing sample_dates:", e);
            }
          }
          return {
            ...part,
            prod_dates: parsedProdDates,
            sample_dates: parsedPassDates,
          };
        });

        return {
          ...vendor,
          parts: partsWithParsedDates,
        };
      }),
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

    if (status && status !== "All") {
      query += ` AND ls.status = $1`;
      params.push(status);
    }

    query += ` ORDER BY ls.schedule_date ASC, ls.created_at ASC`;

    console.log("[GET Local Schedules] Executing query:", query, params);

    const result = await client.query(query, params);

    console.log(`[GET Local Schedules] Found ${result.rows.length} schedules`);

    const schedulesWithDetails = await Promise.all(
      result.rows.map(async (schedule) => {

        const vendorsResult = await client.query(
          `SELECT 
            lsv.id,
            lsv.trip_id,
            lsv.vendor_id,
            lsv.do_number,
            lsv.arrival_time,
            lsv.total_pallet,
            lsv.total_item,
            lsv.status,
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
          [schedule.id],
        );

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
              [vendor.id],
            );

            return {
              ...vendor,
              parts: partsResult.rows,
            };
          }),
        );

        return {
          ...schedule,
          vendors: vendorsWithParts,
        };
      }),
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

router.get("/parts/qty-per-box/:partCode", async (req, res) => {
  try {
    const { partCode } = req.params;

    const result = await pool.query(
      `SELECT qty_per_box FROM kanban_master WHERE part_code = $1 AND is_active = true LIMIT 1`,
      [partCode],
    );

    if (result.rowCount > 0) {
      res.json({
        success: true,
        qty_per_box: result.rows[0].qty_per_box || 1,
      });
    } else {
      res.json({
        success: true,
        qty_per_box: 1,
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

router.put("/bulk/status", async (req, res) => {
  const client = await pool.connect();
  try {
    const { scheduleIds, targetTab } = req.body;

    console.log(`[BULK UPDATE] Request received:`, {
      scheduleIds,
      targetTab,
      body: req.body,
    });

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

    const tabToStatusMapping = {
      New: "New",
      Schedule: "Schedule",
      Today: "Today",
      Received: "Received",
      "IQC Progress": "IQC Progress",
      Pass: "Pass",
      Complete: "Complete",
      History: "History",
    };

    const finalStatus = tabToStatusMapping[targetTab];

    if (!finalStatus) {
      console.log("[BULK UPDATE] Error: Invalid targetTab:", targetTab);
      return res.status(400).json({
        success: false,
        message: `Invalid targetTab: ${targetTab}. Valid values: ${Object.keys(
          tabToStatusMapping,
        ).join(", ")}`,
      });
    }

    console.log(
      `[BULK UPDATE] Converting: "${targetTab}" → DB status: "${finalStatus}"`,
    );

    await client.query("BEGIN");

    const checkResult = await client.query(
      `SELECT id, schedule_code, status 
       FROM local_schedules 
       WHERE id = ANY($1::int[]) AND is_active = true`,
      [scheduleIds],
    );

    console.log(
      `[BULK UPDATE] Found ${checkResult.rowCount} schedules to update`,
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
      [finalStatus, scheduleIds],
    );

    await client.query(
      `UPDATE local_schedule_vendors
       SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE local_schedule_id = ANY($2::int[]) AND is_active = true`,
      [finalStatus, scheduleIds]
    );

    await client.query(
      `UPDATE local_schedule_parts
       SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE local_schedule_vendor_id IN (
         SELECT id FROM local_schedule_vendors
         WHERE local_schedule_id = ANY($2::int[]) AND is_active = true
       ) AND is_active = true`,
      [finalStatus, scheduleIds]
    );

    console.log(
      `[BULK UPDATE] Successfully updated ${updateResult.rowCount} schedules`,
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

router.put("/parts/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { id } = req.params;
    const {
      part_code,
      part_name,
      quantity,
      quantity_box,
      unit,
      remark,
      prod_date,
      prod_dates,
      sample_dates,
      status,
      upload_by_id,
      approve_by_id,
    } = req.body;

    // Fetch current part data before update (needed for sync logic)
    const preUpdateRes = await client.query(
      `SELECT lsp.id, lsp.local_schedule_vendor_id, lsp.prod_dates, lsp.sample_dates,
              lsp.part_code, lsp.part_name, lsv.status as vendor_status
       FROM local_schedule_parts lsp
       JOIN local_schedule_vendors lsv ON lsv.id = lsp.local_schedule_vendor_id
       WHERE lsp.id = $1`,
      [id]
    );
    const preUpdatePart = preUpdateRes.rows[0] || {};

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
      values.push(remark === null || remark === 'null' || remark === '[null]' || remark === '[default]' ? '' : remark);
    }
    if (prod_date !== undefined) {
      updateFields.push(`prod_date = $${paramIndex++}`);
      values.push(prod_date);
    }

    if (prod_dates !== undefined) {
      updateFields.push(`prod_dates = $${paramIndex++}`);
      values.push(JSON.stringify(prod_dates));
    }

    if (sample_dates !== undefined) {
      updateFields.push(`sample_dates = $${paramIndex++}`);
      values.push(JSON.stringify(sample_dates));
    }
    if (status !== undefined) {
      updateFields.push(`status = $${paramIndex++}`);
      values.push(status);
    }

    if (updateFields.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ success: false, message: "No fields to update" });
    }

    values.push(id);
    const query = `
      UPDATE local_schedule_parts 
      SET ${updateFields.join(", ")}, updated_at = NOW()
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const result = await client.query(query, values);

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ success: false, message: "Part not found" });
    }

    if (upload_by_id) {

      const scheduleResult = await client.query(
        `SELECT lsv.local_schedule_id
         FROM local_schedule_parts lsp
         JOIN local_schedule_vendors lsv ON lsv.id = lsp.local_schedule_vendor_id
         WHERE lsp.id = $1
         LIMIT 1`,
        [id],
      );

      if (scheduleResult.rows.length > 0) {
        const scheduleId = scheduleResult.rows[0].local_schedule_id;
        await client.query(
          `UPDATE local_schedules
           SET upload_by = $1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [upload_by_id, scheduleId],
        );
      }
    }


    if (prod_dates !== undefined) {
      const updatedPart = result.rows[0];
      const newProdDates = Array.isArray(updatedPart.prod_dates)
        ? updatedPart.prod_dates
        : (typeof updatedPart.prod_dates === 'string' ? JSON.parse(updatedPart.prod_dates || '[]') : []);

      // Use pre-update values fetched before the UPDATE ran
      const rawSample = preUpdatePart.sample_dates;
      const partCode = preUpdatePart.part_code;
      const partName = preUpdatePart.part_name;
      const vendorId = preUpdatePart.local_schedule_vendor_id;
      const oldSampleDates = Array.isArray(rawSample)
        ? rawSample
        : (typeof rawSample === 'string' ? JSON.parse(rawSample || '[]') : []);
      const prevProdRaw = preUpdatePart.prod_dates;
      const prevProdDates = Array.isArray(prevProdRaw)
        ? prevProdRaw
        : (typeof prevProdRaw === 'string' ? JSON.parse(prevProdRaw || '[]') : []);

      const removedSampleDates = oldSampleDates.filter(d => !newProdDates.includes(d));
      const addedDates = newProdDates.filter(d => !prevProdDates.includes(d));

      // Fetch vendor_name via vendor_detail join
      const vendorNameRes = await client.query(
        `SELECT vd.vendor_name FROM local_schedule_vendors lsv
         JOIN vendor_detail vd ON vd.id = lsv.vendor_id
         WHERE lsv.id = $1`,
        [vendorId]
      );
      const vendorName = vendorNameRes.rows[0]?.vendor_name || '';

      // --- Handle REMOVED sample dates ---
      if (removedSampleDates.length > 0) {
        for (const removedDate of removedSampleDates) {
          await client.query(
            `UPDATE qc_checks
             SET is_active = false, updated_at = CURRENT_TIMESTAMP
             WHERE part_code = $1
               AND data_from = 'M101'
               AND status != 'Complete'
               AND TO_CHAR(production_date, 'YYYY-MM-DD') = $2
               AND is_active = true`,
            [partCode, String(removedDate).split('T')[0]]
          );
        }
      }

      // --- Handle ADDED dates: check if they need a QC check ---
      const addedSampleDates = [];
      for (const addedDate of addedDates) {
        const dateStr = String(addedDate).split('T')[0];
        const completeCheck = await client.query(
          `SELECT id FROM qc_checks
           WHERE part_code = $1
             AND TO_CHAR(production_date, 'YYYY-MM-DD') = $2
             AND status = 'Complete'
             AND is_active = true
           LIMIT 1`,
          [partCode, dateStr]
        );
        if (completeCheck.rowCount === 0) {
          addedSampleDates.push(addedDate);
          const existingInactive = await client.query(
            `SELECT id FROM qc_checks
             WHERE part_code = $1
               AND TO_CHAR(production_date, 'YYYY-MM-DD') = $2
               AND data_from = 'M101'
             LIMIT 1`,
            [partCode, dateStr]
          );
          if (existingInactive.rowCount > 0) {
            const vendorApproveRes = await client.query(
              `SELECT em.emp_name, lsv.approve_at FROM local_schedule_vendors lsv
               LEFT JOIN employees em ON em.id = lsv.approve_by
               WHERE lsv.id = $1`,
              [vendorId]
            );
            const vendorApproveByName = vendorApproveRes.rows[0]?.emp_name || null;
            const vendorApproveAt = vendorApproveRes.rows[0]?.approve_at || null;
            await client.query(
              `UPDATE qc_checks
               SET is_active = true, status = 'M101 Part',
                   created_by = COALESCE(created_by, $2),
                   created_at = COALESCE(created_at, $3),
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = $1`,
              [existingInactive.rows[0].id, vendorApproveByName, vendorApproveAt]
            );
          } else {
            const vendorApproveResIns = await client.query(
              `SELECT em.emp_name, lsv.approve_at FROM local_schedule_vendors lsv
               LEFT JOIN employees em ON em.id = lsv.approve_by
               WHERE lsv.id = $1`,
              [vendorId]
            );
            const vendorApproveByNameIns = vendorApproveResIns.rows[0]?.emp_name || null;
            const vendorApproveAtIns = vendorApproveResIns.rows[0]?.approve_at || null;
            await client.query(
              `INSERT INTO qc_checks
               (part_code, part_name, vendor_name, production_date, data_from, status,
                source_vendor_id, source_part_id, created_by, created_at, updated_at, is_active)
               VALUES ($1, $2, $3, $4::date, 'M101', 'M101 Part', NULL, NULL, $5, $6,
                       CURRENT_TIMESTAMP, true)`,
              [partCode, partName, vendorName, dateStr, vendorApproveByNameIns, vendorApproveAtIns]
            );
          }
        }
      }

      // --- Recompute sample_dates ---
      const updatedSampleDates = [
        ...oldSampleDates.filter(d => !removedSampleDates.includes(d)),
        ...addedSampleDates
      ];
      await client.query(
        `UPDATE local_schedule_parts
         SET sample_dates = $1::jsonb, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [JSON.stringify(updatedSampleDates), id]
      );

      // --- Update part status based on vendor status ---
      const vendorStatus = preUpdatePart.vendor_status || 'IQC Progress';
      const statusWhenSample = ['Today', 'Received', 'Pass', 'Complete', 'IQC Progress', 'Schedule', 'New'].includes(vendorStatus) ? vendorStatus : 'IQC Progress';
      if (updatedSampleDates.length === 0 && newProdDates.length > 0) {
        await client.query(
          `UPDATE local_schedule_parts SET status = 'PASS', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [id]
        );
      } else if (updatedSampleDates.length > 0) {
        await client.query(
          `UPDATE local_schedule_parts SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [statusWhenSample, id]
        );
      }
    }

    await client.query("COMMIT");
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error updating part:", error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
});

router.put("/vendors/:vendorId/status", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId } = req.params;
    const { status, moveByName } = req.body;

    console.log(`[UPDATE Vendor Status] Request:`, {
      vendorId,
      status,
      moveByName,
    });

    if (!status) {
      return res.status(400).json({
        success: false,
        message: "Status is required",
      });
    }

    await client.query("BEGIN");

    const vendorCheck = await client.query(
      `SELECT lsv.id, lsv.local_schedule_id, lsv.status,
              ls.schedule_date, ls.stock_level, ls.model_name
       FROM local_schedule_vendors lsv
       JOIN local_schedules ls ON ls.id = lsv.local_schedule_id
       WHERE lsv.id = $1 AND lsv.is_active = true`,
      [vendorId],
    );

    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Schedule not found",
      });
    }

    const scheduleId = vendorCheck.rows[0].local_schedule_id;
    const scheduleDate = vendorCheck.rows[0].schedule_date;
    const stockLevel = vendorCheck.rows[0].stock_level;
    const modelName = vendorCheck.rows[0].model_name;

    let moveById = null;
    if (moveByName) {
      moveById = await resolveEmployeeId(client, moveByName);
    }

    let vendorResult;
    if (status === "Received") {
      vendorResult = await client.query(
        `UPDATE local_schedule_vendors 
         SET status = $1, 
             move_by = $2,
             move_at = CURRENT_TIMESTAMP,
             schedule_date_ref = $3::date,
             stock_level_ref = $4,
             model_name_ref = $5,
             updated_at = CURRENT_TIMESTAMP 
         WHERE id = $6 AND is_active = true 
         RETURNING id, local_schedule_id, status, move_by, move_at`,
        [status, moveById, scheduleDate, stockLevel, modelName, vendorId],
      );
    } else {
      vendorResult = await client.query(
        `UPDATE local_schedule_vendors 
         SET status = $1, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $2 AND is_active = true 
         RETURNING id, local_schedule_id, status`,
        [status, vendorId],
      );
    }

    console.log(`[UPDATE Vendor Status] Vendor updated:`, vendorResult.rows[0]);

    await client.query(
      `UPDATE local_schedule_parts
       SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE local_schedule_vendor_id = $2 AND is_active = true`,
      [status, vendorId]
    );

    const allVendorsCheck = await client.query(
      `SELECT COUNT(*) as total, 
              SUM(CASE WHEN status = $1 THEN 1 ELSE 0 END) as matched_count
       FROM local_schedule_vendors 
       WHERE local_schedule_id = $2 AND is_active = true`,
      [status, scheduleId],
    );

    const { total, matched_count } = allVendorsCheck.rows[0];

    console.log(`[UPDATE Vendor Status] Vendor counts:`, {
      total: parseInt(total),
      matched_count: parseInt(matched_count),
    });

    if (parseInt(total) > 0 && parseInt(total) === parseInt(matched_count)) {

      const scheduleStatusMapping = {
        Received: "Received",
        "IQC Progress": "IQC Progress",
        Pass: "Pass",
        Complete: "Complete",
      };

      const newScheduleStatus = scheduleStatusMapping[status] || status;

      const scheduleResult = await client.query(
        `UPDATE local_schedules 
         SET status = $1, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $2 AND is_active = true 
         RETURNING id, schedule_code, status`,
        [newScheduleStatus, scheduleId],
      );

      console.log(
        `[UPDATE Vendor Status] Schedule auto-updated:`,
        scheduleResult.rows[0],
      );
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: `Schedule status updated to ${status}`,
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
      message: "Failed to update schedule status",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

router.put("/vendors/:vendorId/approve", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId } = req.params;
    const { approveByName } = req.body;

    console.log(`[APPROVE Vendor] Request:`, { vendorId, approveByName });

    await client.query("BEGIN");

    const vendorCheck = await client.query(
      `SELECT 
        lsv.id, 
        lsv.local_schedule_id, 
        lsv.status,
        lsv.vendor_id,
        lsv.do_number,
        TO_CHAR(lsv.schedule_date_ref, 'YYYY-MM-DD') as schedule_date_ref,
        lsv.stock_level_ref,
        vd.vendor_name,
        ls.model_name,
        ls.stock_level as schedule_stock_level
       FROM local_schedule_vendors lsv
       LEFT JOIN vendor_detail vd ON vd.id = lsv.vendor_id
       LEFT JOIN local_schedules ls ON ls.id = lsv.local_schedule_id
       WHERE lsv.id = $1 AND lsv.is_active = true`,
      [vendorId]
    );

    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Schedule not found" });
    }

    const vendor = vendorCheck.rows[0];
    const scheduleId = vendor.local_schedule_id;
    const modelName = vendor.model_name;

    let rawStockLevel = vendor.schedule_stock_level || "";
    let finalStockLevel = "M101";
    console.log(`[APPROVE Vendor] Raw stock_level from DB: "${rawStockLevel}"`);
    if (rawStockLevel) {
      const parts = rawStockLevel.split("|");
      if (parts.length > 0) {
        const code = parts[0].trim().toUpperCase();
        if (["M101", "M136", "RTV"].includes(code)) {
          finalStockLevel = code;
        }

      }
    }
    console.log(`[APPROVE Vendor] Final stock level: "${finalStockLevel}"`);

    let approveById = null;
    if (approveByName) {
      const empResult = await client.query(
        `SELECT id FROM employees WHERE emp_name = $1 LIMIT 1`,
        [approveByName]
      );
      if (empResult.rowCount > 0) approveById = empResult.rows[0].id;
    }

    const partsResult = await client.query(
      `SELECT 
        lsp.id,
        lsp.part_code,
        lsp.part_name,
        lsp.quantity,
        lsp.quantity_box,
        lsp.unit,
        lsp.do_number,
        lsp.remark,
        TO_CHAR(lsp.prod_date, 'YYYY-MM-DD') as prod_date,
        COALESCE(lsp.prod_dates::jsonb, '[]'::jsonb) as prod_dates,
        km.id as kanban_master_id,
        km.model,
        km.qty_per_box
       FROM local_schedule_parts lsp
       LEFT JOIN kanban_master km ON km.part_code = lsp.part_code AND km.is_active = true
       WHERE lsp.local_schedule_vendor_id = $1 AND lsp.is_active = true
       ORDER BY lsp.id ASC`,
      [vendorId]
    );

    console.log(`[APPROVE Vendor] Found ${partsResult.rowCount} parts`);

    const qcChecksResult = await client.query(
      `SELECT part_code, TO_CHAR(production_date, 'YYYY-MM-DD') as production_date, status
       FROM qc_checks
       WHERE status = 'Complete' AND is_active = true`
    );
    const qcChecks = qcChecksResult.rows;

    const isProductionDateComplete = (partCode, prodDate) => {
      if (!partCode || !prodDate) return false;
      const normalizedDate = prodDate.split("T")[0];
      return qcChecks.some(
        (qc) =>
          qc.part_code === partCode &&
          qc.production_date === normalizedDate &&
          qc.status === "Complete"
      );
    };

    let allPartsPass = true;
    for (const part of partsResult.rows) {
      const prodDates = typeof part.prod_dates === "string"
        ? JSON.parse(part.prod_dates)
        : Array.isArray(part.prod_dates)
          ? part.prod_dates
          : [];

      if (prodDates.length > 0) {
        const incompleteDates = prodDates.filter(
          (date) => !isProductionDateComplete(part.part_code, date)
        );
        if (incompleteDates.length > 0) {
          allPartsPass = false;
          break;
        }
      }

    }
    console.log(`[APPROVE Vendor] All parts PASS (no sampling needed): ${allPartsPass}`);

    if (!allPartsPass) {
      for (const part of partsResult.rows) {
        const prodDates = typeof part.prod_dates === "string"
          ? JSON.parse(part.prod_dates)
          : Array.isArray(part.prod_dates)
            ? part.prod_dates
            : [];

        if (prodDates.length === 0) continue;

        const incompleteDates = prodDates.filter(
          (date) => !isProductionDateComplete(part.part_code, date)
        );

        if (incompleteDates.length > 0) {
          await client.query(
            `UPDATE local_schedule_parts
             SET sample_dates = $1::jsonb, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [JSON.stringify(incompleteDates), part.id]
          );
        }

        for (const date of incompleteDates) {

          const existingCheck = await client.query(
            `SELECT id, status FROM qc_checks
             WHERE part_code = $1
               AND production_date = $2::date
               AND vendor_name = $3
               AND data_from = 'M101'
               AND is_active = true
             LIMIT 1`,
            [part.part_code, date, vendor.vendor_name]
          );

          if (existingCheck.rowCount > 0) {

            if (existingCheck.rows[0].status !== "Complete") {
              await client.query(
                `UPDATE qc_checks
                 SET status = 'M101 Part', created_by = $2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [existingCheck.rows[0].id, approveByName || 'System']
              );
            }
          } else {

            await client.query(
              `INSERT INTO qc_checks (
                part_code, part_name, vendor_name, production_date,
                data_from, status, source_vendor_id, source_part_id,
                created_by, created_at, updated_at, is_active
              ) VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, true)`,
              [
                part.part_code,
                part.part_name,
                vendor.vendor_name,
                date,
                "M101",
                "M101 Part",
                null,
                null,
                approveByName || "System",
              ]
            );
          }
        }
      }
      console.log(`[APPROVE Vendor] Inserted/updated qc_checks with status 'M101 Part' for incomplete prod_dates`);
    }

    const stockResults = [];
    for (const part of partsResult.rows) {
      const qty = parseInt(part.quantity) || 0;
      if (qty <= 0) continue;

      let quantityBefore = 0;
      if (part.kanban_master_id) {

        const stockQuery = await client.query(
          `SELECT stock_m101, stock_m136, stock_off_system, stock_rtv 
           FROM kanban_master WHERE id = $1`,
          [part.kanban_master_id]
        );
        if (stockQuery.rows[0]) {
          const sr = stockQuery.rows[0];
          if (finalStockLevel === "M101")       quantityBefore = parseInt(sr.stock_m101) || 0;
          else if (finalStockLevel === "M136")  quantityBefore = parseInt(sr.stock_m136) || 0;
          else if (finalStockLevel === "RTV")   quantityBefore = parseInt(sr.stock_rtv) || 0;
        }
      }

      const quantityAfter = quantityBefore + qty;

      const rawProdDates = typeof part.prod_dates === "string"
        ? JSON.parse(part.prod_dates)
        : Array.isArray(part.prod_dates) ? part.prod_dates : [];
      const productionDatesText = rawProdDates.length > 0
        ? rawProdDates.map((d) => {
            const [y, m, day] = String(d).split("T")[0].split("-");
            return `${day}/${m}/${y}`;
          }).join(", ")
        : (part.prod_date
            ? (() => { const [y, m, day] = part.prod_date.split("-"); return `${day}/${m}/${y}`; })()
            : null);

      const movementResult = await client.query(
        `INSERT INTO stock_movements (
          part_id, part_code, part_name, movement_type, stock_level,
          quantity, quantity_before, quantity_after,
          source_type, source_id, source_reference,
          model, production_date, production_dates, remark,
          moved_by, moved_by_name, moved_at, is_active
        ) VALUES ($1, $2, $3, 'IN', $4, $5, $6, $7, $8, $9, $10, $11, $12::date, $13, $14, $15, $16, CURRENT_TIMESTAMP, true)
        RETURNING id`,
        [
          part.kanban_master_id,
          part.part_code,
          part.part_name,
          finalStockLevel,
          qty,
          quantityBefore,
          quantityAfter,
          "local_schedule",
          vendorId,
          part.do_number || vendor.do_number,
          part.model || modelName,
          part.prod_date || null,
          productionDatesText,
          part.remark || `Approved from vendor: ${vendor.vendor_name || "Unknown"}`,
          approveById,
          approveByName || null,
        ]
      );
      console.log(`[APPROVE Vendor] Inserted stock movement for ${part.part_code}, movement_id: ${movementResult.rows[0].id}`);

      if (part.kanban_master_id) {

        let updateColumn = "stock_m101";
        if (finalStockLevel === "M136")     updateColumn = "stock_m136";
        else if (finalStockLevel === "RTV") updateColumn = "stock_rtv";

        await client.query(
          `UPDATE kanban_master SET ${updateColumn} = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [quantityAfter, part.kanban_master_id]
        );
        console.log(`[APPROVE Vendor] Updated kanban_master.${updateColumn} for ${part.part_code}: ${quantityBefore} -> ${quantityAfter}`);
      }

      stockResults.push({
        part_code: part.part_code,
        movement_id: movementResult.rows[0].id,
        quantity_added: qty,
        stock_before: quantityBefore,
        stock_after: quantityAfter,
      });
    }
    console.log(`[APPROVE Vendor] Added ${stockResults.length} parts to ${finalStockLevel} stock`);

    const today = new Date();
    const yy = String(today.getFullYear()).slice(-2);
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const datePrefix = yy + mm + dd;

    for (const part of partsResult.rows) {
      const qtyBox = parseInt(part.quantity_box) || 0;
      if (qtyBox <= 0) continue;

      let partId = part.kanban_master_id;
      if (!partId) {
        const partIdRes = await client.query(
          `SELECT id FROM kanban_master WHERE part_code = $1 AND is_active = true LIMIT 1`,
          [part.part_code]
        );
        if (partIdRes.rowCount > 0) {
          partId = partIdRes.rows[0].id;
        } else {
          console.warn(`[APPROVE Vendor] No kanban_master_id for part ${part.part_code}, skipping storage inventory`);
          continue;
        }
      }

      let qtyPerBoxMaster = part.qty_per_box || 1;
      if (qtyPerBoxMaster <= 0) qtyPerBoxMaster = 1;

      const seqRes = await client.query(
        `SELECT COALESCE(MAX(CAST(SUBSTRING(label_id, 13) AS INTEGER)), 0) as max_seq
         FROM storage_inventory WHERE part_id = $1`,
        [partId]
      );
      let nextSeq = seqRes.rows[0].max_seq;

      const totalQty = parseInt(part.quantity) || 0;

      for (let i = 1; i <= qtyBox; i++) {
        nextSeq++;
        const seqStr = String(nextSeq).padStart(6, "0");
        const labelId = datePrefix + partId + seqStr;

        let boxQty;
        if (i < qtyBox) {
          boxQty = qtyPerBoxMaster;
        } else {
          boxQty = totalQty - qtyPerBoxMaster * (qtyBox - 1);
          if (boxQty < 0) boxQty = 0;
        }

        await client.query(
          `INSERT INTO storage_inventory (
            label_id, part_id, part_code, part_name, qty,
            vendor_id, vendor_name, model, stock_level, schedule_date,
            received_by, received_by_name, received_at, status_tab, status_part
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP, 'M101', 'OK')`,
          [
            labelId,
            partId,
            part.part_code,
            part.part_name,
            boxQty,
            vendor.vendor_id,
            vendor.vendor_name,
            part.model || modelName,
            "M101",
            vendor.schedule_date_ref,
            approveById,
            approveByName,
          ]
        );
      }
    }
    console.log(`[APPROVE Vendor] Storage inventory records inserted for M101`);

    const newVendorStatus = allPartsPass ? "Pass" : "IQC Progress";
    console.log(`[APPROVE Vendor] Setting vendor status to: ${newVendorStatus}`);

    let vendorResult;
    if (allPartsPass) {
      vendorResult = await client.query(
        `UPDATE local_schedule_vendors 
         SET status = 'Pass',
             approve_by = $2,
             approve_at = CURRENT_TIMESTAMP,
             sample_by = $2,
             sample_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP 
         WHERE id = $1 AND is_active = true 
         RETURNING id, local_schedule_id, status, approve_by, approve_at`,
        [vendorId, approveById]
      );
    } else {
      vendorResult = await client.query(
        `UPDATE local_schedule_vendors 
         SET status = 'IQC Progress',
             approve_by = $2,
             approve_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP 
         WHERE id = $1 AND is_active = true 
         RETURNING id, local_schedule_id, status, approve_by, approve_at`,
        [vendorId, approveById]
      );
    }
    console.log(`[APPROVE Vendor] Vendor status updated to ${newVendorStatus}`);

    await client.query(
      `UPDATE local_schedule_parts
       SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE local_schedule_vendor_id = $2 AND is_active = true`,
      [newVendorStatus, vendorId]
    );

    if (allPartsPass) {

      const allPassCheck = await client.query(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN status = 'Pass' THEN 1 ELSE 0 END) as matched_count
         FROM local_schedule_vendors WHERE local_schedule_id = $1 AND is_active = true`,
        [scheduleId]
      );
      const { total: tc, matched_count: mc } = allPassCheck.rows[0];
      if (parseInt(tc) > 0 && parseInt(tc) === parseInt(mc)) {
        await client.query(
          `UPDATE local_schedules SET status = 'Pass', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND is_active = true`,
          [scheduleId]
        );
        console.log(`[APPROVE Vendor] Schedule auto-updated to Pass`);
      }
    } else {

      const allIqcCheck = await client.query(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN status = 'IQC Progress' THEN 1 ELSE 0 END) as matched_count
         FROM local_schedule_vendors WHERE local_schedule_id = $1 AND is_active = true`,
        [scheduleId]
      );
      const { total: ti, matched_count: mi } = allIqcCheck.rows[0];
      if (parseInt(ti) > 0 && parseInt(ti) === parseInt(mi)) {
        await client.query(
          `UPDATE local_schedules SET status = 'IQC Progress', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND is_active = true`,
          [scheduleId]
        );
        console.log(`[APPROVE Vendor] Schedule auto-updated to IQC Progress`);
      }
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: allPartsPass
        ? "Schedule approved — no sampling needed, moved directly to Pass"
        : "Vendor approved — parts with incomplete prod_dates moved to IQC Progress",
      data: {
        vendor: vendorResult.rows[0],
        scheduleId: scheduleId,
        stockLevel: finalStockLevel,
        partsAddedToStock: stockResults.length,
        stockMovements: stockResults,
        allPartsPass,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[APPROVE Vendor] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to approve schedule",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

router.put("/vendors/:vendorId/move-to-sample", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId } = req.params;
    const { moveByName } = req.body;

    console.log(`[MOVE TO PASS] Request:`, { vendorId, moveByName });

    await client.query("BEGIN");

    const vendorCheck = await client.query(
      `SELECT id, local_schedule_id, status 
       FROM local_schedule_vendors 
       WHERE id = $1 AND is_active = true`,
      [vendorId],
    );

    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Schedule not found",
      });
    }

    const scheduleId = vendorCheck.rows[0].local_schedule_id;

    let sampleById = null;
    if (moveByName) {
      const empResult = await client.query(
        `SELECT id FROM employees WHERE emp_name = $1 LIMIT 1`,
        [moveByName],
      );
      if (empResult.rowCount > 0) {
        sampleById = empResult.rows[0].id;
      }
    }

    const vendorResult = await client.query(
      `UPDATE local_schedule_vendors 
       SET status = 'Pass', 
           sample_by = $2,
           sample_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND is_active = true 
       RETURNING id, local_schedule_id, status, sample_by, sample_at`,
      [vendorId, sampleById],
    );

    await client.query(
      `UPDATE local_schedule_parts
       SET status = 'Pass', updated_at = CURRENT_TIMESTAMP
       WHERE local_schedule_vendor_id = $1 AND is_active = true`,
      [vendorId]
    );

    console.log(`[MOVE TO PASS] Vendor moved:`, vendorResult.rows[0]);

    const allVendorsCheck = await client.query(
      `SELECT COUNT(*) as total, 
              SUM(CASE WHEN status = 'Pass' THEN 1 ELSE 0 END) as matched_count
       FROM local_schedule_vendors 
       WHERE local_schedule_id = $1 AND is_active = true`,
      [scheduleId],
    );

    const { total, matched_count } = allVendorsCheck.rows[0];

    if (parseInt(total) > 0 && parseInt(total) === parseInt(matched_count)) {
      await client.query(
        `UPDATE local_schedules 
         SET status = 'Pass', updated_at = CURRENT_TIMESTAMP 
         WHERE id = $1 AND is_active = true`,
        [scheduleId],
      );
      console.log(`[MOVE TO PASS] Schedule auto-updated to Pass`);
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Schedule moved to Pass",
      data: {
        vendor: vendorResult.rows[0],
        scheduleId: scheduleId,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[MOVE TO PASS] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to move schedule to Pass",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

router.post("/check-iqc-to-pass", async (req, res) => {
  const client = await pool.connect();
  try {
    const { approvedByName } = req.body || {};

    await client.query("BEGIN");

    let passById = null;
    if (approvedByName) {
      const empResult = await client.query(
        `SELECT id FROM employees WHERE emp_name = $1 LIMIT 1`,
        [approvedByName]
      );
      if (empResult.rowCount > 0) passById = empResult.rows[0].id;
    }

    const vendorsResult = await client.query(
      `SELECT lsv.id as vendor_id, lsv.local_schedule_id,
              lsp.part_code,
              COALESCE(lsp.sample_dates::jsonb, '[]'::jsonb) as sample_dates
       FROM local_schedule_vendors lsv
       JOIN local_schedule_parts lsp ON lsp.local_schedule_vendor_id = lsv.id AND lsp.is_active = true
       WHERE lsv.status = 'IQC Progress' AND lsv.is_active = true`
    );

    if (vendorsResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.json({ success: true, movedVendors: [] });
    }

    const qcResult = await client.query(
      `SELECT part_code, TO_CHAR(production_date, 'YYYY-MM-DD') as production_date
       FROM qc_checks WHERE status = 'Complete' AND is_active = true`
    );
    const completedSet = new Set(
      qcResult.rows.map((r) => `${r.part_code}||${r.production_date}`)
    );

    const vendorMap = {};
    for (const row of vendorsResult.rows) {
      const vid = row.vendor_id;
      if (!vendorMap[vid]) {
        vendorMap[vid] = { local_schedule_id: row.local_schedule_id, allPassDates: [] };
      }
      const sampleDates = typeof row.sample_dates === "string"
        ? JSON.parse(row.sample_dates)
        : Array.isArray(row.sample_dates) ? row.sample_dates : [];
      for (const d of sampleDates) {
        const dateStr = typeof d === "string" ? d.split("T")[0] : d;
        vendorMap[vid].allPassDates.push({ part_code: row.part_code, date: dateStr });
      }
    }

    const movedVendors = [];
    for (const [vendorId, info] of Object.entries(vendorMap)) {
      const { allPassDates, local_schedule_id } = info;

      if (allPassDates.length === 0) continue;

      const allComplete = allPassDates.every(({ part_code, date }) =>
        completedSet.has(`${part_code}||${date}`)
      );

      if (!allComplete) continue;

      await client.query(
        `UPDATE local_schedule_vendors
         SET status = 'Pass',
             sample_by = COALESCE(sample_by, $2),
             sample_at = COALESCE(sample_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND is_active = true`,
        [vendorId, passById]
      );

      await client.query(
        `UPDATE local_schedule_parts
         SET status = 'Pass', updated_at = CURRENT_TIMESTAMP
         WHERE local_schedule_vendor_id = $1 AND is_active = true`,
        [vendorId]
      );

      const allVendorsCheck = await client.query(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN status = 'Pass' THEN 1 ELSE 0 END) as matched_count
         FROM local_schedule_vendors
         WHERE local_schedule_id = $1 AND is_active = true`,
        [local_schedule_id]
      );
      const { total, matched_count } = allVendorsCheck.rows[0];
      if (parseInt(total) > 0 && parseInt(total) === parseInt(matched_count)) {
        await client.query(
          `UPDATE local_schedules SET status = 'Pass', updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND is_active = true`,
          [local_schedule_id]
        );
      }

      movedVendors.push(vendorId);
      console.log(`[CHECK IQC TO PASS] Vendor ${vendorId} auto-moved to Pass`);
    }

    await client.query("COMMIT");
    return res.json({ success: true, movedVendors });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[CHECK IQC TO PASS] Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
});

router.put("/vendors/:vendorId/move-to-complete", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId } = req.params;
    const { moveByName } = req.body;

    console.log(`[MOVE TO COMPLETE] Request:`, { vendorId, moveByName });

    await client.query("BEGIN");

    const vendorCheck = await client.query(
      `SELECT id, local_schedule_id, status 
       FROM local_schedule_vendors 
       WHERE id = $1 AND is_active = true`,
      [vendorId],
    );

    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Schedule not found",
      });
    }

    const scheduleId = vendorCheck.rows[0].local_schedule_id;

    let completeById = null;
    if (moveByName) {
      const empResult = await client.query(
        `SELECT id FROM employees WHERE emp_name = $1 LIMIT 1`,
        [moveByName],
      );
      if (empResult.rowCount > 0) {
        completeById = empResult.rows[0].id;
      }
    }

    const vendorResult = await client.query(
      `UPDATE local_schedule_vendors 
       SET status = 'Complete', 
           complete_by = $2,
           complete_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND is_active = true 
       RETURNING id, local_schedule_id, status, complete_by, complete_at`,
      [vendorId, completeById],
    );

    console.log(`[MOVE TO COMPLETE] Vendor moved:`, vendorResult.rows[0]);
    await client.query(
      `UPDATE local_schedule_parts
       SET status = 'Complete', updated_at = CURRENT_TIMESTAMP
       WHERE local_schedule_vendor_id = $1 AND is_active = true`,
      [vendorId]
    );

    const allVendorsCheck = await client.query(
      `SELECT COUNT(*) as total, 
              SUM(CASE WHEN status = 'Complete' THEN 1 ELSE 0 END) as matched_count
       FROM local_schedule_vendors 
       WHERE local_schedule_id = $1 AND is_active = true`,
      [scheduleId],
    );

    const { total, matched_count } = allVendorsCheck.rows[0];

    if (parseInt(total) > 0 && parseInt(total) === parseInt(matched_count)) {
      await client.query(
        `UPDATE local_schedules 
         SET status = 'Complete', updated_at = CURRENT_TIMESTAMP 
         WHERE id = $1 AND is_active = true`,
        [scheduleId],
      );
      console.log(`[MOVE TO COMPLETE] Schedule auto-updated to Complete`);
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Schedule moved to Complete",
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
      message: "Failed to move schedule to Complete",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

router.put("/vendors/:vendorId/return", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId } = req.params;

    console.log(`[RETURN Vendor] Request:`, { vendorId });

    await client.query("BEGIN");

    const vendorCheck = await client.query(
      `SELECT id, local_schedule_id, status 
       FROM local_schedule_vendors 
       WHERE id = $1 AND is_active = true`,
      [vendorId],
    );

    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Schedule not found",
      });
    }

    const scheduleId = vendorCheck.rows[0].local_schedule_id;

    const vendorResult = await client.query(
      `UPDATE local_schedule_vendors 
       SET status = 'Today', 
           move_by = NULL, 
           move_at = NULL,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND is_active = true 
       RETURNING id, local_schedule_id, status`,
      [vendorId],
    );

    await client.query(
      `UPDATE local_schedule_parts
       SET status = 'Today', updated_at = CURRENT_TIMESTAMP
       WHERE local_schedule_vendor_id = $1 AND is_active = true`,
      [vendorId]
    );

    console.log(
      `[RETURN Vendor] Vendor returned to Today:`,
      vendorResult.rows[0],
    );

    await client.query(
      `UPDATE local_schedules 
       SET status = 'Today', updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND is_active = true`,
      [scheduleId],
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Schedule returned to Today tab",
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
      message: "Failed to return schedule",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

router.put("/vendors/:vendorId/return-to-iqc", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId } = req.params;

    console.log(`[RETURN to IQC] Request:`, { vendorId });

    await client.query("BEGIN");

    const vendorCheck = await client.query(
      `SELECT id, local_schedule_id, status 
       FROM local_schedule_vendors 
       WHERE id = $1 AND is_active = true`,
      [vendorId],
    );

    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Schedule not found",
      });
    }

    const scheduleId = vendorCheck.rows[0].local_schedule_id;

    const vendorResult = await client.query(
      `UPDATE local_schedule_vendors 
       SET status = 'IQC Progress', 
           sample_by = NULL, 
           sample_at = NULL,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND is_active = true 
       RETURNING id, local_schedule_id, status`,
      [vendorId],
    );

    await client.query(
      `UPDATE local_schedule_parts
       SET status = 'IQC Progress', updated_at = CURRENT_TIMESTAMP
       WHERE local_schedule_vendor_id = $1 AND is_active = true`,
      [vendorId]
    );

    console.log(
      `[RETURN to IQC] Vendor returned to IQC Progress:`,
      vendorResult.rows[0],
    );

    await client.query(
      `UPDATE local_schedules 
       SET status = 'IQC Progress', updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND is_active = true`,
      [scheduleId],
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Schedule returned to IQC Progress tab",
      data: {
        vendor: vendorResult.rows[0],
        scheduleId: scheduleId,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[RETURN to IQC] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to return schedule to IQC Progress",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

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

    if (!scheduleDate || !stockLevel || !modelName) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: scheduleDate, stockLevel, modelName",
      });
    }

    await client.query("BEGIN");

    const scheduleCheck = await client.query(
      `SELECT id, schedule_code, status FROM local_schedules 
       WHERE id = $1 AND is_active = true`,
      [id],
    );

    if (scheduleCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Schedule not found",
      });
    }

    const uploadBy = await resolveEmployeeId(client, uploadByName);

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
      [scheduleDate, stockLevel, modelName, uploadBy, id],
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
      "Schedule",
      "Today",
      "Received",
      "IQC Progress",
      "Pass",
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
      [status, id],
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

router.post("/:scheduleId/vendors", async (req, res) => {
  const client = await pool.connect();
  try {
    const { scheduleId } = req.params;
    const { trip_id, vendor_id, do_number } = req.body;

    console.log(`[ADD Vendor] Request:`, {
      scheduleId,
      trip_id,
      vendor_id,
      do_number,
    });

    if (!trip_id || !vendor_id || !do_number) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: trip_id, schedule_id, do_number",
      });
    }

    await client.query("BEGIN");

    const scheduleCheck = await client.query(
      `SELECT id, schedule_date, stock_level, model_name, status FROM local_schedules WHERE id = $1 AND is_active = true`,
      [scheduleId],
    );

    if (scheduleCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Schedule not found",
      });
    }

    const scheduleStatus = scheduleCheck.rows[0].status || 'New';

    const tripCheck = await client.query(
      `SELECT id, arv_to FROM trips WHERE id = $1`,
      [trip_id],
    );

    if (tripCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Trip not found",
      });
    }

    const arrivalTime = tripCheck.rows[0].arv_to;
    const doJoined = Array.isArray(do_number)
      ? do_number.join(" | ")
      : do_number;

    const result = await client.query(
      `INSERT INTO local_schedule_vendors
       (local_schedule_id, trip_id, vendor_id, do_number, arrival_time, total_pallet, total_item, status)
       VALUES ($1, $2, $3, $4, $5, 0, 0, $6)
       RETURNING id, local_schedule_id, trip_id, vendor_id, do_number, arrival_time, status`,
      [scheduleId, trip_id, vendor_id, doJoined, arrivalTime, scheduleStatus],
    );

    await client.query(
      `UPDATE local_schedules
       SET total_vendor = (
         SELECT COUNT(*) FROM local_schedule_vendors WHERE local_schedule_id = $1 AND is_active = true
       ),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [scheduleId],
    );

    await client.query("COMMIT");

    console.log(`[ADD Vendor] Success:`, result.rows[0]);

    res.status(201).json({
      success: true,
      message: "Schedule added successfully",
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[ADD Vendor] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to add schedule",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

router.post("/vendors/:vendorId/parts", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId } = req.params;
    const { part_code, part_name, quantity, quantity_box, unit, do_number } =
      req.body;

    console.log(`[ADD Part] Request:`, {
      vendorId,
      part_code,
      part_name,
      quantity,
      quantity_box,
      unit,
    });

    if (!part_code) {
      return res.status(400).json({
        success: false,
        message: "Missing required field: part_code",
      });
    }

    await client.query("BEGIN");

    const vendorCheck = await client.query(
      `SELECT id, local_schedule_id FROM local_schedule_vendors WHERE id = $1 AND is_active = true`,
      [vendorId],
    );

    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Schedule not found",
      });
    }

    const scheduleId = vendorCheck.rows[0].local_schedule_id;

    let partId = null;
    const partRes = await client.query(
      `SELECT id FROM kanban_master WHERE part_code = $1 AND is_active = true LIMIT 1`,
      [part_code.trim()],
    );
    if (partRes.rows[0]) {
      partId = partRes.rows[0].id;
    }

    const vendorStatusRes = await client.query(
      `SELECT lsv.status FROM local_schedule_vendors lsv WHERE lsv.id = $1`,
      [vendorId]
    );
    const vendorStatus = vendorStatusRes.rows[0]?.status || 'New';

    const result = await client.query(
      `INSERT INTO local_schedule_parts
       (local_schedule_vendor_id, part_id, part_code, part_name, quantity, quantity_box, unit, do_number, remark, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, part_code, part_name, quantity as qty, quantity_box as qty_box, unit`,
      [
        vendorId,
        partId,
        part_code,
        part_name || "",
        Number(quantity) || 0,
        Number(quantity_box) || 0,
        unit || "PCS",
        do_number || "",
        "",
        vendorStatus,
      ],
    );

    await client.query(
      `UPDATE local_schedule_vendors
       SET total_item = (
         SELECT COUNT(*) FROM local_schedule_parts WHERE local_schedule_vendor_id = $1 AND is_active = true
       ),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [vendorId],
    );

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
      [scheduleId],
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

router.post("/:scheduleId/vendors/bulk", async (req, res) => {
  const client = await pool.connect();
  try {
    const { scheduleId } = req.params;
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "items array is required" });
    }

    await client.query("BEGIN");

    const scheduleCheck = await client.query(
      `SELECT id, schedule_date, stock_level, model_name, status FROM local_schedules WHERE id = $1 AND is_active = true`,
      [scheduleId]
    );

    if (scheduleCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Schedule not found" });
    }

    const scheduleStatus = scheduleCheck.rows[0].status || 'New';

    const insertedVendors = [];

    for (const item of items) {
      const { trip_id, vendor_id, do_number } = item;
      if (!trip_id || !vendor_id) continue;

      const tripCheck = await client.query(
        `SELECT id, arv_to FROM trips WHERE id = $1`,
        [trip_id]
      );
      const arrivalTime = tripCheck.rows[0]?.arv_to || null;
      const doJoined = Array.isArray(do_number) ? do_number.join(" | ") : (do_number || "");

      const result = await client.query(
        `INSERT INTO local_schedule_vendors
         (local_schedule_id, trip_id, vendor_id, do_number, arrival_time, total_pallet, total_item, status)
         VALUES ($1, $2, $3, $4, $5, 0, 0, $6)
         RETURNING id, local_schedule_id, trip_id, vendor_id, do_number, arrival_time, status`,
        [scheduleId, trip_id, vendor_id, doJoined, arrivalTime, scheduleStatus]
      );

      insertedVendors.push(result.rows[0]);
    }

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

    res.status(201).json({
      success: true,
      message: `${insertedVendors.length} vendors added successfully`,
      vendors: insertedVendors,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[BULK ADD Vendors] Error:", error);
    res.status(500).json({ success: false, message: "Failed to add vendors", error: error.message });
  } finally {
    client.release();
  }
});

router.post("/:vendorId/parts/bulk", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId } = req.params;
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "items array is required" });
    }

    await client.query("BEGIN");

    const vendorCheck = await client.query(
      `SELECT id, local_schedule_id FROM local_schedule_vendors WHERE id = $1 AND is_active = true`,
      [vendorId]
    );

    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }

    const scheduleId = vendorCheck.rows[0].local_schedule_id;
    const scheduleRes = await client.query(
      `SELECT status FROM local_schedules WHERE id = $1`,
      [scheduleId]
    );
    const scheduleStatus = scheduleRes.rows[0]?.status || 'New';
    const insertedParts = [];

    for (const item of items) {
      const { part_code, part_name, qty, qty_box, unit, do_number } = item;
      if (!part_code) continue;

      const partRes = await client.query(
        `SELECT id FROM kanban_master WHERE part_code = $1 AND is_active = true LIMIT 1`,
        [part_code.trim()]
      );
      const partId = partRes.rows[0]?.id || null;

      const result = await client.query(
        `INSERT INTO local_schedule_parts
         (local_schedule_vendor_id, part_id, part_code, part_name, quantity, quantity_box, unit, do_number, remark, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, part_code, part_name, quantity as qty, quantity_box as qty_box, unit`,
        [vendorId, partId, part_code, part_name || "", Number(qty) || 0, Number(qty_box) || 0, unit || "PCS", do_number || "", "", scheduleStatus]
      );

      insertedParts.push(result.rows[0]);
    }

    await client.query(
      `UPDATE local_schedule_vendors
       SET total_item = (
         SELECT COUNT(*) FROM local_schedule_parts WHERE local_schedule_vendor_id = $1 AND is_active = true
       ),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [vendorId]
    );

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

    res.status(201).json({
      success: true,
      message: `${insertedParts.length} parts added successfully`,
      parts: insertedParts,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[BULK ADD Parts] Error:", error);
    res.status(500).json({ success: false, message: "Failed to add parts", error: error.message });
  } finally {
    client.release();
  }
});

router.delete("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    console.log(`[DELETE Schedule] Deleting schedule ID: ${id}`);

    await client.query("BEGIN");

    const scheduleCheck = await client.query(
      `SELECT id, schedule_code, status FROM local_schedules 
       WHERE id = $1 AND is_active = true`,
      [id],
    );

    if (scheduleCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      console.log(`[DELETE Schedule] Schedule ${id} not found`);
      return res.status(404).json({
        success: false,
        message: "Schedule not found or already deleted",
      });
    }

    const schedule = scheduleCheck.rows[0];
    console.log(`[DELETE Schedule] Found schedule:`, schedule);

    const vendorIdsResult = await client.query(
      `SELECT id FROM local_schedule_vendors 
       WHERE local_schedule_id = $1 AND is_active = true`,
      [id],
    );

    const vendorIds = vendorIdsResult.rows.map((row) => row.id);
    console.log(
      `[DELETE Schedule] Found ${vendorIds.length} vendors to delete`,
    );

    let deletedParts = 0;
    let deletedVendors = 0;

    if (vendorIds.length > 0) {
      const partsDeleteResult = await client.query(
        `DELETE FROM local_schedule_parts 
         WHERE local_schedule_vendor_id = ANY($1::int[])
         RETURNING id`,
        [vendorIds],
      );
      deletedParts = partsDeleteResult.rowCount;
      console.log(`[DELETE Schedule] Deleted ${deletedParts} parts`);
    }

    const vendorsDeleteResult = await client.query(
      `DELETE FROM local_schedule_vendors 
       WHERE local_schedule_id = $1
       RETURNING id`,
      [id],
    );
    deletedVendors = vendorsDeleteResult.rowCount;
    console.log(`[DELETE Schedule] Deleted ${deletedVendors} vendors`);

    const scheduleDeleteResult = await client.query(
      `DELETE FROM local_schedules 
       WHERE id = $1 
       RETURNING id, schedule_code, status, schedule_date`,
      [id],
    );

    console.log(
      `[DELETE Schedule] Deleted schedule:`,
      scheduleDeleteResult.rows[0],
    );

    await client.query("COMMIT");

    console.log(`[DELETE Schedule] Successfully deleted schedule ${id}`);

    res.json({
      success: true,
      message: "Schedule and all related data deleted successfully",
      data: {
        schedule: scheduleDeleteResult.rows[0],
        deletedVendors: deletedVendors,
        deletedParts: deletedParts,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[DELETE Schedule] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete schedule",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

router.delete("/vendors/:vendorId", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId } = req.params;

    console.log(`[DELETE Vendor] Deleting vendor ID: ${vendorId}`);

    await client.query("BEGIN");

    const vendorCheck = await client.query(
      `SELECT id, local_schedule_id FROM local_schedule_vendors 
       WHERE id = $1 AND is_active = true`,
      [vendorId],
    );

    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      console.log(`[DELETE Vendor] Vendor ${vendorId} not found`);
      return res.status(404).json({
        success: false,
        message: "Schedule not found or already deleted",
      });
    }

    const vendor = vendorCheck.rows[0];
    const scheduleId = vendor.local_schedule_id;
    console.log(`[DELETE Vendor] Found vendor:`, vendor);

    const partsDeleteResult = await client.query(
      `DELETE FROM local_schedule_parts 
       WHERE local_schedule_vendor_id = $1
       RETURNING id`,
      [vendorId],
    );
    const deletedParts = partsDeleteResult.rowCount;
    console.log(`[DELETE Vendor] Deleted ${deletedParts} parts`);

    const vendorDeleteResult = await client.query(
      `DELETE FROM local_schedule_vendors 
       WHERE id = $1 
       RETURNING id`,
      [vendorId],
    );
    console.log(`[DELETE Vendor] Deleted vendor:`, vendorDeleteResult.rows[0]);

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
      [scheduleId],
    );
    console.log(
      `[DELETE Vendor] Updated schedule totals:`,
      updateResult.rows[0],
    );

    await client.query("COMMIT");

    console.log(
      `[DELETE Vendor] Successfully deleted vendor ${vendorId} with all parts`,
    );

    res.json({
      success: true,
      message: "Schedule and all related parts deleted successfully",
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
      message: "Failed to delete schedule",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

router.delete("/parts/:partId", async (req, res) => {
  const client = await pool.connect();
  try {
    const { partId } = req.params;

    console.log(`[DELETE Part] Deleting part ID: ${partId}`);

    await client.query("BEGIN");

    const partCheck = await client.query(
      `SELECT id, local_schedule_vendor_id FROM local_schedule_parts 
       WHERE id = $1 AND is_active = true`,
      [partId],
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

    const partDeleteResult = await client.query(
      `DELETE FROM local_schedule_parts 
       WHERE id = $1 
       RETURNING id`,
      [partId],
    );
    console.log(`[DELETE Part] Deleted part:`, partDeleteResult.rows[0]);

    const updateVendorResult = await client.query(
      `UPDATE local_schedule_vendors
       SET total_item = (
         SELECT COUNT(*) FROM local_schedule_parts 
         WHERE local_schedule_vendor_id = $1 AND is_active = true
       ),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING total_item, local_schedule_id`,
      [vendorId],
    );

    const scheduleId = updateVendorResult.rows[0].local_schedule_id;
    console.log(
      `[DELETE Part] Updated vendor total_item:`,
      updateVendorResult.rows[0],
    );

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
      [scheduleId],
    );
    console.log(
      `[DELETE Part] Updated schedule total_item:`,
      updateScheduleResult.rows[0],
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

router.delete("/:scheduleId/vendors/:vendorId", async (req, res) => {
  const client = await pool.connect();
  try {
    const { scheduleId, vendorId } = req.params;

    console.log(
      `[DELETE Vendor Alt] Deleting vendor ${vendorId} from schedule ${scheduleId}`,
    );

    await client.query("BEGIN");

    const vendorCheck = await client.query(
      `SELECT id FROM local_schedule_vendors 
       WHERE id = $1 AND local_schedule_id = $2 AND is_active = true`,
      [vendorId, scheduleId],
    );

    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Schedule not found in this schedule",
      });
    }

    const partsDeleteResult = await client.query(
      `DELETE FROM local_schedule_parts 
       WHERE local_schedule_vendor_id = $1
       RETURNING id`,
      [vendorId],
    );
    const deletedParts = partsDeleteResult.rowCount;
    console.log(`[DELETE Vendor Alt] Deleted ${deletedParts} parts`);

    await client.query(
      `DELETE FROM local_schedule_vendors 
       WHERE id = $1`,
      [vendorId],
    );
    console.log(`[DELETE Vendor Alt] Deleted vendor ${vendorId}`);

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
      [scheduleId],
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Schedule and all parts deleted successfully",
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
      message: "Failed to delete schedule",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

router.delete("/vendors/:vendorId/parts/:partId", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId, partId } = req.params;

    console.log(
      `[DELETE Part Alt] Deleting part ${partId} from vendor ${vendorId}`,
    );

    await client.query("BEGIN");

    const partCheck = await client.query(
      `SELECT id FROM local_schedule_parts 
       WHERE id = $1 AND local_schedule_vendor_id = $2 AND is_active = true`,
      [partId, vendorId],
    );

    if (partCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Part not found in this schedule",
      });
    }

    await client.query(
      `DELETE FROM local_schedule_parts 
       WHERE id = $1`,
      [partId],
    );
    console.log(`[DELETE Part Alt] Deleted part ${partId}`);

    const vendorUpdate = await client.query(
      `UPDATE local_schedule_vendors
       SET total_item = (
         SELECT COUNT(*) FROM local_schedule_parts 
         WHERE local_schedule_vendor_id = $1 AND is_active = true
       ),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING local_schedule_id`,
      [vendorId],
    );

    const scheduleId = vendorUpdate.rows[0].local_schedule_id;

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
      [scheduleId],
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