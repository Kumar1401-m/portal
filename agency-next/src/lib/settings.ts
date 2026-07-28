/**
 * Agency settings — key/value rows in the existing `settings` table.
 *
 * The keys mirror the original Express `settingsService` exactly, so the two
 * apps stay in sync: change the invoice prefix here and the old portal picks
 * up the same value. Secrets are never handed to the browser in full.
 */
import "server-only";
import { query, execute } from "./db";

export const SETTING_DEFAULTS = {
  company_name: "NVK Hub",
  powered_by: "Powered by Venkat",
  company_logo_url: "",
  contact_number: "",
  company_email: "",
  business_address: "",
  razorpay_key_id: "",
  razorpay_key_secret: "",
  invoice_prefix: "INV",
  processing_fee_percent: "2.60",
  tax_percent: "0",
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type Settings = Record<SettingKey, string>;

/** Keys that must never be rendered back to the browser. */
export const SECRET_KEYS: SettingKey[] = ["razorpay_key_secret"];

export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];

export function isSettingKey(k: string): k is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTING_DEFAULTS, k);
}

/** All settings, defaults merged under whatever is stored. */
export async function getSettings(): Promise<Settings> {
  const merged: Settings = { ...SETTING_DEFAULTS };
  try {
    const rows = await query<{ setting_key: string; setting_value: string | null }>(
      "SELECT setting_key, setting_value FROM settings"
    );
    for (const r of rows) {
      if (isSettingKey(r.setting_key)) merged[r.setting_key] = r.setting_value ?? "";
    }
  } catch (err) {
    console.warn("settings load failed, using defaults:", err instanceof Error ? err.message : err);
  }
  return merged;
}

/** Settings safe to render: secrets collapse to a "<key>_set" boolean. */
export async function getPublicSettings(): Promise<
  Omit<Settings, "razorpay_key_secret"> & { razorpay_key_secret_set: boolean }
> {
  const all = await getSettings();
  const { razorpay_key_secret, ...rest } = all;
  return { ...rest, razorpay_key_secret_set: Boolean(razorpay_key_secret) };
}

/** Upsert a batch of settings. Unknown keys and blank secrets are ignored. */
export async function saveSettings(values: Partial<Settings>): Promise<void> {
  for (const [k, v] of Object.entries(values)) {
    if (!isSettingKey(k)) continue;
    // A blank secret means "leave it alone", not "clear it".
    if (SECRET_KEYS.includes(k) && !v) continue;
    await execute(
      `INSERT INTO settings (setting_key, setting_value) VALUES (?,?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [k, v == null ? "" : String(v)]
    );
  }
}
