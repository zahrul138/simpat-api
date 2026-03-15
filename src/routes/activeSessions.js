const express = require("express");
const pool    = require("../db");
const router  = express.Router();

const activeSessions = new Map();
const TIMEOUT_NORMAL  = 24 * 60 * 60 * 1000; 
const TIMEOUT_CLOSING = 10 * 1000;            

const cleanupStale = () => {
  const now = Date.now();
  for (const [userId, session] of activeSessions.entries()) {
    const timeout = session.isClosing ? TIMEOUT_CLOSING : TIMEOUT_NORMAL;
    if (now - session.lastSeen > timeout) activeSessions.delete(userId);
  }
};

const getOnlineByDept = () => {
  cleanupStale();
  const map = {};
  for (const s of activeSessions.values()) {
    const dept = s.deptCode || "Unknown";
    map[dept] = (map[dept] || 0) + 1;
  }
  return Object.entries(map)
    .map(([dept_code, online_count]) => ({ dept_code, online_count }))
    .sort((a, b) => b.online_count - a.online_count);
};

const getOnlineUsers = () => {
  cleanupStale();
  const byDept = {};
  for (const [userId, s] of activeSessions.entries()) {
    const dept = s.deptCode || "Unknown";
    if (!byDept[dept]) byDept[dept] = [];
    byDept[dept].push({
      userId,
      empName:     s.empName,
      deptCode:    s.deptCode,
      loginTime:   new Date(s.loginTime).toISOString(),
      lastSeen:    new Date(s.lastSeen).toISOString(),
      currentPage: s.currentPage || "/",
    });
  }
  for (const dept of Object.keys(byDept)) {
    byDept[dept].sort((a, b) => new Date(a.loginTime) - new Date(b.loginTime));
  }
  return byDept;
};

router.post("/heartbeat", async (req, res) => {
  const { userId, currentPage } = req.body;
  if (!userId) return res.status(400).json({ success: false, message: "userId required" });

  try {
    // Ambil data dari DB
    const { rows } = await pool.query(
      `SELECT e.emp_name, d.dept_code
       FROM employees e
       LEFT JOIN departments d ON d.id = e.dept_id
       WHERE e.id = $1 LIMIT 1`,
      [userId]
    );

    const empName  = rows[0]?.emp_name  || "Unknown";
    const deptCode = rows[0]?.dept_code || "Unknown";

    const existing = activeSessions.get(String(userId));
    activeSessions.set(String(userId), {
      lastSeen:    Date.now(),
      loginTime:   existing ? existing.loginTime : Date.now(),
      empName,
      deptCode,
      currentPage: currentPage || existing?.currentPage || "/",
    });

    cleanupStale();
    res.json({ success: true, onlineCount: activeSessions.size });
  } catch (e) {
    console.error("[heartbeat]", e.message);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

router.get("/count", (req, res) => {
  cleanupStale();
  res.json({ success: true, onlineCount: activeSessions.size });
});

router.get("/online", (req, res) => {
  cleanupStale();
  const list = [];
  for (const [userId, s] of activeSessions.entries()) {
    list.push({
      userId,
      empName:     s.empName,
      deptCode:    s.deptCode,
      loginTime:   new Date(s.loginTime).toISOString(),
      lastSeen:    new Date(s.lastSeen).toISOString(),
      currentPage: s.currentPage,
    });
  }
  res.json({ success: true, data: list, total: list.length });
});

router.delete("/logout", (req, res) => {
  let userId = req.body?.userId;

  if (!userId && typeof req.body === "string") {
    try { userId = JSON.parse(req.body)?.userId; } catch {}
  }

  if (userId) activeSessions.delete(String(userId));
  cleanupStale();
  res.json({ success: true, onlineCount: activeSessions.size });
});

router.patch("/mark-closing", (req, res) => {
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { userId } = body || {};
  if (userId) {
    const session = activeSessions.get(String(userId));
    if (session) {
      activeSessions.set(String(userId), { ...session, isClosing: true, lastSeen: Date.now() });
    }
  }
  res.json({ ok: true });
});

router.delete("/logout-with-log", async (req, res) => {
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { userId } = body || {};

  if (userId) activeSessions.delete(String(userId));
  cleanupStale();

  try {
    const { rows } = await pool.query(
      'SELECT emp_name, username FROM employees WHERE id = $1 LIMIT 1',
      [userId]
    );
    const empName = rows[0]?.emp_name || "Unknown";
    const username = rows[0]?.username || userId;
    await pool.query(
      `INSERT INTO activity_logs (emp_id, emp_name, action, description)
       VALUES ($1, $2, 'LOGOUT', $3)`,
      [userId || null, empName, `User "${username}" closed the browser tab`]
    );
  } catch (e) {
    console.error("[logout-with-log]", e.message);
  }

  res.json({ success: true });
});

module.exports = router;
module.exports.getOnlineByDept = getOnlineByDept;
module.exports.getOnlineUsers  = getOnlineUsers;