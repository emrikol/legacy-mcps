#!/usr/bin/env node

'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const tempRoot = '/tmp/legacy-mcps';
fs.mkdirSync(tempRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(tempRoot, 'dosbox-patch-test.'));

function cleanup() {
  fs.rmSync(scratch, { recursive: true, force: true });
}

for (const [signal, code] of [['SIGHUP', 129], ['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => {
    cleanup();
    process.exit(code);
  });
}

function copy(relative) {
  const source = path.join(repoRoot, relative);
  const destination = path.join(scratch, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function runVerifier() {
  return childProcess.spawnSync(process.execPath,
    [path.join(scratch, 'scripts', 'verify-dosbox-x-patches.js')],
    { encoding: 'utf8' });
}

try {
  copy('patches/dosbox-x/manifest.json');
  copy('patches/dosbox-x/source-contract.json');
  copy('scripts/update-dosbox-x-identity.js');
  copy('scripts/verify-dosbox-x-patches.js');
  for (const name of fs.readdirSync(path.join(repoRoot, 'patches', 'dosbox-x', 'series'))) {
    if (name.endsWith('.patch')) copy(path.join('patches', 'dosbox-x', 'series', name));
  }

  let result = runVerifier();
  assert.strictEqual(result.status, 0, result.stderr);

  const first = path.join(scratch, 'patches', 'dosbox-x', 'series',
    '0001-fix-screenshot-PNG-color-correction-for-macOS-SDL.patch');
  fs.appendFileSync(first, '\n');
  result = runVerifier();
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /checksum mismatch/);

  copy('patches/dosbox-x/series/0001-fix-screenshot-PNG-color-correction-for-macOS-SDL.patch');
  fs.writeFileSync(path.join(scratch, 'patches', 'dosbox-x', 'series', '9999-extra.patch'), 'extra');
  result = runVerifier();
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /does not exactly match/);

  process.stdout.write('DOSBox-X patch verifier tests OK\n');
} finally {
  cleanup();
}
