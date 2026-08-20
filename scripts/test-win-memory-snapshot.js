#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DIFF_SCHEMA,
  MAX_READ_LENGTH,
  SNAPSHOT_SCHEMA,
  buildCapturePlan,
  captureSnapshot,
  decodeField,
  diffSnapshots,
  parseMemoryResponse,
  publishJsonNoReplace,
  readJsonFile,
  validateManifest,
  validateSnapshot,
} = require('../lib/win-memory-snapshot');
const { main: runCli, parseArguments } = require('../bin/winmcp-snapshot');

const segment = Object.freeze({ segment: 2, selector: '1234',
  linearBase: '00100000', size: 0x20000 });

function manifestFor(length, fields) {
  return { module: 'APP', ranges: [{ name: 'state', segment: 2,
    offset: 0x20, length, ...(fields ? { fields } : {}) }] };
}

function fakeSession(bytes, events = []) {
  let taskCount = 0;
  return async (options, callback) => {
    assert.deepEqual(options.requiredFeatures, ['TASK', 'MODULE', 'MEMORY']);
    const win = {
      async send(command) {
        events.push(command);
        if (command === 'TASK INFO APP') {
          taskCount++;
          return 'OK TASK=1234 MODULE=APP';
        }
        const match = command.match(/^MEMORY READ 1234:([0-9A-F]{8}) (\d+)$/);
        assert(match, `unexpected command ${command}`);
        const offset = parseInt(match[1], 16);
        const count = Number(match[2]);
        const chunk = bytes.subarray(offset - 0x20, offset - 0x20 + count);
        assert.equal(chunk.length, count);
        return `OK 1234:${match[1]} N=${count} ` +
          [...chunk].map(byte => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ');
      },
      async moduleSegments(module) {
        events.push(`MODULE SEGMENTS ${module}`);
        return [segment];
      },
    };
    const result = await callback(win);
    assert.equal(taskCount, 2);
    return result;
  };
}

function outputBuffer() {
  let value = '';
  return { stream: { write(chunk) { value += chunk; } }, read() { return value; } };
}

function applyChanges(bytes, changes) {
  const result = Buffer.from(bytes);
  for (const change of changes) {
    Buffer.from(change.after, 'hex').copy(result, change.relativeOffset);
  }
  return result;
}

async function main() {
  assert.equal(SNAPSHOT_SCHEMA, 'legacy-mcps.win16-memory-snapshot/v1');
  assert.equal(DIFF_SCHEMA, 'legacy-mcps.win16-memory-diff/v1');
  assert.equal(MAX_READ_LENGTH, 512);
  assert.throws(() => validateManifest({ ranges: manifestFor(1).ranges }), /module is required/);
  assert.throws(() => validateManifest({ module: 'APP', ranges: [] }), /1-128/);
  assert.throws(() => validateManifest({ module: 'APP', ranges: [
    { name: 'same', segment: 1, offset: 0, length: 1 },
    { name: 'same', segment: 1, offset: 1, length: 1 },
  ] }), /duplicate range/);
  assert.throws(() => validateManifest(manifestFor(1,
    [{ name: 'wide', offset: 0, type: 'u32le' }])), /extends beyond/);
  assert.throws(() => validateManifest(manifestFor(4,
    [{ name: 'numeric', offset: 0, type: 'u32le', length: 4 }])), /must not declare/);
  await assert.rejects(() => captureSnapshot(manifestFor(1), {
    sessionOptions: { requiredFeatures: 'MEMORY' }, withSession: fakeSession(Buffer.alloc(1)),
  }), /array of strings/);

  for (const length of [1, 2, 511, 512, 513, 1024, 1025, 65536]) {
    const plan = buildCapturePlan(manifestFor(length), [segment]);
    assert.equal(plan.reads.reduce((sum, read) => sum + read.count, 0), length);
    assert(plan.reads.every(read => read.count >= 1 && read.count <= 512));
    assert.equal(plan.reads.length, Math.ceil(length / 512));
    let expectedOffset = 0x20;
    for (const read of plan.reads) {
      assert.equal(read.offset, expectedOffset);
      expectedOffset += read.count;
    }
    assert.equal(expectedOffset, 0x20 + length);
  }
  assert.throws(() => buildCapturePlan(manifestFor(2), [{ ...segment, size: 0x21 }]),
    /extends beyond/);

  const parsed = parseMemoryResponse('OK 1234:00000020 N=3 00 7F FF', 3);
  assert.equal(parsed.selector, '1234');
  assert.equal(parsed.offset, 0x20);
  assert.equal(parsed.bytes.toString('hex'), '007fff');
  assert.throws(() => parseMemoryResponse('OK 1234:00000020 N=2 00 7F', 3), /expected 3/);
  assert.throws(() => parseMemoryResponse('OK 1234:00000020 N=1 ff', 1), /malformed/);

  const fields = [
    { name: 'unsigned', offset: 0, type: 'u16le' },
    { name: 'signed', offset: 2, type: 'i16le' },
    { name: 'tag', offset: 4, type: 'ascii', length: 4 },
    { name: 'raw', offset: 8, type: 'bytes', length: 2 },
  ];
  const beforeBytes = Buffer.alloc(513);
  for (let index = 0; index < beforeBytes.length; index++) beforeBytes[index] = index & 0xff;
  beforeBytes.writeUInt16LE(0x1234, 0);
  beforeBytes.writeInt16LE(-2, 2);
  beforeBytes.write('AB\0Z', 4, 'latin1');
  const events = [];
  const before = await captureSnapshot(manifestFor(beforeBytes.length, fields), {
    withSession: fakeSession(beforeBytes, events), capturedAt: '2026-01-02T03:04:05.000Z',
  });
  assert.equal(before.schema, SNAPSHOT_SCHEMA);
  assert.equal(before.evidence.atomic, false);
  assert.equal(before.evidence.taskResponseUnchanged, true);
  assert.equal(before.evidence.readReceipts.length, 2);
  assert.equal(before.ranges[0].bytes, beforeBytes.toString('hex').toUpperCase());
  assert.deepEqual(before.ranges[0].decodedFields,
    { unsigned: 0x1234, signed: -2, tag: 'AB', raw: '0809' });
  assert.deepEqual(events.slice(0, 2), ['TASK INFO APP', 'MODULE SEGMENTS APP']);
  validateSnapshot(before);

  assert.equal(decodeField(Buffer.from([0xff]), { name: 'i8', offset: 0, type: 'i8' }), -1);
  assert.equal(decodeField(Buffer.from([0xff, 0xff, 0xff, 0xff]),
    { name: 'i32', offset: 0, type: 'i32le' }), -1);

  const tamperedAtomic = JSON.parse(JSON.stringify(before));
  tamperedAtomic.evidence.atomic = true;
  assert.throws(() => validateSnapshot(tamperedAtomic), /non-atomic evidence/);
  const tamperedReceipt = JSON.parse(JSON.stringify(before));
  tamperedReceipt.evidence.readReceipts[0].response =
    tamperedReceipt.evidence.readReceipts[0].response.replace(/ 34 /, ' 35 ');
  assert.throws(() => validateSnapshot(tamperedReceipt), /does not match its receipts/);
  const tamperedHash = JSON.parse(JSON.stringify(before));
  tamperedHash.ranges[0].sha256 = '0'.repeat(64);
  assert.throws(() => validateSnapshot(tamperedHash), /does not match its receipts/);

  const afterBytes = Buffer.from(beforeBytes);
  afterBytes[0] ^= 0x01;
  afterBytes[1] ^= 0x01;
  afterBytes[20] ^= 0x80;
  const after = await captureSnapshot(manifestFor(afterBytes.length, fields), {
    withSession: fakeSession(afterBytes), capturedAt: '2026-01-02T03:05:05.000Z',
  });
  const diff = diffSnapshots(before, after);
  assert.equal(diff.schema, DIFF_SCHEMA);
  assert.equal(diff.atomic, false);
  assert.equal(diff.changedByteCount, 3);
  assert.equal(diff.ranges[0].changedByteCount, 3);
  assert.equal(diff.ranges[0].changes.length, 2);
  assert.equal(diff.ranges[0].fieldChanges.length, 1);
  assert(applyChanges(beforeBytes, diff.ranges[0].changes).equals(afterBytes));

  /* Deterministic generated cases exercise the diff reconstruction invariant
   * across chunk boundaries and separated/contiguous changes without adding a
   * new test dependency to this dependency-free project. */
  for (const length of [1, 7, 64, 511, 512, 513, 777]) {
    const left = Buffer.alloc(length);
    const right = Buffer.alloc(length);
    for (let index = 0; index < length; index++) {
      left[index] = (index * 17 + length) & 0xff;
      right[index] = left[index] ^ (index % 5 === 0 || index === length - 1 ? 0x5a : 0);
    }
    const leftSnapshot = await captureSnapshot(manifestFor(length), {
      withSession: fakeSession(left), capturedAt: '2026-02-01T00:00:00.000Z',
    });
    const rightSnapshot = await captureSnapshot(manifestFor(length), {
      withSession: fakeSession(right), capturedAt: '2026-02-01T00:00:01.000Z',
    });
    const generatedDiff = diffSnapshots(leftSnapshot, rightSnapshot);
    const expectedChanges = left.reduce((count, byte, index) => count + (byte !== right[index]), 0);
    assert.equal(generatedDiff.changedByteCount, expectedChanges);
    assert(applyChanges(left, generatedDiff.ranges[0].changes).equals(right));
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-mcps-win-snapshot-'));
  try {
    const output = path.join(root, 'snapshot.json');
    assert.equal(publishJsonNoReplace(output, before),
      path.join(fs.realpathSync(root), 'snapshot.json'));
    assert.deepEqual(readJsonFile(output, 'published snapshot'), before);
    assert.equal(fs.lstatSync(output).nlink, 1);
    assert.throws(() => publishJsonNoReplace(output, after), error => error.code === 'EEXIST');
    assert.equal(fs.readdirSync(root).some(name => name.endsWith('.tmp')), false);
    const failedOutput = path.join(root, 'failed-snapshot.json');
    const originalFsync = fs.fsyncSync;
    let fsyncCalls = 0;
    fs.fsyncSync = descriptor => {
      fsyncCalls++;
      if (fsyncCalls === 2) throw new Error('injected post-link directory fsync failure');
      return originalFsync(descriptor);
    };
    try {
      assert.throws(() => publishJsonNoReplace(failedOutput, before), error =>
        /injected post-link/.test(error.message) &&
        error.publicationDisposition === 'retained-uncertain' &&
        path.basename(error.retainedDestination) === 'failed-snapshot.json');
    } finally { fs.fsyncSync = originalFsync; }
    assert.equal(fs.existsSync(failedOutput), true,
      'post-link uncertainty must retain the published destination');
    assert.deepEqual(readJsonFile(failedOutput, 'retained uncertain snapshot'), before);
    assert.equal(fs.readdirSync(root).some(name => name.endsWith('.tmp')), false);
    assert.throws(() => publishJsonNoReplace(failedOutput, before),
      error => error.code === 'EEXIST');
    const failedReadback = path.join(root, 'failed-readback.json');
    const originalReadFile = fs.readFileSync;
    let corruptedRead = false;
    fs.readFileSync = (file, ...args) => {
      const bytes = originalReadFile(file, ...args);
      if (!corruptedRead && path.basename(String(file)) === 'failed-readback.json' &&
          Buffer.isBuffer(bytes)) {
        corruptedRead = true;
        const changed = Buffer.from(bytes);
        changed[0] ^= 1;
        return changed;
      }
      return bytes;
    };
    try {
      assert.throws(() => publishJsonNoReplace(failedReadback, before), error =>
        /durable output check/.test(error.message) &&
        error.publicationDisposition === 'retained-uncertain');
    } finally { fs.readFileSync = originalReadFile; }
    assert.equal(fs.existsSync(failedReadback), true,
      'uncertain readback must retain rather than unlink by a raced path');
    assert.deepEqual(readJsonFile(failedReadback, 'retained failed-readback snapshot'), before);
    assert.equal(fs.readdirSync(root).some(name => name.endsWith('.tmp')), false);
    const link = path.join(root, 'snapshot-link.json');
    fs.symlinkSync('snapshot.json', link);
    assert.throws(() => readJsonFile(link, 'linked snapshot'), /single-link/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.equal(parseArguments(['capture', 'manifest.json', 'snapshot.json']).command, 'capture');
  assert.equal(parseArguments(['diff', 'before.json', 'after.json', 'diff.json']).command, 'diff');
  assert.throws(() => parseArguments(['--timeout', '10', 'diff', 'a', 'b', 'c']), /Usage/);
  assert.throws(() => parseArguments(['capture', 'manifest.json']), /Usage/);

  const cliOutput = outputBuffer();
  let published;
  await runCli(['--magic-dir', '/tmp/generic-share', 'capture', 'manifest.json', 'out.json'], {
    readJsonFile: () => manifestFor(beforeBytes.length, fields),
    captureSnapshot: async (manifest, options) => {
      assert.equal(options.sessionOptions.magicDir, '/tmp/generic-share');
      return captureSnapshot(manifest, { withSession: fakeSession(beforeBytes),
        capturedAt: '2026-01-02T03:04:05.000Z' });
    },
    publishJsonNoReplace: (file, value) => { published = { file, value }; return file; },
    output: cliOutput.stream,
  });
  assert.equal(published.value.schema, SNAPSHOT_SCHEMA);
  assert.match(cliOutput.read(), /"atomic":false/);

  const expectedHash = crypto.createHash('sha256').update(beforeBytes).digest('hex');
  assert.equal(before.ranges[0].sha256, expectedHash);
  console.log('Win16 memory snapshot tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
