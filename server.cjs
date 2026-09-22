const http = require("http");
const url = require("url");
const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const PORT = parseInt(process.env.PORT || "8791", 10);
const DB_PATH = process.env.DB_PATH || "/var/lib/lucid/beta_intake.sqlite";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "lucid2026admin";

// Initialize SQLite database
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS beta_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    phone_model TEXT,
    os_version TEXT,
    target_apps TEXT,
    focus_goal TEXT,
    code TEXT,
    client_ip TEXT,
    user_agent TEXT,
    raw_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_code ON beta_applications(code);
  CREATE INDEX IF NOT EXISTS idx_created_at ON beta_applications(created_at);
`);

const stmtInsert = db.prepare(`
  INSERT INTO beta_applications 
  (created_at, phone_model, os_version, target_apps, focus_goal, code, client_ip, user_agent, raw_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtCount = db.prepare(`SELECT COUNT(*) as total FROM beta_applications`);
const stmtList = db.prepare(`SELECT id, created_at, phone_model, os_version, target_apps, focus_goal, code, client_ip FROM beta_applications ORDER BY id DESC LIMIT 500`);
const stmtAllForExport = db.prepare(`SELECT id, created_at, phone_model, os_version, target_apps, focus_goal, code, client_ip FROM beta_applications ORDER BY id ASC`);

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
}

