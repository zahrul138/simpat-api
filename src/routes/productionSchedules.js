// routes/productionSchedules.js
const express = require("express");
const router = express.Router();
const pool = require("../db");



// ===== Helper =====
const toStartOfDay = (val) => {
  const d = new Date(val);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

const sanitizePalletType = (val) => {
  const s = String(val || "").toLowerCase();
  if (s.includes("w")) return "W";
  return "R";
};

const toPalletLabel = (abbr) => (abbr === "W" ? "Pallet W" : "Pallet R");

const resolveCustomerId = async (client, payload) => {
  // prioritas: customerId langsung, fallback: customerName
  if (payload.customerId) return payload.customerId;
  if (!payload.customerName) {
    console.error("Missing customerName in payload:", payload);
    return null;
  }

  try {
    const { rows } = await client.query(
      `SELECT id FROM public.customers WHERE LOWER(cust_name) = LOWER($1) AND is_active = true LIMIT 1`,
      [payload.customerName.trim()]
    );

    if (!rows[0]) {
      console.error(`Customer not found: ${payload.customerName}`);
      return null;
    }

    return rows[0].id;
  } catch (err) {
    console.error("Error resolving customer:", err);
    return null;
  }
};

// SEKARANG: Tidak perlu resolvePartId, langsung gunakan materialCode
const resolveMaterialCode = async (client, payload) => {
  console.log(
    `[resolveMaterialCode] Using materialCode directly: ${payload.materialCode}`
  );
  return payload.materialCode;
};

// ===== CREATE: Header + Details (sekali tembak) =====
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      lineCode,
      shiftTime,
      targetDate, // "YYYY-MM-DD"
      createdBy,
      details, // array of items (customerName/materialCode atau customerId/partId)
    } = req.body || {};

    console.log("Received POST /api/production-schedules:", {
      lineCode,
      shiftTime,
      targetDate,
      createdBy,
      detailsCount: details?.length,
    });

    // 1) Validasi basic payload
    if (!lineCode || !shiftTime || !targetDate || !Array.isArray(details)) {
      return res.status(400).json({
        message: "Payload kurang lengkap.",
        required: ["lineCode", "shiftTime", "targetDate", "details"],
        received: {
          lineCode,
          shiftTime,
          targetDate,
          details: Array.isArray(details) ? details.length : "not array",
        },
      });
    }

    if (details.length === 0) {
      return res.status(400).json({ message: "Details tidak boleh kosong." });
    }

    const today = toStartOfDay(new Date());
    const td = toStartOfDay(targetDate);
    if (!td) {
      return res.status(400).json({
        message: "Format Target Date tidak valid.",
        received: targetDate,
      });
    }

    // if (td <= today) {
    //   return res.status(400).json({
    //     message: "Target Date harus lebih besar dari Request Date (hari ini).",
    //     targetDate: targetDate,
    //     today: today.toISOString().split("T")[0],
    //   });
    // }

    const dupCheck = await client.query(
      `SELECT id, prod_schedule_code
       FROM public.production_schedules
       WHERE line_code   = $1
         AND shift_time  = $2
         AND target_date = $3::date
         AND is_active   = true
       LIMIT 1`,
      [lineCode, shiftTime, targetDate]
    );

    if (dupCheck.rowCount > 0) {
      return res.status(400).json({
        message: `Sudah ada schedule untuk Line ${lineCode}, Shift ${shiftTime} pada ${targetDate}.`,
        existingCode: dupCheck.rows[0].prod_schedule_code,
      });
    }

    // 4) Transaksi insert header + details
    await client.query("BEGIN");

    // Insert header
    const insertHeader = await client.query(
      `INSERT INTO public.production_schedules
         (line_code, shift_time, target_date, status, created_by)
       VALUES ($1, $2, $3::date, 'New', $4)
       RETURNING id, prod_schedule_code, created_at`,
      [lineCode, shiftTime, targetDate, createdBy ?? null]
    );

    const scheduleId = insertHeader.rows[0].id;
    const scheduleCode = insertHeader.rows[0].prod_schedule_code;

    console.log(`Created schedule header: ${scheduleCode} (ID: ${scheduleId})`);

    // 4a) Resolve customer_id & material_code untuk tiap detail
    const resolved = [];
    const unmapped = [];

    for (let i = 0; i < details.length; i++) {
      const d = details[i] || {};
      console.log(`Processing detail ${i + 1}:`, {
        customerName: d.customerName,
        materialCode: d.materialCode,
        inputQuantity: d.inputQuantity,
      });

      const customerId = await resolveCustomerId(client, d);
      const materialCode = await resolveMaterialCode(client, d);

      console.log(
        `Resolved - Customer ID: ${customerId}, Material Code: ${materialCode}`
      );

      // pallet type "Pallet R/W" atau "R/W" kita jadikan "R"/"W"
      const palletType = sanitizePalletType(d.palletType);

      // build PO number (string kosong -> null)
      const poRaw =
        typeof d.poNumber === "string" ? d.poNumber.trim() : d.poNumber;
      const poValue = poRaw === "" ? null : poRaw;

      resolved.push({
        production_schedule_id: scheduleId,
        customer_id: customerId,
        material_code: materialCode, // GANTI: part_id -> material_code
        input_quantity: Number(d.inputQuantity ?? d.input ?? 0) || 0,
        pallet_type: palletType,
        is_auto_split: Boolean(d.isAutoSplit ?? false),
        original_input: d.originalInput ?? null,
        sequence_number: Number(d.sequenceNumber ?? i + 1) || i + 1,
        po_number: poValue,
        pallet_status: d.palletStatus || "Pending",
        model: d.model || "Veronicas",
        description: d.description || "",
        _src: {
          idx: i,
          customerName: d.customerName,
          materialCode: d.materialCode,
          model: d.model,
          description: d.description,
        },
      });

      // HANYA check customer_id, material_code selalu ada
      if (!customerId) {
        unmapped.push({
          index: i + 1,
          need: "customer",
          customerName: d.customerName ?? null,
          materialCode: d.materialCode ?? null,
          customerIdResolved: !!customerId,
          materialCodeResolved: true, // SELALU true sekarang
        });
      }
    }

    if (unmapped.length > 0) {
      await client.query("ROLLBACK");
      console.error("Unmapped references:", unmapped);
      return res.status(400).json({
        message: "Data customer tidak valid.",
        detail: unmapped,
        suggestion: "Pastikan customer name ada di database dan status aktif",
      });
    }

    // 4b) Insert details satu per satu (LEBIH AMAN - menghindari parameter mismatch)
    const detailIds = [];
    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i];
      try {
        const detailResult = await client.query(
          `INSERT INTO public.production_schedule_details (
            production_schedule_id, customer_id, material_code, input_quantity, 
            pallet_type, is_auto_split, original_input, sequence_number, 
            po_number, pallet_status, model, description
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
          RETURNING id`,
          [
            r.production_schedule_id,
            r.customer_id,
            r.material_code,
            r.input_quantity,
            r.pallet_type,
            r.is_auto_split,
            r.original_input,
            r.sequence_number,
            r.po_number,
            r.pallet_status,
            r.model,
            r.description,
          ]
        );
        detailIds.push(detailResult.rows[0].id);
        console.log(
          `Inserted detail ${i + 1} with ID: ${detailResult.rows[0].id}`
        );
      } catch (err) {
        console.error(`Error inserting detail ${i + 1}:`, err);
        throw err;
      }
    }

    console.log(`Successfully inserted ${detailIds.length} detail records`);

    // 5) Hitung & update total pada header
    const sumRes = await client.query(
      `SELECT
        COALESCE(SUM(input_quantity), 0) AS total_input,
        COALESCE(COUNT(DISTINCT customer_id), 0) AS total_customer,
        COALESCE(COUNT(DISTINCT material_code), 0) AS total_model,
        COALESCE(COUNT(*), 0) AS total_pallet
      FROM public.production_schedule_details
      WHERE production_schedule_id = $1`,
      [scheduleId]
    );

    const t = sumRes.rows[0];
    await client.query(
      `UPDATE public.production_schedules
        SET total_input = $1,
            total_customer = $2,
            total_model = $3,
            total_pallet = $4,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $5`,
      [
        t.total_input,
        t.total_customer,
        t.total_model,
        t.total_pallet,
        scheduleId,
      ]
    );

    await client.query("COMMIT");

    console.log(`Successfully created production schedule: ${scheduleCode}`);

    return res.status(201).json({
      id: scheduleId,
      code: scheduleCode,
      lineCode,
      shiftTime,
      targetDate,
      totals: {
        input: Number(t.total_input),
        customer: Number(t.total_customer),
        model: Number(t.total_model),
        pallet: Number(t.total_pallet),
      },
      detailsCount: details.length,
      message: "Production schedule berhasil dibuat beserta details-nya.",
    });
  } catch (err) {
    // rollback ke client yang sama
    try {
      await client.query("ROLLBACK");
      console.log("Transaction rolled back due to error");
    } catch (rollbackErr) {
      console.error("Rollback error:", rollbackErr);
    }

    console.error("ERR /api/production-schedules POST:", {
      code: err.code,
      message: err.message,
      detail: err.detail,
      stack: err.stack,
    });

    // Error handling yang lebih spesifik
    if (err.code === "23505") {
      return res.status(409).json({
        message:
          "Schedule untuk Line+Shift+Tanggal tersebut sudah ada (aktif).",
        detail: err.detail,
      });
    }

    if (err.code === "23502") {
      return res.status(400).json({
        message: "Data required tidak lengkap.",
        detail: err.detail,
      });
    }

    if (err.code === "23503") {
      return res.status(400).json({
        message: "Data relasi tidak valid (cek kembali customer_id).",
        detail: err.detail,
      });
    }

    if (err.code === "22P02") {
      return res.status(400).json({
        message: "Format data tidak valid (cek tanggal/angka).",
        detail: err.detail,
      });
    }

    // Generic error
    return res.status(500).json({
      message: "Server error.",
      error:
        process.env.NODE_ENV === "development"
          ? err.message
          : "Internal server error",
    });
  } finally {
    client.release();
  }
});

