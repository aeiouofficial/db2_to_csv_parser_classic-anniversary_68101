#!/usr/bin/env node
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db2CdnExportService } from '../server/asset-pipeline/db2-cdn-export-service.mjs';

const modulePath = fileURLToPath(import.meta.url);
const root = resolve(dirname(modulePath), '..');

export function isDirectCliRun() {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === modulePath;
}

function parseArgs(argv = process.argv.slice(2)) {
  return new Map(argv.map(arg => {
    const trimmed = arg.replace(/^--/, '');
    const [key, ...value] = trimmed.split('=');
    return [key, value.length ? value.join('=') : true];
  }));
}

async function createService(rootDirectory = root) {
  const service = new Db2CdnExportService({
    rootDirectory,
    dataDirectory: join(rootDirectory, 'server', 'data'),
  });
  await service.init();
  return service;
}

export async function runExport({
  service = null,
  rootDirectory = root,
  profile = '',
  build = '',
  outDir = '',
  strict = false,
  concurrency = 8,
  onProgress = null,
} = {}) {
  const activeService = service || await createService(rootDirectory);
  return await activeService.exportShippedCsvAll({
    profile,
    build,
    outDir,
    strict,
    concurrency,
    onProgress,
  });
}

async function main() {
  const args = parseArgs();
  const service = await createService(root);
  const profile = String(args.get('profile') || '');
  const build = String(args.get('build') || '');
  const outDir = String(args.get('outDir') || '');
  const strict = args.get('strict') !== 'false';
  const concurrency = Number(args.get('concurrency') || 8);

  let result;
  if (args.has('inventory')) {
    result = await service.inventoryJob({ profile });
  } else if (args.has('table')) {
    result = await service.exportTable({ profile, tableName: String(args.get('table')) });
  } else if (args.has('promote')) {
    result = await service.promoteSemanticIndexes({ profile, strict });
  } else if (args.has('verify')) {
    result = await service.verify({ strict });
  } else if (build || outDir || args.has('csv')) {
    result = await runExport({ service, profile, build, outDir, strict, concurrency });
  } else {
    result = await service.exportAll({ profile, strict, concurrency });
  }

  console.log(JSON.stringify({ ok: true, result }, null, 2));
}

if (isDirectCliRun()) {
  main().catch(error => {
    console.error(JSON.stringify({
      ok: false,
      error: error.message,
      details: error.details || null,
    }, null, 2));
    process.exitCode = 1;
  });
}
