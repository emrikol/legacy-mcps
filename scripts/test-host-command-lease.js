#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HostCommandLease, withHostCommandLease } = require('../lib/host-command-lease');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-mcps-lease-'));
  try {
    const lease = await new HostCommandLease({ directory: root, name: 'winmcp' }).acquire();
    assert.equal(lease.owned, true);
    assert.equal(fs.readFileSync(lease.lockPath, 'utf8').trim(), lease.token);
    assert.throws(() => new HostCommandLease({ directory: 'relative' }));
    lease.release();
    assert.equal(fs.existsSync(lease.lockPath), false);

    const events = [];
    const first = withHostCommandLease({ directory: root, name: 'winmcp' }, async () => {
      events.push('first-enter');
      await new Promise(resolve => setTimeout(resolve, 50));
      events.push('first-exit');
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = withHostCommandLease({ directory: root, name: 'winmcp' }, async () => {
      events.push('second-enter');
    });
    await Promise.all([first, second]);
    assert.deepEqual(events, ['first-enter', 'first-exit', 'second-enter']);

    const staleQueue = path.join(root, '.dosmcp-host-command-queue');
    fs.mkdirSync(staleQueue, { mode: 0o700 });
    const staleToken = '999999999:0123456789abcdef0123456789abcdef';
    fs.writeFileSync(path.join(staleQueue,
      '0000000000000-999999999-0123456789abcdef0123456789abcdef'), `${staleToken}\n`,
    { mode: 0o600 });
    const staleLock = path.join(root, '.dosmcp-host-command.lock');
    fs.writeFileSync(staleLock, `${staleToken}\n`, { mode: 0o600 });
    const reclaimed = await new HostCommandLease({ directory: root, name: 'dosmcp',
      isProcessAlive: pid => pid === process.pid }).acquire();
    reclaimed.release();

    fs.writeFileSync(path.join(staleQueue, 'foreign'), 'bad\n', { mode: 0o600 });
    await assert.rejects(() => new HostCommandLease({ directory: root, name: 'dosmcp',
      timeout: 10, isProcessAlive: pid => pid === process.pid }).acquire(),
    /Unexpected .* queue member/);
    fs.unlinkSync(path.join(staleQueue, 'foreign'));

    const callbackError = new Error('callback failed');
    await assert.rejects(() => withHostCommandLease({ directory: root, name: 'winmcp' },
      async () => { throw callbackError; }), error => error === callbackError);
    assert.equal(fs.existsSync(path.join(root, '.winmcp-host-command.lock')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('Host-command lease tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