// ===== READ: List header (filter + paging + search) =====
router.get("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      status,
      dateFrom,
      dateTo,
      q,
      page = "1",
      limit = "20",
      includeInactive,
    } = req.query || {};

    const pg = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
    const off = (pg - 1) * lim;

    const wh = [];
    const params = [];

    if (!includeInactive) {
      params.push(true);
      wh.push(`ps.is_active = $${params.length}`);
    }

    if (
      status &&
      ["New", "OnProgress", "Complete", "Reject"].includes(status)
    ) {
      params.push(status);
      wh.push(`ps.status = $${params.length}`);
    }

    if (dateFrom) {
      params.push(dateFrom);
      wh.push(`ps.target_date >= $${params.length}::date`);
    }
    if (dateTo) {
      params.push(dateTo);
      wh.push(`ps.target_date <= $${params.length}::date`);
    }

    // untuk search ke detail: join ringan
    let searchJoin = "";
    if (q && q.trim() !== "") {
      searchJoin = `
        LEFT JOIN public.production_schedule_details d ON d.production_schedule_id = ps.id
        LEFT JOIN public.customers c ON c.id = d.customer_id
      `;
      params.push(`%${q.trim()}%`);
      const idx = params.length;
      wh.push(`(
        c.cust_name ILIKE $${idx}
        OR d.material_code ILIKE $${idx}
        OR d.po_number ILIKE $${idx}
      )`);
    }

    const whereSql = wh.length ? `WHERE ${wh.join(" AND ")}` : "";

    // COUNT total
    const countSql = `
      SELECT COUNT(DISTINCT ps.id) AS total
      FROM public.production_schedules ps
      ${searchJoin}
      ${whereSql}
    `;
    const countRes = await client.query(countSql, params);
    const totalRows = Number(countRes.rows[0]?.total || 0);

    const dataSql = `
      SELECT DISTINCT
        ps.id,
        ps.prod_schedule_code,
        ps.line_code,
        ps.shift_time,
        ps.target_date,
        ps.status,
        COALESCE(ps.total_input,0) AS total_input,
        COALESCE(ps.total_customer,0) AS total_customer,
        COALESCE(ps.total_model,0) AS total_model,
        COALESCE(ps.total_pallet,0) AS total_pallet,
        ps.created_by,
        ps.created_at,
        CASE 
          WHEN e.emp_name IS NOT NULL THEN 
            e.emp_name || ' | ' || TO_CHAR(ps.created_at, 'YYYY-MM-DD HH24:MI')
          ELSE 
            'User-' || COALESCE(ps.created_by::text, 'System') || ' | ' || TO_CHAR(ps.created_at, 'YYYY-MM-DD HH24:MI')
        END AS created_by_name
      FROM public.production_schedules ps
      LEFT JOIN public.employees e ON e.id = ps.created_by::int
      ${searchJoin}
      ${whereSql}
      ORDER BY ps.target_date ASC, ps.created_at DESC
      LIMIT ${lim} OFFSET ${off}
    `;
    const dataRes = await client.query(dataSql, params);

    // Fungsi untuk memformat tanggal ke YYYY-MM-DD
    const formatToYYYYMMDD = (dateString) => {
      if (!dateString) return null;
      
      try {
        let dateObj;
        
        // Jika tanggal sudah mengandung T (ISO format)
        if (dateString.includes('T')) {
          dateObj = new Date(dateString);
        } else {
          // Jika hanya YYYY-MM-DD
          dateObj = new Date(dateString + 'T00:00:00');
        }
        
        // Validasi tanggal
        if (isNaN(dateObj.getTime())) {
          console.warn('Invalid date string:', dateString);
          return dateString;
        }
        
        // Format ke YYYY-MM-DD
        const year = dateObj.getFullYear();
        const month = String(dateObj.getMonth() + 1).padStart(2, '0');
        const day = String(dateObj.getDate()).padStart(2, '0');
        
        return `${year}-${month}-${day}`;
      } catch (error) {
        console.error('Error formatting date:', error.message);
        return dateString;
      }
    };

    // Map hasil query dan tambahkan target_date_display
    const items = dataRes.rows.map((r) => {
      const formattedDate = formatToYYYYMMDD(r.target_date);
      
      return {
        id: r.id,
        code: r.prod_schedule_code,
        line_code: r.line_code,
        shift_time: r.shift_time,
        target_date: r.target_date,
        target_date_display: formattedDate, // TAMBAHKAN INI
        status: r.status,
        total_input: Number(r.total_input || 0),
        total_customer: Number(r.total_customer || 0),
        total_model: Number(r.total_model || 0),
        total_pallet: Number(r.total_pallet || 0),
        created_by: r.created_by,
        created_by_name:
          r.created_by_name ||
          `${r.created_by} | ${new Date(r.created_at).toLocaleString("id-ID")}`,
        created_at: r.created_at,
      };
    });

    return res.json({
      page: pg,
      limit: lim,
      total: totalRows,
      items: items,
    });
  } catch (err) {
    console.error("ERR GET /api/production-schedules", err.message);
    return res.status(500).json({ message: "Server error." });
  } finally {
    client.release();
  }
});

