// routes/overseaSchedules.js
const express = require("express");
const router = express.Router();
const pool = require("../db");

// ==================== PALLET CALCULATION FUNCTIONS ====================

// Pallet configurations
const PALLET_CONFIG = {
  large: {
    length: 110,
    width: 110,
    maxHeight: 170,
    baseHeight: 15,
    maxWeight: 150,
  },
  small: {
    length: 96,
    width: 76,
    maxHeight: 150,
    baseHeight: 15,
    maxWeight: 60,
  },
};

// Helper: check if box fits in pallet
const canBoxFitPallet = (boxLength, boxWidth, palletLength, palletWidth) => {
  return (
    (boxLength <= palletLength && boxWidth <= palletWidth) ||
    (boxWidth <= palletLength && boxLength <= palletWidth)
  );
};

// Calculate max boxes per pallet
const calculateMaxBoxesInPallet = (box, palletType) => {
  const config = PALLET_CONFIG[palletType];
  const availableHeight = config.maxHeight - config.baseHeight;

  // Calculate boxes per layer with best orientation
  let bestBoxesPerLayer = 0;

  // Try normal orientation
  const boxesLengthwiseNormal = Math.floor(config.length / box.length);
  const boxesWidthwiseNormal = Math.floor(config.width / box.width);
  const boxesPerLayerNormal = boxesLengthwiseNormal * boxesWidthwiseNormal;

  // Try rotated orientation
  const boxesLengthwiseRotated = Math.floor(config.length / box.width);
  const boxesWidthwiseRotated = Math.floor(config.width / box.length);
  const boxesPerLayerRotated = boxesLengthwiseRotated * boxesWidthwiseRotated;

  // Take the best
  bestBoxesPerLayer = Math.max(boxesPerLayerNormal, boxesPerLayerRotated);

  // For large pallet, try mixed if less than 4
  if (palletType === "large" && bestBoxesPerLayer < 4) {
    const boxesMixed = boxesPerLayerNormal + boxesPerLayerRotated;
    bestBoxesPerLayer = Math.max(bestBoxesPerLayer, Math.min(4, boxesMixed));
  }

  if (bestBoxesPerLayer === 0) return { maxBoxesPerPallet: 0 };

  // Calculate max layers by height
  const maxLayersByHeight = Math.floor(availableHeight / box.height);
  const safeLayersByHeight = Math.max(1, maxLayersByHeight - 1);

  // Calculate weight per layer
  const weightPerLayer = bestBoxesPerLayer * box.weight;

  // Calculate max layers by weight
  const maxLayersByWeight = weightPerLayer > 0
    ? Math.floor(config.maxWeight / weightPerLayer)
    : safeLayersByHeight;

  // Take the smaller between height and weight limits
  const finalLayers = Math.max(1, Math.min(safeLayersByHeight, maxLayersByWeight));

  // Total boxes per pallet by dimensions
  const maxBoxesByDimension = bestBoxesPerLayer * finalLayers;

  // Calculate max boxes by weight only
  const maxBoxesByWeight = box.weight > 0
    ? Math.floor(config.maxWeight / box.weight)
    : maxBoxesByDimension;

  // Take the smaller (dimension OR weight that limits)
  const maxBoxesPerPallet = Math.min(maxBoxesByDimension, maxBoxesByWeight);

  return {
    maxBoxesPerPallet: Math.max(1, maxBoxesPerPallet),
    boxesPerLayer: bestBoxesPerLayer,
    maxLayers: finalLayers,
  };
};

// Optimize pallet mixing
const optimizePalletMixing = (palletDetails) => {
  if (palletDetails.length <= 1) return palletDetails;

  const optimized = [...palletDetails];

  // Try to merge pallets of same type with available space
  for (let i = 0; i < optimized.length; i++) {
    for (let j = i + 1; j < optimized.length; j++) {
      const palletA = optimized[i];
      const palletB = optimized[j];

      // Only merge if same type
      if (palletA.palletType !== palletB.palletType) continue;

      const maxWeight = palletA.palletType === "large" ? 150 : 60;
      const combinedWeight = palletA.totalWeight + palletB.totalWeight;
      const combinedBoxes = palletA.boxesCount + palletB.boxesCount;

      // Check if can be merged (weight and capacity)
      if (combinedWeight <= maxWeight && combinedBoxes <= palletA.capacity) {
        // Merge into palletA
        palletA.boxesCount = combinedBoxes;
        palletA.totalWeight = combinedWeight;

        // Remove palletB
        optimized.splice(j, 1);
        j--;
      }
    }
  }

  return optimized;
};

// Get box dimensions from database (same query as /api/kanban-master/placement-details)
const getBoxDimensionsFromDB = async (client, partCode) => {
  const defaultDimensions = { length: 30, width: 30, height: 30, weight: 0.5 };

  try {
    // Query same as /api/kanban-master/placement-details endpoint
    const result = await client.query(
      `SELECT 
        km.part_code,
        km.part_weight,
        km.weight_unit,
        vp.length_cm,
        vp.width_cm,
        vp.height_cm
       FROM kanban_master km
       LEFT JOIN vendor_placement vp ON km.placement_id = vp.id
       WHERE km.part_code = $1
         AND km.is_active = TRUE
       ORDER BY km.id DESC
       LIMIT 1`,
      [partCode]
    );

    if (result.rowCount > 0) {
      const row = result.rows[0];

      // Convert weight unit to kg (same as placement-details endpoint)
      let partWeight = parseFloat(row.part_weight) || 0;
      if (row.weight_unit === 'g') {
        partWeight = partWeight / 1000;
      } else if (row.weight_unit === 'lbs') {
        partWeight = partWeight * 0.453592;
      } else if (row.weight_unit === 'oz') {
        partWeight = partWeight * 0.0283495;
      }

      return {
        length: parseFloat(row.length_cm) || 30,
        width: parseFloat(row.width_cm) || 30,
        height: parseFloat(row.height_cm) || 30,
        weight: partWeight || 0.5,
      };
    }

    return defaultDimensions;
  } catch (error) {
    console.warn(`[getBoxDimensionsFromDB] Error for ${partCode}:`, error.message);
    return defaultDimensions;
  }
};

// Calculate optimized pallet count from box data
const calculateOptimizedPallet = (boxData) => {
  if (!boxData || boxData.length === 0) {
    return { largePallets: 0, smallPallets: 0, totalPallets: 0 };
  }

  // Group boxes by size
  const boxGroups = {};

  boxData.forEach((box) => {
    const boxKey = `${box.length}x${box.width}x${box.height}`;

    if (!boxGroups[boxKey]) {
      boxGroups[boxKey] = {
        length: box.length,
        width: box.width,
        height: box.height,
        totalBoxes: 0,
        totalWeight: 0,
      };
    }

    boxGroups[boxKey].totalBoxes += 1;
    boxGroups[boxKey].totalWeight += box.weight;
  });

  const palletDetails = [];

  // PERBAIKAN: Urutkan keys untuk konsistensi dengan frontend
  // for...in tidak menjamin urutan, menyebabkan hasil berbeda dengan frontend
  const sortedKeys = Object.keys(boxGroups).sort();

  for (const key of sortedKeys) {
    const group = boxGroups[key];
    if (group.totalBoxes <= 0) continue;

    const weightPerBox = group.totalWeight / group.totalBoxes;

    // Check which pallet type fits
    const fitsLarge = canBoxFitPallet(group.length, group.width, 110, 110);
    const fitsSmall = canBoxFitPallet(group.length, group.width, 96, 76);

    let palletType = "large";
    if (!fitsLarge && fitsSmall) {
      palletType = "small";
    }

    // Calculate capacity
    const capacity = calculateMaxBoxesInPallet(
      {
        length: group.length,
        width: group.width,
        height: group.height,
        weight: weightPerBox,
      },
      palletType
    );

    if (capacity.maxBoxesPerPallet === 0) continue;

    // Calculate pallets needed
    const palletsNeeded = Math.ceil(group.totalBoxes / capacity.maxBoxesPerPallet);

    // Distribute to pallets
    let remainingBoxes = group.totalBoxes;
    for (let i = 0; i < palletsNeeded; i++) {
      const boxesInThisPallet = Math.min(remainingBoxes, capacity.maxBoxesPerPallet);
      const weightInThisPallet = boxesInThisPallet * weightPerBox;

      palletDetails.push({
        palletType,
        boxesCount: boxesInThisPallet,
        boxSize: key,
        totalWeight: weightInThisPallet,
        capacity: capacity.maxBoxesPerPallet,
      });

      remainingBoxes -= boxesInThisPallet;
    }
  }

  // Optimize mixing
  const optimizedPallets = optimizePalletMixing(palletDetails);

  // Count results
  let largePallets = 0;
  let smallPallets = 0;

  optimizedPallets.forEach((pallet) => {
    if (pallet.palletType === "large") {
      largePallets++;
    } else {
      smallPallets++;
    }
  });

  return {
    largePallets,
    smallPallets,
    totalPallets: largePallets + smallPallets,
  };
};

