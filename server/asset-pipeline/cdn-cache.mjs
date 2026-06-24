import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const DEFAULT_CACHE_DIRECTORY = resolve('server', 'data', 'asset-pipeline', 'cdn-cache');
const STORED_HEADERS = [
  'accept-ranges',
  'cache-control',
  'content-encoding',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
];

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || headers.get(name.toLowerCase()) || '';
  const wanted = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted) return value || '';
  }
  return '';
}

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return String(input);
  return String(input?.url || '');
}

function requestMethod(input, init = {}) {
  return String(init.method || input?.method || 'GET').toUpperCase();
}

function requestHeaders(input, init = {}) {
  return init.headers || input?.headers || {};
}

function nodeRequestHeaders(options = {}) {
  return options.headers || {};
}

function isCacheableUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    return (
      host.endsWith('.blizzard.com') ||
      host.endsWith('.battle.net') ||
      host.endsWith('.battlenet.com.cn') ||
      host === 'github.com' ||
      host === 'raw.githubusercontent.com' ||
      host.includes('akamaihd.net') ||
      path.includes('/tpr/wow/') ||
      path.includes('/wow/data/') ||
      path.includes('/wow/config/') ||
      path.includes('/wow/patch/')
    );
  } catch {
    return false;
  }
}

function cacheKey(input, init = {}) {
  const url = requestUrl(input);
  const method = requestMethod(input, init);
  const range = headerValue(requestHeaders(input, init), 'range');
  return createHash('sha1').update(`${method}\n${url}\n${range}`).digest('hex');
}

function bodyPath(cacheDirectory, key) {
  return join(cacheDirectory, key.slice(0, 2), key.slice(2, 4), key);
}

function metaPath(cacheDirectory, key) {
  return `${bodyPath(cacheDirectory, key)}.meta.json`;
}

async function writeAtomic(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content);
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await rename(temporary, filePath);
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === 20) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 75));
    }
  }
}

function responseHeaders(response) {
  const headers = {};
  for (const key of STORED_HEADERS) {
    const value = response.headers.get(key);
    if (value) headers[key] = value;
  }
  return headers;
}

export function installCdnCache({ cacheDirectory = DEFAULT_CACHE_DIRECTORY, log = () => {} } = {}) {
  const realFetch = globalThis.fetch;
  const realHttpsGet = https.get;
  const directory = resolve(cacheDirectory);

  const cachedFetch = async function cachedFetch(input, init = {}) {
    const url = requestUrl(input);
    const method = requestMethod(input, init);
    if (method !== 'GET' || !isCacheableUrl(url)) return realFetch(input, init);

    const key = cacheKey(input, init);
    const bPath = bodyPath(directory, key);
    const mPath = metaPath(directory, key);
    const range = headerValue(requestHeaders(input, init), 'range');

    try {
      if (existsSync(bPath) && existsSync(mPath)) {
        const [body, metaText] = await Promise.all([readFile(bPath), readFile(mPath, 'utf8')]);
        const meta = JSON.parse(metaText);
        log({ event: 'cdn-cache.hit', url, range, key, bytes: body.length, status: meta.status, expected: true });
        return new Response(body, { status: meta.status, headers: meta.headers || {} });
      }
    } catch (error) {
      log({ event: 'cdn-cache.read-error', url, range, key, result: 'bypass', expected: false, error: error.message });
    }

    const response = await realFetch(input, init);
    if (response.status !== 200 && response.status !== 206) {
      log({ event: 'cdn-cache.bypass', url, range, key, status: response.status, expected: false });
      return response;
    }

    try {
      const body = Buffer.from(await response.clone().arrayBuffer());
      const meta = {
        format: 'classic-realm-cdn-cache-entry',
        version: 1,
        url,
        range,
        key,
        status: response.status,
        headers: responseHeaders(response),
        bytes: body.length,
        storedAtUtc: new Date().toISOString(),
      };
      await writeAtomic(bPath, body);
      await writeAtomic(mPath, Buffer.from(`${JSON.stringify(meta, null, 2)}\n`));
      log({ event: 'cdn-cache.store', url, range, key, bytes: body.length, status: response.status, expected: true });
    } catch (error) {
      log({ event: 'cdn-cache.write-error', url, range, key, result: 'bypass', expected: false, error: error.message });
    }
    return response;
  };
  globalThis.fetch = cachedFetch;

  const cachedHttpsGet = function cachedHttpsGet(input, options = {}, callback = undefined) {
    let requestOptions = options;
    let requestCallback = callback;
    if (typeof requestOptions === 'function') {
      requestCallback = requestOptions;
      requestOptions = {};
    }
    const url = requestUrl(input);
    if (!isCacheableUrl(url)) return realHttpsGet(input, requestOptions, requestCallback);

    const key = cacheKey(url, { method: 'GET', headers: nodeRequestHeaders(requestOptions) });
    const bPath = bodyPath(directory, key);
    const mPath = metaPath(directory, key);
    const range = headerValue(nodeRequestHeaders(requestOptions), 'range');

    if (existsSync(bPath) && existsSync(mPath)) {
      const req = new EventEmitter();
      req.end = () => req;
      req.setTimeout = () => req;
      req.destroy = () => req;
      req.abort = () => req;
      req.setHeader = () => req;
      req.getHeader = () => undefined;
      queueMicrotask(async () => {
        try {
          const [body, metaText] = await Promise.all([readFile(bPath), readFile(mPath, 'utf8')]);
          const meta = JSON.parse(metaText);
          const response = new PassThrough();
          response.statusCode = meta.status;
          response.headers = meta.headers || {};
          log({ event: 'cdn-cache.hit', transport: 'https.get', url, range, key, bytes: body.length, status: meta.status, expected: true });
          requestCallback?.(response);
          response.end(body);
        } catch (error) {
          log({ event: 'cdn-cache.read-error', transport: 'https.get', url, range, key, result: 'bypass', expected: false, error: error.message });
          req.emit('error', error);
        }
      });
      return req;
    }

    return realHttpsGet(input, requestOptions, response => {
      const chunks = [];
      response.on('data', chunk => {
        chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => {
        const status = Number(response.statusCode || 0);
        if (status !== 200 && status !== 206) return;
        const body = Buffer.concat(chunks);
        const headers = {};
        for (const keyName of STORED_HEADERS) {
          const value = response.headers?.[keyName];
          if (value) headers[keyName] = Array.isArray(value) ? value.join(', ') : String(value);
        }
        const meta = {
          format: 'classic-realm-cdn-cache-entry',
          version: 1,
          transport: 'https.get',
          url,
          range,
          key,
          status,
          headers,
          bytes: body.length,
          storedAtUtc: new Date().toISOString(),
        };
        Promise.all([
          writeAtomic(bPath, body),
          writeAtomic(mPath, Buffer.from(`${JSON.stringify(meta, null, 2)}\n`)),
        ]).then(() => {
          log({ event: 'cdn-cache.store', transport: 'https.get', url, range, key, bytes: body.length, status, expected: true });
        }).catch(error => {
          log({ event: 'cdn-cache.write-error', transport: 'https.get', url, range, key, result: 'bypass', expected: false, error: error.message });
        });
      });
      requestCallback?.(response);
    });
  };
  https.get = cachedHttpsGet;

  return function restoreCdnCache() {
    if (globalThis.fetch === cachedFetch) globalThis.fetch = realFetch;
    if (https.get === cachedHttpsGet) https.get = realHttpsGet;
  };
}

export const __cdnCacheInternals = {
  cacheKey,
  isCacheableUrl,
};
