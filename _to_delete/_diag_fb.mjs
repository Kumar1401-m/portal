import mysql from "mysql2/promise";
import fs from "fs";

const envPath = new URL("./.env.local", import.meta.url);
const raw = fs.readFileSync(envPath, "utf8");
const env = {};
for (const line of raw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const pool = mysql.createPool({
  host: env.DB_HOST || "localhost",
  port: Number(env.DB_PORT || 3306),
  user: env.DB_USER || "root",
  password: env.DB_PASSWORD || "",
  database: env.DB_NAME || "agency_erp",
});

const [rows] = await pool.execute(
  `SELECT id, name, ig_username, ig_user_id, fb_page_id,
          (ig_access_token IS NOT NULL AND ig_access_token <> '') AS has_token,
          CHAR_LENGTH(ig_access_token) AS token_len
     FROM clients
    WHERE ig_username LIKE '%4insite%' OR name LIKE '%4insite%' OR ig_username LIKE '%insite%'`
);
console.log("DB rows:", JSON.stringify(rows, null, 2));

if (rows.length) {
  const c = rows[0];
  console.log("\n--- comparing ids ---");
  console.log("ig_user_id :", c.ig_user_id);
  console.log("fb_page_id :", c.fb_page_id);
  console.log("same value?:", c.ig_user_id && c.fb_page_id && c.ig_user_id === c.fb_page_id);
}

await pool.end();