// Calculate total pallet for a vendor based on its parts
const calculateVendorTotalPallet = async (client, vendorId) => {
  try {
    // Get all parts for this vendor
    const partsResult = await client.query(
      `SELECT part_code, quantity_box FROM oversea_schedule_parts 
       WHERE oversea_schedule_vendor_id = $1 AND is_active = true`,
      [vendorId]
    );

    if (partsResult.rowCount === 0) {
      return 0;
    }

    // Collect box data
    const boxData = [];

    for (const part of partsResult.rows) {
      const qtyBox = parseInt(part.quantity_box) || 0;
      if (qtyBox <= 0) continue;

      const dimensions = await getBoxDimensionsFromDB(client, part.part_code);

      // Add each box
      for (let i = 0; i < qtyBox; i++) {
        boxData.push({
          length: dimensions.length,
          width: dimensions.width,
          height: dimensions.height,
          weight: dimensions.weight,
          partCode: part.part_code,
        });
      }
    }

    if (boxData.length === 0) {
      return 0;
    }

    // Calculate optimized pallets
    const result = calculateOptimizedPallet(boxData);

    console.log(`[calculateVendorTotalPallet] Vendor ${vendorId}: ${boxData.length} boxes -> ${result.totalPallets} pallets`);

    return result.totalPallets;
  } catch (error) {
    console.error(`[calculateVendorTotalPallet] Error for vendor ${vendorId}:`, error.message);
    // Return 0 on error - don't try to query again as transaction may be aborted
    return 0;
  }
};

// ==================== OPTIMIZED TOTALS UPDATE FUNCTIONS ====================

// Update vendor totals (total_item and total_pallet) using optimized pallet calculation
const updateVendorTotals = async (client, vendorId) => {
  try {
    // Calculate total_item (count of parts)
    const itemResult = await client.query(
      `SELECT COUNT(*) as total_item FROM oversea_schedule_parts 
       WHERE oversea_schedule_vendor_id = $1 AND is_active = true`,
      [vendorId]
    );
    const totalItem = parseInt(itemResult.rows[0].total_item) || 0;

    // Calculate total_pallet using optimized calculation
    const totalPallet = await calculateVendorTotalPallet(client, vendorId);

    // Update vendor
    await client.query(
      `UPDATE oversea_schedule_vendors 
       SET total_item = $1, total_pallet = $2, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $3`,
      [totalItem, totalPallet, vendorId]
    );

    console.log(`[updateVendorTotals] Vendor ${vendorId}: item=${totalItem}, pallet=${totalPallet}`);

    return { totalItem, totalPallet };
  } catch (error) {
    console.error(`[updateVendorTotals] Error for vendor ${vendorId}:`, error.message);
    // Fallback to simple calculation if optimized fails
    try {
      await client.query(
        `UPDATE oversea_schedule_vendors 
         SET total_item = (
           SELECT COUNT(*) FROM oversea_schedule_parts 
           WHERE oversea_schedule_vendor_id = $1 AND is_active = true
         ),
         total_pallet = (
           SELECT COALESCE(SUM(quantity_box), 0) FROM oversea_schedule_parts 
           WHERE oversea_schedule_vendor_id = $1 AND is_active = true
         ),
         updated_at = CURRENT_TIMESTAMP 
         WHERE id = $1`,
        [vendorId]
      );
      console.log(`[updateVendorTotals] Vendor ${vendorId}: used fallback calculation`);
    } catch (fallbackError) {
      console.error(`[updateVendorTotals] Fallback also failed for vendor ${vendorId}:`, fallbackError.message);
    }
    return { totalItem: 0, totalPallet: 0 };
  }
};

// Update schedule totals from all its vendors
const updateScheduleTotals = async (client, scheduleId) => {
  try {
    // Sum totals from all active vendors
    const result = await client.query(
      `UPDATE oversea_schedules
       SET total_item = (
         SELECT COALESCE(SUM(total_item), 0) FROM oversea_schedule_vendors 
         WHERE oversea_schedule_id = $1 AND is_active = true
       ),
       total_pallet = (
         SELECT COALESCE(SUM(total_pallet), 0) FROM oversea_schedule_vendors 
         WHERE oversea_schedule_id = $1 AND is_active = true
       ),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING total_item, total_pallet`,
      [scheduleId]
    );

    if (result.rowCount > 0) {
      console.log(`[updateScheduleTotals] Schedule ${scheduleId}: item=${result.rows[0].total_item}, pallet=${result.rows[0].total_pallet}`);
      return { totalItem: result.rows[0].total_item, totalPallet: result.rows[0].total_pallet };
    }
    return { totalItem: 0, totalPallet: 0 };
  } catch (error) {
    console.error(`[updateScheduleTotals] Error for schedule ${scheduleId}:`, error.message);
    return { totalItem: 0, totalPallet: 0 };
  }
};

// ==================== END OPTIMIZED TOTALS UPDATE FUNCTIONS ====================

// ==================== END PALLET CALCULATION FUNCTIONS ====================

// ==================== QC CHECKS AUTO-CREATE FUNCTIONS ====================

// Create QC checks for SAMPLE production dates
const createQCChecksForSampleDates = async (client, vendorId, vendorName, createdByName) => {
  try {
    console.log(`[createQCChecksForSampleDates] Creating QC checks for vendor ${vendorId}`);

    // Get all parts with their prod_dates for this vendor
    const partsResult = await client.query(
      `SELECT id, part_code, part_name, prod_dates 
       FROM oversea_schedule_parts 
       WHERE oversea_schedule_vendor_id = $1 AND is_active = true`,
      [vendorId]
    );

    const qcChecksCreated = [];

    for (const part of partsResult.rows) {
      // Parse prod_dates (can be JSONB array or single value)
      let prodDates = [];

      if (part.prod_dates) {
        if (typeof part.prod_dates === 'string') {
          try {
            prodDates = JSON.parse(part.prod_dates);
          } catch {
            prodDates = [part.prod_dates];
          }
        } else if (Array.isArray(part.prod_dates)) {
          prodDates = part.prod_dates;
        } else {
          prodDates = [part.prod_dates];
        }
      }

      // For each prod_date that is SAMPLE
      for (const prodDate of prodDates) {
        const prodDateStr = String(prodDate || '').toUpperCase();

        // Check if prod_date is SAMPLE
        if (prodDateStr.includes('SAMPLE') || prodDateStr === 'SAMPLE') {
          console.log(`[createQCChecksForSampleDates] Creating QC check for ${part.part_code} - ${prodDate}`);

          // Check if QC check already exists
          const existingCheck = await client.query(
            `SELECT id FROM qc_checks 
             WHERE part_code = $1 
               AND UPPER(production_date::text) = UPPER($2) 
               AND data_from = 'M136' 
               AND source_vendor_id = $3
               AND is_active = true 
             LIMIT 1`,
            [part.part_code, String(prodDate), vendorId]
          );

          if (existingCheck.rowCount === 0) {
            // Create new QC check
            const insertResult = await client.query(
              `INSERT INTO qc_checks (
                part_code, 
                part_name, 
                vendor_name, 
                production_date, 
                data_from, 
                status, 
                qc_status, 
                source_vendor_id,
                source_part_id,
                created_by, 
                created_at, 
                updated_at, 
                is_active
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, true)
              RETURNING id`,
              [
                part.part_code,
                part.part_name,
                vendorName,
                String(prodDate),
                'M136',
                'Pending',
                null,
                vendorId,
                part.id,
                createdByName
              ]
            );

            qcChecksCreated.push({
              qc_check_id: insertResult.rows[0].id,
              part_code: part.part_code,
              prod_date: prodDate
            });
          }
        }
      }
    }

    console.log(`[createQCChecksForSampleDates] Created ${qcChecksCreated.length} QC checks`);
    return qcChecksCreated;
  } catch (error) {
    console.error(`[createQCChecksForSampleDates] Error:`, error.message);
    throw error;
  }
};

