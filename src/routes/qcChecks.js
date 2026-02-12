// routes/qcChecks.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

// Helper: Cari employee ID dari nama
const resolveEmployeeId = async (empName) => {
  if (!empName) return null;
  try {
    const client = await pool.connect();
    const result = await client.query(
      `SELECT id FROM employees WHERE LOWER(emp_name) = LOWER($1) LIMIT 1`,
      [empName]
    );
    client.release();
    return result.rows[0]?.id ?? null;
  } catch (error) {
    console.error("Error resolving employee:", empName);
    return null;
  }
};

// ====== GET all QC Checks ======
router.get("/", async (req, res) => {
  try {
    const { status, part_code, date_from, date_to, data_from } = req.query;

    console.log(`[QC GET] status=${status}, part=${part_code}`);

    let query = `
      SELECT 
        id,
        part_code,
        part_name,
        vendor_name,
        TO_CHAR(production_date, 'YYYY-MM-DD') as production_date,
        data_from,
        status,
        qc_status,
        remark,
        approved_by_name as approved_by,
        approved_at,
        rejected_by_name as rejected_by,
        rejected_at,
        created_by,
        created_at,
        updated_at,
        source_vendor_id,
        source_part_id
      FROM qc_checks
      WHERE is_active = true
    `;

    const params = [];
    let paramCount = 0;

    if (status) {
      paramCount++;
      query += ` AND status = $${paramCount}`;
      params.push(status);
    }

    if (part_code) {
      paramCount++;
      query += ` AND part_code ILIKE $${paramCount}`;
      params.push(`%${part_code}%`);
    }

    if (date_from) {
      paramCount++;
      query += ` AND production_date >= $${paramCount}::date`;
      params.push(date_from);
    }

    if (date_to) {
      paramCount++;
      query += ` AND production_date <= $${paramCount}::date`;
      params.push(date_to);
    }

    if (data_from) {
      paramCount++;
      query += ` AND data_from = $${paramCount}`;
      params.push(data_from);
    }

    query += ` ORDER BY created_at DESC`;

    const result = await pool.query(query, params);

    console.log(`[QC GET] Found ${result.rows.length} records`);

    res.json({
      success: true,
      data: result.rows,
      total: result.rows.length,
    });
  } catch (error) {
    console.error("[QC GET] Error:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch QC checks",
      error: error.message,
    });
  }
});

