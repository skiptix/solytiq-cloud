import crypto from 'crypto';
import { pool } from './db';

function printBanner(token: string) {
  const pad = ' '.repeat(Math.max(0, Math.floor((58 - token.length) / 2)));
  const line = '█'.repeat(62);
  console.log(`\n\x1b[43m\x1b[30m${line}\x1b[0m`);
  console.log(`\x1b[43m\x1b[30m█                                                            █\x1b[0m`);
  console.log(`\x1b[43m\x1b[30m█     !!  SOLYTIQ CLOUD — INITIAL SETUP TOKEN  !!            █\x1b[0m`);
  console.log(`\x1b[43m\x1b[30m█                                                            █\x1b[0m`);
  console.log(`\x1b[43m\x1b[30m${line}\x1b[0m`);
  console.log(`\x1b[1m\x1b[97m\x1b[44m${pad}  ${token}  ${pad}\x1b[0m`);
  console.log(`\x1b[43m\x1b[30m${line}\x1b[0m`);
  console.log(`\x1b[90m   Paste this token into the Setup Wizard → Security Verification.\x1b[0m`);
  console.log(`\x1b[90m   A new token is generated each time the system resets.\x1b[0m\n`);
}

export async function generateAndLogSetupToken(): Promise<string> {
  const token = crypto.randomBytes(18).toString('base64url');
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('setup_token', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [token]
  );
  printBanner(token);
  return token;
}

// On startup: re-print existing token if present, otherwise generate a new one.
export async function ensureSetupTokenLogged(): Promise<void> {
  const result = await pool.query<{ value: string }>(
    `SELECT value FROM app_settings WHERE key = 'setup_token'`
  );
  if (result.rows[0]) {
    printBanner(result.rows[0].value);
  } else {
    await generateAndLogSetupToken();
  }
}

// Re-print the current token to logs (triggered by frontend button).
export async function logSetupToken(): Promise<boolean> {
  const result = await pool.query<{ value: string }>(
    `SELECT value FROM app_settings WHERE key = 'setup_token'`
  );
  if (!result.rows[0]) return false;
  printBanner(result.rows[0].value);
  return true;
}

export async function clearSetupToken(): Promise<void> {
  await pool.query(`DELETE FROM app_settings WHERE key = 'setup_token'`);
}