// Check if all SAMPLE prod_dates for a vendor are approved and move to Pass
const checkAndMoveVendorToPassIfAllApproved = async (client, vendorId) => {
  try {
    console.log(`[checkAndMoveVendorToPassIfAllApproved] Checking vendor ${vendorId}`);

    // Count total SAMPLE QC checks for this vendor
    const totalChecksResult = await client.query(
      `SELECT COUNT(*) as total 
       FROM qc_checks 
       WHERE source_vendor_id = $1 
         AND data_from = 'M136' 
         AND is_active = true`,
      [vendorId]
    );

    const totalChecks = parseInt(totalChecksResult.rows[0].total) || 0;

    if (totalChecks === 0) {
      console.log(`[checkAndMoveVendorToPassIfAllApproved] No QC checks found for vendor ${vendorId}`);
      return false;
    }

    // Count approved QC checks
    const approvedChecksResult = await client.query(
      `SELECT COUNT(*) as approved 
       FROM qc_checks 
       WHERE source_vendor_id = $1 
         AND data_from = 'M136' 
         AND status = 'Complete'
         AND is_active = true`,
      [vendorId]
    );

    const approvedChecks = parseInt(approvedChecksResult.rows[0].approved) || 0;

    console.log(`[checkAndMoveVendorToPassIfAllApproved] Vendor ${vendorId}: ${approvedChecks}/${totalChecks} approved`);

    // If all approved, move vendor to Pass
    if (totalChecks > 0 && approvedChecks === totalChecks) {
      console.log(`[checkAndMoveVendorToPassIfAllApproved] All QC checks approved! Moving vendor ${vendorId} to Pass`);

      await client.query(
        `UPDATE oversea_schedule_vendors 
         SET vendor_status = 'Sample', 
             updated_at = CURRENT_TIMESTAMP 
         WHERE id = $1 AND is_active = true`,
        [vendorId]
      );

      // Get schedule_id to update schedule status if needed
      const vendorInfo = await client.query(
        `SELECT oversea_schedule_id FROM oversea_schedule_vendors WHERE id = $1`,
        [vendorId]
      );

      if (vendorInfo.rowCount > 0) {
        const scheduleId = vendorInfo.rows[0].oversea_schedule_id;

        // Check if all vendors in schedule are in Sample status
        const allVendorsCheck = await client.query(
          `SELECT COUNT(*) as total, 
                  SUM(CASE WHEN vendor_status = 'Sample' THEN 1 ELSE 0 END) as sample_count
           FROM oversea_schedule_vendors 
           WHERE oversea_schedule_id = $1 AND is_active = true`,
          [scheduleId]
        );

        const { total, sample_count } = allVendorsCheck.rows[0];
        if (parseInt(total) > 0 && parseInt(total) === parseInt(sample_count)) {
          await client.query(
            `UPDATE oversea_schedules 
             SET status = 'Sample', 
                 updated_at = CURRENT_TIMESTAMP 
             WHERE id = $1 AND is_active = true`,
            [scheduleId]
          );
          console.log(`[checkAndMoveVendorToPassIfAllApproved] Schedule ${scheduleId} moved to Sample`);
        }
      }

      return true;
    }

    return false;
  } catch (error) {
    console.error(`[checkAndMoveVendorToPassIfAllApproved] Error:`, error.message);
    return false;
  }
};

// ==================== END QC CHECKS AUTO-CREATE FUNCTIONS ====================

// helper functions
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
    const {
      stockLevel,
      modelName,
      scheduleDate,
      uploadByName,
      totalVendor,
      totalPallet,
      totalItem
    } = req.body || {};

    if (!stockLevel || !modelName || !scheduleDate) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    const existingSchedule = await client.query(
      `SELECT id FROM oversea_schedules 
       WHERE schedule_date = $1::date AND is_active = true LIMIT 1`,
      [scheduleDate]
    );

    if (existingSchedule.rowCount > 0) {
      return res.status(409).json({
        success: false,
        message: "Schedule date already exists in database",
        existingSchedule: existingSchedule.rows[0],
      });
    }

    await client.query("BEGIN");
    const uploadBy = await resolveEmployeeId(client, uploadByName);

    // Generate schedule_code
    const now = new Date();
    const scheduleDateObj = new Date(scheduleDate);

    const scheduleCode = `OVERSEA-${String(scheduleDateObj.getDate()).padStart(2, '0')}/${String(scheduleDateObj.getMonth() + 1).padStart(2, '0')}/${scheduleDateObj.getFullYear()}/${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')}`;

    const ins = await client.query(
      `INSERT INTO oversea_schedules
        (schedule_code, stock_level, model_name, upload_by, schedule_date, 
         total_vendor, total_pallet, total_item, status)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, 'New')
       RETURNING id, schedule_code, stock_level, model_name, upload_by, 
                 TO_CHAR(schedule_date, 'YYYY-MM-DD') as schedule_date,
                 total_vendor, total_pallet, total_item, status, created_at, updated_at, is_active`,
      [
        scheduleCode,
        stockLevel,
        modelName,
        uploadBy,
        scheduleDate,
        totalVendor || 0,
        totalPallet || 0,
        totalItem || 0
      ]
    );

    await client.query("COMMIT");
    res.status(201).json({ success: true, schedule: ins.rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[Create Oversea Schedule] Error:", e.message);
    res.status(400).json({ success: false, message: e.message || "Failed to create schedule" });
  } finally {
    client.release();
  }
});