// ====== CREATE QC Check ======
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      part_code,
      part_name,
      vendor_name,
      production_date,
      data_from = "Create",
      status = "Pending",
      approved_by_name,
      created_by_name,
      source_vendor_id,  // For auto-move to Pass
      source_part_id,    // For reference
      isLastQcCheck = false,  // NEW: Flag from frontend
    } = req.body;

    console.log(`[QC CREATE] ${part_code} - ${production_date} (vendor_id: ${source_vendor_id}, isLastQcCheck: ${isLastQcCheck})`);

    if (!part_code || !production_date) {
      return res.status(400).json({
        success: false,
        message: "part_code and production_date are required",
      });
    }

    await client.query("BEGIN");

    // Check duplicate
    const existingCheck = await client.query(
      `SELECT id FROM qc_checks 
       WHERE part_code = $1 
       AND production_date = $2::date 
       AND is_active = true
       LIMIT 1`,
      [part_code, production_date]
    );

    if (existingCheck.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(200).json({
        success: true,
        message: "QC Check already exists",
        data: existingCheck.rows[0],
        alreadyExists: true,
      });
    }

    // Cari ID employee jika ada namanya
    let approvedById = null;
    if (approved_by_name) {
      approvedById = await resolveEmployeeId(approved_by_name);
    }

    const result = await client.query(
      `INSERT INTO qc_checks (
        part_code, part_name, vendor_name, production_date, data_from,
        status, approved_by, approved_by_name, approved_at,
        source_vendor_id, source_part_id,
        created_by, created_at, updated_at, is_active
      ) VALUES (
        $1, $2, $3, $4::date, $5,
        $6, $7, $8, 
        ${status === "Complete" && approved_by_name ? "CURRENT_TIMESTAMP" : "NULL"},
        $9, $10,
        $11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, true
      )
      RETURNING 
        id,
        part_code,
        part_name,
        vendor_name,
        TO_CHAR(production_date, 'YYYY-MM-DD') as production_date,
        data_from,
        status,
        source_vendor_id,
        approved_by_name as approved_by,
        approved_at,
        created_by,
        created_at`,
      [
        part_code,
        part_name || null,
        vendor_name || null,
        production_date,
        data_from,
        status,
        approvedById,
        approved_by_name || null,
        source_vendor_id || null,
        source_part_id || null,
        created_by_name || approved_by_name || "System",
      ]
    );

    let vendorMovedToPass = false;

    // AUTO-CHECK: If this is the last QC check for vendor, move to Pass
    if (data_from === 'M136' && status === 'Complete' && source_vendor_id && isLastQcCheck) {
      console.log(`[QC CREATE] Last QC check for vendor ${source_vendor_id}! Moving to Pass`);

      try {
        // Recalculate total_pallet before moving
        const palletCalc = await client.query(
          `SELECT COALESCE(SUM(quantity_box), 0) as total_boxes
           FROM oversea_schedule_parts
           WHERE oversea_schedule_vendor_id = $1 AND is_active = true`,
          [source_vendor_id]
        );

        const totalPallet = parseInt(palletCalc.rows[0]?.total_boxes) || 0;

        // Update vendor status AND total_pallet AND set sample timestamp
        await client.query(
          `UPDATE oversea_schedule_vendors 
           SET vendor_status = 'Sample',
              sample_by = $2,              
              sample_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP 
           WHERE id = $1 AND is_active = true`,
          [source_vendor_id, approvedById]  
        );

        console.log(`[QC CREATE] Vendor ${source_vendor_id} moved to Pass with total_pallet=${totalPallet}`);

        // Check if should update schedule status
        const vendorInfo = await client.query(
          `SELECT oversea_schedule_id FROM oversea_schedule_vendors WHERE id = $1`,
          [source_vendor_id]
        );

        if (vendorInfo.rowCount > 0) {
          const scheduleId = vendorInfo.rows[0].oversea_schedule_id;

          const allVendorsCheck = await client.query(
            `SELECT COUNT(*) as total, 
                      SUM(CASE WHEN vendor_status = 'Sample' THEN 1 ELSE 0 END) as sample_count
               FROM oversea_schedule_vendors 
               WHERE oversea_schedule_id = $1 AND is_active = true`,
            [scheduleId]
          );

          const { total, sample_count } = allVendorsCheck.rows[0];
          if (parseInt(total) > 0 && parseInt(total) === parseInt(sample_count)) {
            // Recalculate schedule total_pallet (sum of all vendors)
            const schedulePalletCalc = await client.query(
              `SELECT COALESCE(SUM(total_pallet), 0) as total_pallets
                 FROM oversea_schedule_vendors
                 WHERE oversea_schedule_id = $1 AND is_active = true`,
              [scheduleId]
            );

            const scheduleTotalPallet = parseInt(schedulePalletCalc.rows[0]?.total_pallets) || 0;

            await client.query(
              `UPDATE oversea_schedules 
                 SET status = 'Sample',
                     total_pallet = $2,
                     updated_at = CURRENT_TIMESTAMP 
                 WHERE id = $1 AND is_active = true`,
              [scheduleId, scheduleTotalPallet]
            );
            console.log(`[QC CREATE] Schedule ${scheduleId} moved to Sample with total_pallet=${scheduleTotalPallet}`);
          }
        }

        vendorMovedToPass = true;
      } catch (autoMoveError) {
        console.error(`[QC CREATE] Error auto-moving vendor:`, autoMoveError.message);
        // Don't rollback, just log
      }
    }

    await client.query("COMMIT");

    console.log(`[QC CREATE] Success: ID ${result.rows[0].id}${vendorMovedToPass ? ' (Vendor moved to Pass)' : ''}`);

    res.status(201).json({
      success: true,
      message: "QC Check created successfully",
      data: result.rows[0],
      vendorMovedToPass: vendorMovedToPass,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[QC CREATE] Error:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to create QC check",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== APPROVE QC Check ======
router.put("/:id/approve", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { approved_by_name, isLastQcCheck } = req.body;

    console.log(`[QC APPROVE] ID ${id} by ${approved_by_name}, isLastQcCheck: ${isLastQcCheck}`);

    if (!approved_by_name) {
      return res.status(400).json({
        success: false,
        message: "approved_by_name is required",
      });
    }

    await client.query("BEGIN");

    const approvedById = await resolveEmployeeId(approved_by_name);

    // Get QC check details before update (need source_vendor_id for auto-move)
    const qcCheckBefore = await client.query(
      `SELECT source_vendor_id, data_from FROM qc_checks WHERE id = $1 AND is_active = true`,
      [id]
    );

    if (qcCheckBefore.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "QC Check not found",
      });
    }

    const { source_vendor_id, data_from } = qcCheckBefore.rows[0];

    // Update status from "M136 Part" to "Complete"
    const result = await client.query(
      `UPDATE qc_checks 
       SET status = 'Complete',
           approved_by = $2,
           approved_by_name = $3,
           approved_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND is_active = true
       RETURNING 
         id,
         part_code,
         status,
         approved_by_name as approved_by,
         approved_at`,
      [id, approvedById, approved_by_name]
    );

    let vendorMovedToPass = false;

    // AUTO-MOVE TO PASS: If this is the last QC check for M136 vendor
    if (data_from === 'M136' && isLastQcCheck && source_vendor_id) {
      console.log(`[QC APPROVE] Last QC check for vendor ${source_vendor_id}! Moving to Pass`);

      try {
        // Recalculate total_pallet before moving
        const palletCalc = await client.query(
          `SELECT COALESCE(SUM(quantity_box), 0) as total_boxes
           FROM oversea_schedule_parts
           WHERE oversea_schedule_vendor_id = $1 AND is_active = true`,
          [source_vendor_id]
        );

        const totalPallet = parseInt(palletCalc.rows[0]?.total_boxes) || 0;

        // Update vendor status AND total_pallet AND set sample timestamp
        await client.query(
          `UPDATE oversea_schedule_vendors 
            SET vendor_status = 'Sample',
                sample_by = $2,              
                sample_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP 
            WHERE id = $1 AND is_active = true`,
          [source_vendor_id, approvedById]  
        );
        console.log(`[QC APPROVE] Vendor ${source_vendor_id} moved to Pass with total_pallet=${totalPallet}`);

        // Check if should update schedule status
        const vendorInfo = await client.query(
          `SELECT oversea_schedule_id FROM oversea_schedule_vendors WHERE id = $1`,
          [source_vendor_id]
        );

        if (vendorInfo.rowCount > 0) {
          const scheduleId = vendorInfo.rows[0].oversea_schedule_id;

          const allVendorsCheck = await client.query(
            `SELECT COUNT(*) as total, 
                    SUM(CASE WHEN vendor_status = 'Sample' THEN 1 ELSE 0 END) as sample_count
             FROM oversea_schedule_vendors 
             WHERE oversea_schedule_id = $1 AND is_active = true`,
            [scheduleId]
          );

          const { total, sample_count } = allVendorsCheck.rows[0];
          if (parseInt(total) > 0 && parseInt(total) === parseInt(sample_count)) {
            // Recalculate schedule total_pallet (sum of all vendors)
            const schedulePalletCalc = await client.query(
              `SELECT COALESCE(SUM(total_pallet), 0) as total_pallets
               FROM oversea_schedule_vendors
               WHERE oversea_schedule_id = $1 AND is_active = true`,
              [scheduleId]
            );

            const scheduleTotalPallet = parseInt(schedulePalletCalc.rows[0]?.total_pallets) || 0;

            await client.query(
              `UPDATE oversea_schedules 
               SET status = 'Sample',
                   total_pallet = $2,
                   updated_at = CURRENT_TIMESTAMP 
               WHERE id = $1 AND is_active = true`,
              [scheduleId, scheduleTotalPallet]
            );
            console.log(`[QC APPROVE] Schedule ${scheduleId} moved to Sample with total_pallet=${scheduleTotalPallet}`);
          }
        }

        vendorMovedToPass = true;
      } catch (autoMoveError) {
        console.error(`[QC APPROVE] Error auto-moving vendor:`, autoMoveError.message);
        // Don't rollback, just log
      }
    }

    await client.query("COMMIT");

    console.log(`[QC APPROVE] Success: ID ${id}${vendorMovedToPass ? ' (Vendor moved to Pass)' : ''}`);

    res.json({
      success: true,
      message: "QC Check approved successfully",
      data: result.rows[0],
      vendorMovedToPass: vendorMovedToPass,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[QC APPROVE] Error:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to approve QC check",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== REJECT QC Check ======
router.put("/:id/reject", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { rejected_by_name, remark } = req.body;

    console.log(`[QC REJECT] ID ${id} by ${rejected_by_name}`);

    if (!rejected_by_name) {
      return res.status(400).json({
        success: false,
        message: "rejected_by_name is required",
      });
    }

    await client.query("BEGIN");

    const rejectedById = await resolveEmployeeId(rejected_by_name);

    const result = await client.query(
      `UPDATE qc_checks 
       SET status = 'Reject',
           rejected_by = $2,
           rejected_by_name = $3,
           rejected_at = CURRENT_TIMESTAMP,
           remark = COALESCE($4, remark),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND is_active = true
       RETURNING 
         id,
         part_code,
         status,
         rejected_by_name as rejected_by,
         rejected_at`,
      [id, rejectedById, rejected_by_name, remark]
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "QC Check not found",
      });
    }

    await client.query("COMMIT");

    console.log(`[QC REJECT] Success: ID ${id}`);

    res.json({
      success: true,
      message: "QC Check rejected successfully",
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[QC REJECT] Error:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to reject QC check",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== DELETE QC Check ======
router.delete("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    console.log(`[QC DELETE] ID ${id}`);

    const result = await client.query(
      `UPDATE qc_checks 
       SET is_active = false,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND is_active = true
       RETURNING id, part_code`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "QC Check not found",
      });
    }

    await client.query("COMMIT");

    console.log(`[QC DELETE] Success: ID ${id}`);

    res.json({
      success: true,
      message: "QC Check deleted successfully",
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[QC DELETE] Error:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to delete QC check",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== Endpoint Penting Lainnya ======

// CHECK IF PART + DATE IS COMPLETE
router.get("/check-complete/:part_code/:production_date", async (req, res) => {
  try {
    const { part_code, production_date } = req.params;

    const result = await pool.query(
      `SELECT id FROM qc_checks
       WHERE part_code = $1 
         AND production_date = $2::date
         AND is_active = true
         AND status = 'Complete'
       LIMIT 1`,
      [part_code, production_date]
    );

    res.json({
      success: true,
      isComplete: result.rows.length > 0,
    });
  } catch (error) {
    console.error("[CHECK COMPLETE] Error:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to check completion status",
      error: error.message,
    });
  }
});

// BULK CHECK COMPLETE
router.post("/check-complete-bulk", async (req, res) => {
  try {
    const { checks } = req.body;

    if (!checks || !Array.isArray(checks) || checks.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid request: 'checks' must be a non-empty array",
      });
    }

    console.log(`[BULK CHECK] Checking ${checks.length} items`);

    const conditions = checks.map((_, idx) =>
      `(part_code = $${idx * 2 + 1} AND DATE(production_date) = DATE($${idx * 2 + 2}::date))`
    ).join(" OR ");

    const params = checks.flatMap(c => [c.part_code, c.production_date]);

    const query = `
      SELECT 
        part_code,
        TO_CHAR(production_date, 'YYYY-MM-DD') as production_date,
        status
      FROM qc_checks
      WHERE (${conditions})
        AND is_active = true
        AND status = 'Complete'
    `;

    const result = await pool.query(query, params);

    const completeMap = {};
    result.rows.forEach(row => {
      const key = `${row.part_code}_${row.production_date}`;
      completeMap[key] = true;
    });

    const results = checks.map(check => ({
      part_code: check.part_code,
      production_date: check.production_date,
      isComplete: completeMap[`${check.part_code}_${check.production_date}`] || false,
    }));

    console.log(`[BULK CHECK] Found ${result.rows.length} complete items`);

    res.json({
      success: true,
      data: results,
      totalComplete: result.rows.length,
      totalChecked: checks.length,
    });
  } catch (error) {
    console.error("[BULK CHECK] Error:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to bulk check completion status",
      error: error.message,
    });
  }
});

// GET Current Check tab (Pending status)
router.get("/current-check", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        id,
        part_code,
        part_name,
        vendor_name,
        TO_CHAR(production_date, 'YYYY-MM-DD') as production_date,
        data_from,
        status,
        created_by,
        created_at
       FROM qc_checks
       WHERE is_active = true
         AND status = 'Pending'
       ORDER BY created_at DESC`
    );

    console.log(`[CURRENT CHECK] Found ${result.rows.length} pending items`);

    res.json({
      success: true,
      data: result.rows,
      total: result.rows.length,
    });
  } catch (error) {
    console.error("[CURRENT CHECK] Error:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch current check items",
      error: error.message,
    });
  }
});

// UPDATE QC STATUS
router.put("/:id/update-status", async (req, res) => {
  try {
    const { id } = req.params;
    const { qc_status } = req.body;

    console.log(`[UPDATE STATUS] ID ${id} to ${qc_status}`);

    const result = await pool.query(
      `UPDATE qc_checks
       SET qc_status = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND is_active = true
       RETURNING id, part_code, qc_status`,
      [qc_status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "QC Check not found",
      });
    }

    console.log(`[UPDATE STATUS] Success: ID ${id}`);

    res.json({
      success: true,
      message: "QC status updated successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("[UPDATE STATUS] Error:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to update QC status",
      error: error.message,
    });
  }
});

// BULK APPROVE
router.post("/bulk-approve", async (req, res) => {
  const client = await pool.connect();
  try {
    const { ids, approved_by_name } = req.body;

    console.log(`[BULK APPROVE] ${ids.length} items by ${approved_by_name}`);

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid request: 'ids' must be a non-empty array",
      });
    }

    await client.query("BEGIN");

    const approvedById = await resolveEmployeeId(approved_by_name);

    const result = await client.query(
      `UPDATE qc_checks
       SET status = 'Complete',
           approved_by = $1,
           approved_by_name = $2,
           approved_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ANY($3::int[])
         AND is_active = true
       RETURNING id`,
      [approvedById, approved_by_name, ids]
    );

    await client.query("COMMIT");

    console.log(`[BULK APPROVE] Success: ${result.rows.length} items`);

    res.json({
      success: true,
      message: `${result.rows.length} QC Checks approved successfully`,
      approvedCount: result.rows.length,
      approvedIds: result.rows.map(r => r.id),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[BULK APPROVE] Error:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to bulk approve QC checks",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// GET single QC Check by ID
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT 
        id,
        part_code,
        part_name,
        vendor_name,
        TO_CHAR(production_date, 'YYYY-MM-DD') as production_date,
        data_from,
        status,
        approved_by_name as approved_by,
        approved_at,
        created_by,
        created_at
       FROM qc_checks
       WHERE id = $1 AND is_active = true`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "QC Check not found",
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error("[GET BY ID] Error:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch QC check",
      error: error.message,
    });
  }
});

module.exports = router;