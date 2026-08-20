#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DosMcpClient, resetDosMcpMailbox, withDosMcpClient } = require('../lib/dos-mcp');
const { expectedRuntimeIdentity } = require('../lib/guest-tool-identity');
const { parseArguments } = require('../bin/dosmcp');

function responseIdentity() {
  const expected = expectedRuntimeIdentity('DOSMCP');
  return `OK TOOL=DOSMCP PROTOCOL=${expected.protocol} BUILD=${expected.build} ` +
    'FEATURES=META,MEM';
}

async function agent(directory, responses) {
  for (const response of responses) {
    const deadline = Date.now() + 2000;
    let request;
    while (Date.now() < deadline && !request) {
      request = fs.readdirSync(directory).find(name => name.toLowerCase() === '__mcp__.tx');
      if (request && fs.statSync(path.join(directory, request)).size === 0) request = undefined;
      if (!request) await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert(request, 'DOSMCP request did not appear');
    const command = fs.readFileSync(path.join(directory, request), 'ascii').trim();
    fs.truncateSync(path.join(directory, request), 0);
    assert.equal(command, response.command);
    if (response.assertLeaseHeld) {
      assert.equal(fs.existsSync(path.join(directory, '.dosmcp-host-command.lock')), true,
        'DOSMCP lease was released before an unawaited command drained');
    }
    if (response.delayMs) await new Promise(resolve => setTimeout(resolve, response.delayMs));
    if (response.response !== undefined) {
      fs.writeFileSync(path.join(directory, '__MCP__.RW'), `${response.response}\r\n`,
        { flag: 'wx', mode: 0o600 });
      fs.renameSync(path.join(directory, '__MCP__.RW'), path.join(directory, '__MCP__.RX'));
    }
  }
}

async function main() {
  assert.deepEqual(parseArguments(['--magic-dir', '/tmp/x', 'identity']).operation, 'identity');
  assert.equal(parseArguments(['reset', '--confirm-guest-reset']).operation, 'reset');
  assert.equal(parseArguments(['send', '--', 'META', 'PING']).command, 'META PING');
  assert.throws(() => parseArguments(['send', 'META PING']));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-mcps-dosmcp-'));
  try {
    const responder = agent(root, [
      { command: 'META IDENTITY', response: responseIdentity() },
      { command: 'META PING', response: 'OK PONG' },
      { command: 'META VERSION', response: 'OK DOSMCP/0.11' },
      { command: 'X'.repeat(255), response: 'OK BOUND' },
      { command: 'META STATUS', response: 'OK STATUS', delayMs: 25,
        assertLeaseHeld: true },
    ]);
    let escapedClient;
    const result = await withDosMcpClient({ magicDir: root, pollMs: 2 }, async client => {
      assert.equal(client.runtimeIdentity.tool, 'DOSMCP');
      assert.deepEqual(await Promise.all([
        client.send('META PING'), client.send('META VERSION'),
      ]), ['OK PONG', 'OK DOSMCP/0.11']);
      assert.equal(Object.getOwnPropertyDescriptor(client, 'mailbox'), undefined);
      assert.equal(await client.send('X'.repeat(255)), 'OK BOUND');
      await assert.rejects(() => client.send('X'.repeat(256)), /1-255 printable ASCII bytes/);
      escapedClient = client;
      client.send('META STATUS');
      return 'OK';
    });
    assert.equal(result, 'OK');
    await responder;
    await assert.rejects(() => escapedClient.send('META PING'), /revoked/);
    assert.equal(fs.statSync(path.join(root, '__mcp__.tx')).size, 0,
      'real DOSMCP leaves its consumed TX inode empty');
    assert.equal(fs.existsSync(path.join(root, '.dosmcp-host-command.lock')), false);

    let unhandled;
    const onUnhandled = error => { unhandled = error; };
    process.on('unhandledRejection', onUnhandled);
    const timeoutAgent = agent(root, [
      { command: 'META IDENTITY', response: responseIdentity() },
      { command: 'META STATUS', delayMs: 20, assertLeaseHeld: true },
    ]);
    await assert.rejects(() => withDosMcpClient({ magicDir: root, pollMs: 2, timeout: 10 },
      client => { client.send('META STATUS'); return 'callback returned'; }), /timed out/);
    await timeoutAgent;
    await new Promise(resolve => setImmediate(resolve));
    process.off('unhandledRejection', onUnhandled);
    assert.equal(unhandled, undefined, 'drained unawaited failure must not reject an unobserved wrapper');
    assert.equal(fs.existsSync(path.join(root, '.dosmcp-host-command.lock')), false);
    await resetDosMcpMailbox({ magicDir: root, pollMs: 2, confirmGuestReset: true });

    const badAgent = agent(root, [{ command: 'META IDENTITY',
      response: responseIdentity().replace(/BUILD=[0-9a-f]{64}/, `BUILD=${'0'.repeat(64)}`) }]);
    await assert.rejects(() => new DosMcpClient({ magicDir: root, pollMs: 2 }).open(),
      /does not match/);
    await badAgent;
    assert.equal(fs.existsSync(path.join(root, '.dosmcp-host-command.lock')), false);

    fs.writeFileSync(path.join(root, '.dosmcp-host-command.inflight'),
      'uncertain-command-v1\n', { flag: 'wx', mode: 0o600 });
    await assert.rejects(() => resetDosMcpMailbox({ magicDir: root, pollMs: 2 }),
      /confirmGuestReset=true/);
    await resetDosMcpMailbox({ magicDir: root, pollMs: 2, confirmGuestReset: true });
    assert.equal(fs.existsSync(path.join(root, '.dosmcp-host-command.inflight')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('DOSMCP client tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