// ====== CHECK schedule date ======
router.get("/check-date", async (req, res) => {
  try {
    const { scheduleDate } = req.query;
    if (!scheduleDate) {
      return res.status(400).json({ success: false, message: "scheduleDate is required" });
    }

    const { rows } = await pool.query(
      `SELECT id, schedule_code, TO_CHAR(schedule_date, 'YYYY-MM-DD') as schedule_date, stock_level, model_name
       FROM oversea_schedules WHERE schedule_date = $1::date AND is_active = true LIMIT 1`,
      [scheduleDate]
    );

    return res.json({ success: true, exists: rows.length > 0, schedule: rows[0] || null });
  } catch (err) {
    console.error("[Check Schedule Date] Error:", err.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ====== GET all oversea schedules ======
router.get("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const { status, date_from, date_to, vendor_name, part_code } = req.query;

    // Map frontend status to database status
    const statusMapping = {
      "New": "New",
      "Schedule": "Scheduled",
      "Received": "Received",
      "IQC Progress": "IQC Progress",
      "Sample": "Sample",
      "Complete": "Complete"
    };

    let query = `
      SELECT 
        os.id,
        os.schedule_code,
        os.stock_level,
        os.model_name,
        TO_CHAR(os.schedule_date, 'YYYY-MM-DD') as schedule_date,
        os.total_vendor,
        os.total_pallet,
        os.total_item,
        os.status,
        os.created_at,
        os.updated_at,
        os.upload_by,
        e.emp_name as upload_by_name
      FROM oversea_schedules os
      LEFT JOIN employees e ON e.id = os.upload_by
      WHERE os.is_active = true`;

    const params = [];
    let paramCount = 0;

    // Filter by status
    if (status && statusMapping[status]) {
      paramCount++;
      query += ` AND os.status = $${paramCount}`;
      params.push(statusMapping[status]);
    }

    // Filter by date range
    if (date_from) {
      paramCount++;
      query += ` AND os.schedule_date >= $${paramCount}::date`;
      params.push(date_from);
    }

    if (date_to) {
      paramCount++;
      query += ` AND os.schedule_date <= $${paramCount}::date`;
      params.push(date_to);
    }

    query += ` ORDER BY os.schedule_date DESC, os.created_at DESC`;

    console.log("Query:", query);
    console.log("Params:", params);

    const result = await client.query(query, params);
    console.log("Found schedules:", result.rows.length);

    // Get detailed data for each schedule
    const schedulesWithDetails = await Promise.all(
      result.rows.map(async (schedule) => {
        console.log(`Fetching vendors for schedule ${schedule.id}`);

        try {
          // Get vendors for this schedule
          const vendorsResult = await client.query(
            `SELECT 
              osv.id,
              osv.oversea_schedule_id,
              osv.trip_id,
              osv.vendor_id,
              osv.do_numbers,
              osv.arrival_time,
              osv.total_pallet,
              osv.total_item,
              osv.vendor_status,
              osv.move_by,
              osv.move_at,
              osv.approve_by,
              osv.approve_at,
              osv.sample_by,
              osv.sample_at,
              osv.complete_by,
              osv.complete_at,
              osv.schedule_date_ref,
              osv.stock_level_ref,
              osv.model_name_ref,
              osv.created_at,
              osv.updated_at,
              vd.vendor_name,
              vd.vendor_code,
              t.trip_code,
              t.arv_to as trip_arrival_time
            FROM oversea_schedule_vendors osv
            LEFT JOIN vendor_detail vd ON vd.id = osv.vendor_id
            LEFT JOIN trips t ON t.id = osv.trip_id
            WHERE osv.oversea_schedule_id = $1 
              AND osv.is_active = true
            ORDER BY osv.id ASC`,
            [schedule.id]
          );

          console.log(`Found ${vendorsResult.rows.length} vendors for schedule ${schedule.id}`);

          // Get parts for each vendor
          const vendorsWithParts = await Promise.all(
            vendorsResult.rows.map(async (vendor) => {
              console.log(`Fetching parts for vendor ${vendor.id}`);

              try {
                const partsResult = await client.query(
                  `SELECT 
                    osp.id,
                    osp.oversea_schedule_vendor_id,
                    osp.part_id,
                    osp.part_code,
                    osp.part_name,
                    osp.quantity,
                    osp.quantity_box,
                    osp.unit,
                    osp.do_number,
                    osp.remark,
                    osp.status,
                    TO_CHAR(osp.prod_date, 'YYYY-MM-DD') as prod_date,
                    osp.prod_dates,
                    osp.created_at,
                    osp.updated_at
                  FROM oversea_schedule_parts osp
                  WHERE osp.oversea_schedule_vendor_id = $1 
                    AND osp.is_active = true
                  ORDER BY osp.id ASC`,
                  [vendor.id]
                );

                console.log(`Found ${partsResult.rows.length} parts for vendor ${vendor.id}`);
                return {
                  ...vendor,
                  parts: partsResult.rows.map(p => ({
                    ...p,
                    qty: p.quantity,
                    qty_box: p.quantity_box
                  }))
                };
              } catch (error) {
                console.error(`Error fetching parts for vendor ${vendor.id}:`, error);
                return { ...vendor, parts: [] };
              }
            })
          );

          return {
            ...schedule,
            vendors: vendorsWithParts
          };
        } catch (error) {
          console.error(`Error fetching vendors for schedule ${schedule.id}:`, error);
          return { ...schedule, vendors: [] };
        }
      })
    );

    res.json({
      success: true,
      data: schedulesWithDetails
    });

  } catch (error) {
    console.error("[GET Oversea Schedules] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch schedules",
      error: error.message
    });
  } finally {
    client.release();
  }
});

// ====== GET received vendors (flat list) ======
router.get("/received-vendors", async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT osv.*, vd.vendor_name, vd.vendor_code, t.trip_code,
              t.arv_to as arrival_time, 
              e_move.emp_name as move_by_name, os.schedule_code, os.model_name as schedule_model_name
       FROM oversea_schedule_vendors osv
       LEFT JOIN vendor_detail vd ON vd.id = osv.vendor_id
       LEFT JOIN trips t ON t.id = osv.trip_id
       LEFT JOIN employees e_move ON e_move.id = osv.move_by
       LEFT JOIN oversea_schedules os ON os.id = osv.oversea_schedule_id
       WHERE osv.vendor_status = 'Received' AND osv.is_active = true
       ORDER BY osv.move_at DESC`
    );

    const vendorsWithParts = await Promise.all(
      result.rows.map(async (vendor) => {
        const partsResult = await client.query(
          `SELECT 
            osp.id,
            osp.part_code,
            osp.part_name,
            osp.quantity as qty,
            osp.quantity_box as qty_box,
            osp.unit,
            osp.do_number,
            osp.remark,
            osp.status,
            TO_CHAR(osp.prod_date, 'YYYY-MM-DD') as prod_date,
            COALESCE(osp.prod_dates::jsonb, '[]'::jsonb) as prod_dates
           FROM oversea_schedule_parts osp
           WHERE osp.oversea_schedule_vendor_id = $1 AND osp.is_active = true
           ORDER BY osp.id ASC`,
          [vendor.id]
        );

        // Parse prod_dates
        const partsWithParsedDates = partsResult.rows.map((part) => ({
          ...part,
          prod_dates:
            typeof part.prod_dates === "string"
              ? JSON.parse(part.prod_dates)
              : Array.isArray(part.prod_dates)
                ? part.prod_dates
                : [],
        }));

        return {
          ...vendor,
          parts: partsWithParsedDates
        };
      })
    );

    res.json({ success: true, vendors: vendorsWithParts });
  } catch (error) {
    console.error("[GET Received Vendors] Error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch received vendors" });
  } finally {
    client.release();
  }
});

// ====== GET all vendors with IQC Progress status ======
router.get("/iqc-progress-vendors", async (req, res) => {
  const client = await pool.connect();
  try {
    // Get all vendors with vendor_status = 'IQC Progress'
    const vendorsResult = await client.query(
      `SELECT 
        osv.id,
        osv.oversea_schedule_id,
        osv.vendor_id,
        osv.do_numbers,
        osv.total_pallet,
        osv.total_item,
        osv.vendor_status,
        osv.approve_by,
        osv.approve_at,
        TO_CHAR(osv.schedule_date_ref, 'YYYY-MM-DD') as schedule_date,
        osv.stock_level_ref as stock_level,
        osv.model_name_ref as model_name,
        vd.vendor_name,
        em.emp_name as approve_by_name,
        t.trip_code,
        t.arv_to as arrival_time
       FROM oversea_schedule_vendors osv
       LEFT JOIN vendor_detail vd ON vd.id = osv.vendor_id
       LEFT JOIN employees em ON em.id = osv.approve_by
       LEFT JOIN trips t ON t.id = osv.trip_id
       WHERE osv.vendor_status = 'IQC Progress' AND osv.is_active = true
       ORDER BY osv.approve_at DESC, osv.id ASC`,
    );

    // Get parts for each vendor with prod_dates
    const vendorsWithParts = await Promise.all(
      vendorsResult.rows.map(async (vendor) => {
        const partsResult = await client.query(
          `SELECT 
            osp.id,
            osp.part_code,
            osp.part_name,
            osp.quantity as qty,
            osp.quantity_box as qty_box,
            osp.unit,
            osp.do_number,
            osp.remark,
            osp.status,
            TO_CHAR(osp.prod_date, 'YYYY-MM-DD') as prod_date,
            COALESCE(osp.prod_dates::jsonb, '[]'::jsonb) as prod_dates,
            COALESCE(osp.sample_dates::jsonb, '[]'::jsonb) as sample_dates
           FROM oversea_schedule_parts osp
           WHERE osp.oversea_schedule_vendor_id = $1 AND osp.is_active = true
           ORDER BY osp.id ASC`,
          [vendor.id],
        );

        // Parse prod_dates and sample_dates from JSON
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

// ====== GET Sample vendors ======
router.get("/sample-vendors", async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT osv.*, vd.vendor_name, vd.vendor_code, t.trip_code,
              t.arv_to as arrival_time,
              e_sample.emp_name as sample_by_name, os.schedule_code
       FROM oversea_schedule_vendors osv
       LEFT JOIN vendor_detail vd ON vd.id = osv.vendor_id
       LEFT JOIN trips t ON t.id = osv.trip_id
       LEFT JOIN employees e_sample ON e_sample.id = osv.sample_by
       LEFT JOIN oversea_schedules os ON os.id = osv.oversea_schedule_id
       WHERE osv.vendor_status = 'Sample' AND osv.is_active = true
       ORDER BY osv.sample_at DESC`
    );

    const vendorsWithParts = await Promise.all(
      result.rows.map(async (vendor) => {
        // AFTER - Add sample_dates
        const partsResult = await client.query(
          `SELECT 
            osp.id,
            osp.part_code,
            osp.part_name,
            osp.quantity as qty,
            osp.quantity_box as qty_box,
            osp.unit,
            osp.do_number,
            osp.remark,
            osp.status,
            TO_CHAR(osp.prod_date, 'YYYY-MM-DD') as prod_date,
            COALESCE(osp.prod_dates::jsonb, '[]'::jsonb) as prod_dates,
            COALESCE(osp.sample_dates::jsonb, '[]'::jsonb) as sample_dates
          FROM oversea_schedule_parts osp
          WHERE osp.oversea_schedule_vendor_id = $1 AND osp.is_active = true
          ORDER BY osp.id ASC`,
          [vendor.id]
        );

        // Parse prod_dates and sample_dates
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
          parts: partsWithParsedDates
        };
      })
    );
    res.json({ success: true, vendors: vendorsWithParts });
  } catch (error) {
    console.error("[GET Sample Vendors] Error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch sample vendors" });
  } finally {
    client.release();
  }
});

