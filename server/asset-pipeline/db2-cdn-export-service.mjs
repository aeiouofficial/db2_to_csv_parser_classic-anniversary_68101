import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { CASCClient, DBDParser, WDCReader } from '@rhyster/wow-casc-dbc';
import { installCdnCache } from './cdn-cache.mjs';

const VALID_STATUSES = new Set([
  'ok',
  'encrypted',
  'missingKey',
  'dbdMissing',
  'schemaMismatch',
  'unsupportedWdc',
  'parseError',
  'ioError',
  'notFound',
  'pending',
]);

const DEFAULT_PROFILE = 'bc_anniversary_68101';
const DB2_NAME_PATTERN = /^DBFilesClient\/(.+)\.db2$/i;
const CONTENT_DB_IMPORT_TABLES = new Map([
  ['map', 'Map'],
  ['faction', 'Faction'],
  ['chrraces', 'ChrRaces'],
  ['chrclasses', 'ChrClasses'],
  ['spell', 'Spell'],
  ['itemsparse', 'Item-Sparse'],
  ['item-sparse', 'Item-Sparse'],
  ['creaturedisplayinfo', 'CreatureDisplayInfo'],
  ['questv2', 'QuestV2'],
]);
const REQUIRED_CONTENT_DB_CDN_TABLES = Object.freeze([
  { sourceTable: 'map', canonical: 'Map' },
  { sourceTable: 'faction', canonical: 'Faction' },
  { sourceTable: 'chrraces', canonical: 'ChrRaces' },
  { sourceTable: 'chrclasses', canonical: 'ChrClasses' },
  { sourceTable: 'spell', canonical: 'Spell' },
  { sourceTable: 'itemsparse', canonical: 'Item-Sparse' },
  { sourceTable: 'creaturedisplayinfo', canonical: 'CreatureDisplayInfo' },
  { sourceTable: 'questv2', canonical: 'QuestV2' },
]);

function contentImportTable(tableName) {
  return CONTENT_DB_IMPORT_TABLES.get(String(tableName || '').toLowerCase()) || null;
}

