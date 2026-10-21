#!/usr/bin/env node
// The deployment-wide kill switch (#886): the operator's break-glass for every org at once.
//
//   ADMIN_DATABASE_URL=postgres://... pnpm ops:kill-switch status
//   ADMIN_DATABASE_URL=postgres://... pnpm ops:kill-switch ai on --reason "AI endpoint compromised" --by "Tên người trực"
//   ADMIN_DATABASE_URL=postgres://... pnpm ops:kill-switch mail off --by "Tên người trực"
//
// 'ai' stops AI document reading and every agent run; 'mail' holds the mail queue (mail stays queued and goes out once
// released). It writes through crove_kernel.global_kill_switch_set, which only the database owner may run, so it needs
// the admin URL the migrations use; no Crove login can flip it. Every change is kept, with its reason and who.
import pg from 'pg';

const KEYS = ['ai', 'mail'];

export function parseArgs(argv) {
  const [first, second, ...rest] = argv;
  if (first === 'status' && second === undefined) return { action: 'status' };
  if (!KEYS.includes(first) || !['on', 'off'].includes(second)) {
    throw new Error('usage: kill-switch status | kill-switch <ai|mail> <on|off> --by <name> [--reason <text>]');
  }
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    const value = rest[i + 1];
    if ((name !== '--by' && name !== '--reason') || value === undefined) throw new Error(`unknown or empty option: ${name}`);
    flags[name.slice(2)] = value;
  }
  const by = (flags.by ?? '').trim();
  if (by.length < 1 || by.length > 100) throw new Error('--by names who changes the switch (1 to 100 characters)');
  const reason = flags.reason?.trim() || null;
  if (reason && reason.length > 500) throw new Error('--reason is at most 500 characters');
  if (second === 'on' && !reason) throw new Error('--reason is required to engage a switch');
  return { action: 'set', key: first, engaged: second === 'on', by, reason };
}

async function main() {
  const command = parseArgs(process.argv.slice(2));
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url) throw new Error('set ADMIN_DATABASE_URL (the database owner, as for the migrations)');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    if (command.action === 'set') {
      await client.query('SELECT crove_kernel.global_kill_switch_set($1, $2, $3, $4)', [command.key, command.engaged, command.reason, command.by]);
    }
    for (const key of KEYS) {
      const { rows } = await client.query(
        `SELECT crove_kernel.global_kill_switch_on($1) AS engaged,
                (SELECT row_to_json(s) FROM (SELECT changed_at, changed_by, reason FROM crove_kernel.global_kill_switch
                  WHERE key = $1 ORDER BY changed_at DESC, id DESC LIMIT 1) s) AS last`,
        [key],
      );
      const { engaged, last } = rows[0];
      console.log(`${key}: ${engaged ? 'ON (stopped)' : 'off'}${last ? ` since ${last.changed_at} by ${last.changed_by}${last.reason ? ` (${last.reason})` : ''}` : ''}`);
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`kill-switch: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