// ====== GET Complete vendors ======
router.get("/complete-vendors", async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT osv.*, vd.vendor_name, vd.vendor_code, t.trip_code,
              t.arv_to as arrival_time,
              e_complete.emp_name as complete_by_name, os.schedule_code
       FROM oversea_schedule_vendors osv
       LEFT JOIN vendor_detail vd ON vd.id = osv.vendor_id
       LEFT JOIN trips t ON t.id = osv.trip_id
       LEFT JOIN employees e_complete ON e_complete.id = osv.complete_by
       LEFT JOIN oversea_schedules os ON os.id = osv.oversea_schedule_id
       WHERE osv.vendor_status = 'Complete' AND osv.is_active = true
       ORDER BY osv.complete_at DESC`
    );

    const vendorsWithParts = await Promise.all(
      result.rows.map(async (vendor) => {
        // AFTER - Add sample_dates
        const partsResult = await client.query(
          `SELECT 
            osp.id,
            osp.part_code,
            osp.part_name,
            osp.quantity as qty,
            osp.quantity_box as qty_box,
            osp.unit,
            osp.do_number,
            osp.remark,
            osp.status,
            TO_CHAR(osp.prod_date, 'YYYY-MM-DD') as prod_date,
            COALESCE(osp.prod_dates::jsonb, '[]'::jsonb) as prod_dates,
            COALESCE(osp.sample_dates::jsonb, '[]'::jsonb) as sample_dates
          FROM oversea_schedule_parts osp
          WHERE osp.oversea_schedule_vendor_id = $1 AND osp.is_active = true
          ORDER BY osp.id ASC`,
          [vendor.id]
        );

        // Parse prod_dates and sample_dates
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
          parts: partsWithParsedDates
        };
      })
    );
    res.json({ success: true, vendors: vendorsWithParts });
  } catch (error) {
    console.error("[GET Complete Vendors] Error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch complete vendors" });
  } finally {
    client.release();
  }
});

// ====== ADD single vendor ======
router.post("/:scheduleId/vendors", async (req, res) => {
  const client = await pool.connect();
  try {
    const { scheduleId } = req.params;
    const { trip_id, vendor_id, do_numbers } = req.body;

    console.log(`[ADD Vendor] Request:`, {
      scheduleId,
      trip_id,
      vendor_id,
      do_numbers,
    });

    if (!trip_id || !vendor_id || !do_numbers) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: trip_id, vendor_id, do_numbers",
      });
    }

    await client.query("BEGIN");

    // Cek schedule exists dan ambil data schedule
    const scheduleCheck = await client.query(
      `SELECT id, schedule_date, stock_level, model_name, status 
       FROM oversea_schedules 
       WHERE id = $1 AND is_active = true`,
      [scheduleId],
    );

    if (scheduleCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Schedule not found",
      });
    }

    const schedule = scheduleCheck.rows[0];

    // Get trip arrival time
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

    // Pastikan do_numbers adalah array
    const doArray = Array.isArray(do_numbers)
      ? do_numbers.filter(d => d && d.trim())
      : [do_numbers].filter(d => d && d.trim());

    // Insert vendor dengan SEMUA data referensi dari schedule
    const result = await client.query(
      `INSERT INTO oversea_schedule_vendors
       (oversea_schedule_id, trip_id, vendor_id, do_numbers, arrival_time, 
        total_pallet, total_item, vendor_status,
        schedule_date_ref, stock_level_ref, model_name_ref)
       VALUES ($1, $2, $3, $4, $5, 0, 0, 'Pending', $6, $7, $8)
       RETURNING id, oversea_schedule_id, trip_id, vendor_id, do_numbers, arrival_time,
                 schedule_date_ref, stock_level_ref, model_name_ref`,
      [
        scheduleId,
        trip_id,
        vendor_id,
        doArray,
        arrivalTime,
        schedule.schedule_date,  // schedule_date_ref
        schedule.stock_level,    // stock_level_ref
        schedule.model_name      // model_name_ref
      ],
    );

    // Update total_vendor di schedule
    await client.query(
      `UPDATE oversea_schedules
       SET total_vendor = (
         SELECT COUNT(*) FROM oversea_schedule_vendors WHERE oversea_schedule_id = $1 AND is_active = true
       ),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [scheduleId],
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

// ====== BULK ADD VENDORS to schedule ======
router.post("/:scheduleId/vendors/bulk", async (req, res) => {
  const client = await pool.connect();
  try {
    const { scheduleId } = req.params;
    const { items } = req.body;

    console.log(`[BULK ADD Vendors] Request:`, {
      scheduleId,
      itemsCount: items?.length || 0,
      items
    });

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "items array is required with vendor data",
      });
    }

    await client.query("BEGIN");

    // Cek schedule exists
    const scheduleCheck = await client.query(
      `SELECT id, schedule_date, stock_level, model_name, status 
       FROM oversea_schedules 
       WHERE id = $1 AND is_active = true`,
      [scheduleId],
    );

    if (scheduleCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Schedule not found",
      });
    }

    const schedule = scheduleCheck.rows[0];

    const vendorIds = [];
    const vendorErrors = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const { tripId, vendorId, doNumbers, arrivalTime, totalPallet, totalItem } = item;

      try {
        // Validate required fields
        if (!tripId || !vendorId) {
          vendorErrors.push(`Item ${i + 1}: Missing tripId or vendorId`);
          continue;
        }

        // Get trip arrival time if not provided
        let finalArrivalTime = arrivalTime;
        if (!finalArrivalTime) {
          const tripCheck = await client.query(
            `SELECT arv_to FROM trips WHERE id = $1`,
            [tripId],
          );
          if (tripCheck.rowCount > 0) {
            finalArrivalTime = tripCheck.rows[0].arv_to;
          }
        }

        // Ensure doNumbers is array
        const doArray = Array.isArray(doNumbers)
          ? doNumbers.filter(d => d && String(d).trim())
          : [doNumbers].filter(d => d && String(d).trim());

        // Insert vendor - dengan SEMUA data referensi dari schedule
        const result = await client.query(
          `INSERT INTO oversea_schedule_vendors
           (oversea_schedule_id, trip_id, vendor_id, do_numbers, arrival_time, 
            total_pallet, total_item, vendor_status,
            schedule_date_ref, stock_level_ref, model_name_ref)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'Pending', $8, $9, $10)
           RETURNING id, trip_id, vendor_id, do_numbers, arrival_time, total_pallet, total_item,
                     schedule_date_ref, stock_level_ref, model_name_ref`,
          [
            scheduleId,
            tripId,
            vendorId,
            doArray,
            finalArrivalTime || null,
            totalPallet || 0,
            totalItem || 0,
            schedule.schedule_date,  // schedule_date_ref
            schedule.stock_level,    // stock_level_ref
            schedule.model_name      // model_name_ref
          ],
        );

        vendorIds.push(result.rows[0].id);
        console.log(`[BULK ADD Vendors] Vendor ${i + 1} added:`, result.rows[0].id);

      } catch (error) {
        console.error(`[BULK ADD Vendors] Error adding vendor ${i + 1}:`, error);
        vendorErrors.push(`Item ${i + 1}: ${error.message}`);
      }
    }

    // Jika semua vendor gagal
    if (vendorIds.length === 0 && vendorErrors.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Failed to add vendors",
        errors: vendorErrors,
      });
    }

    // Update total_vendor count
    await client.query(
      `UPDATE oversea_schedules
       SET total_vendor = (
         SELECT COUNT(*) FROM oversea_schedule_vendors 
         WHERE oversea_schedule_id = $1 AND is_active = true
       ),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [scheduleId],
    );

    // Update schedule totals using optimized calculation
    await updateScheduleTotals(client, scheduleId);

    await client.query("COMMIT");

    console.log(`[BULK ADD Vendors] Success: Added ${vendorIds.length} vendors`);

    res.status(201).json({
      success: true,
      message: `Successfully added ${vendorIds.length} vendor(s)`,
      vendorIds: vendorIds,
      errors: vendorErrors.length > 0 ? vendorErrors : undefined,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[BULK ADD Vendors] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to add vendors in bulk",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== ADD single part to existing vendor ======
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

    // Cek vendor exists
    const vendorCheck = await client.query(
      `SELECT id, oversea_schedule_id FROM oversea_schedule_vendors WHERE id = $1 AND is_active = true`,
      [vendorId],
    );

    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    const scheduleId = vendorCheck.rows[0].oversea_schedule_id;

    // Get part_id from kanban_master if exists
    let partId = null;
    const partRes = await client.query(
      `SELECT id, qty_per_box FROM kanban_master WHERE part_code = $1 AND is_active = true LIMIT 1`,
      [part_code.trim()],
    );

    let qtyPerBox = 1;
    if (partRes.rowCount > 0) {
      partId = partRes.rows[0].id;
      qtyPerBox = partRes.rows[0].qty_per_box || 1;
    }

    // Calculate quantity_box if not provided
    let finalQuantityBox = quantity_box;
    if (!quantity_box && quantity && qtyPerBox > 0) {
      finalQuantityBox = Math.ceil(Number(quantity) / qtyPerBox);
    }

    // Insert part
    const result = await client.query(
      `INSERT INTO oversea_schedule_parts
       (oversea_schedule_vendor_id, part_id, part_code, part_name, quantity, quantity_box, unit, do_number, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Pending')
       RETURNING id, part_code, part_name, quantity as qty, quantity_box as qty_box, unit`,
      [
        vendorId,
        partId,
        part_code,
        part_name || "",
        Number(quantity) || 0,
        finalQuantityBox || 0,
        unit || "PCS",
        do_number || "",
      ],
    );

    // Update total_item dan total_pallet di vendor using optimized calculation
    await updateVendorTotals(client, vendorId);

    // Update total_item dan total_pallet di schedule
    await updateScheduleTotals(client, scheduleId);

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

// ====== BULK insert parts ======
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
      `SELECT id, oversea_schedule_id FROM oversea_schedule_vendors WHERE id = $1 AND is_active = true`,
      [vendorId]
    );
    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }

    const scheduleId = vendorCheck.rows[0].oversea_schedule_id;
    const insertedParts = [];

    for (const item of items) {
      // Support both naming conventions (camelCase and snake_case)
      const partCode = item.partCode || item.part_code;
      const partName = item.partName || item.part_name || "";
      const quantity = item.quantity || item.qty || 0;
      const quantityBox = item.quantityBox || item.qty_box;
      const unit = item.unit || "PCS";
      const doNumber = item.doNumber || item.do_number || "";
      const remark = item.remark || "";
      const prodDate = item.prodDate || item.prod_date || null;
      const prodDates = item.prodDates || item.prod_dates || [];

      let partId = null;
      let qtyPerBox = 1;

      const kanbanCheck = await client.query(
        `SELECT id, qty_per_box FROM kanban_master WHERE part_code = $1 AND is_active = true LIMIT 1`,
        [partCode]
      );
      if (kanbanCheck.rowCount > 0) {
        partId = kanbanCheck.rows[0].id;
        qtyPerBox = kanbanCheck.rows[0].qty_per_box || 1;
      }

      // Calculate quantity_box if not provided
      let finalQuantityBox = quantityBox;
      if (!quantityBox && quantity && qtyPerBox > 0) {
        finalQuantityBox = Math.ceil(Number(quantity) / qtyPerBox);
      }

      const result = await client.query(
        `INSERT INTO oversea_schedule_parts 
          (oversea_schedule_vendor_id, part_id, part_code, part_name, quantity, quantity_box, unit, do_number, remark, prod_date, prod_dates, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11::jsonb, 'Pending') 
         RETURNING id, part_code, part_name, quantity as qty, quantity_box as qty_box, unit`,
        [vendorId, partId, partCode, partName, quantity || 0, finalQuantityBox || 0, unit || "PCS", doNumber, remark, prodDate || null, prodDates ? JSON.stringify(prodDates) : "[]"]
      );
      insertedParts.push(result.rows[0]);
    }

    // Update vendor totals using optimized pallet calculation
    await updateVendorTotals(client, vendorId);

    // Update schedule totals
    await updateScheduleTotals(client, scheduleId);

    await client.query("COMMIT");

    console.log(`[Bulk Insert Parts] Success: ${insertedParts.length} parts inserted for vendor ${vendorId}`);

    res.status(201).json({ success: true, parts: insertedParts, partIds: insertedParts.map(p => p.id) });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[Bulk Insert Parts] Error:", error);
    res.status(500).json({ success: false, message: "Failed to insert parts" });
  } finally {
    client.release();
  }
});

// ====== UPDATE schedule status bulk (New -> Scheduled) ======
router.put("/bulk/status", async (req, res) => {
  const client = await pool.connect();
  try {
    const { scheduleIds, status } = req.body;
    if (!scheduleIds || !Array.isArray(scheduleIds) || scheduleIds.length === 0) {
      return res.status(400).json({ success: false, message: "scheduleIds array is required" });
    }

    await client.query("BEGIN");

    const statusMapping = { New: "New", Schedule: "Scheduled", Received: "Received", "IQC Progress": "IQC Progress", Sample: "Sample", Complete: "Complete" };
    const dbStatus = statusMapping[status] || status;

    const result = await client.query(
      `UPDATE oversea_schedules SET status = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = ANY($2::int[]) AND is_active = true RETURNING id, schedule_code, status`,
      [dbStatus, scheduleIds]
    );

    await client.query("COMMIT");
    res.json({ success: true, updated: result.rows });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[Bulk Update Status] Error:", error);
    res.status(500).json({ success: false, message: "Failed to update schedules" });
  } finally {
    client.release();
  }
});

// ====== UPDATE vendor status (Schedule -> Received) ======
router.put("/vendors/:vendorId/status", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId } = req.params;
    const { status, moveByName } = req.body;

    await client.query("BEGIN");

    const vendorCheck = await client.query(
      `SELECT osv.id, osv.oversea_schedule_id, osv.vendor_status,
              os.schedule_date, os.stock_level, os.model_name
       FROM oversea_schedule_vendors osv
       LEFT JOIN oversea_schedules os ON os.id = osv.oversea_schedule_id
       WHERE osv.id = $1 AND osv.is_active = true`,
      [vendorId]
    );

    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }

    const scheduleId = vendorCheck.rows[0].oversea_schedule_id;
    const scheduleData = vendorCheck.rows[0];

    const vendorStatusMapping = { Received: "Received", "IQC Progress": "IQC Progress", Sample: "Sample", Complete: "Complete" };
    const newVendorStatus = vendorStatusMapping[status] || status;

    let moveById = null;
    if (moveByName) {
      const empResult = await client.query(`SELECT id FROM employees WHERE emp_name = $1 LIMIT 1`, [moveByName]);
      if (empResult.rowCount > 0) moveById = empResult.rows[0].id;
    }

    // PERBAIKAN: Recalculate vendor totals SEBELUM update status
    // Ini memastikan total_pallet yang tersimpan adalah nilai terbaru dari perhitungan
    console.log(`[Move Vendor] Recalculating totals for vendor ${vendorId} before moving to ${newVendorStatus}`);
    await updateVendorTotals(client, vendorId);

    const vendorResult = await client.query(
      `UPDATE oversea_schedule_vendors 
       SET vendor_status = $1, move_by = $2, move_at = CURRENT_TIMESTAMP,
           schedule_date_ref = $3, stock_level_ref = $4, model_name_ref = $5, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $6 AND is_active = true 
       RETURNING id, oversea_schedule_id, vendor_status, move_by, move_at, total_pallet, total_item`,
      [newVendorStatus, moveById, scheduleData.schedule_date, scheduleData.stock_level, scheduleData.model_name, vendorId]
    );

    console.log(`[Move Vendor] Vendor ${vendorId} moved to ${newVendorStatus} with total_pallet=${vendorResult.rows[0].total_pallet}`);

    const allVendorsCheck = await client.query(
      `SELECT COUNT(*) as total, SUM(CASE WHEN vendor_status = $1 THEN 1 ELSE 0 END) as matched_count
       FROM oversea_schedule_vendors WHERE oversea_schedule_id = $2 AND is_active = true`,
      [newVendorStatus, scheduleId]
    );

    const { total, matched_count } = allVendorsCheck.rows[0];
    if (parseInt(total) > 0 && parseInt(total) === parseInt(matched_count)) {
      await client.query(
        `UPDATE oversea_schedules SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND is_active = true`,
        [newVendorStatus, scheduleId]
      );
    }

    // PERBAIKAN: Update schedule totals setelah vendor dipindahkan
    await updateScheduleTotals(client, scheduleId);

    await client.query("COMMIT");
    res.json({ success: true, data: { vendor: vendorResult.rows[0], scheduleId } });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[UPDATE Vendor Status] Error:", error);
    res.status(500).json({ success: false, message: "Failed to update vendor status" });
  } finally {
    client.release();
  }
});

// ====== UPDATE PART ======
router.put("/parts/:partId", async (req, res) => {
  const client = await pool.connect();
  try {
    const { partId } = req.params;
    const { quantity, quantityBox, status, remark, prod_date, prod_dates } = req.body;

    console.log("[UPDATE Part] Request:", {
      partId,
      quantity,
      quantityBox,
      status,
      remark,
      prod_date,
      prod_dates
    });

    await client.query("BEGIN");

    // 1. Get current part info to find vendor_id
    const currentPart = await client.query(
      `SELECT id, oversea_schedule_vendor_id FROM oversea_schedule_parts WHERE id = $1 AND is_active = true`,
      [partId]
    );

    if (currentPart.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Part not found",
      });
    }

    const vendorId = currentPart.rows[0].oversea_schedule_vendor_id;

    // 2. Build update query dynamically
    const updateFields = [];
    const updateValues = [];
    let paramCount = 1;

    if (quantity !== undefined) {
      updateFields.push(`quantity = $${paramCount}`);
      updateValues.push(quantity);
      paramCount++;
    }

    if (quantityBox !== undefined) {
      updateFields.push(`quantity_box = $${paramCount}`);
      updateValues.push(quantityBox);
      paramCount++;
    }

    if (status !== undefined) {
      updateFields.push(`status = $${paramCount}`);
      updateValues.push(status);
      paramCount++;
    }

    if (remark !== undefined) {
      updateFields.push(`remark = $${paramCount}`);
      updateValues.push(remark);
      paramCount++;
    }

    if (prod_date !== undefined) {
      updateFields.push(`prod_date = $${paramCount}::date`);
      updateValues.push(prod_date);
      paramCount++;
    }

    if (prod_dates !== undefined) {
      let prodDatesValue = prod_dates;
      if (Array.isArray(prod_dates)) {
        prodDatesValue = JSON.stringify(prod_dates);
      } else if (typeof prod_dates === 'string') {
        try {
          JSON.parse(prod_dates);
          prodDatesValue = prod_dates;
        } catch {
          prodDatesValue = JSON.stringify([prod_dates]);
        }
      } else {
        prodDatesValue = '[]';
      }

      updateFields.push(`prod_dates = $${paramCount}::jsonb`);
      updateValues.push(prodDatesValue);
      paramCount++;
    }

    if (updateFields.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "No fields to update",
      });
    }

    // Add updated_at
    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    updateValues.push(partId);

    // 3. Update the part
    const result = await client.query(
      `UPDATE oversea_schedule_parts 
       SET ${updateFields.join(", ")} 
       WHERE id = $${paramCount} AND is_active = true
       RETURNING *`,
      updateValues
    );

    console.log("[UPDATE Part] Part updated:", result.rows[0]);

    // 4. IMPORTANT: Recalculate vendor totals using optimized calculation
    await updateVendorTotals(client, vendorId);

    // 5. Get schedule_id to update schedule totals
    const vendorInfo = await client.query(
      `SELECT oversea_schedule_id FROM oversea_schedule_vendors WHERE id = $1`,
      [vendorId]
    );

    if (vendorInfo.rowCount > 0) {
      const scheduleId = vendorInfo.rows[0].oversea_schedule_id;

      // 6. Recalculate schedule totals using optimized calculation
      await updateScheduleTotals(client, scheduleId);
    }

    await client.query("COMMIT");

    console.log("[UPDATE Part] Success - all totals updated");

    res.json({
      success: true,
      message: "Part updated successfully",
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[UPDATE Part] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update part",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== DELETE part ======
router.delete("/parts/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    await client.query("BEGIN");

    const partCheck = await client.query(
      `SELECT osp.id, osp.oversea_schedule_vendor_id, osv.oversea_schedule_id
       FROM oversea_schedule_parts osp
       LEFT JOIN oversea_schedule_vendors osv ON osv.id = osp.oversea_schedule_vendor_id
       WHERE osp.id = $1 AND osp.is_active = true`,
      [id]
    );

    if (partCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Part not found" });
    }

    const vendorId = partCheck.rows[0].oversea_schedule_vendor_id;
    const scheduleId = partCheck.rows[0].oversea_schedule_id;

    console.log(`[DELETE Part] Deleting part ${id}...`);

    // HARD DELETE - Remove from database completely
    const partDeleted = await client.query(
      `DELETE FROM oversea_schedule_parts WHERE id = $1`,
      [id]
    );
    console.log(`[DELETE Part] Deleted part ${id}`);

    // Update vendor totals using optimized calculation
    await updateVendorTotals(client, vendorId);

    // Update schedule totals using optimized calculation
    await updateScheduleTotals(client, scheduleId);

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Part deleted successfully",
      deleted: partDeleted.rowCount
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[DELETE Part] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete part",
      error: error.message
    });
  } finally {
    client.release();
  }
});

// ====== DELETE vendor ======
router.delete("/vendors/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    await client.query("BEGIN");

    const vendorCheck = await client.query(
      `SELECT id, oversea_schedule_id FROM oversea_schedule_vendors WHERE id = $1 AND is_active = true`,
      [id]
    );

    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }

    const scheduleId = vendorCheck.rows[0].oversea_schedule_id;

    console.log(`[DELETE Vendor] Deleting vendor ${id} and all parts...`);

    // HARD DELETE - Remove from database completely
    // 1. Delete all parts (child)
    const partsDeleted = await client.query(
      `DELETE FROM oversea_schedule_parts WHERE oversea_schedule_vendor_id = $1`,
      [id]
    );
    console.log(`[DELETE Vendor] Deleted ${partsDeleted.rowCount} parts`);

    // 2. Delete vendor (parent)
    const vendorDeleted = await client.query(
      `DELETE FROM oversea_schedule_vendors WHERE id = $1`,
      [id]
    );
    console.log(`[DELETE Vendor] Deleted vendor ${id}`);

    // 3. Update schedule totals
    // Update total_vendor count
    await client.query(
      `UPDATE oversea_schedules SET 
        total_vendor = (
          SELECT COUNT(*) FROM oversea_schedule_vendors 
          WHERE oversea_schedule_id = $1 AND is_active = true
        ),
        updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [scheduleId]
    );

    // Update totals using optimized calculation
    await updateScheduleTotals(client, scheduleId);

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Vendor and all parts deleted successfully",
      deleted: {
        parts: partsDeleted.rowCount,
        vendor: vendorDeleted.rowCount
      }
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[DELETE Vendor] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete vendor",
      error: error.message
    });
  } finally {
    client.release();
  }
});

