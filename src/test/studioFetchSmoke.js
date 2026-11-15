// Import from a URL (docs/agent-studio.md, phase 3): the fetch's limits against a real local server:
// redirects (followed, capped, and re-checked for the scheme), the size limit with and without a
// declared length, the timeout, error statuses and bad addresses.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { fetchSharedWorkflow, MAX_REDIRECTS, FetchError } = require(path.join(__dirname, '../../out/studio/fetchShared.js'));

async function main() {
  const big = 'x'.repeat(2048);
  let redirectClosed = false;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const hop = Number(url.searchParams.get('n') ?? 0);
    switch (url.pathname) {
      case '/ok': response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"id":"shared"}'); return;
      case '/hop': response.writeHead(302, { location: hop > 0 ? `/hop?n=${hop - 1}` : '/ok' }); response.end(); return;
      case '/to-https': response.writeHead(301, { location: 'https://example.invalid/w.json' }); response.end(); return;
      case '/declared': response.writeHead(200, { 'content-length': String(big.length) }); response.end(big); return;
      case '/chunked': response.writeHead(200); response.write(big.slice(0, 1024)); response.end(big.slice(1024)); return;
      case '/slow': return; // never answers
      case '/endless-redirect': {
        // A redirect whose body never ends: the fetch must close it, not read it.
        response.writeHead(302, { location: '/ok' });
        const timer = setInterval(() => response.write('x'.repeat(1024)), 5);
        response.on('close', () => { clearInterval(timer); redirectClosed = true; });
        return;
      }
      default: response.writeHead(404, 'Not Found'); response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const local = { protocols: ['http:'] };
  try {
    // Redirects are followed, and the final address is reported.
    let fetched = await fetchSharedWorkflow(`${base}/hop?n=2`, local);
    assert.deepEqual(fetched, { text: '{"id":"shared"}', url: `${base}/ok` });
    // At most MAX_REDIRECTS.
    await assert.rejects(fetchSharedWorkflow(`${base}/hop?n=${MAX_REDIRECTS}`, local), /More than 5 redirects/);
    // The scheme is checked first, and again after a redirect (here to one this test does not allow).
    await assert.rejects(fetchSharedWorkflow(`${base}/ok`), /Only https addresses can be imported\.$/);
    await assert.rejects(fetchSharedWorkflow(`${base}/to-https`, local), /Only http addresses can be imported \(redirected to https:\/\/example\.invalid\/w\.json\)/);
    // The size limit, by the declared length and while reading a body with none.
    await assert.rejects(fetchSharedWorkflow(`${base}/declared`, { ...local, maxBytes: 1500 }), /larger than 1 KB/);
    await assert.rejects(fetchSharedWorkflow(`${base}/chunked`, { ...local, maxBytes: 1500 }), /larger than 1 KB/);
    fetched = await fetchSharedWorkflow(`${base}/chunked`, { ...local, maxBytes: 4096 });
    assert.equal(fetched.text.length, 2048);
    // The timeout covers a server that never answers.
    const started = Date.now();
    await assert.rejects(fetchSharedWorkflow(`${base}/slow`, { ...local, timeoutMs: 300 }), /No complete answer from 127\.0\.0\.1:\d+ within 0\.3 s/);
    assert.ok(Date.now() - started < 3000, 'the timeout did not stop the fetch');
    // Error statuses and bad addresses.
    await assert.rejects(fetchSharedWorkflow(`${base}/missing`, local), /answered 404 Not Found/);
    await assert.rejects(fetchSharedWorkflow('not a url'), error => error instanceof FetchError && /is not a URL/.test(error.message));
    await assert.rejects(fetchSharedWorkflow('http://127.0.0.1:1/x', local), /Could not reach 127\.0\.0\.1:1/);
    // Review of the first version (Codex). A redirect's endless body is not drained: the fetch ends
    // and that connection is closed.
    fetched = await fetchSharedWorkflow(`${base}/endless-redirect`, { ...local, timeoutMs: 2000 });
    assert.equal(fetched.text, '{"id":"shared"}');
    for (let i = 0; i < 50 && !redirectClosed; i++) { await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(redirectClosed, true, 'the redirect connection stayed open');
    // A request that cannot even be built rejects at once, and its deadline does not fire later.
    const uncaught = [];
    const onUncaught = error => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    await assert.rejects(fetchSharedWorkflow('https://example.invalid/x', { timeoutMs: 100, get: () => { throw new URIError('URI malformed'); } }), /Could not request example\.invalid: URI malformed/);
    await new Promise(resolve => setTimeout(resolve, 250));
    process.off('uncaughtException', onUncaught);
    assert.deepEqual(uncaught, [], 'the deadline fired after the fetch had failed');
    console.log('Studio fetch smoke passed');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}
main().catch(error => { console.error(error); process.exit(1); });