// ===== READ: Detail per header =====
router.get("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id || 0);
    if (!id) return res.status(400).json({ message: "Invalid id." });

    const hdrRes = await client.query(
      `SELECT
        ps.id,
        ps.prod_schedule_code,
        ps.line_code,
        ps.shift_time,
        ps.target_date,
        ps.status,
        COALESCE(ps.total_input,0) AS total_input,
        COALESCE(ps.total_customer,0) AS total_customer,
        COALESCE(ps.total_model,0) AS total_model,
        COALESCE(ps.total_pallet,0) AS total_pallet,
        ps.created_by,
        ps.created_at,
        CASE 
          WHEN e.emp_name IS NOT NULL THEN 
            e.emp_name || ' | ' || TO_CHAR(ps.created_at, 'YYYY-MM-DD HH24:MI')
          ELSE 
            'User-' || COALESCE(ps.created_by::text, 'System') || ' | ' || TO_CHAR(ps.created_at, 'YYYY-MM-DD HH24:MI')
        END AS created_by_name
      FROM public.production_schedules ps
      LEFT JOIN public.employees e ON e.id = ps.created_by::int
      WHERE ps.id = $1
      LIMIT 1`,
      [id]
    );

    if (hdrRes.rowCount === 0) {
      return res.status(404).json({ message: "Schedule tidak ditemukan." });
    }

    const detRes = await client.query(
      `SELECT
        d.id,
        d.input_quantity,
        d.pallet_type,
        d.po_number,
        d.pallet_status,
        d.sequence_number,
        d.status,
        c.cust_name,
        d.material_code,
        COALESCE(d.model, 'Veronicas') AS model,
        COALESCE(d.description, '') AS description
      FROM public.production_schedule_details d
      LEFT JOIN public.customers c ON c.id = d.customer_id
      WHERE d.production_schedule_id = $1
      ORDER BY d.sequence_number ASC, d.id ASC`,
      [id]
    );

    const header = hdrRes.rows[0];
    const details = detRes.rows.map((r) => ({
      id: r.id,
      material_code: r.material_code || null,
      customer: r.cust_name || null,
      model: r.model || "Veronicas",
      description: r.description || "",
      input: Number(r.input_quantity || 0),
      po_number: r.po_number || null,
      pallet_type: toPalletLabel(r.pallet_type),
      pallet_use: 1,
      pallet_status: r.pallet_status || "Pending",
      sequence_number: r.sequence_number || 1,
      status: r.status || "New",
    }));

    // Fungsi untuk memformat tanggal ke YYYY-MM-DD
    const formatToYYYYMMDD = (dateString) => {
      if (!dateString) return null;
      
      try {
        let dateObj;
        
        if (dateString.includes('T')) {
          dateObj = new Date(dateString);
        } else {
          dateObj = new Date(dateString + 'T00:00:00');
        }
        
        if (isNaN(dateObj.getTime())) {
          console.warn('Invalid date string:', dateString);
          return dateString;
        }
        
        const year = dateObj.getFullYear();
        const month = String(dateObj.getMonth() + 1).padStart(2, '0');
        const day = String(dateObj.getDate()).padStart(2, '0');
        
        return `${year}-${month}-${day}`;
      } catch (error) {
        console.error('Error formatting date:', error.message);
        return dateString;
      }
    };

    // Format tanggal untuk header
    const formattedDate = formatToYYYYMMDD(header.target_date);

    return res.json({
      header: {
        id: header.id,
        code: header.prod_schedule_code,
        line_code: header.line_code,
        shift_time: header.shift_time,
        target_date: header.target_date,
        target_date_display: formattedDate, // TAMBAHKAN INI
        status: header.status,
        total_input: Number(header.total_input || 0),
        total_customer: Number(header.total_customer || 0),
        total_model: Number(header.total_model || 0),
        total_pallet: Number(header.total_pallet || 0),
        created_by: header.created_by,
        created_by_name:
          header.created_by_name ||
          `${header.created_by} | ${new Date(header.created_at).toLocaleString(
            "id-ID"
          )}`,
        created_at: header.created_at,
      },
      details,
    });
  } catch (err) {
    console.error("ERR GET /api/production-schedules/:id", err.message);
    return res.status(500).json({ message: "Server error." });
  } finally {
    client.release();
  }
});

