const express = require("express");
const router = express.Router();
const pool = require("../db");

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
  if (payload.customerId) return payload.customerId;
  if (!payload.customerName) {
    console.error("Missing customerName in payload:", payload);
    return null;
  }

  try {
    const { rows } = await client.query(
      `SELECT id FROM public.customers WHERE LOWER(cust_name) = LOWER($1) AND is_active = true LIMIT 1`,
      [payload.customerName.trim()],
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

const resolveMaterialCode = async (client, payload) => {
  console.log(
    `[resolveMaterialCode] Using materialCode directly: ${payload.materialCode}`,
  );
  return payload.materialCode;
};

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

    const dupCheck = await client.query(
      `SELECT id, prod_schedule_code
       FROM public.production_schedules
       WHERE line_code   = $1
         AND shift_time  = $2
         AND target_date = $3::date
         AND is_active   = true
       LIMIT 1`,
      [lineCode, shiftTime, targetDate],
    );

    if (dupCheck.rowCount > 0) {
      return res.status(400).json({
        message: `Sudah ada schedule untuk Line ${lineCode}, Shift ${shiftTime} pada ${targetDate}.`,
        existingCode: dupCheck.rows[0].prod_schedule_code,
      });
    }

    await client.query("BEGIN");

    const insertHeader = await client.query(
      `INSERT INTO public.production_schedules
         (line_code, shift_time, target_date, status, created_by)
       VALUES ($1, $2, $3::date, 'New', $4)
       RETURNING id, prod_schedule_code, created_at`,
      [lineCode, shiftTime, targetDate, createdBy ?? null],
    );

    const scheduleId = insertHeader.rows[0].id;
    const scheduleCode = insertHeader.rows[0].prod_schedule_code;

    console.log(`Created schedule header: ${scheduleCode} (ID: ${scheduleId})`);

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
        `Resolved - Customer ID: ${customerId}, Material Code: ${materialCode}`,
      );

      const palletType = sanitizePalletType(d.palletType);

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
          ],
        );
        detailIds.push(detailResult.rows[0].id);
        console.log(
          `Inserted detail ${i + 1} with ID: ${detailResult.rows[0].id}`,
        );
      } catch (err) {
        console.error(`Error inserting detail ${i + 1}:`, err);
        throw err;
      }
    }

    console.log(`Successfully inserted ${detailIds.length} detail records`);

    const sumRes = await client.query(
      `SELECT
        COALESCE(SUM(input_quantity), 0) AS total_input,
        COALESCE(COUNT(DISTINCT customer_id), 0) AS total_customer,
        COALESCE(COUNT(DISTINCT material_code), 0) AS total_model,
        COALESCE(COUNT(*), 0) AS total_pallet
      FROM public.production_schedule_details
      WHERE production_schedule_id = $1`,
      [scheduleId],
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
      ],
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
        COALESCE(ps.actual_input,0) AS actual_input,
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

    const formatToYYYYMMDD = (dateString) => {
      if (!dateString) return null;
      try {
        let dateObj;

        if (dateString instanceof Date) {
          dateObj = dateString;
        } else {
          const str = String(dateString);

          if (str.includes("T")) {
            dateObj = new Date(str);
          } else {
            dateObj = new Date(str + "T00:00:00");
          }
        }

        if (isNaN(dateObj.getTime())) {
          console.warn("Invalid date value:", dateString);
          return String(dateString);
        }

        const year = dateObj.getFullYear();
        const month = String(dateObj.getMonth() + 1).padStart(2, "0");
        const day = String(dateObj.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
      } catch (error) {
        console.error("Error formatting date:", error.message);
        return String(dateString);
      }
    };

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
        actual_input: Number(r.actual_input || 0),
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
      [id],
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
      [id],
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

    const formatToYYYYMMDD = (dateString) => {
      if (!dateString) return null;
      try {
        let dateObj;

        if (dateString instanceof Date) {
          dateObj = dateString;
        } else {
          const str = String(dateString);
          if (str.includes("T")) {
            dateObj = new Date(str);
          } else {
            dateObj = new Date(str + "T00:00:00");
          }
        }
        if (isNaN(dateObj.getTime())) {
          console.warn("Invalid date value:", dateString);
          return String(dateString);
        }
        const year = dateObj.getFullYear();
        const month = String(dateObj.getMonth() + 1).padStart(2, "0");
        const day = String(dateObj.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
      } catch (error) {
        console.error("Error formatting date:", error.message);
        return dateString;
      }
    };

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
            "id-ID",
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

    await client.query("BEGIN");

    const result = await client.query(
      `UPDATE public.production_schedules 
       SET status = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 AND is_active = true
       RETURNING id, prod_schedule_code, status`,
      [status, id],
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Schedule tidak ditemukan." });
    }

    await client.query(
      `UPDATE public.production_schedule_details
       SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE production_schedule_id = $2`,
      [status, id],
    );

    await client.query("COMMIT");

    return res.json({
      message: "Status berhasil diupdate",
      data: result.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(
      "ERR PATCH /api/production-schedules/:id/status",
      err.message,
    );
    return res.status(500).json({ message: "Server error." });
  } finally {
    client.release();
  }
});

router.delete("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id || 0);
    if (!id) {
      return res.status(400).json({ message: "Invalid id." });
    }

    console.log(
      `[DELETE /api/production-schedules/${id}] Permanent delete requested`,
    );

    await client.query("BEGIN");

    const deleteDetails = await client.query(
      `DELETE FROM public.production_schedule_details 
       WHERE production_schedule_id = $1 
       RETURNING id`,
      [id],
    );

    console.log(`Deleted ${deleteDetails.rowCount} detail records`);

    const deleteHeader = await client.query(
      `DELETE FROM public.production_schedules 
       WHERE id = $1 
       RETURNING id, prod_schedule_code, line_code, shift_time, target_date`,
      [id],
    );

    if (deleteHeader.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Schedule tidak ditemukan." });
    }

    await client.query("COMMIT");

    const deletedSchedule = deleteHeader.rows[0];

    console.log(
      `[DELETE /api/production-schedules/${id}] Successfully deleted: ${deletedSchedule.prod_schedule_code}`,
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

router.delete("/details/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id || 0);
    if (!id) {
      return res.status(400).json({ message: "Invalid detail id." });
    }

    await client.query("BEGIN");

    const getDetail = await client.query(
      `SELECT production_schedule_id FROM public.production_schedule_details WHERE id = $1`,
      [id],
    );

    if (getDetail.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Detail tidak ditemukan." });
    }

    const scheduleId = getDetail.rows[0].production_schedule_id;

    const deleteResult = await client.query(
      `DELETE FROM public.production_schedule_details WHERE id = $1 RETURNING id`,
      [id],
    );

    const sumRes = await client.query(
      `SELECT
        COALESCE(SUM(input_quantity), 0) AS total_input,
        COALESCE(COUNT(DISTINCT customer_id), 0) AS total_customer,
        COALESCE(COUNT(DISTINCT material_code), 0) AS total_model,
        COALESCE(COUNT(*), 0) AS total_pallet
      FROM public.production_schedule_details
      WHERE production_schedule_id = $1`,
      [scheduleId],
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
      ],
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

const getLocalDateString = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

router.post("/:id/details", async (req, res) => {
  const client = await pool.connect();
  try {
    const scheduleId = Number(req.params.id || 0);
    if (!scheduleId)
      return res.status(400).json({ message: "Invalid schedule id." });

    const { customerName, materialCode, model, input, poNumber, description } =
      req.body || {};

    if (!customerName)
      return res.status(400).json({ message: "customerName is required." });
    if (!input || Number(input) <= 0)
      return res.status(400).json({ message: "Input must be greater than 0." });

    await client.query("BEGIN");

    const schedRes = await client.query(
      `SELECT id FROM public.production_schedules WHERE id = $1 AND is_active = true`,
      [scheduleId],
    );
    if (schedRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Schedule tidak ditemukan." });
    }

    const custRes = await client.query(
      `SELECT id, default_pallet_type, pallet_capacity, min_pallet_w_quantity
       FROM public.customers WHERE LOWER(cust_name) = LOWER($1) AND is_active = true LIMIT 1`,
      [customerName],
    );
    if (custRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ message: `Customer "${customerName}" tidak ditemukan.` });
    }

    const custRow = custRes.rows[0];
    const customerId = custRow.id;
    const defType = custRow.default_pallet_type || "R";
    const R_CAP = 16;
    const cap = Number(custRow.pallet_capacity) || (defType === "W" ? 32 : 16);
    const minW = Number(custRow.min_pallet_w_quantity ?? 5);

    const seqRes = await client.query(
      `SELECT COALESCE(MAX(sequence_number), 0) AS max_seq FROM public.production_schedule_details WHERE production_schedule_id = $1`,
      [scheduleId],
    );
    let seqNum = Number(seqRes.rows[0].max_seq);

    const baseRow = {
      production_schedule_id: scheduleId,
      customer_id: customerId,
      material_code: materialCode || null,
      model_name: model || null,
      po_number: poNumber || null,
      description: description || null,
      is_auto_split: false,
      pallet_status: "Pending",
    };

    const originalInput = Number(input);
    const rows = [];
    let remaining = originalInput;

    if (defType === "W") {
      const existedRes = await client.query(
        `SELECT COALESCE(SUM(input_quantity), 0) AS existed
         FROM public.production_schedule_details
         WHERE production_schedule_id = $1 AND customer_id = $2 AND pallet_type = 'W'
         AND ($3::text IS NULL OR po_number = $3)`,
        [scheduleId, customerId, poNumber || null],
      );
      const existed = Number(existedRes.rows[0].existed);

      if (existed === 0 && remaining <= cap) {
        rows.push({
          ...baseRow,
          input_quantity: remaining,
          original_input: originalInput,
          pallet_type: remaining < minW ? "R" : "W",
        });
      } else {
        const roomW = Math.max(0, cap - existed);
        if (roomW > 0) {
          const chunk = Math.min(roomW, remaining);
          rows.push({
            ...baseRow,
            input_quantity: chunk,
            original_input: originalInput,
            pallet_type: "W",
          });
          remaining -= chunk;
        }
        while (remaining > 0) {
          if (remaining < minW) {
            rows.push({
              ...baseRow,
              input_quantity: remaining,
              original_input: originalInput,
              pallet_type: "R",
            });
            remaining = 0;
          } else if (remaining <= cap) {
            rows.push({
              ...baseRow,
              input_quantity: remaining,
              original_input: originalInput,
              pallet_type: "W",
            });
            remaining = 0;
          } else {
            rows.push({
              ...baseRow,
              input_quantity: cap,
              original_input: originalInput,
              pallet_type: "W",
            });
            remaining -= cap;
          }
        }
      }
    } else {
      while (remaining > 0) {
        const chunk = Math.min(R_CAP, remaining);
        rows.push({
          ...baseRow,
          input_quantity: chunk,
          original_input: originalInput,
          pallet_type: "R",
        });
        remaining -= chunk;
      }
    }

    const insertedIds = [];
    for (const r of rows) {
      seqNum += 1;
      const ins = await client.query(
        `INSERT INTO public.production_schedule_details
          (production_schedule_id, customer_id, material_code, model_name, input_quantity, po_number, description, sequence_number, pallet_type, is_auto_split, original_input, pallet_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          r.production_schedule_id,
          r.customer_id,
          r.material_code,
          r.model_name,
          r.input_quantity,
          r.po_number,
          r.description,
          seqNum,
          r.pallet_type,
          r.is_auto_split,
          r.original_input,
          r.pallet_status,
        ],
      );
      insertedIds.push(ins.rows[0].id);
    }

    const sumRes = await client.query(
      `SELECT
        COALESCE(SUM(input_quantity), 0) AS total_input,
        COALESCE(COUNT(DISTINCT customer_id), 0) AS total_customer,
        COALESCE(COUNT(DISTINCT material_code), 0) AS total_model,
        COALESCE(COUNT(*), 0) AS total_pallet
       FROM public.production_schedule_details
       WHERE production_schedule_id = $1`,
      [scheduleId],
    );
    const t = sumRes.rows[0];
    await client.query(
      `UPDATE public.production_schedules
         SET total_input = $1, total_customer = $2, total_model = $3, total_pallet = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [
        t.total_input,
        t.total_customer,
        t.total_model,
        t.total_pallet,
        scheduleId,
      ],
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Detail berhasil ditambahkan",
      insertedCount: rows.length,
      insertedIds,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("ERR POST /api/production-schedules/:id/details", err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

router.patch("/auto-progress", async (req, res) => {
  const client = await pool.connect();
  try {
    const now = new Date();
    const currentTime = now.toTimeString().slice(0, 5); // HH:MM
    const currentDate = getLocalDateString(now); // LOCAL date (bukan UTC)

    console.log(`[AUTO-PROGRESS] Checking at ${currentTime} on ${currentDate}`);

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
      [currentDate, currentTime],
    );

    console.log(
      `[AUTO-PROGRESS] Found ${schedulesToProgress.rowCount} schedules to progress`,
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
        [scheduleId],
      );

      await client.query(
        `UPDATE public.production_schedule_details 
         SET status = 'OnProgress', 
             updated_at = CURRENT_TIMESTAMP 
         WHERE production_schedule_id = $1`,
        [scheduleId],
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
      [status, id],
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
      err,
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
      [id],
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
      err.message,
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

    const currentTime = `${currentHours.toString().padStart(2, "0")}:${currentMinutes.toString().padStart(2, "0")}`;

    const currentDate = getLocalDateString(now);

    console.log(
      `[AUTO-COMPLETE] Checking at ${currentTime}:${currentSeconds} on ${currentDate}`,
    );

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
      [currentDate],
    );

    console.log(
      `[AUTO-COMPLETE] Found ${schedulesToCheck.rowCount} OnProgress schedules for today`,
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
        console.log(
          `[AUTO-COMPLETE] Schedule ${scheduleId}: ${currentTime} >= ${endTime}, completing...`,
        );

        await client.query(
          `UPDATE public.production_schedules 
           SET status = 'Complete', 
               updated_at = CURRENT_TIMESTAMP 
           WHERE id = $1`,
          [scheduleId],
        );

        await client.query(
          `UPDATE public.production_schedule_details 
           SET status = 'Complete', 
               updated_at = CURRENT_TIMESTAMP 
           WHERE production_schedule_id = $1`,
          [scheduleId],
        );

        completedSchedules.push({
          id: scheduleId,
          shift_time: schedule.shift_time,
          target_date: schedule.target_date,
          completed_at: now.toISOString(),
          reason: `Shift ended at ${endTime}, current time is ${currentTime}`,
        });
      } else {
        console.log(
          `[AUTO-COMPLETE] Schedule ${scheduleId}: ${currentTime} < ${endTime}, still in progress`,
        );
      }
    }

    await client.query("COMMIT");

    return res.json({
      message: `Auto-complete checked ${schedulesToCheck.rowCount} schedules, completed ${completedSchedules.length}`,
      completed: completedSchedules.length,
      schedules: completedSchedules,
      current_time: currentTime,
      current_date: currentDate,
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

router.patch("/:id/approve-units", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id || 0);
    const count = Number(req.body?.count ?? 1);
    const approvedById = req.body?.approved_by_id || null;
    const remark = req.body?.remark || null;

    if (!id) return res.status(400).json({ message: "Invalid id." });
    if (!Number.isInteger(count) || count < 1)
      return res
        .status(400)
        .json({ message: "count must be a positive integer." });

    const cur = await client.query(
      `SELECT total_input, actual_input, prod_schedule_code FROM public.production_schedules WHERE id = $1 AND is_active = true`,
      [id],
    );
    if (cur.rowCount === 0)
      return res.status(404).json({ message: "Schedule tidak ditemukan." });

    const totalInput = Number(cur.rows[0].total_input || 0);
    const actualInput = Number(cur.rows[0].actual_input || 0);
    const prodScheduleCode = cur.rows[0].prod_schedule_code || null;

    await client.query("BEGIN");

    const now = new Date();

    const detailsForModel = await client.query(
      `SELECT d.input_quantity, COALESCE(d.model, 'Veronicas') AS model
       FROM public.production_schedule_details d
       WHERE d.production_schedule_id = $1
       ORDER BY d.sequence_number ASC, d.id ASC`,
      [id],
    );
    let cumModel = 0;
    const modelBreakdown = detailsForModel.rows.map((r) => {
      const start = cumModel;
      cumModel += Number(r.input_quantity || 0);
      return { model: r.model, start, end: cumModel };
    });
    const getModelForUnit = (u) => {
      for (const b of modelBreakdown) {
        if (u > b.start && u <= b.end) return b.model;
      }
      return modelBreakdown.length > 0
        ? modelBreakdown[modelBreakdown.length - 1].model
        : null;
    };

    const existingRes = await client.query(
      `SELECT unit_no, COALESCE(status, 'approved') AS status
       FROM public.target_scan_approvals WHERE schedule_id = $1`,
      [id],
    );
    const existingMap = {};
    existingRes.rows.forEach((r) => {
      existingMap[Number(r.unit_no)] = r.status;
    });

    let filledCount = 0;
    let nextUnit = 1;
    const approvedModels = new Set();

    while (nextUnit <= totalInput && existingMap[nextUnit] === "approved")
      nextUnit++;

    while (filledCount < count && nextUnit <= totalInput) {
      const existStatus = existingMap[nextUnit];
      if (existStatus === "skipped") {
        nextUnit++;
        continue;
      }
      if (existStatus === "approved") {
        nextUnit++;
        continue;
      }

      const unitModel = getModelForUnit(nextUnit);
      if (unitModel) approvedModels.add(unitModel);
      await client.query(
        `INSERT INTO public.target_scan_approvals (schedule_id, unit_no, remark, approved_by, approved_at, status)
         VALUES ($1, $2, $3, $4, $5, 'approved')
         ON CONFLICT (schedule_id, unit_no) DO UPDATE
           SET status = 'approved', remark = EXCLUDED.remark,
               approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at`,
        [id, nextUnit, remark || null, approvedById, now],
      );
      filledCount++;
      nextUnit++;
    }
    const approvedModelStr =
      approvedModels.size > 0 ? [...approvedModels].join(", ") : null;

    const approvedCountRes = await client.query(
      `SELECT COUNT(*) AS cnt FROM public.target_scan_approvals
       WHERE schedule_id = $1 AND COALESCE(status, 'approved') = 'approved'`,
      [id],
    );
    const updatedActual = Number(approvedCountRes.rows[0].cnt);

    const result = await client.query(
      `UPDATE public.production_schedules
         SET actual_input = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND is_active = true
       RETURNING id, prod_schedule_code, total_input, actual_input`,
      [updatedActual, id],
    );

    let approvedByName = null;
    if (approvedById) {
      const empRes = await client.query(
        `SELECT emp_name FROM public.employees WHERE id = $1 LIMIT 1`,
        [approvedById],
      );
      if (empRes.rows.length > 0) approvedByName = empRes.rows[0].emp_name;
    }

    if (filledCount > 0) {
      const partsRes = await client.query(
        `SELECT id, part_code, part_name, stock_m101, qty_per_assembly FROM kanban_master
         WHERE is_active = true AND qty_per_assembly > 0`,
      );
      for (const part of partsRes.rows) {
        const deduct = (part.qty_per_assembly || 1) * filledCount;
        const newStock = Math.max(0, (part.stock_m101 || 0) - deduct);
        await client.query(
          `UPDATE kanban_master SET stock_m101 = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [newStock, part.id],
        );

        await client.query(
          `INSERT INTO stock_movements (
             part_id, part_code, part_name, movement_type, stock_level,
             quantity, quantity_before, quantity_after,
             source_type, source_reference, model, remark,
             moved_by, moved_by_name, moved_at
           ) VALUES ($1,$2,$3,'OUT','M101',$4,$5,$6,'finish_good',$7,$8,$9,$10,$11,CURRENT_TIMESTAMP)`,
          [
            part.id,
            part.part_code,
            part.part_name,
            deduct,
            part.stock_m101,
            newStock,
            prodScheduleCode,
            approvedModelStr,
            remark || "-",
            approvedById || null,
            approvedByName || null,
          ],
        );
      }
    }
    await client.query("COMMIT");

    return res.json({
      message: `Approved ${filledCount} unit(s)`,
      data: result.rows[0],
      approved_by_name: approvedByName,
      approved_at: now.toISOString(),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(
      "ERR PATCH /api/production-schedules/:id/approve-units",
      err.message,
    );
    return res.status(500).json({ message: "Server error." });
  } finally {
    client.release();
  }
});

router.get("/:id/scan-approvals", async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id || 0);
    if (!id) return res.status(400).json({ message: "Invalid id." });

    const result = await client.query(
      `SELECT
         a.unit_no,
         a.remark,
         a.approved_at,
         COALESCE(a.status, 'approved') AS status,
         CASE
           WHEN e.emp_name IS NOT NULL THEN
             e.emp_name || ' | ' || TO_CHAR(a.approved_at, 'DD/MM/YYYY HH24:MI')
           ELSE
             'User-' || COALESCE(a.approved_by::text, 'System') || ' | ' || TO_CHAR(a.approved_at, 'DD/MM/YYYY HH24:MI')
         END AS approved_by_name
       FROM public.target_scan_approvals a
       LEFT JOIN public.employees e ON e.id = a.approved_by
       WHERE a.schedule_id = $1
       ORDER BY a.unit_no`,
      [id],
    );

    return res.json(result.rows);
  } catch (err) {
    console.error(
      "ERR GET /api/production-schedules/:id/scan-approvals",
      err.message,
    );
    return res.status(500).json({ message: "Server error." });
  } finally {
    client.release();
  }
});

router.patch("/:id/skip-unit", async (req, res) => {
  const client = await pool.connect();
  try {
    const scheduleId = Number(req.params.id || 0);
    const { unit_no, remark } = req.body || {};
    if (!scheduleId) return res.status(400).json({ message: "Invalid id." });
    if (!unit_no) return res.status(400).json({ message: "unit_no required." });
    if (!remark || !String(remark).trim())
      return res
        .status(400)
        .json({ message: "Remark wajib diisi untuk Skip." });

    const cur = await client.query(
      `SELECT id FROM public.production_schedules WHERE id = $1 AND is_active = true`,
      [scheduleId],
    );
    if (cur.rowCount === 0)
      return res.status(404).json({ message: "Schedule tidak ditemukan." });

    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.target_scan_approvals (schedule_id, unit_no, remark, approved_by, approved_at, status)
       VALUES ($1, $2, $3, NULL, CURRENT_TIMESTAMP, 'skipped')
       ON CONFLICT (schedule_id, unit_no) DO UPDATE
         SET remark = EXCLUDED.remark, approved_at = EXCLUDED.approved_at, status = 'skipped'`,
      [scheduleId, unit_no, remark],
    );
    const skipCountRes = await client.query(
      `SELECT COUNT(*) AS cnt FROM public.target_scan_approvals
       WHERE schedule_id = $1 AND COALESCE(status, 'approved') = 'approved'`,
      [scheduleId],
    );
    const skipNewActual = Number(skipCountRes.rows[0].cnt);
    await client.query(
      `UPDATE public.production_schedules SET actual_input = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [skipNewActual, scheduleId],
    );
    await client.query("COMMIT");
    return res.json({
      message: `Unit ${unit_no} di-skip`,
      new_actual_input: skipNewActual,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("ERR PATCH /:id/skip-unit", err.message);
    return res.status(500).json({ message: "Server error." });
  } finally {
    client.release();
  }
});

router.patch("/:id/approve-single", async (req, res) => {
  const client = await pool.connect();
  try {
    const scheduleId = Number(req.params.id || 0);
    const { unit_no, approved_by_id, remark } = req.body || {};
    if (!scheduleId) return res.status(400).json({ message: "Invalid id." });
    if (!unit_no) return res.status(400).json({ message: "unit_no required." });

    const cur = await client.query(
      `SELECT total_input, actual_input FROM public.production_schedules WHERE id = $1 AND is_active = true`,
      [scheduleId],
    );
    if (cur.rowCount === 0)
      return res.status(404).json({ message: "Schedule tidak ditemukan." });

    const detailRes = await client.query(
      `SELECT c.cust_name, d.input_quantity, COALESCE(d.model, 'Veronicas') AS model
       FROM public.production_schedule_details d
       LEFT JOIN public.customers c ON c.id = d.customer_id
       WHERE d.production_schedule_id = $1
       ORDER BY d.sequence_number ASC, d.id ASC`,
      [scheduleId],
    );
    let cumulative = 0;
    const breakdown = detailRes.rows.map((row) => {
      const start = cumulative;
      cumulative += Number(row.input_quantity || 0);
      return {
        cust_name: row.cust_name,
        model: row.model || "Veronicas",
        start,
        end: cumulative,
      };
    });
    const getCustomer = (u) => {
      for (const b of breakdown) {
        if (u > b.start && u <= b.end) return b.cust_name || null;
      }
      return breakdown.length > 0
        ? breakdown[breakdown.length - 1].cust_name || null
        : null;
    };
    const getModel = (u) => {
      for (const b of breakdown) {
        if (u > b.start && u <= b.end) return b.model;
      }
      return breakdown.length > 0
        ? breakdown[breakdown.length - 1].model
        : null;
    };

    const now = new Date();
    const customer = getCustomer(Number(unit_no));
    const unitModel = getModel(Number(unit_no));

    await client.query("BEGIN");

    await client.query(
      `INSERT INTO public.target_scan_approvals (schedule_id, unit_no, remark, approved_by, approved_at, customer, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'approved')
       ON CONFLICT (schedule_id, unit_no) DO UPDATE
         SET remark = EXCLUDED.remark,
             approved_by = EXCLUDED.approved_by,
             approved_at = EXCLUDED.approved_at,
             status = 'approved'`,
      [
        scheduleId,
        unit_no,
        remark || null,
        approved_by_id || null,
        now,
        customer,
      ],
    );

    const singleCountRes = await client.query(
      `SELECT COUNT(*) AS cnt FROM public.target_scan_approvals
       WHERE schedule_id = $1 AND COALESCE(status, 'approved') = 'approved'`,
      [scheduleId],
    );
    const singleNewActual = Number(singleCountRes.rows[0].cnt);
    await client.query(
      `UPDATE public.production_schedules SET actual_input = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [singleNewActual, scheduleId],
    );

    let approvedByName = null;
    if (approved_by_id) {
      const empRes = await client.query(
        `SELECT emp_name FROM public.employees WHERE id = $1 LIMIT 1`,
        [approved_by_id],
      );
      if (empRes.rows.length > 0) approvedByName = empRes.rows[0].emp_name;
    }

    const partsRes = await client.query(
      `SELECT id, part_code, part_name, stock_m101, qty_per_assembly FROM kanban_master
       WHERE is_active = true AND qty_per_assembly > 0`,
    );

    const schedCodeRes = await client.query(
      `SELECT prod_schedule_code FROM public.production_schedules WHERE id = $1 LIMIT 1`,
      [scheduleId],
    );
    const scheduleCode = schedCodeRes.rows[0]?.prod_schedule_code || null;

    for (const part of partsRes.rows) {
      const deduct = part.qty_per_assembly || 1;
      const newStock = Math.max(0, (part.stock_m101 || 0) - deduct);
      await client.query(
        `UPDATE kanban_master SET stock_m101 = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [newStock, part.id],
      );

      await client.query(
        `INSERT INTO stock_movements (
           part_id, part_code, part_name, movement_type, stock_level,
           quantity, quantity_before, quantity_after,
           source_type, source_reference, model, remark,
           moved_by, moved_by_name, moved_at
         ) VALUES ($1,$2,$3,'OUT','M101',$4,$5,$6,'finish_good',$7,$8,$9,$10,$11,CURRENT_TIMESTAMP)`,
        [
          part.id,
          part.part_code,
          part.part_name,
          deduct,
          part.stock_m101,
          newStock,
          scheduleCode,
          unitModel || null,
          remark || "-",
          approved_by_id || null,
          approvedByName || null,
        ],
      );
    }

    await client.query("COMMIT");

    return res.json({
      message: `Unit ${unit_no} berhasil di-approve`,
      approved_by_name: approvedByName,
      approved_at: now.toISOString(),
      new_actual_input: singleNewActual,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("ERR PATCH /:id/approve-single", err.message);
    return res.status(500).json({ message: "Server error." });
  } finally {
    client.release();
  }
});

router.patch("/:id/update-approval", async (req, res) => {
  const client = await pool.connect();
  try {
    const scheduleId = Number(req.params.id || 0);
    const { unit_no, remark, approved_by_id } = req.body || {};
    if (!scheduleId) return res.status(400).json({ message: "Invalid id." });
    if (!unit_no) return res.status(400).json({ message: "unit_no required." });

    const now = new Date();
    const result = await client.query(
      `UPDATE public.target_scan_approvals
         SET remark = $1,
             approved_by = $2,
             approved_at = $3
       WHERE schedule_id = $4 AND unit_no = $5
       RETURNING unit_no`,
      [remark || null, approved_by_id || null, now, scheduleId, unit_no],
    );

    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ message: "Approval record tidak ditemukan." });
    }

    let approvedByName = null;
    if (approved_by_id) {
      const empRes = await client.query(
        `SELECT emp_name FROM public.employees WHERE id = $1 LIMIT 1`,
        [approved_by_id],
      );
      if (empRes.rows.length > 0) approvedByName = empRes.rows[0].emp_name;
    }

    return res.json({
      message: `Remark unit ${unit_no} berhasil diupdate`,
      approved_by_name: approvedByName,
      approved_at: now.toISOString(),
    });
  } catch (err) {
    console.error("ERR PATCH /:id/update-approval", err.message);
    return res.status(500).json({ message: "Server error." });
  } finally {
    client.release();
  }
});

module.exports = router;
