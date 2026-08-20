#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadSequence, runSequence, validateSequence } = require('../lib/win-sequence');

async function main() {
  assert.deepEqual(validateSequence(['META PING']), ['META PING']);
  assert.equal(validateSequence(['X'.repeat(511)])[0].length, 511);
  for (const invalid of [[], Array(257).fill('META PING'), ['bad\ncommand'], [1],
    ['x'.repeat(512)]]) assert.throws(() => validateSequence(invalid));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-mcps-sequence-'));
  try {
    const file = path.join(root, 'sequence.json');
    fs.writeFileSync(file, '["META PING","WINDOW LIST"]\n', { mode: 0o600 });
    assert.deepEqual(loadSequence(file), ['META PING', 'WINDOW LIST']);
    const replacement = path.join(root, 'replacement.json');
    fs.writeFileSync(replacement, '["META PONG","WINDOW LIST"]\n', { mode: 0o600 });
    const originalRead = fs.readFileSync;
    fs.readFileSync = function(target, ...args) {
      const bytes = originalRead.call(fs, target, ...args);
      if (typeof target === 'number') fs.renameSync(replacement, file);
      return bytes;
    };
    try { assert.throws(() => loadSequence(file), /changed while being read/); }
    finally { fs.readFileSync = originalRead; }
    fs.writeFileSync(file, '["META PING","WINDOW LIST"]\n', { mode: 0o600 });
    const link = path.join(root, 'link.json');
    fs.symlinkSync('sequence.json', link);
    assert.throws(() => loadSequence(link), /regular/);

    const commands = [];
    const observed = [];
    const win = { send: async command => {
      commands.push(command);
      return command === 'META PING' ? 'OK PONG' : 'OK';
    } };
    const results = await runSequence(win, loadSequence(file),
      { onResult: result => observed.push(result.index) });
    assert.deepEqual(commands, ['META PING', 'WINDOW LIST']);
    assert.deepEqual(observed, [0, 1]);
    assert(Object.isFrozen(results) && results.every(Object.isFrozen));

    await assert.rejects(() => runSequence({ send: async () => 'ERR FAILED' }, ['META PING']),
      error => error.result.index === 0);
    const continued = await runSequence({ send: async () => 'ERR FAILED' }, ['META PING'],
      { requireOk: false });
    assert.equal(continued[0].response, 'ERR FAILED');
    await assert.rejects(() => runSequence(win, ['MEMORY WRITE UNSAFE 1000:00000000 01']),
      /dedicated unsafe-write/);
    await assert.rejects(() => runSequence(win, ['memory write unsafe 1000:00000000 01'],
      { allowUnsafe: true }), /dedicated unsafe-write/);
    await assert.rejects(() => runSequence({ send: async () => 'OKAY' }, ['META PING']),
      error => error.result.response === 'OKAY');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('WINMCP sequence tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