router.patch("/:id/status", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id || 0);
    const { status } = req.body || {};

    if (!id) {
      return res.status(400).json({ message: "Invalid id." });
    }

    if (!["New", "OnProgress", "Complete", "Reject"].includes(status)) {
      return res.status(400).json({
        message:
          "Status harus salah satu dari: New, OnProgress, Complete, Reject",
      });
    }

    const result = await client.query(
      `UPDATE public.production_schedules 
       SET status = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 AND is_active = true
       RETURNING id, prod_schedule_code, status`,
      [status, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Schedule tidak ditemukan." });
    }

    return res.json({
      message: "Status berhasil diupdate",
      data: result.rows[0],
    });
  } catch (err) {
    console.error(
      "ERR PATCH /api/production-schedules/:id/status",
      err.message
    );
    return res.status(500).json({ message: "Server error." });
  } finally {
    client.release();
  }
});

// ===== DELETE: Permanent delete schedule =====
router.delete("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id || 0);
    if (!id) {
      return res.status(400).json({ message: "Invalid id." });
    }

    console.log(
      `[DELETE /api/production-schedules/${id}] Permanent delete requested`
    );

    await client.query("BEGIN");

    // 1. Hapus details terlebih dahulu (karena foreign key constraint)
    const deleteDetails = await client.query(
      `DELETE FROM public.production_schedule_details 
       WHERE production_schedule_id = $1 
       RETURNING id`,
      [id]
    );

    console.log(`Deleted ${deleteDetails.rowCount} detail records`);

    // 2. Hapus header
    const deleteHeader = await client.query(
      `DELETE FROM public.production_schedules 
       WHERE id = $1 
       RETURNING id, prod_schedule_code, line_code, shift_time, target_date`,
      [id]
    );

    if (deleteHeader.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Schedule tidak ditemukan." });
    }

    await client.query("COMMIT");

    const deletedSchedule = deleteHeader.rows[0];

    console.log(
      `[DELETE /api/production-schedules/${id}] Successfully deleted: ${deletedSchedule.prod_schedule_code}`
    );

    return res.json({
      success: true,
      message: "Schedule berhasil dihapus secara permanen",
      deletedSchedule: {
        id: deletedSchedule.id,
        code: deletedSchedule.prod_schedule_code,
        line: deletedSchedule.line_code,
        shift: deletedSchedule.shift_time,
        date: deletedSchedule.target_date,
      },
      deletedDetailsCount: deleteDetails.rowCount,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`[DELETE /api/production-schedules/${id}] Error:`, err);

    // Handle foreign key constraint error
    if (err.code === "23503") {
      return res.status(400).json({
        success: false,
        message:
          "Tidak dapat menghapus schedule. Data masih terkait dengan tabel lain.",
        error: "Foreign key constraint violation",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Gagal menghapus schedule",
      error: err.message,
    });
  } finally {
    client.release();
  }
});

