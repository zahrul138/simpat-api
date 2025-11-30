// src/index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");


// bikin koneksi DB di awal biar kelihatan log "Connected"
require("./db");

// ====== Routes ======
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const deptRoutes = require("./routes/departments");
const customersRoutes = require("./routes/customers");
const productionSchedulesRoutes = require("./routes/productionSchedules");

// NEW: routes yang tadi bikin 404
const localSchedulesRoutes = require("./routes/localSchedules");
const localScheduleVendorsRoutes = require("./routes/localScheduleVendors");
const mastersRoutes = require("./routes/masters");
const kanbanMasterRouter = require("./routes/kanbanMaster");
const localSchedulePartsRoutes = require("./routes/localScheduleParts");
const vendorsRoutes = require("./routes/vendors");
const warningSettingsRoutes = require('./routes/warningSettings');


// ====== App setup ======
const app = express();

// CORS (allow FRONTEND_URL + localhost)
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
app.use(
  cors({
    origin: (origin, cb) => {
      // allow no-origin (Postman) + localhost:* + FRONTEND_URL
      const ok =
        !origin ||
        origin === FRONTEND_URL ||
        /^http:\/\/localhost:\d+$/.test(origin);
      cb(null, ok);
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

// ====== Health check ======
app.get("/", (req, res) => {
  res.json({ ok: true, name: "SIMPAT API", port: process.env.PORT });
});

// ====== Mount routes (PASTI setelah app dibuat) ======
app.use("/auth", authRoutes);
app.use("/users", userRoutes);
app.use("/departments", deptRoutes);
app.use("/api/customers", customersRoutes);
app.use("/api/production-schedules", productionSchedulesRoutes);

// NEW: yang dipakai AddLocalSchedulePage
app.use("/api/local-schedules", localSchedulesRoutes);          
app.use("/api/local-schedules", localScheduleVendorsRoutes);    
app.use("/api/masters", mastersRoutes);      
app.use("/api/kanban-master", kanbanMasterRouter);      
app.use("/api/local-schedules", localSchedulePartsRoutes);
app.use("/api/vendors", vendorsRoutes);
app.use('/api/warning-settings', warningSettingsRoutes);

            

// ====== 404 fallback ======
app.use((req, res) => {
  res.status(404).json({
    message: "Route not found",
    method: req.method,
    path: req.originalUrl,
  });
});

// ====== Error handler ======
app.use((err, req, res, next) => {
  console.error("[Unhandled Error]", err);
  res
    .status(err.status || 500)
    .json({ message: err.message || "Internal Server Error" });
});

// ====== Start ======
const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`🚀 API running on http://localhost:${port}`);
});
