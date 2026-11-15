/**
 * Fetches a shared workflow file from a URL for Import (docs/agent-studio.md, phase 3). HTTPS only,
 * also after each redirect; at most MAX_REDIRECTS redirects; the whole fetch within TIMEOUT_MS; the
 * body cut off as soon as it passes MAX_SHARED_BYTES. The text then goes through the same checks as
 * a file. No `vscode` here.
 */
import * as https from 'https';
import * as http from 'http';
import { MAX_SHARED_BYTES } from './sharing';

export const MAX_REDIRECTS = 5;
export const TIMEOUT_MS = 15000;

export class FetchError extends Error {}

type Get = (url: URL, callback: (response: http.IncomingMessage) => void) => http.ClientRequest;

export interface FetchOptions {
  /** Schemes allowed (tests serve over http). */
  protocols?: string[];
  get?: Get;
  timeoutMs?: number;
  maxBytes?: number;
}

/** The text at `address`, and the URL it finally came from. */
export async function fetchSharedWorkflow(address: string, options: FetchOptions = {}): Promise<{ text: string; url: string }> {
  const protocols = options.protocols ?? ['https:'];
  const get: Get = options.get ?? ((url, callback) => (url.protocol === 'http:' ? http : https).get(url, { headers: { accept: 'application/json, text/plain;q=0.9' } }, callback));
  const maxBytes = options.maxBytes ?? MAX_SHARED_BYTES;
  let url: URL;
  try { url = new URL(address.trim()); } catch { throw new FetchError(`"${address}" is not a URL.`); }
  const limit = options.timeoutMs ?? TIMEOUT_MS;
  const deadline = Date.now() + limit;
  for (let redirects = 0; ; redirects++) {
    if (!protocols.includes(url.protocol)) { throw new FetchError(`Only ${protocols.map(item => item.replace(':', '')).join(' or ')} addresses can be imported${redirects ? ` (redirected to ${url.href})` : ''}.`); }
    const result = await once(get, url, deadline, limit, maxBytes);
    if ('redirect' in result) {
      if (redirects >= MAX_REDIRECTS) { throw new FetchError(`More than ${MAX_REDIRECTS} redirects from ${address}.`); }
      url = new URL(result.redirect, url);
      continue;
    }
    return { text: result.text, url: url.href };
  }
}

function once(get: Get, url: URL, deadline: number, limit: number, maxBytes: number): Promise<{ text: string } | { redirect: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: { text: string } | { redirect: string }) => {
      if (settled) { return; }
      settled = true;
      clearTimeout(timer);
      if (error) { request.destroy(); reject(error); } else { resolve(value!); }
    };
    // One deadline for the whole fetch, redirects included.
    const timer = setTimeout(() => finish(new FetchError(`No complete answer from ${url.host} within ${limit / 1000} s.`)), Math.max(0, deadline - Date.now()));
    const request = get(url, response => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        finish(undefined, { redirect: response.headers.location });
        return;
      }
      if (status !== 200) { response.resume(); finish(new FetchError(`${url.host} answered ${status}${response.statusMessage ? ` ${response.statusMessage}` : ''}.`)); return; }
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) { response.resume(); finish(new FetchError(`The file is larger than ${Math.round(maxBytes / 1024)} KB.`)); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { finish(new FetchError(`The file is larger than ${Math.round(maxBytes / 1024)} KB.`)); return; }
        chunks.push(chunk);
      });
      response.on('end', () => finish(undefined, { text: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', error => finish(new FetchError(`Reading from ${url.host} failed: ${error.message}`)));
    });
    request.on('error', error => finish(new FetchError(`Could not reach ${url.host}: ${error.message}`)));
  });
}