// DELETE detail individual - PASTIKAN ROUTE INI ADA
router.delete("/details/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id || 0);
    if (!id) {
      return res.status(400).json({ message: "Invalid detail id." });
    }

    await client.query("BEGIN");

    // Dapatkan schedule_id sebelum menghapus
    const getDetail = await client.query(
      `SELECT production_schedule_id FROM public.production_schedule_details WHERE id = $1`,
      [id]
    );

    if (getDetail.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Detail tidak ditemukan." });
    }

    const scheduleId = getDetail.rows[0].production_schedule_id;

    // Hapus detail
    const deleteResult = await client.query(
      `DELETE FROM public.production_schedule_details WHERE id = $1 RETURNING id`,
      [id]
    );

    // Update totals di header
    const sumRes = await client.query(
      `SELECT
        COALESCE(SUM(input_quantity), 0) AS total_input,
        COALESCE(COUNT(DISTINCT customer_id), 0) AS total_customer,
        COALESCE(COUNT(DISTINCT material_code), 0) AS total_model,
        COALESCE(COUNT(*), 0) AS total_pallet
      FROM public.production_schedule_details
      WHERE production_schedule_id = $1`,
      [scheduleId]
    );

    const t = sumRes.rows[0];
    await client.query(
      `UPDATE public.production_schedules
        SET total_input = $1,
            total_customer = $2,
            total_model = $3,
            total_pallet = $4,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $5`,
      [
        t.total_input,
        t.total_customer,
        t.total_model,
        t.total_pallet,
        scheduleId,
      ]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Detail berhasil dihapus",
      deletedDetailId: id,
      scheduleId: scheduleId,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("ERR DELETE /api/production-schedules/details/:id", err);
    res.status(500).json({
      success: false,
      message: "Gagal menghapus detail",
      error: err.message,
    });
  } finally {
    client.release();
  }
});

