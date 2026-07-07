#!/usr/bin/env node
// Verify tables/columns/functions exist in the deployed Supabase schema (via PostgREST).
// Usage: node scripts/check-schema.mjs <table>[:col1,col2] [rpc:<function>] ...
// Example: node scripts/check-schema.mjs ai_messages:metadata conversations rpc:match_chunks
// Exit code 1 if anything is missing (i.e. a migration in backend/sql/ was not applied).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(join(root, 'backend/.env'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);
const { SUPABASE_URL, SUPABASE_KEY } = env;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_KEY missing in backend/.env');
  process.exit(2);
}
const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node scripts/check-schema.mjs <table>[:col1,col2] [rpc:<function>] ...');
  process.exit(2);
}

let failed = false;
for (const arg of args) {
  if (arg.startsWith('rpc:')) {
    const fn = arg.slice(4);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const body = await res.json().catch(() => ({}));
    if (body.code === 'PGRST202') {
      console.log(`✗ function ${fn} NOT FOUND — migration not applied`);
      failed = true;
    } else {
      // Any other response (including arg-mismatch errors) means the function exists.
      console.log(`✓ function ${fn} exists`);
    }
    continue;
  }
  const [table, cols] = arg.split(':');
  const select = cols || '*';
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${select}&limit=1`, { headers });
  if (res.ok) {
    console.log(`✓ ${table}${cols ? ` (${cols})` : ''} ok`);
    continue;
  }
  const body = await res.json().catch(() => ({}));
  failed = true;
  if (body.code === 'PGRST205') {
    console.log(`✗ table ${table} NOT FOUND — migration not applied`);
  } else if (body.code === '42703') {
    console.log(`✗ ${table}: ${body.message} — column migration not applied`);
  } else {
    console.log(`✗ ${table}: ${body.code || res.status} ${body.message || ''}`);
  }
}
process.exit(failed ? 1 : 0);