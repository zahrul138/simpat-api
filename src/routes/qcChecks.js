// routes/qcChecks.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

// Helper: resolve employee ID from name
const resolveEmployeeId = async (client, empName) => {
  if (!empName) return null;
  const q = await client.query(
    `SELECT id FROM employees WHERE LOWER(emp_name)=LOWER($1) LIMIT 1`,
    [empName]
  );
  return q.rows[0]?.id ?? null;
};

// ====== CHECK IF PART + DATE IS COMPLETE (untuk IQC Progress filter) ======
// Endpoint ini digunakan oleh LocalSchedulePage untuk mengecek status
router.get("/check-complete/:part_code/:production_date", async (req, res) => {
  try {
    const { part_code, production_date } = req.params;

    console.log(`[CHECK COMPLETE] Checking: ${part_code} - ${production_date}`);

    const query = `
      SELECT 
        id,
        part_code,
        TO_CHAR(production_date, 'YYYY-MM-DD') as production_date,
        status,
        data_from
      FROM qc_checks
      WHERE part_code = $1 
        AND DATE(production_date) = DATE($2::date)
        AND is_active = true
        AND status = 'Complete'
      LIMIT 1
    `;

    const result = await pool.query(query, [part_code, production_date]);

    const isComplete = result.rows.length > 0;

    console.log(`[CHECK COMPLETE] Result: ${isComplete ? 'Complete' : 'Not Complete'}`);

    res.json({
      success: true,
      isComplete: isComplete,
      data: result.rows[0] || null,
    });
  } catch (error) {
    console.error("[CHECK COMPLETE] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to check completion status",
      error: error.message,
    });
  }
});

// ====== BULK CHECK COMPLETE (untuk multiple dates sekaligus) ======
// Endpoint ini lebih efisien untuk mengecek banyak part+date sekaligus
router.post("/check-complete-bulk", async (req, res) => {
  try {
    const { checks } = req.body; // Array of { part_code, production_date }

    if (!checks || !Array.isArray(checks) || checks.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid request: 'checks' must be a non-empty array",
      });
    }

    console.log(`[BULK CHECK COMPLETE] Checking ${checks.length} items`);

    // Build query untuk check multiple items
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

    // Create a map of complete items
    const completeMap = {};
    result.rows.forEach(row => {
      const key = `${row.part_code}_${row.production_date}`;
      completeMap[key] = true;
    });

    // Return results for each check
    const results = checks.map(check => ({
      part_code: check.part_code,
      production_date: check.production_date,
      isComplete: completeMap[`${check.part_code}_${check.production_date}`] || false,
    }));

    console.log(`[BULK CHECK COMPLETE] Found ${result.rows.length} complete items`);

    res.json({
      success: true,
      data: results,
      totalComplete: result.rows.length,
      totalChecked: checks.length,
    });
  } catch (error) {
    console.error("[BULK CHECK COMPLETE] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to bulk check completion status",
      error: error.message,
    });
  }
});