router.patch("/auto-progress", async (req, res) => {
  const client = await pool.connect();
  try {
    const now = new Date();
    const currentTime = now.toTimeString().slice(0, 5); // HH:MM
    const currentDate = now.toISOString().split("T")[0];

    console.log(
      `[AUTO-PROGRESS] Checking at ${currentTime} on ${currentDate}`
    );

    const schedulesToProgress = await client.query(
      `SELECT 
        ps.id, 
        ps.shift_time,
        ps.target_date,
        SPLIT_PART(ps.shift_time, ' - ', 1) as start_time
       FROM public.production_schedules ps
       WHERE ps.status = 'New'
         AND ps.is_active = true
         AND ps.target_date = $1::date
         AND $2 >= SPLIT_PART(ps.shift_time, ' - ', 1)  -- current time >= start time
       ORDER BY ps.shift_time`,
      [currentDate, currentTime]
    );

    console.log(
      `[AUTO-PROGRESS] Found ${schedulesToProgress.rowCount} schedules to progress`
    );

    if (schedulesToProgress.rowCount === 0) {
      return res.json({
        message: "No schedules to progress at this time",
        progressed: 0,
      });
    }

    await client.query("BEGIN");

    const progressedSchedules = [];

    for (const schedule of schedulesToProgress.rows) {
      const scheduleId = schedule.id;

      await client.query(
        `UPDATE public.production_schedules 
         SET status = 'OnProgress', 
             updated_at = CURRENT_TIMESTAMP 
         WHERE id = $1`,
        [scheduleId]
      );

      await client.query(
        `UPDATE public.production_schedule_details 
         SET status = 'OnProgress', 
             updated_at = CURRENT_TIMESTAMP 
         WHERE production_schedule_id = $1`,
        [scheduleId]
      );

      progressedSchedules.push({
        id: scheduleId,
        shift_time: schedule.shift_time,
        target_date: schedule.target_date,
        start_time: schedule.start_time,
      });

      console.log(`[AUTO-PROGRESS] Progressed schedule ID: ${scheduleId}`);
    }

    await client.query("COMMIT");

    return res.json({
      message: `Successfully progressed ${progressedSchedules.length} schedules`,
      progressed: progressedSchedules.length,
      schedules: progressedSchedules,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("ERR PATCH /api/production-schedules/auto-progress", err);
    return res.status(500).json({
      message: "Server error during auto-progress",
      error: err.message,
    });
  } finally {
    client.release();
  }
});

router.patch("/details/:id/status", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id || 0);
    const { status } = req.body || {};

    if (!id) {
      return res.status(400).json({ message: "Invalid detail id." });
    }

    if (!["New", "OnProgress", "Complete", "Reject"].includes(status)) {
      return res.status(400).json({
        message:
          "Status harus salah satu dari: New, OnProgress, Complete, Reject",
      });
    }

    const result = await client.query(
      `UPDATE public.production_schedule_details 
       SET status = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2
       RETURNING id, status`,
      [status, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Detail tidak ditemukan." });
    }

    return res.json({
      message: "Detail status berhasil diupdate",
      data: result.rows[0],
    });
  } catch (err) {
    console.error(
      "ERR PATCH /api/production-schedules/details/:id/status",
      err
    );
    return res.status(500).json({ message: "Server error." });
  } finally {
    client.release();
  }
});