// ====== DELETE schedule ======
router.delete("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    await client.query("BEGIN");

    // Check if schedule exists
    const scheduleCheck = await client.query(
      `SELECT id FROM oversea_schedules WHERE id = $1 AND is_active = true`,
      [id]
    );

    if (scheduleCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Schedule not found" });
    }

    console.log(`[DELETE Schedule] Deleting schedule ${id} and all related data...`);

    // HARD DELETE - Remove from database completely (cascade)
    // Order matters: Delete child records first, then parent

    // 1. Delete all parts (child of vendors)
    const partsDeleted = await client.query(
      `DELETE FROM oversea_schedule_parts 
       WHERE oversea_schedule_vendor_id IN 
       (SELECT id FROM oversea_schedule_vendors WHERE oversea_schedule_id = $1)`,
      [id]
    );
    console.log(`[DELETE Schedule] Deleted ${partsDeleted.rowCount} parts`);

    // 2. Delete all vendors (child of schedule)
    const vendorsDeleted = await client.query(
      `DELETE FROM oversea_schedule_vendors WHERE oversea_schedule_id = $1`,
      [id]
    );
    console.log(`[DELETE Schedule] Deleted ${vendorsDeleted.rowCount} vendors`);

    // 3. Delete schedule (parent)
    const scheduleDeleted = await client.query(
      `DELETE FROM oversea_schedules WHERE id = $1`,
      [id]
    );
    console.log(`[DELETE Schedule] Deleted schedule ${id}`);

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Schedule and all related data deleted successfully",
      deleted: {
        parts: partsDeleted.rowCount,
        vendors: vendorsDeleted.rowCount,
        schedule: scheduleDeleted.rowCount
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

// ====== RECALCULATE VENDOR TOTALS ======
router.put("/vendors/:vendorId/recalculate-totals", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId } = req.params;

    await client.query("BEGIN");

    // Use optimized calculation for vendor totals
    const vendorTotals = await updateVendorTotals(client, vendorId);

    // Get schedule ID untuk update schedule totals
    const vendorCheck = await client.query(
      `SELECT oversea_schedule_id FROM oversea_schedule_vendors WHERE id = $1`,
      [vendorId]
    );

    if (vendorCheck.rowCount > 0) {
      const scheduleId = vendorCheck.rows[0].oversea_schedule_id;

      // Update schedule totals using optimized calculation
      await updateScheduleTotals(client, scheduleId);
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Totals recalculated",
      data: { total_pallet: vendorTotals.totalPallet, total_item: vendorTotals.totalItem }
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[RECALCULATE TOTALS] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to recalculate totals",
      error: error.message
    });
  } finally {
    client.release();
  }
});