// ====== CREATE QC Check ======
// Digunakan oleh:
// 1. AddQCCheckPage (data_from = "Create")
// 2. LocalSchedulePage - Move to Sample action (data_from = "Sample")
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      part_code,
      part_name,
      vendor_name,
      vendor_id,
      vendor_type,
      production_date,
      approved_by,
      data_from, // "Create" dari AddQCCheckPage, "Sample" dari LocalSchedulePage
      local_schedule_part_id, // NEW: ID dari local_schedule_parts (untuk tracking)
      created_by, // NEW: Siapa yang membuat (untuk Sample)
      skip_duplicate_check, // NEW: Flag untuk skip duplicate check
    } = req.body || {};

    console.log("[POST QC Check] Received data:", req.body);

    if (!part_code || !production_date) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: part_code and production_date are required",
      });
    }

    await client.query("BEGIN");

    // ====== NEW: Check for duplicate (same part_code + production_date) ======
    if (!skip_duplicate_check) {
      const duplicateCheck = await client.query(`
        SELECT id, part_code, TO_CHAR(production_date, 'YYYY-MM-DD') as production_date, status, data_from
        FROM qc_checks
        WHERE part_code = $1 
          AND DATE(production_date) = DATE($2::date)
          AND is_active = true
        LIMIT 1
      `, [part_code, production_date]);

      if (duplicateCheck.rows.length > 0) {
        await client.query("ROLLBACK");
        console.log("[POST QC Check] Duplicate found:", duplicateCheck.rows[0]);
        return res.status(200).json({
          success: true,
          message: "QC Check already exists for this part and date",
          data: duplicateCheck.rows[0],
          alreadyExists: true,
        });
      }
    }

    // Resolve approved_by to employee ID (jika ada)
    const approvedById = await resolveEmployeeId(client, approved_by);

    // Determine status based on data_from
    // - "Create" dari AddQCCheckPage = langsung Complete
    // - "Sample" dari LocalSchedulePage = status bisa "Pending" atau langsung "Complete"
    const initialStatus = data_from === "Sample" ? "Pending" : "Complete";

    const insertQuery = `
      INSERT INTO qc_checks (
        part_code,
        part_name,
        vendor_name,
        vendor_id,
        vendor_type,
        production_date,
        approved_by,
        approved_by_name,
        approved_at,
        data_from,
        local_schedule_part_id,
        created_by,
        status,
        created_at,
        updated_at,
        is_active
      ) VALUES (
        $1, $2, $3, $4, $5, $6::date, $7, $8, 
        ${data_from === "Create" ? "CURRENT_TIMESTAMP" : "NULL"},
        $9, $10, $11, $12, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, true
      )
      RETURNING 
        id,
        part_code,
        part_name,
        vendor_name,
        vendor_id,
        vendor_type,
        TO_CHAR(production_date, 'YYYY-MM-DD') as production_date,
        approved_by,
        approved_by_name,
        approved_at,
        data_from,
        local_schedule_part_id,
        created_by,
        status,
        created_at
    `;

    const values = [
      part_code,
      part_name || null,
      vendor_name || null,
      vendor_id || null,
      vendor_type || null,
      production_date,
      approvedById,
      approved_by || null, // Store name directly for display
      data_from || "Create",
      local_schedule_part_id || null, // NEW
      created_by || approved_by || null, // NEW
      initialStatus,
    ];

    const result = await client.query(insertQuery, values);

    await client.query("COMMIT");

    console.log("[POST QC Check] Successfully created:", result.rows[0]);

    res.status(201).json({
      success: true,
      message: "QC Check created successfully",
      data: result.rows[0],
      alreadyExists: false,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[POST QC Check] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create QC check",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== GET all QC Checks (for Complete tab & IQC Progress check) ======
router.get("/", async (req, res) => {
  try {
    const { status, date_from, date_to, part_code, data_from, vendor_id } = req.query;

    console.log("[GET QC Checks] Query params:", req.query);

    let query = `
      SELECT 
        qc.id,
        qc.part_code,
        qc.part_name,
        qc.vendor_name,
        qc.vendor_id,
        qc.vendor_type,
        TO_CHAR(qc.production_date, 'YYYY-MM-DD') as production_date,
        qc.approved_by,
        qc.approved_by_name,
        qc.approved_at,
        qc.rejected_by,
        qc.rejected_by_name,
        qc.rejected_at,
        qc.data_from,
        qc.local_schedule_part_id,
        qc.created_by,
        qc.status,
        qc.qc_status,
        qc.remark,
        qc.created_at,
        qc.updated_at,
        e.emp_name as approved_by_emp_name
      FROM qc_checks qc
      LEFT JOIN employees e ON e.id = qc.approved_by
      WHERE qc.is_active = true
    `;

    const params = [];
    let paramCount = 0;

    // Filter by status
    if (status) {
      paramCount++;
      query += ` AND qc.status = $${paramCount}`;
      params.push(status);
    }

    // Filter by date range
    if (date_from) {
      paramCount++;
      query += ` AND qc.production_date >= $${paramCount}::date`;
      params.push(date_from);
    }

    if (date_to) {
      paramCount++;
      query += ` AND qc.production_date <= $${paramCount}::date`;
      params.push(date_to);
    }

    // Filter by part code
    if (part_code) {
      paramCount++;
      query += ` AND qc.part_code ILIKE $${paramCount}`;
      params.push(`%${part_code}%`);
    }

    // Filter by data_from
    if (data_from) {
      paramCount++;
      query += ` AND qc.data_from = $${paramCount}`;
      params.push(data_from);
    }

    // Filter by vendor_id (NEW)
    if (vendor_id) {
      paramCount++;
      query += ` AND qc.vendor_id = $${paramCount}`;
      params.push(vendor_id);
    }

    query += ` ORDER BY qc.created_at DESC, qc.production_date DESC`;

    console.log("[GET QC Checks] Executing query:", query);

    const result = await pool.query(query, params);

    console.log(`[GET QC Checks] Found ${result.rows.length} records`);

    // Format the response to use approved_by_name for display
    const formattedData = result.rows.map((row) => ({
      ...row,
      approved_by: row.approved_by_name || row.approved_by_emp_name || "Unknown",
    }));

    res.json({
      success: true,
      data: formattedData,
      total: formattedData.length,
    });
  } catch (error) {
    console.error("[GET QC Checks] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch QC checks",
      error: error.message,
    });
  }
});

// ====== GET QC Checks for Current Check tab (Pending status from Sample) ======
router.get("/current-check", async (req, res) => {
  try {
    console.log("[GET Current Check] Fetching pending samples...");

    const query = `
      SELECT 
        qc.id,
        qc.part_code,
        qc.part_name,
        qc.vendor_name,
        qc.vendor_id,
        qc.vendor_type,
        TO_CHAR(qc.production_date, 'YYYY-MM-DD') as production_date,
        qc.approved_by,
        qc.approved_by_name,
        qc.approved_at,
        qc.data_from,
        qc.local_schedule_part_id,
        qc.created_by,
        qc.status,
        qc.remark,
        qc.created_at,
        qc.updated_at
      FROM qc_checks qc
      WHERE qc.is_active = true
        AND qc.status = 'Pending'
      ORDER BY qc.created_at DESC
    `;

    const result = await pool.query(query);

    console.log(`[GET Current Check] Found ${result.rows.length} pending items`);

    res.json({
      success: true,
      data: result.rows,
      total: result.rows.length,
    });
  } catch (error) {
    console.error("[GET Current Check] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch current check items",
      error: error.message,
    });
  }
});