router.get("/:id/check-status", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id || 0);
    if (!id) return res.status(400).json({ message: "Invalid id." });

    const scheduleRes = await client.query(
      `SELECT 
        id, 
        shift_time, 
        target_date,
        status,
        SPLIT_PART(shift_time, ' - ', 1) as start_time,
        SPLIT_PART(shift_time, ' - ', 2) as end_time
       FROM public.production_schedules 
       WHERE id = $1 AND is_active = true`,
      [id]
    );

    if (scheduleRes.rowCount === 0) {
      return res.status(404).json({ message: "Schedule tidak ditemukan." });
    }

    const schedule = scheduleRes.rows[0];
    const now = new Date();
    const currentTime = now.toTimeString().slice(0, 5);

    const [startHours, startMinutes] = schedule.start_time
      .split(":")
      .map(Number);
    const [endHours, endMinutes] = schedule.end_time.split(":").map(Number);
    const [currentHours, currentMinutes] = currentTime.split(":").map(Number);

    const startTotalMinutes = startHours * 60 + startMinutes;
    const endTotalMinutes = endHours * 60 + endMinutes;
    const currentTotalMinutes = currentHours * 60 + currentMinutes;

    let shouldBeCompleted = false;
    let reason = "";

    if (endTotalMinutes > startTotalMinutes) {
      shouldBeCompleted = currentTotalMinutes >= endTotalMinutes;
      reason = shouldBeCompleted
        ? "Shift sudah selesai"
        : "Shift masih berjalan";
    } else {
      shouldBeCompleted =
        currentTotalMinutes >= endTotalMinutes &&
        currentTotalMinutes < startTotalMinutes;
      reason = shouldBeCompleted
        ? "Shift sudah selesai (melewati midnight)"
        : "Shift masih berjalan";
    }

    return res.json({
      id: schedule.id,
      shift_time: schedule.shift_time,
      status: schedule.status,
      current_time: currentTime,
      should_be_completed: shouldBeCompleted,
      reason: reason,
      time_data: {
        start_total_minutes: startTotalMinutes,
        end_total_minutes: endTotalMinutes,
        current_total_minutes: currentTotalMinutes,
      },
    });
  } catch (err) {
    console.error(
      "ERR GET /api/production-schedules/:id/check-status",
      err.message
    );
    return res.status(500).json({ message: "Server error." });
  } finally {
    client.release();
  }
});

