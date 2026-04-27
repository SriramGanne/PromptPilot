import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const CONFIG_KEYS = [
  'TOGETHER_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
];

function parseEnvFile(content) {
  const result = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Returns all 5 API keys merged from:
 *  1. ~/.promptpilot/config (JSON, lowest priority)
 *  2. .env.local in process.cwd()
 *  3. process.env (highest priority — set by Claude Code from settings.json env block)
 */
export function getConfig() {
  const config = {};

  const globalConfigPath = join(homedir(), '.promptpilot', 'config');
  if (existsSync(globalConfigPath)) {
    try {
      const parsed = JSON.parse(readFileSync(globalConfigPath, 'utf8'));
      for (const key of CONFIG_KEYS) {
        if (parsed[key]) config[key] = parsed[key];
      }
    } catch (err) {
      console.warn('Warning: Could not parse ~/.promptpilot/config:', err.message);
    }
  }

  const envLocalPath = join(process.cwd(), '.env.local');
  if (existsSync(envLocalPath)) {
    try {
      const envVars = parseEnvFile(readFileSync(envLocalPath, 'utf8'));
      for (const key of CONFIG_KEYS) {
        if (envVars[key]) config[key] = envVars[key];
      }
    } catch (err) {
      console.warn('Warning: Could not read .env.local:', err.message);
    }
  }

  for (const key of CONFIG_KEYS) {
    if (process.env[key]) config[key] = process.env[key];
  }

  return config;
}