// ====== APPROVE/COMPLETE QC Check (untuk Current Check tab) ======
router.put("/:id/approve", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { approved_by, approved_by_name } = req.body || {};

    console.log(`[APPROVE QC Check] Approving ID: ${id} by ${approved_by_name || approved_by}`);

    await client.query("BEGIN");

    // Check if exists
    const checkQuery = `
      SELECT id, status FROM qc_checks WHERE id = $1 AND is_active = true
    `;
    const checkResult = await client.query(checkQuery, [id]);

    if (checkResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "QC Check not found",
      });
    }

    // Resolve approved_by to employee ID
    const approvedById = await resolveEmployeeId(client, approved_by_name || approved_by);

    const updateQuery = `
      UPDATE qc_checks
      SET 
        status = 'Complete',
        data_from = 'Check',
        approved_by = $1,
        approved_by_name = $2,
        approved_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING 
        id,
        part_code,
        part_name,
        TO_CHAR(production_date, 'YYYY-MM-DD') as production_date,
        approved_by,
        approved_by_name,
        approved_at,
        status,
        data_from
    `;

    const result = await client.query(updateQuery, [
      approvedById,
      approved_by_name || approved_by || null,
      id,
    ]);

    await client.query("COMMIT");

    console.log(`[APPROVE QC Check] Successfully approved ID: ${id}`);

    res.json({
      success: true,
      message: "QC Check approved successfully",
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[APPROVE QC Check] Error:", error);
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
    const { rejected_by, rejected_by_name } = req.body || {};

    console.log(`[REJECT QC Check] Rejecting ID: ${id} by ${rejected_by_name || rejected_by}`);

    await client.query("BEGIN");

    // Check if exists
    const checkQuery = `
      SELECT id, status FROM qc_checks WHERE id = $1 AND is_active = true
    `;
    const checkResult = await client.query(checkQuery, [id]);

    if (checkResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "QC Check not found",
      });
    }

    // Resolve rejected_by to employee ID
    const rejectedById = await resolveEmployeeId(client, rejected_by_name || rejected_by);

    const updateQuery = `
      UPDATE qc_checks
      SET 
        status = 'Reject',
        rejected_by = $1,
        rejected_by_name = $2,
        rejected_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING 
        id,
        part_code,
        part_name,
        TO_CHAR(production_date, 'YYYY-MM-DD') as production_date,
        rejected_by,
        rejected_by_name,
        rejected_at,
        status
    `;

    const result = await client.query(updateQuery, [
      rejectedById,
      rejected_by_name || rejected_by || null,
      id,
    ]);

    await client.query("COMMIT");

    console.log(`[REJECT QC Check] Successfully rejected ID: ${id}`);

    res.json({
      success: true,
      message: "QC Check rejected successfully",
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[REJECT QC Check] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to reject QC check",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== UPDATE QC STATUS (for editing status in Current Check) ======
router.put("/:id/update-status", async (req, res) => {
  try {
    const { id } = req.params;
    const { qc_status } = req.body || {};

    console.log(`[UPDATE QC STATUS] Updating ID: ${id} to status: ${qc_status}`);

    const updateQuery = `
      UPDATE qc_checks
      SET 
        qc_status = $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND is_active = true
      RETURNING 
        id,
        part_code,
        part_name,
        qc_status,
        status
    `;

    const result = await pool.query(updateQuery, [qc_status || null, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "QC Check not found",
      });
    }

    console.log(`[UPDATE QC STATUS] Successfully updated ID: ${id}`);

    res.json({
      success: true,
      message: "QC status updated successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("[UPDATE QC STATUS] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update QC status",
      error: error.message,
    });
  }
});

// ====== BULK APPROVE QC Checks ======
router.post("/bulk-approve", async (req, res) => {
  const client = await pool.connect();
  try {
    const { ids, approved_by, approved_by_name } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid request: 'ids' must be a non-empty array",
      });
    }

    console.log(`[BULK APPROVE] Approving ${ids.length} items by ${approved_by_name || approved_by}`);

    await client.query("BEGIN");

    // Resolve approved_by to employee ID
    const approvedById = await resolveEmployeeId(client, approved_by_name || approved_by);

    const updateQuery = `
      UPDATE qc_checks
      SET 
        status = 'Complete',
        data_from = 'Check',
        approved_by = $1,
        approved_by_name = $2,
        approved_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ANY($3::int[])
        AND is_active = true
      RETURNING id
    `;

    const result = await client.query(updateQuery, [
      approvedById,
      approved_by_name || approved_by || null,
      ids,
    ]);

    await client.query("COMMIT");

    console.log(`[BULK APPROVE] Successfully approved ${result.rows.length} items`);

    res.json({
      success: true,
      message: `${result.rows.length} QC Checks approved successfully`,
      approvedCount: result.rows.length,
      approvedIds: result.rows.map(r => r.id),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[BULK APPROVE] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to bulk approve QC checks",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== GET single QC Check by ID ======
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const query = `
      SELECT 
        qc.id,
        qc.part_code,
        qc.part_name,
        qc.vendor_name,
        qc.vendor_id,
        qc.vendor_type,
        TO_CHAR(qc.production_date, 'YYYY-MM-DD') as production_date,
        qc.approved_by,
        qc.approved_by_name,
        qc.approved_at,
        qc.data_from,
        qc.local_schedule_part_id,
        qc.created_by,
        qc.status,
        qc.remark,
        qc.created_at,
        qc.updated_at,
        e.emp_name as approved_by_emp_name
      FROM qc_checks qc
      LEFT JOIN employees e ON e.id = qc.approved_by
      WHERE qc.id = $1 AND qc.is_active = true
    `;

    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "QC Check not found",
      });
    }

    const row = result.rows[0];
    res.json({
      success: true,
      data: {
        ...row,
        approved_by: row.approved_by_name || row.approved_by_emp_name || "Unknown",
      },
    });
  } catch (error) {
    console.error("[GET QC Check by ID] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch QC check",
      error: error.message,
    });
  }
});