function now() {
  return new Date().toISOString();
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function httpError(status, message, details = undefined) {
  return Object.assign(new Error(message), { status, details });
}

function normalizeTableName(value) {
  const table = String(value || '').trim().replace(/\.db2$/i, '');
  if (!/^[A-Za-z0-9_]{1,96}$/.test(table)) throw httpError(422, 'DB2 table name must match ^[A-Za-z0-9_]+$');
  return table;
}

function assertInside(root, candidate) {
  const resolvedRoot = resolve(root);
  const resolved = resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${sep}`)) {
    throw httpError(422, 'Resolved DB2 artifact path escapes its configured root');
  }
  return resolved;
}

function safeRelativePath(value, label = 'path') {
  const raw = String(value || '').replace(/\\/g, '/').trim();
  if (!raw || raw.startsWith('/') || /^[a-z]:\//i.test(raw) || raw.includes('\0')) {
    throw httpError(422, `${label} is unsafe`);
  }
  const normalized = normalize(raw).replace(/\\/g, '/');
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw httpError(422, `${label} escapes the configured root`);
  }
  return normalized;
}

export async function atomicWrite(path, content, encoding = 'utf8') {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, encoding);
  try {
    let lastError = null;
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      try {
        await rename(temporary, path);
        return;
      } catch (error) {
        lastError = error;
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === 20) throw error;
        await new Promise(resolve => setTimeout(resolve, attempt * 75));
      }
    }
    throw lastError;
  } catch (error) {
    // Eigenes Temp bei gefangenem Fehler entfernen – kein Leak bei rename-Abbruch.
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export function decodeRows(parser) {
  const ids = parser.getAllIDs();
  const rows = [];
  const warnings = [];
  for (const id of ids) {
    try {
      rows.push({ ID: id, ...(parser.getRowData(id) || {}) });
    } catch (rowError) {
      warnings.push(`row ${id}: ${rowError?.message || String(rowError)}`);
    }
  }
  return { rows, warnings };
}

function jsonStable(value) {
  return `${JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2)}\n`;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = Array.isArray(value) ? JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item) : String(value);
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function browserCsvCell(value) {
  if (value === null || value === undefined) return '';
  const text = Array.isArray(value) || (value && typeof value === 'object')
    ? JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)
    : String(value);
  return /[,"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function rowsToCsv(columns, rows) {
  const names = columns.map(column => column.name);
  const lines = [names.map(csvCell).join(';')];
  for (const row of rows) lines.push(names.map(name => csvCell(row[name])).join(';'));
  return `${lines.join('\n')}\n`;
}

function rowsToBrowserCsv(columns, rows) {
  const names = columns.map(column => column.name);
  const lines = [names.map(browserCsvCell).join(',')];
  for (const row of rows) lines.push(names.map(name => browserCsvCell(row[name])).join(','));
  return `${lines.join('\n')}\n`;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path) {
  return sha256(await readFile(path));
}

async function readJsonIfExists(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function toPortablePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

async function directorySize(root) {
  let total = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) total += (await stat(path)).size;
    }
  }
  await walk(root);
  return total;
}

function parseCascError(error) {
  const message = String(error?.message || error || 'unknown error');
  if (/missing key|decrypt|encrypted|key/i.test(message)) return 'missingKey';
  if (/unsupported|wdc/i.test(message)) return 'unsupportedWdc';
  if (/dbd|definition|layout/i.test(message)) return 'schemaMismatch';
  if (/not found|undefined/i.test(message)) return 'notFound';
  return 'parseError';
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function isTransientNetworkError(error) {
  const message = String(error?.message || error || '');
  // Node 18+/undici fetch aborts surface as AbortError/ABORT_ERR with message "aborted".
  // Treat them as transient so the existing retry can recover instead of failing the table.
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return true;
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'socket hang up', 'terminated', 'fetch failed', 'aborted', 'The operation was aborted'].some(fragment => message.includes(fragment));
}

async function withTransientRetry(operation, { attempts = 3, delayMs = 1_500, onRetry = null } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (!isTransientNetworkError(error) || attempt >= attempts) throw error;
      if (typeof onRetry === 'function') await onRetry({ attempt, attempts, error: error.message });
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}

export class Db2CdnExportService {
  constructor({
    rootDirectory,
    dataDirectory,
    buildArtifactsDirectory = join(rootDirectory, 'build-artifacts', 'db2'),
    shippedDbDirectory = join(rootDirectory, 'assets', 'db'),
    cdnCacheDirectory = join(dataDirectory, 'asset-pipeline', 'cdn-cache'),
    profilePath = join(rootDirectory, 'data', 'db2-build-profiles.json'),
    requiredTablesPath = join(rootDirectory, 'data', 'required-tables.json'),
    maxConcurrency = 8,
  }) {
    this.rootDirectory = resolve(rootDirectory);
    this.dataDirectory = dataDirectory;
    this.buildArtifactsDirectory = resolve(buildArtifactsDirectory);
    this.shippedDbDirectory = resolve(shippedDbDirectory);
    this.cdnCacheDirectory = resolve(cdnCacheDirectory);
    this.profilePath = profilePath;
    this.requiredTablesPath = requiredTablesPath;
    this.maxConcurrency = Math.max(1, Math.min(8, Number(maxConcurrency) || 8));
    this.pipelineDirectory = join(dataDirectory, 'asset-pipeline');
    this.manifestPath = join(this.pipelineDirectory, 'build-manifest.json');
    this.inventoryPath = join(this.pipelineDirectory, 'db2-inventory.json');
    this.profiles = null;
    this.requiredTables = null;
    this.inventory = null;
    this.manifest = null;
    this.client = null;
    this.inventoryWrite = Promise.resolve();
  }

  async init() {
    await Promise.all([
      mkdir(this.pipelineDirectory, { recursive: true }),
      mkdir(this.buildArtifactsDirectory, { recursive: true }),
      mkdir(this.shippedDbDirectory, { recursive: true }),
      mkdir(this.cdnCacheDirectory, { recursive: true }),
    ]);
    this.profiles = JSON.parse(await readFile(this.profilePath, 'utf8'));
    this.requiredTables = JSON.parse(await readFile(this.requiredTablesPath, 'utf8'));
    this.manifest = await readJsonIfExists(this.manifestPath, null);
    this.inventory = await readJsonIfExists(this.inventoryPath, null);
    await this.sweepStaleTemps().catch(() => {});
  }

  async sweepStaleTemps({ maxAgeMs = 5 * 60_000 } = {}) {
    // matcht NUR `${path}.<pid>.<ts>.<uuid>.tmp`, nie echte *.json/.csv/.db2
    const TEMP_RE = /\.\d+\.\d+\.[0-9a-f-]{36}\.tmp$/i;
    const roots = [this.pipelineDirectory, this.buildArtifactsDirectory, this.shippedDbDirectory];
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    const walk = async (dir) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      for (const ent of entries) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) {
          await walk(full);
        } else if (ent.isFile() && TEMP_RE.test(ent.name)) {
          try {
            const info = await stat(full);
            if (info.mtimeMs <= cutoff) {        // nur alte Temps – schützt in-flight Writes
              await rm(full, { force: true });
              removed += 1;
            }
          } catch { /* race mit aktivem Writer – ignorieren */ }
        }
      }
    };
    await Promise.all(roots.map(walk));
    return removed;
  }

  profile(profileName = '') {
    const key = profileName || this.profiles?.defaultProfile || DEFAULT_PROFILE;
    const profile = this.profiles?.profiles?.[key];
    if (!profile) throw httpError(422, `Unknown DB2 build profile: ${key}`);
    return profile;
  }

  listProfiles() {
    const defaultProfile = this.profiles?.defaultProfile || DEFAULT_PROFILE;
    const profiles = Object.values(this.profiles?.profiles || {}).map(profile => ({
      profile: profile.profile,
      label: profile.label,
      product: profile.product,
      region: profile.region,
      locale: profile.locale,
      buildId: profile.buildId,
      versionName: profile.versionName,
      default: profile.profile === defaultProfile,
    }));
    return { defaultProfile, profiles };
  }

  profileByBuild(build = '') {
    const buildId = String(build || '').trim();
    if (!/^\d{1,10}$/.test(buildId)) throw httpError(422, 'DB2 build must be a numeric build id');
    const profile = Object.values(this.profiles?.profiles || {}).find(candidate => String(candidate.buildId) === buildId);
    if (!profile) throw httpError(422, `Unknown DB2 build id: ${buildId}`);
    return profile;
  }

  resolveProfile({ profile = '', build = '' } = {}) {
    if (profile) return this.profile(profile);
    if (build) return this.profileByBuild(build);
    return this.profile('');
  }

  requiredSet() {
    const required = new Set();
    for (const system of Object.values(this.requiredTables?.systems || {})) {
      for (const table of Array.isArray(system.required) ? system.required : []) required.add(table);
    }
    return required;
  }

  runtimeAllowlist() {
    return new Set(this.requiredTables?.runtimeAllowlist || []);
  }

  canonicalRuntimeTable(table) {
    const safeTable = normalizeTableName(table);
    return [...this.runtimeAllowlist()].find(name => name.toLowerCase() === safeTable.toLowerCase()) || null;
  }

  isRuntimeTableAllowed(table) {
    return Boolean(this.canonicalRuntimeTable(table));
  }

  parsedTablePath(table) {
    const safeTable = normalizeTableName(table);
    return assertInside(this.buildArtifactsDirectory, join(this.buildArtifactsDirectory, 'parsed', this.profile().buildId, `${safeTable}.json`));
  }

  runtimeTablePath(table) {
    const safeTable = this.canonicalRuntimeTable(table);
    if (!safeTable) throw httpError(404, 'DB2 table is not runtime allowlisted');
    return assertInside(this.shippedDbDirectory, join(this.shippedDbDirectory, 'tables', `${safeTable}.json`));
  }

  async getRuntimeTable(table, { limit = 250, offset = 0 } = {}) {
    const safeTable = this.canonicalRuntimeTable(table);
    if (!safeTable) return null;
    const path = this.runtimeTablePath(safeTable);
    const parsed = await readJsonIfExists(path, null);
    if (!parsed) return null;
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.min(1000, Math.max(1, Number(limit) || 250));
    return {
      summary: {
        table: parsed.table || safeTable,
        rows: rows.length,
        sourcePath: `assets/db/tables/${safeTable}.json`,
        product: parsed.product,
        build: parsed.buildId,
        locale: parsed.locale,
        layoutHash: parsed.layoutHash,
      },
      rows: rows.slice(start, start + size),
      offset: start,
      limit: size,
    };
  }

  async cascClient(profileName = '') {
    const profile = this.profile(profileName);
    if (this.client) return this.client;
    const version = {
      Region: profile.region,
      BuildConfig: profile.buildConfig,
      CDNConfig: profile.cdnConfig,
      KeyRing: profile.keyRing || '',
      BuildId: profile.buildId,
      VersionsName: profile.versionName,
      ProductConfig: profile.productConfig,
    };
    const client = new CASCClient(profile.region, profile.product, version);
    await client.init();
    await client.loadRemoteTACTKeys();
    this.client = client;
    return client;
  }

  async loadListfileClient(profileName = '') {
    const client = await this.cascClient(profileName);
    if (!client.name2FileDataID?.size) await client.loadRemoteListFile();
    return client;
  }

  buildManifest({ profile, discoveredDb2Count = 0, traceId = randomUUID() } = {}) {
    return {
      format: 'classic-realm-db2-build-manifest',
      version: 1,
      profile: profile.profile,
      label: profile.label,
      product: profile.product,
      region: profile.region,
      locale: profile.locale,
      buildId: profile.buildId,
      versionName: profile.versionName,
      buildConfig: profile.buildConfig,
      cdnConfig: profile.cdnConfig,
      productConfig: profile.productConfig,
      listfileRevision: profile.listfileRevision,
      dbdRevision: profile.dbdRevision,
      hotfixStatus: profile.hotfixStatus,
      observedDb2CountBaseline: profile.observedDb2CountBaseline,
      discoveredDb2Count,
      toolVersions: {
        '@rhyster/wow-casc-dbc': '2.15.10',
        pipeline: 'v6.6-db2',
      },
      generatedAtUtc: now(),
      traceId,
    };
  }

  async inventoryJob({ profile: profileName = '', traceId = randomUUID() } = {}) {
    const profile = this.profile(profileName);
    const client = await this.loadListfileClient(profile.profile);
    const required = this.requiredSet();
    // requiredSet()/runtimeAllowlist() carry canonical names (e.g. "Spell"), but inventory
    // tableName is normalized lowercase ("spell"). Compare case-insensitively so required
    // tables are flagged correctly and the requiredFailed summary counter is honest.
    const requiredLower = new Set([...required].map(name => String(name).toLowerCase()));
    const runtimeAllowlist = this.runtimeAllowlist();
    const runtimeAllowlistLower = new Set([...runtimeAllowlist].map(name => String(name).toLowerCase()));
    const entries = [];
    for (const [path, fileDataID] of client.name2FileDataID.entries()) {
      const normalizedPath = safeRelativePath(path, 'DB2 listfile path');
      const match = normalizedPath.match(DB2_NAME_PATTERN);
      if (!match) continue;
      const tableName = basename(match[1]).replace(/[^A-Za-z0-9_]/g, '');
      if (!tableName) continue;
      const infos = client.getContentKeysByFileDataID(fileDataID) || [];
      const preferred = infos.find(info => Number(info.localeFlags || 0) & CASCClient.LocaleFlags.enUS) || infos[0] || {};
      entries.push({
        tableName,
        fileDataID,
        sourcePath: normalizedPath,
        localeFlags: Number(preferred.localeFlags || 0),
        contentFlags: Number(preferred.contentFlags || 0),
        contentKey: preferred.cKey || null,
        sha256: null,
        wdcVersion: null,
        layoutHash: null,
        dbdMatched: false,
        rowCount: 0,
        fieldCount: 0,
        parseStatus: 'pending',
        errors: [],
        bytes: 0,
        isRequired: requiredLower.has(tableName.toLowerCase()),
        isRuntimeAllowlisted: runtimeAllowlistLower.has(tableName.toLowerCase()),
      });
    }
    entries.sort((a, b) => a.tableName.localeCompare(b.tableName) || a.fileDataID - b.fileDataID);
    const manifest = this.buildManifest({ profile, discoveredDb2Count: entries.length, traceId });
    const inventory = {
      format: 'classic-realm-db2-inventory',
      version: 1,
      profile: profile.profile,
      buildId: profile.buildId,
      locale: profile.locale,
      generatedAtUtc: now(),
      traceId,
      entries,
      summary: this.summarizeEntries(entries),
    };
    await atomicWrite(this.manifestPath, jsonStable(manifest));
    await atomicWrite(this.inventoryPath, jsonStable(inventory));
    this.manifest = manifest;
    this.inventory = inventory;
    return { manifest, summary: inventory.summary };
  }

  async ensureInventory(profileName = '', traceId = randomUUID()) {
    if (this.inventory?.entries?.length) return this.inventory;
    if (await pathExists(this.inventoryPath)) {
      this.inventory = JSON.parse(await readFile(this.inventoryPath, 'utf8'));
      return this.inventory;
    }
    await this.inventoryJob({ profile: profileName, traceId });
    return this.inventory;
  }

  async flushInventory() {
    this.inventoryWrite = this.inventoryWrite
      .catch(() => {})
      .then(() => atomicWrite(this.inventoryPath, jsonStable(this.inventory)));
    return this.inventoryWrite;
  }

  inventoryEntry({ tableName = '', fileDataID = null } = {}) {
    const entries = this.inventory?.entries || [];
    if (fileDataID !== null && fileDataID !== undefined) {
      const id = Number(fileDataID);
      if (!Number.isInteger(id) || id <= 0) throw httpError(422, 'fileDataID must be a positive integer');
      return entries.find(entry => Number(entry.fileDataID) === id) || null;
    }
    const table = normalizeTableName(tableName);
    return entries.find(entry => entry.tableName.toLowerCase() === table.toLowerCase()) || null;
  }

  rawPath(profile, entry) {
    return assertInside(this.buildArtifactsDirectory, join(this.buildArtifactsDirectory, 'raw', profile.buildId, `${entry.fileDataID}.db2`));
  }

  parsedJsonPath(profile, tableName) {
    return assertInside(this.buildArtifactsDirectory, join(this.buildArtifactsDirectory, 'parsed', profile.buildId, `${normalizeTableName(tableName)}.json`));
  }

  parsedCsvPath(profile, tableName) {
    return assertInside(this.buildArtifactsDirectory, join(this.buildArtifactsDirectory, 'parsed', profile.buildId, `${normalizeTableName(tableName)}.csv`));
  }

  shippedCsvDirectory(profile, outDir = '') {
    if (!outDir) return assertInside(this.shippedDbDirectory, join(this.shippedDbDirectory, profile.buildId));
    const resolved = resolve(this.rootDirectory, String(outDir));
    return assertInside(this.rootDirectory, resolved);
  }

  shippedCsvPath(profile, tableName, outDir = '') {
    if (!outDir) return assertInside(this.shippedDbDirectory, join(this.shippedDbDirectory, profile.buildId, `${normalizeTableName(tableName)}.csv`));
    const directory = this.shippedCsvDirectory(profile, outDir);
    return assertInside(directory, join(directory, `${normalizeTableName(tableName)}.csv`));
  }

  shippedCsvManifestPath(profile, outDir = '') {
    const directory = this.shippedCsvDirectory(profile, outDir);
    return assertInside(directory, join(directory, 'manifest.json'));
  }

  async listShippedCsvFiles({ profile: profileName = '', build = '', outDir = '' } = {}) {
    const profile = this.resolveProfile({ profile: profileName, build });
    const directory = this.shippedCsvDirectory(profile, outDir);
    const manifest = await readJsonIfExists(this.shippedCsvManifestPath(profile, outDir), null);
    const recordsByTable = new Map();
    for (const table of manifest?.tables || []) {
      if (!table?.tableName || !table?.path) continue;
      const absolute = assertInside(this.rootDirectory, join(this.rootDirectory, safeRelativePath(table.path, 'DB2 CSV manifest path')));
      if (await pathExists(absolute)) recordsByTable.set(String(table.tableName).toLowerCase(), table);
    }
    try {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.csv')) continue;
        const tableName = normalizeTableName(entry.name.replace(/\.csv$/i, ''));
        if (recordsByTable.has(tableName.toLowerCase())) continue;
        const csvPath = this.shippedCsvPath(profile, tableName, outDir);
        recordsByTable.set(tableName.toLowerCase(), {
          tableName,
          fileDataID: null,
          contentKey: null,
          csvSha256: await sha256File(csvPath),
          rowCount: 0,
          path: this.relativeArtifactPath(csvPath),
          status: 'present',
          generatedAtUtc: now(),
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const tables = [...recordsByTable.values()].sort((a, b) => String(a.tableName).localeCompare(String(b.tableName)));
    const importableTables = tables.map(table => ({ table, canonical: contentImportTable(table.tableName) }))
      .filter(entry => entry.canonical && entry.table.path)
      .map(entry => ({ table: entry.canonical, sourceTable: entry.table.tableName, path: entry.table.path, rows: entry.table.rowCount || 0, status: entry.table.status }));
    return {
      ok: true,
      profile: profile.profile,
      buildId: profile.buildId,
      directory: this.relativeArtifactPath(directory),
      manifestPath: this.relativeArtifactPath(this.shippedCsvManifestPath(profile, outDir)),
      tables,
      importableTables,
    };
  }

  async validateShippedCsvCompleteness({ manifest, profile, outDir = '' } = {}) {
    const byTable = new Map((manifest?.tables || []).map(table => [String(table.tableName || '').toLowerCase(), table]));
    const availableStatuses = new Set(['written', 'partial', 'skipped', 'present']);
    const missingTables = [];
    const missingFiles = [];
    const requiredTables = REQUIRED_CONTENT_DB_CDN_TABLES.map(spec => ({
      ...spec,
      expectedPath: this.relativeArtifactPath(this.shippedCsvPath(profile, spec.sourceTable, outDir)),
    }));

    for (const required of requiredTables) {
      const table = byTable.get(required.sourceTable);
      const expectedPath = table?.path || required.expectedPath;
      if (!table || !availableStatuses.has(table.status) || !table.path) {
        missingTables.push({
          table: required.canonical,
          sourceTable: required.sourceTable,
          expectedPath,
          reason: table ? `manifest status ${table.status || 'unknown'} is not importable` : 'not present in shipped CSV manifest',
        });
        continue;
      }
      const absolute = assertInside(this.rootDirectory, join(this.rootDirectory, safeRelativePath(table.path, 'DB2 CSV manifest path')));
      if (!await pathExists(absolute)) {
        missingFiles.push({
          table: required.canonical,
          sourceTable: table.tableName || required.sourceTable,
          path: table.path,
          reason: 'manifest entry exists but CSV file is absent on disk',
        });
      }
    }

    return {
      ok: missingTables.length === 0 && missingFiles.length === 0,
      requiredTables,
      missingTables,
      missingFiles,
    };
  }

  async selectedContentKey(client, entry) {
    const infos = client.getContentKeysByFileDataID(entry.fileDataID) || [];
    const selected = infos.find(info => Number(info.localeFlags || 0) & CASCClient.LocaleFlags.enUS) || infos[0];
    if (!selected?.cKey) throw httpError(404, `No content key found for ${entry.tableName}`);
    return selected;
  }

  relativeArtifactPath(absolutePath) {
    return toPortablePath(relative(this.rootDirectory, absolutePath));
  }

  async exportTable({ profile: profileName = '', tableName = '', fileDataID = null, traceId = randomUUID(), writeRuntimeAllowlist = true, writeShippedCsv = false, shippedOutDir = '' } = {}) {
    const profile = this.profile(profileName);
    await this.ensureInventory(profile.profile, traceId);
    const entry = this.inventoryEntry({ tableName, fileDataID });
    if (!entry) throw httpError(404, 'DB2 table not found in inventory');
    const client = await this.cascClient(profile.profile);
    try {
      const selected = await this.selectedContentKey(client, entry);
      const result = await withTransientRetry(
        () => client.getFileByContentKey(selected.cKey, true),
        { attempts: 3, delayMs: 1_500 }
      );
      const digest = sha256(result.buffer);
      await atomicWrite(this.rawPath(profile, entry), result.buffer, undefined);
      const reader = new WDCReader(result.buffer, result.blocks ? { blocks: result.blocks } : undefined);
      const parser = await DBDParser.parse(reader);
      const { rows, warnings: rowWarnings } = decodeRows(parser);
      if (!rows.length && rowWarnings.length) {
        throw new Error(`all rows failed to decode (e.g. ${rowWarnings[0]})`);
      }
      const columns = parser.columns?.length ? parser.columns : Object.keys(rows[0] || {}).map(name => ({ name, type: 'unknown' }));
      const parsed = {
        format: 'classic-realm-db2-table',
        version: 1,
        profile: profile.profile,
        product: profile.product,
        buildId: profile.buildId,
        locale: profile.locale,
        table: entry.tableName,
        fileDataID: entry.fileDataID,
        sourcePath: entry.sourcePath,
        contentKey: selected.cKey,
        sha256: digest,
        wdcVersion: 'WDC',
        layoutHash: reader.layoutHash,
        tableHash: reader.tableHash,
        columns,
        rowCount: rows.length,
        idColumn: 'ID',
        rows,
        traceId,
        generatedAtUtc: now(),
      };
      await atomicWrite(this.parsedJsonPath(profile, entry.tableName), jsonStable(parsed));
      await atomicWrite(this.parsedCsvPath(profile, entry.tableName), rowsToCsv(columns, rows));
      if (writeShippedCsv) {
        await atomicWrite(this.shippedCsvPath(profile, entry.tableName, shippedOutDir), rowsToBrowserCsv(columns, rows));
      }
      if (writeRuntimeAllowlist && entry.isRuntimeAllowlisted) {
        const runtimePath = assertInside(this.shippedDbDirectory, join(this.shippedDbDirectory, 'tables', `${entry.tableName}.json`));
        await atomicWrite(runtimePath, jsonStable(parsed));
      }
      Object.assign(entry, {
        contentKey: selected.cKey,
        sha256: digest,
        wdcVersion: 'WDC',
        layoutHash: reader.layoutHash,
        dbdMatched: true,
        rowCount: rows.length,
        fieldCount: columns.length,
        parseStatus: 'ok',
        errors: [],
        warnings: rowWarnings,
        bytes: result.buffer.length,
      });
      if (result.type === 'partial' && result.blocks?.length) {
        entry.parseStatus = rows.length ? 'encrypted' : 'missingKey';
        entry.errors = result.blocks.map(block => `missing encrypted block key ${block.key || 'unknown'}`);
      }
    } catch (error) {
      const status = error.status === 404 ? 'notFound' : parseCascError(error);
      Object.assign(entry, {
        parseStatus: VALID_STATUSES.has(status) ? status : 'parseError',
        errors: [error.message],
      });
    }
    this.inventory.summary = this.summarizeEntries(this.inventory.entries);
    await this.flushInventory();
    return entry;
  }

  async exportAll({ profile: profileName = '', traceId = randomUUID(), strict = true, concurrency = this.maxConcurrency } = {}) {
    const profile = this.profile(profileName);
    await this.ensureInventory(profile.profile, traceId);
    const entries = this.inventory.entries || [];
    await mapLimit(entries, Math.max(1, Math.min(8, Number(concurrency) || this.maxConcurrency)), entry =>
      this.exportTable({ profile: profile.profile, fileDataID: entry.fileDataID, traceId, writeRuntimeAllowlist: false })
    );
    const summary = this.summarizeEntries(this.inventory.entries);
    const requiredFailed = this.requiredFailures();
    if (strict && requiredFailed.length) {
      throw httpError(409, 'Required DB2 tables failed strict export', { requiredFailed });
    }
    return { summary, requiredFailed, strict };
  }

  async exportShippedCsvAll({ profile: profileName = '', build = '', outDir = '', traceId = randomUUID(), strict = true, concurrency = this.maxConcurrency, onProgress = null } = {}) {
    const profile = this.resolveProfile({ profile: profileName, build });
    const shippedDirectory = this.shippedCsvDirectory(profile, outDir);
    await mkdir(shippedDirectory, { recursive: true });
    const emit = async event => {
      if (typeof onProgress === 'function') await onProgress({ traceId, buildId: profile.buildId, ...event });
    };
    const cacheStats = { hits: 0, stores: 0, bypasses: 0, errors: 0 };
    const restoreCdnCache = installCdnCache({
      cacheDirectory: this.cdnCacheDirectory,
      log: event => {
        if (event.event === 'cdn-cache.hit') cacheStats.hits += 1;
        else if (event.event === 'cdn-cache.store') cacheStats.stores += 1;
        else if (event.event === 'cdn-cache.bypass') cacheStats.bypasses += 1;
        else if (String(event.event || '').startsWith('cdn-cache.') && /error/i.test(event.event)) cacheStats.errors += 1;
      },
    });
    try {
      await emit({ type: 'phase', phase: 'casc-init', message: 'CASC setup still running', progress: 1, cacheDirectory: this.relativeArtifactPath(this.cdnCacheDirectory) });
      await withTransientRetry(
        () => this.ensureInventory(profile.profile, traceId),
        {
          attempts: 3,
          delayMs: 3_000,
          onRetry: event => emit({ type: 'phase', phase: 'casc-retry', message: event.error, attempt: event.attempt, attempts: event.attempts, progress: 1 }),
        }
      );
      const client = await withTransientRetry(
        () => this.cascClient(profile.profile),
        {
          attempts: 3,
          delayMs: 3_000,
          onRetry: event => emit({ type: 'phase', phase: 'casc-retry', message: event.error, attempt: event.attempt, attempts: event.attempts, progress: 1 }),
        }
      );
      const manifestPath = this.shippedCsvManifestPath(profile, outDir);
      const previousManifest = await readJsonIfExists(manifestPath, null);
      const previousByTable = new Map((previousManifest?.tables || []).map(table => [String(table.tableName || '').toLowerCase(), table]));
      const manifestByTable = new Map(previousByTable);
      const entries = this.inventory.entries || [];
      const writtenFiles = [];
      const skippedFiles = [];
      const failedTables = [];
      let completed = 0;
      const total = entries.length;
      const buildManifest = () => {
        const tables = [...manifestByTable.values()].sort((a, b) => String(a.tableName).localeCompare(String(b.tableName)));
        return {
          format: 'classic-realm-db2-csv-manifest',
          version: 1,
          profile: profile.profile,
          buildId: profile.buildId,
          locale: profile.locale,
          generatedAtUtc: now(),
          traceId,
          cache: { directory: this.relativeArtifactPath(this.cdnCacheDirectory), ...cacheStats },
          tables,
          summary: {
            total,
            written: tables.filter(table => table.status === 'written').length,
            skipped: tables.filter(table => table.status === 'skipped').length,
            partial: tables.filter(table => table.status === 'partial').length,
            failed: tables.filter(table => !['written', 'partial', 'skipped', 'present'].includes(table.status)).length,
          },
        };
      };
      let manifestWrite = Promise.resolve();
      const queueManifestFlush = async () => {
        const snapshot = buildManifest();
        manifestWrite = manifestWrite.then(() => atomicWrite(manifestPath, jsonStable(snapshot)));
        return manifestWrite;
      };
      await emit({ type: 'start', profile: profile.profile, buildId: profile.buildId, total, outDir: this.relativeArtifactPath(shippedDirectory) });
      await mapLimit(entries, Math.max(1, Math.min(8, Number(concurrency) || this.maxConcurrency)), async entry => {
        const tableName = entry.tableName;
        const csvPath = this.shippedCsvPath(profile, tableName, outDir);
        try {
          const selected = await this.selectedContentKey(client, entry);
          const previous = previousByTable.get(tableName.toLowerCase());
          if (['written', 'partial', 'skipped'].includes(previous?.status) && previous?.contentKey === selected.cKey && await pathExists(csvPath)) {
            const csvSha256 = await sha256File(csvPath);
            if (!previous.csvSha256 || previous.csvSha256 === csvSha256) {
              completed += 1;
              const skipped = {
                tableName,
                fileDataID: entry.fileDataID,
                contentKey: selected.cKey,
                csvSha256,
                rowCount: Number(previous.rowCount || 0),
                path: this.relativeArtifactPath(csvPath),
                status: 'skipped',
                generatedAtUtc: previous.generatedAtUtc || now(),
              };
              skippedFiles.push(skipped.path);
              manifestByTable.set(tableName.toLowerCase(), skipped);
              await queueManifestFlush();
              await emit({ type: 'table', table: tableName, status: 'skipped', rows: skipped.rowCount, path: skipped.path, progress: Math.round((completed / Math.max(1, total)) * 100) });
              return;
            }
          }
          const result = await this.exportTable({
            profile: profile.profile,
            fileDataID: entry.fileDataID,
            traceId,
            writeRuntimeAllowlist: false,
            writeShippedCsv: true,
            shippedOutDir: outDir,
          });
          completed += 1;
          if ((result.parseStatus === 'ok' || result.parseStatus === 'encrypted') && await pathExists(csvPath)) {
            const text = await readFile(csvPath, 'utf8');
            const record = {
              tableName,
              fileDataID: entry.fileDataID,
              contentKey: result.contentKey || selected.cKey,
              csvSha256: sha256(text),
              rowCount: Number(result.rowCount || 0),
              path: this.relativeArtifactPath(csvPath),
              status: result.parseStatus === 'ok' ? 'written' : 'partial',
              generatedAtUtc: now(),
            };
            writtenFiles.push(record.path);
            manifestByTable.set(tableName.toLowerCase(), record);
            await queueManifestFlush();
            await emit({ type: 'table', table: tableName, status: record.status, rows: record.rowCount, path: record.path, progress: Math.round((completed / Math.max(1, total)) * 100) });
          } else {
            const failure = { tableName, parseStatus: result.parseStatus, errors: result.errors || [] };
            failedTables.push(failure);
            manifestByTable.set(tableName.toLowerCase(), { tableName, fileDataID: entry.fileDataID, contentKey: selected.cKey, status: result.parseStatus, errors: result.errors || [], generatedAtUtc: now() });
            await queueManifestFlush();
            await emit({ type: 'table', table: tableName, status: result.parseStatus, errors: result.errors || [], progress: Math.round((completed / Math.max(1, total)) * 100) });
          }
        } catch (error) {
          completed += 1;
          const failure = { tableName, parseStatus: error.status === 404 ? 'notFound' : 'parseError', errors: [error?.message || String(error)] };
          failedTables.push(failure);
          manifestByTable.set(tableName.toLowerCase(), { tableName, fileDataID: entry.fileDataID, status: failure.parseStatus, errors: failure.errors, generatedAtUtc: now() });
          // Inventory konsistent halten: ein hier gefangener Fehler (z.B. notFound aus selectedContentKey)
          // muss auch den Inventory-Entry setzen, sonst bleibt die Tabelle ewig 'pending'.
          Object.assign(entry, { parseStatus: failure.parseStatus, errors: failure.errors, bytes: 0 });
          this.inventory.summary = this.summarizeEntries(this.inventory.entries);
          await this.flushInventory();
          await queueManifestFlush();
          await emit({ type: 'table', table: tableName, status: failure.parseStatus, errors: failure.errors, progress: Math.round((completed / Math.max(1, total)) * 100) });
        }
      });
      await manifestWrite;
      const manifest = buildManifest();
      await atomicWrite(manifestPath, jsonStable(manifest));
      const availableFiles = manifest.tables.filter(table => ['written', 'partial', 'skipped', 'present'].includes(table.status) && table.path);
      const importableTables = availableFiles.map(table => ({ table, canonical: contentImportTable(table.tableName) }))
        .filter(entry => entry.canonical)
        .map(entry => ({ table: entry.canonical, sourceTable: entry.table.tableName, path: entry.table.path, rows: entry.table.rowCount || 0, status: entry.table.status }));
      const completeness = await this.validateShippedCsvCompleteness({ manifest, profile, outDir });
      const validation = await this.verify({ strict: false });
      await emit({ type: 'validation', ok: validation.ok, problems: validation.problems, requiredFailed: validation.requiredFailed });
      const complete = {
        manifest,
        writtenFiles,
        skippedFiles,
        failedTables,
        importableTables,
        validation,
        completeness,
        missingTables: completeness.missingTables,
        missingFiles: completeness.missingFiles,
        cache: cacheStats,
      };
      await emit({ type: 'complete', ...complete });
      if (!completeness.ok) {
        throw httpError(409, 'DB2 shipped CSV set is incomplete', {
          missingTables: completeness.missingTables,
          missingFiles: completeness.missingFiles,
          complete,
        });
      }
      if (strict && failedTables.some(table => table.parseStatus !== 'encrypted')) {
        throw httpError(409, 'DB2 CSV export completed with failed tables', { failedTables, complete });
      }
      return complete;
    } finally {
      restoreCdnCache();
    }
  }

  async promoteSemanticIndexes({ profile: profileName = '', traceId = randomUUID(), strict = true } = {}) {
    const profile = this.profile(profileName);
    await this.ensureInventory(profile.profile, traceId);
    const requiredFailed = this.requiredFailures();
    if (strict && requiredFailed.length) {
      throw httpError(409, 'Cannot promote semantic indexes until required DB2 tables parse cleanly', { requiredFailed });
    }
    await mkdir(join(this.shippedDbDirectory, 'semantic'), { recursive: true });
    await mkdir(join(this.shippedDbDirectory, 'tables'), { recursive: true });
    const semantic = [];
    for (const [systemName, spec] of Object.entries(this.requiredTables.systems || {})) {
      const sourceTables = [...(spec.required || []), ...(spec.optional || [])];
      const tables = [];
      for (const table of sourceTables) {
        const path = this.parsedJsonPath(profile, table);
        const parsed = await readJsonIfExists(path, null);
        if (parsed) {
          tables.push({
            table,
            rowCount: parsed.rowCount,
            columns: parsed.columns?.map(column => column.name) || [],
            rows: Array.isArray(parsed.rows) ? parsed.rows.slice(0, 500) : [],
          });
          if (this.isRuntimeTableAllowed(table)) {
            await atomicWrite(this.runtimeTablePath(table), jsonStable(parsed));
          }
        }
      }
      const payload = {
        format: 'classic-realm-db2-semantic-index',
        schemaVersion: 1,
        system: systemName,
        profile: profile.profile,
        buildId: profile.buildId,
        locale: profile.locale,
        sourceTables,
        availableTables: tables.map(table => table.table),
        tables,
        generatedAtUtc: now(),
        traceId,
      };
      const relative = safeRelativePath(spec.semanticIndex.replace(/^assets\/db\//, ''), 'semantic index path');
      const outPath = assertInside(this.shippedDbDirectory, join(this.shippedDbDirectory, relative));
      await atomicWrite(outPath, jsonStable(payload));
      semantic.push({ system: systemName, path: spec.semanticIndex, sourceTables, availableTables: payload.availableTables });
    }
    return { semantic, requiredFailed, shippedDbBytes: await directorySize(this.shippedDbDirectory) };
  }

  async verify({ strict = false } = {}) {
    const profile = this.profile();
    const inventory = await this.ensureInventory(profile.profile);
    const summary = this.summarizeEntries(inventory.entries || []);
    const requiredFailed = this.requiredFailures();
    const shippedDbBytes = await directorySize(this.shippedDbDirectory);
    const runtimeDbBytes = await directorySize(join(this.shippedDbDirectory, 'tables')) + await directorySize(join(this.shippedDbDirectory, 'semantic'));
    const budget = Number(profile.shippedDbBudgetBytes || 8_388_608);
    const problems = [];
    if (!this.manifest) problems.push('build-manifest.json is missing');
    if (!inventory.entries?.length) problems.push('db2-inventory.json has no entries');
    if (requiredFailed.length) problems.push(`${requiredFailed.length} required DB2 tables are not ok`);
    if (runtimeDbBytes > budget) problems.push(`assets/db runtime tables exceed budget: ${runtimeDbBytes}/${budget}`);
    if (strict && problems.length) throw httpError(409, 'DB2 verification failed', { problems, requiredFailed });
    return { ok: problems.length === 0, summary, requiredFailed, shippedDbBytes, runtimeDbBytes, budget, problems };
  }

  requiredFailures() {
    const required = this.requiredSet();
    const entries = this.inventory?.entries || [];
    const byName = new Map(entries.map(entry => [entry.tableName.toLowerCase(), entry]));
    return [...required].map(table => byName.get(table.toLowerCase()) || { tableName: table, parseStatus: 'notFound' })
      .filter(entry => entry.parseStatus !== 'ok')
      .map(entry => ({ tableName: entry.tableName, parseStatus: entry.parseStatus, errors: entry.errors || [] }));
  }

  summarizeEntries(entries = []) {
    const counts = { discovered: entries.length, parsed: 0, encrypted: 0, missingKey: 0, failed: 0, pending: 0, requiredFailed: 0 };
    for (const entry of entries) {
      if (entry.parseStatus === 'ok') counts.parsed += 1;
      else if (entry.parseStatus === 'encrypted') counts.encrypted += 1;
      else if (entry.parseStatus === 'missingKey') counts.missingKey += 1;
      else if (entry.parseStatus === 'pending') counts.pending += 1;
      else counts.failed += 1;
      if (entry.isRequired && entry.parseStatus !== 'ok') counts.requiredFailed += 1;
    }
    return counts;
  }

  status() {
    const profile = this.profile();
    const entries = this.inventory?.entries || [];
    const summary = this.summarizeEntries(entries);
    return {
      ok: true,
      format: 'classic-realm-db2-status',
      version: 1,
      buildId: profile.buildId,
      versionName: profile.versionName,
      product: profile.product,
      locale: profile.locale,
      buildConfig: profile.buildConfig,
      cdnConfig: profile.cdnConfig,
      listfileRevision: this.manifest?.listfileRevision || profile.listfileRevision,
      dbdRevision: this.manifest?.dbdRevision || profile.dbdRevision,
      observedDb2CountBaseline: profile.observedDb2CountBaseline,
      discovered: summary.discovered,
      parsed: summary.parsed,
      encrypted: summary.encrypted,
      missingKey: summary.missingKey,
      failed: summary.failed,
      pending: summary.pending,
      requiredFailed: summary.requiredFailed,
      semanticIndexCount: Object.keys(this.requiredTables?.systems || {}).length,
      runtimeTableCount: this.requiredTables?.runtimeAllowlist?.length || 0,
      latestTraceId: this.inventory?.traceId || this.manifest?.traceId || null,
      inventoryPath: this.inventoryPath,
      manifestPath: this.manifestPath,
      buildArtifactsDirectory: this.buildArtifactsDirectory,
      shippedDbDirectory: this.shippedDbDirectory,
    };
  }
}