// ====== APPROVE VENDOR (Received -> IQC Progress + add stock) ======
router.put("/vendors/:vendorId/approve", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId } = req.params;
    const { approveByName } = req.body;

    await client.query("BEGIN");

    const vendorCheck = await client.query(
      `SELECT osv.id, osv.oversea_schedule_id, osv.vendor_status, osv.vendor_id, osv.do_numbers,
              vd.vendor_name, os.model_name, os.stock_level as schedule_stock_level
       FROM oversea_schedule_vendors osv
       LEFT JOIN vendor_detail vd ON vd.id = osv.vendor_id
       LEFT JOIN oversea_schedules os ON os.id = osv.oversea_schedule_id
       WHERE osv.id = $1 AND osv.is_active = true`,
      [vendorId]
    );

    if (vendorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }

    const vendor = vendorCheck.rows[0];
    const scheduleId = vendor.oversea_schedule_id;
    const modelName = vendor.model_name;

    // Extract stock level code
    let rawStockLevel = vendor.schedule_stock_level || "";
    let finalStockLevel = "M136";
    if (rawStockLevel) {
      const parts = rawStockLevel.split("|");
      if (parts.length > 0) {
        const code = parts[0].trim().toUpperCase();
        if (["M101", "M136", "M1Y2", "RTV"].includes(code)) finalStockLevel = code;
      }
    }

    let approveById = null;
    if (approveByName) {
      const empResult = await client.query(`SELECT id FROM employees WHERE emp_name = $1 LIMIT 1`, [approveByName]);
      if (empResult.rowCount > 0) approveById = empResult.rows[0].id;
    }

    const partsResult = await client.query(
      `SELECT osp.id, osp.part_code, osp.part_name, osp.quantity, osp.quantity_box, osp.unit,
              osp.do_number, osp.remark, TO_CHAR(osp.prod_date, 'YYYY-MM-DD') as prod_date,
              COALESCE(osp.prod_dates::jsonb, '[]'::jsonb) as prod_dates,
              km.id as kanban_master_id, km.model
       FROM oversea_schedule_parts osp
       LEFT JOIN kanban_master km ON km.part_code = osp.part_code AND km.is_active = true
       WHERE osp.oversea_schedule_vendor_id = $1 AND osp.is_active = true
       ORDER BY osp.id ASC`,
      [vendorId]
    );

    // CRITICAL: Fetch QC checks Complete untuk calculate sample_dates
    const qcChecksResult = await client.query(
      `SELECT part_code, TO_CHAR(production_date, 'YYYY-MM-DD') as production_date, status
       FROM qc_checks
       WHERE status = 'Complete' AND is_active = true`
    );
    const qcChecks = qcChecksResult.rows;

    // Helper: Check if production date is complete
    const isProductionDateComplete = (partCode, prodDate) => {
      if (!partCode || !prodDate) return false;
      const normalizedProdDate = prodDate.split("T")[0];
      return qcChecks.some(
        (qc) =>
          qc.part_code === partCode &&
          qc.production_date === normalizedProdDate &&
          qc.status === "Complete"
      );
    };

    // Update sample_dates for each part (dates yang BELUM complete saat masuk IQC Progress)
    for (const part of partsResult.rows) {
      const prodDates = typeof part.prod_dates === 'string'
        ? JSON.parse(part.prod_dates)
        : Array.isArray(part.prod_dates)
          ? part.prod_dates
          : [];

      if (prodDates.length > 0) {
        // Calculate incomplete dates (yang perlu sample)
        const incompleteDates = prodDates.filter(
          (date) => !isProductionDateComplete(part.part_code, date)
        );

        // Save sample_dates ke database (STATIC - tidak berubah setelah ini)
        await client.query(
          `UPDATE oversea_schedule_parts 
           SET sample_dates = $1::jsonb 
           WHERE id = $2`,
          [JSON.stringify(incompleteDates), part.id]
        );

        // NEW: Create qc_checks entries dengan status "M136 Part" untuk setiap incomplete date
        for (const date of incompleteDates) {
          // Check if entry already exists
          const existingCheck = await client.query(
            `SELECT id, status FROM qc_checks 
             WHERE part_code = $1 
             AND production_date = $2::date 
             AND is_active = true
             LIMIT 1`,
            [part.part_code, date]
          );

          if (existingCheck.rowCount > 0) {
            // Entry exists - only update if status is NOT Complete
            const currentStatus = existingCheck.rows[0].status;
            if (currentStatus !== 'Complete') {
              await client.query(
                `UPDATE qc_checks 
                 SET status = $3,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [existingCheck.rows[0].id, 'M136 Part']
              );
            }
            // If status is Complete, don't touch it
          } else {
            // Entry doesn't exist - create new
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
                'M136',
                'M136 Part',  // Status = "M136 Part" (waiting for approval)
                vendorId,
                part.id,
                approveByName || 'System'
              ]
            );
          }
        }
      }
    }

    const stockResults = [];
    for (const part of partsResult.rows) {
      const qty = parseInt(part.quantity) || 0;
      if (qty > 0) {
        let quantityBefore = 0;
        if (part.kanban_master_id) {
          const stockQuery = await client.query(
            `SELECT stock_m101, stock_m136, stock_m1y2, stock_rtv FROM kanban_master WHERE id = $1`,
            [part.kanban_master_id]
          );
          if (stockQuery.rows[0]) {
            const stockRow = stockQuery.rows[0];
            if (finalStockLevel === "M101") quantityBefore = parseInt(stockRow.stock_m101) || 0;
            else if (finalStockLevel === "M136") quantityBefore = parseInt(stockRow.stock_m136) || 0;
            else if (finalStockLevel === "M1Y2") quantityBefore = parseInt(stockRow.stock_m1y2) || 0;
            else if (finalStockLevel === "RTV") quantityBefore = parseInt(stockRow.stock_rtv) || 0;
          }
        }

        const quantityAfter = quantityBefore + qty;

        const movementResult = await client.query(
          `INSERT INTO stock_movements (part_id, part_code, part_name, movement_type, stock_level,
            quantity, quantity_before, quantity_after, source_type, source_id, source_reference,
            model, production_date, remark, moved_by, moved_by_name, moved_at, is_active)
           VALUES ($1, $2, $3, 'IN', $4, $5, $6, $7, $8, $9, $10, $11, $12::date, $13, $14, $15, CURRENT_TIMESTAMP, true)
           RETURNING id`,
          [part.kanban_master_id, part.part_code, part.part_name, finalStockLevel, qty, quantityBefore, quantityAfter,
            "oversea_schedule", vendorId, part.do_number || vendor.do_numbers, part.model || modelName,
          part.prod_date || null, part.remark || `Approved from oversea vendor: ${vendor.vendor_name || "Unknown"}`,
            approveById, approveByName || null]
        );

        if (part.kanban_master_id) {
          let updateColumn = "stock_m136";
          if (finalStockLevel === "M101") updateColumn = "stock_m101";
          else if (finalStockLevel === "M1Y2") updateColumn = "stock_m1y2";
          else if (finalStockLevel === "RTV") updateColumn = "stock_rtv";

          await client.query(
            `UPDATE kanban_master SET ${updateColumn} = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [quantityAfter, part.kanban_master_id]
          );
        }

        stockResults.push({ part_code: part.part_code, movement_id: movementResult.rows[0].id, quantity_added: qty, stock_before: quantityBefore, stock_after: quantityAfter });
      }
    }

    const vendorResult = await client.query(
      `UPDATE oversea_schedule_vendors 
       SET vendor_status = 'IQC Progress', approve_by = $2, approve_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND is_active = true RETURNING id, oversea_schedule_id, vendor_status, approve_by, approve_at`,
      [vendorId, approveById]
    );

    // PERBAIKAN: Recalculate vendor dan schedule totals setelah approve
    await updateVendorTotals(client, vendorId);

    const allVendorsCheck = await client.query(
      `SELECT COUNT(*) as total, SUM(CASE WHEN vendor_status = 'IQC Progress' THEN 1 ELSE 0 END) as matched_count
       FROM oversea_schedule_vendors WHERE oversea_schedule_id = $1 AND is_active = true`,
      [scheduleId]
    );

    const { total, matched_count } = allVendorsCheck.rows[0];
    if (parseInt(total) > 0 && parseInt(total) === parseInt(matched_count)) {
      await client.query(
        `UPDATE oversea_schedules SET status = 'IQC Progress', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND is_active = true`,
        [scheduleId]
      );
    }

    // PERBAIKAN: Update schedule totals
    await updateScheduleTotals(client, scheduleId);

    // NOTE: QC checks akan dibuat saat user approve di M136 Part tab
    // Mengikuti pattern Local Schedule (M101 Part)
    // Frontend akan display prod_dates yang belum complete sebagai SAMPLE

    await client.query("COMMIT");
    res.json({
      success: true,
      message: "Vendor approved and parts added to stock",
      data: {
        vendor: vendorResult.rows[0],
        stockLevel: finalStockLevel,
        stockMovements: stockResults
      }
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[APPROVE Vendor] Error:", error);
    res.status(500).json({ success: false, message: "Failed to approve vendor" });
  } finally {
    client.release();
  }
});

// ====== MOVE VENDOR TO SAMPLE/PASS (from IQC Progress) ======
router.put("/vendors/:vendorId/move-to-sample", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId } = req.params;
    const { moveByName } = req.body;

    await client.query("BEGIN");

    // Get employee ID from name
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

    // Update vendor status to Sample with sample_by and sample_at
    const vendorResult = await client.query(
      `UPDATE oversea_schedule_vendors 
       SET vendor_status = 'Sample', 
           sample_by = $2,
           sample_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND is_active = true 
       RETURNING id, oversea_schedule_id, vendor_status, sample_by, sample_at`,
      [vendorId, sampleById],
    );

    if (vendorResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    const scheduleId = vendorResult.rows[0].oversea_schedule_id;

    // PERBAIKAN: Recalculate vendor dan schedule totals
    await updateVendorTotals(client, vendorId);
    await updateScheduleTotals(client, scheduleId);

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Vendor moved to Pass",
      data: vendorResult.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[MOVE TO SAMPLE] Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to move vendor to Pass",
      error: error.message,
    });
  } finally {
    client.release();
  }
});