function escapeCsvField(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

function formatToBeijingTime(isoStr) {
  if (!isoStr) return "-";
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return String(isoStr);
    // 转换为北京时间 (Asia/Shanghai, UTC+8)
    const formatter = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    // 部分 Node 环境下的格式可能是 2026/09/22 18:05:38
    return formatter.format(d).replace(/\//g, "-");
  } catch (e) {
    return String(isoStr);
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const server = http.createServer((req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname.replace(/\/+$/, "") || "/";
  const query = parsedUrl.query;

  // Extract client IP
  const clientIp = (req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const userAgent = req.headers["user-agent"] || "";

  // 1. Healthcheck & Stats: /api/intake/stats or /lucid/api/intake/stats
  if (req.method === "GET" && (pathname.endsWith("/stats") || pathname.endsWith("/healthz"))) {
    const { total } = stmtCount.get();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, status: "healthy", total_submissions: total }));
    return;
  }

  // 2. Submit Intake: POST /api/intake or /lucid/api/intake or /api/intake/submit
  if (req.method === "POST" && (pathname.endsWith("/intake") || pathname.endsWith("/submit"))) {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 64) {
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        let payload = {};
        if (body.trim().startsWith("{")) {
          payload = JSON.parse(body);
        } else {
          const params = new URLSearchParams(body);
          for (const [k, v] of params.entries()) {
            payload[k] = v;
          }
        }

        const phoneModel = (payload.deviceModel || payload.phone_model || payload.model || "").trim();
        const osVersion = (payload.androidVersion || payload.os_version || payload.systemVersion || "").trim();
        const targetApps = (payload.targetApps || payload.target_apps || payload.apps || "").trim();
        const focusGoal = (payload.focusGoal || payload.focus_goal || payload.goal || "").trim();
        const code = (payload.inviteCode || payload.code || "").trim();
        const createdAt = new Date().toISOString();

        const result = stmtInsert.run(
          createdAt,
          phoneModel,
          osVersion,
          targetApps,
          focusGoal,
          code,
          clientIp,
          userAgent,
          body
        );

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true,
          message: "内测问卷数据已成功保存至云服务器数据库",
          id: Number(result.lastInsertRowid),
          code: code
        }));
      } catch (err) {
        console.error("Intake insert error:", err);
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "提交处理失败: " + err.message }));
      }
    });
    return;
  }

  // 3. View JSON Records: GET .../records?token=xxx
  if (req.method === "GET" && pathname.endsWith("/records")) {
    if (query.token !== ADMIN_TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized: Invalid or missing token" }));
      return;
    }
    const records = stmtList.all();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, count: records.length, records }));
    return;
  }

  // 4. Export CSV: GET .../export.csv?token=xxx
  if (req.method === "GET" && pathname.endsWith("/export.csv")) {
    if (query.token !== ADMIN_TOKEN) {
      res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Unauthorized: Invalid token");
      return;
    }

    const records = stmtAllForExport.all();
    const headers = ["ID", "提交时间 (北京时间)", "手机型号", "系统版本", "防守目标应用", "专注目标与痛点", "分配激活码", "用户IP"];
    let csv = "\uFEFF" + headers.map(escapeCsvField).join(",") + "\r\n";

    for (const r of records) {
      const row = [
        r.id,
        formatToBeijingTime(r.created_at),
        r.phone_model,
        r.os_version,
        r.target_apps,
        r.focus_goal,
        r.code,
        r.client_ip
      ];
      csv += row.map(escapeCsvField).join(",") + "\r\n";
    }

    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="lucid_beta_submissions_${Date.now()}.csv"`
    });
    res.end(csv);
    return;
  }

  // 5. Admin Dashboard: GET .../admin?token=xxx
  if (req.method === "GET" && pathname.endsWith("/admin")) {
    if (query.token !== ADMIN_TOKEN) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <div style="font-family:sans-serif;max-width:440px;margin:60px auto;padding:24px;border:1px solid #ddd;border-radius:12px;text-align:center;">
          <h2 style="color:#C0392B;">🔐 管理员访问受限</h2>
          <p style="color:#666;font-size:14px;line-height:1.6;">请在访问链接后附带管理员密钥参数，例如：</p>
          <code style="background:#f1f1f1;padding:6px 10px;border-radius:6px;display:inline-block;margin-top:8px;">?token=lucid2026admin</code>
        </div>
      `);
      return;
    }

    const { total } = stmtCount.get();
    const records = stmtList.all();

    const rowsHtml = records.map(r => `
      <tr>
        <td style="padding:12px 10px;border-bottom:1px solid #1E2822;color:#8F9B93;">${r.id}</td>
        <td style="padding:12px 10px;border-bottom:1px solid #1E2822;font-family:monospace;font-size:12px;white-space:nowrap;color:#C9D6CE;">${escapeHtml(formatToBeijingTime(r.created_at))}</td>
        <td style="padding:12px 10px;border-bottom:1px solid #1E2822;font-weight:600;color:#FFF;">${escapeHtml(r.phone_model || "-")}</td>
        <td style="padding:12px 10px;border-bottom:1px solid #1E2822;color:#A8B3AC;">${escapeHtml(r.os_version || "-")}</td>
        <td style="padding:12px 10px;border-bottom:1px solid #1E2822;"><span style="background:rgba(40,199,111,0.15);color:#28C76F;padding:2px 8px;border-radius:4px;font-size:12px;">${escapeHtml(r.target_apps || "-")}</span></td>
        <td style="padding:12px 10px;border-bottom:1px solid #1E2822;color:#D8E2DC;max-width:260px;word-break:break-word;">${escapeHtml(r.focus_goal || "-")}</td>
        <td style="padding:12px 10px;border-bottom:1px solid #1E2822;font-family:monospace;font-weight:700;color:#E5C158;">${escapeHtml(r.code || "-")}</td>
        <td style="padding:12px 10px;border-bottom:1px solid #1E2822;font-size:12px;color:#78867E;">${escapeHtml(r.client_ip || "-")}</td>
      </tr>
    `).join("");

    const exportPath = pathname.replace(/\/admin$/, "/export.csv");

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>清醒一下 (LUCID) - 内测问卷实时看板</title>
  <style>
    body { margin:0; background:#080C0A; color:#E1E9E4; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; padding:24px; }
    .container { max-width:1100px; margin:0 auto; }
    .header { display:flex; justify-content:space-between; align-items:center; margin-bottom:24px; flex-wrap:wrap; gap:16px; }
    .title { font-size:22px; font-weight:800; color:#FFF; display:flex; align-items:center; gap:8px; }
    .badge { background:rgba(229,193,88,0.2); color:#E5C158; padding:6px 14px; border-radius:20px; font-size:13px; font-weight:700; border:1px solid rgba(229,193,88,0.3); }
    .actions { display:flex; gap:12px; align-items:center; }
    .btn { background:linear-gradient(180deg,#E5C158 0%,#CFA53E 100%); color:#080C0A; text-decoration:none; padding:10px 18px; border-radius:8px; font-weight:700; font-size:14px; box-shadow:0 4px 14px rgba(229,193,88,0.25); display:inline-flex; align-items:center; gap:6px; transition:transform 0.1s; }
    .btn:active { transform:scale(0.98); }
    .table-wrap { background:#0E1411; border:1px solid #1E2A22; border-radius:12px; overflow-x:auto; box-shadow:0 8px 30px rgba(0,0,0,0.5); }
    table { width:100%; border-collapse:collapse; text-align:left; font-size:13px; }
    th { padding:14px 10px; background:#121B16; color:#95A39B; font-weight:600; border-bottom:1px solid #1E2A22; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <div class="title">⚡ 清醒一下 (LUCID) 种子用户问卷实时数据库</div>
        <div style="font-size:13px;color:#78867E;margin-top:6px;">自主云服务器 SQLite 持久化 · 数据 100% 自主可控</div>
      </div>
      <div class="actions">
        <span class="badge">累计报名: ${total} 人</span>
        <a href="${exportPath}?token=${ADMIN_TOKEN}" class="btn" download>📥 一键导出 Excel (CSV)</a>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>提交时间 (北京时间)</th>
            <th>手机型号</th>
            <th>系统版本</th>
            <th>想防守的应用</th>
            <th>专注痛点与目标</th>
            <th>激活码</th>
            <th>访客 IP</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml || '<tr><td colspan="8" style="text-align:center;padding:50px;color:#78867E;">暂无内测报名记录，待首位用户提交</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // Fallback 404
  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error: "Not Found", path: pathname }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[LUCID-BETA-INTAKE] Server listening on http://127.0.0.1:${PORT}`);
  console.log(`[LUCID-BETA-INTAKE] SQLite database: ${DB_PATH}`);
});