router.patch("/auto-complete", async (req, res) => {
  const client = await pool.connect();
  try {
    const now = new Date();
    const currentHours = now.getHours();
    const currentMinutes = now.getMinutes();
    const currentSeconds = now.getSeconds();
    
    // Format waktu saat ini: HH:MM
    const currentTime = `${currentHours.toString().padStart(2, '0')}:${currentMinutes.toString().padStart(2, '0')}`;
    
    // Format tanggal hari ini: YYYY-MM-DD
    const currentDate = now.toISOString().split('T')[0];

    console.log(
      `[AUTO-COMPLETE] Checking at ${currentTime}:${currentSeconds} on ${currentDate}`
    );

    // Ambil schedule OnProgress untuk hari ini
    const schedulesToCheck = await client.query(
      `SELECT 
        ps.id, 
        ps.shift_time,
        ps.target_date,
        ps.status,
        SPLIT_PART(ps.shift_time, ' - ', 1) as start_time,
        SPLIT_PART(ps.shift_time, ' - ', 2) as end_time
       FROM public.production_schedules ps
       WHERE ps.status = 'OnProgress'
         AND ps.is_active = true
         AND ps.target_date = $1::date
       ORDER BY ps.shift_time`,
      [currentDate]
    );

    console.log(
      `[AUTO-COMPLETE] Found ${schedulesToCheck.rowCount} OnProgress schedules for today`
    );

    if (schedulesToCheck.rowCount === 0) {
      return res.json({
        message: "No OnProgress schedules found",
        completed: 0,
      });
    }

    await client.query("BEGIN");

    const completedSchedules = [];

    for (const schedule of schedulesToCheck.rows) {
      const scheduleId = schedule.id;
      const endTime = schedule.end_time;

      const endTimeWithSeconds = endTime + ":00";

      if (currentTime >= endTime) {
        console.log(`[AUTO-COMPLETE] Schedule ${scheduleId}: ${currentTime} >= ${endTime}, completing...`);
        
        await client.query(
          `UPDATE public.production_schedules 
           SET status = 'Complete', 
               updated_at = CURRENT_TIMESTAMP 
           WHERE id = $1`,
          [scheduleId]
        );

        await client.query(
          `UPDATE public.production_schedule_details 
           SET status = 'Complete', 
               updated_at = CURRENT_TIMESTAMP 
           WHERE production_schedule_id = $1`,
          [scheduleId]
        );

        completedSchedules.push({
          id: scheduleId,
          shift_time: schedule.shift_time,
          target_date: schedule.target_date,
          completed_at: now.toISOString(),
          reason: `Shift ended at ${endTime}, current time is ${currentTime}`
        });
      } else {
        console.log(`[AUTO-COMPLETE] Schedule ${scheduleId}: ${currentTime} < ${endTime}, still in progress`);
      }
    }

    await client.query("COMMIT");

    return res.json({
      message: `Auto-complete checked ${schedulesToCheck.rowCount} schedules, completed ${completedSchedules.length}`,
      completed: completedSchedules.length,
      schedules: completedSchedules,
      current_time: currentTime,
      current_date: currentDate
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("ERR PATCH /api/production-schedules/auto-complete", err);
    return res.status(500).json({
      message: "Server error during auto-complete",
      error: err.message,
    });
  } finally {
    client.release();
  }
});

module.exports = router;
