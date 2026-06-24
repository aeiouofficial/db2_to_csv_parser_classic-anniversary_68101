import { runExport } from './export-wow-db2-csv.mjs';
import { readFile } from 'node:fs/promises';

const inventoryPath = new URL('../server/data/asset-pipeline/db2-inventory.json', import.meta.url);
const countStatuses = (inv) => {
  const c = {};
  for (const e of inv.entries || []) { const s = e.parseStatus || '(none)'; c[s] = (c[s] || 0) + 1; }
  return c;
};

const readInv = async () => {
  try { return JSON.parse(await readFile(inventoryPath, 'utf8')); }
  catch (e) { if (e?.code === 'ENOENT') return { summary: {}, entries: [] }; throw e; }
};
const before = await readInv();
console.log('BEFORE summary:', JSON.stringify(before.summary));
console.log('BEFORE status counts:', JSON.stringify(countStatuses(before)));

let threw = null;
try {
  const result = await runExport({
    profile: 'bc_anniversary_68101',
    build: '68101',
    strict: false,
    concurrency: 8,
    onProgress: (ev) => {
      if (ev.type === 'phase') console.log(`[phase] ${ev.phase} :: ${ev.message || ''} ${ev.attempt ? `(attempt ${ev.attempt}/${ev.attempts})` : ''}`);
      else if (ev.type === 'start') console.log(`[start] total=${ev.total} outDir=${ev.outDir}`);
      else if (ev.type === 'table') console.log(`[table] ${ev.table} -> ${ev.status} rows=${ev.rows ?? ''} ${ev.errors ? JSON.stringify(ev.errors) : ''}`);
      else if (ev.type === 'validation') console.log(`[validation] ok=${ev.ok} problems=${JSON.stringify(ev.problems || [])}`);
      else if (ev.type === 'complete') console.log(`[complete] written=${ev.writtenFiles?.length} skipped=${ev.skippedFiles?.length} failed=${ev.failedTables?.length}`);
    },
  });
  console.log('RUN OK. failedTables=', (result.failedTables || []).length);
} catch (err) {
  threw = err;
  console.error('RUN THREW:', err?.status || '', err?.message);
  console.error(err?.stack);
}

const after = await readInv();
console.log('AFTER summary:', JSON.stringify(after.summary));
console.log('AFTER status counts:', JSON.stringify(countStatuses(after)));
const stillPending = (after.entries || []).filter(e => e.parseStatus === 'pending');
console.log('STILL PENDING:', stillPending.length);
if (stillPending.length) console.log('PENDING SAMPLE:', stillPending.slice(0, 10).map(e => e.tableName).join(', '));
process.exit(threw ? 1 : (stillPending.length ? 2 : 0));