// ====== MOVE VENDOR TO COMPLETE (from Pass/Sample) ======
router.put("/vendors/:vendorId/move-to-complete", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vendorId } = req.params;
    const { moveByName } = req.body;

    await client.query("BEGIN");

    // Get employee ID from name
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

    // Update vendor status to Complete
    const vendorResult = await client.query(
      `UPDATE oversea_schedule_vendors 
       SET vendor_status = 'Complete', 
           complete_by = $2,
           complete_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND is_active = true 
       RETURNING id, oversea_schedule_id, vendor_status, complete_by, complete_at`,
      [vendorId, completeById],
    );

    if (vendorResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    const scheduleId = vendorResult.rows[0].oversea_schedule_id;

    // PERBAIKAN: Recalculate vendor dan schedule totals
    await updateVendorTotals(client, vendorId);
    await updateScheduleTotals(client, scheduleId);

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Vendor moved to Complete",
      data: vendorResult.rows[0],
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

// ====== UPDATE schedule ======
router.put("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { stockLevel, modelName, scheduleDate } = req.body;

    await client.query("BEGIN");

    const updates = [];
    const params = [];
    let paramCount = 0;

    if (stockLevel !== undefined) { paramCount++; updates.push(`stock_level = $${paramCount}`); params.push(stockLevel); }
    if (modelName !== undefined) { paramCount++; updates.push(`model_name = $${paramCount}`); params.push(modelName); }
    if (scheduleDate !== undefined) { paramCount++; updates.push(`schedule_date = $${paramCount}::date`); params.push(scheduleDate); }

    if (updates.length === 0) return res.status(400).json({ success: false, message: "No fields to update" });

    paramCount++;
    params.push(id);

    const result = await client.query(
      `UPDATE oversea_schedules SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $${paramCount} AND is_active = true
       RETURNING id, schedule_code, stock_level, model_name, TO_CHAR(schedule_date, 'YYYY-MM-DD') as schedule_date, status`,
      params
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Schedule not found" });
    }

    await client.query("COMMIT");
    res.json({ success: true, schedule: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[Update Schedule] Error:", error);
    res.status(500).json({ success: false, message: "Failed to update schedule" });
  } finally {
    client.release();
  }
});

module.exports = router;