// ====== DELETE QC Check ======
router.delete("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    console.log(`[DELETE QC Check] Deleting ID: ${id}`);

    await client.query("BEGIN");

    // Check if exists
    const checkQuery = `
      SELECT id FROM qc_checks WHERE id = $1 AND is_active = true
    `;
    const checkResult = await client.query(checkQuery, [id]);

    if (checkResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "QC Check not found or already deleted",
      });
    }

    // Soft delete (set is_active to false)
    const deleteQuery = `
      UPDATE qc_checks
      SET is_active = false, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id
    `;

    const result = await client.query(deleteQuery, [id]);

    await client.query("COMMIT");

    console.log(`[DELETE QC Check] Successfully deleted ID: ${id}`);

    res.json({
      success: true,
      message: "QC Check deleted successfully",
      data: { deletedId: result.rows[0].id },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[DELETE QC Check] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete QC check",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== UPDATE QC Check ======
router.put("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const {
      part_code,
      part_name,
      vendor_name,
      vendor_id,
      vendor_type,
      production_date,
      status,
      remark,
    } = req.body || {};

    console.log(`[PUT QC Check] Updating ID: ${id}`, req.body);

    await client.query("BEGIN");

    // Check if exists
    const checkQuery = `
      SELECT id FROM qc_checks WHERE id = $1 AND is_active = true
    `;
    const checkResult = await client.query(checkQuery, [id]);

    if (checkResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "QC Check not found",
      });
    }

    const updateQuery = `
      UPDATE qc_checks
      SET 
        part_code = COALESCE($1, part_code),
        part_name = COALESCE($2, part_name),
        vendor_name = COALESCE($3, vendor_name),
        vendor_id = COALESCE($4, vendor_id),
        vendor_type = COALESCE($5, vendor_type),
        production_date = COALESCE($6::date, production_date),
        status = COALESCE($7, status),
        remark = COALESCE($8, remark),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $9
      RETURNING 
        id,
        part_code,
        part_name,
        vendor_name,
        vendor_id,
        vendor_type,
        TO_CHAR(production_date, 'YYYY-MM-DD') as production_date,
        approved_by,
        approved_by_name,
        approved_at,
        data_from,
        local_schedule_part_id,
        created_by,
        status,
        remark,
        updated_at
    `;

    const values = [
      part_code,
      part_name,
      vendor_name,
      vendor_id,
      vendor_type,
      production_date,
      status,
      remark,
      id,
    ];

    const result = await client.query(updateQuery, values);

    await client.query("COMMIT");

    console.log(`[PUT QC Check] Successfully updated ID: ${id}`);

    res.json({
      success: true,
      message: "QC Check updated successfully",
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[PUT QC Check] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update QC check",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

module.exports = router;