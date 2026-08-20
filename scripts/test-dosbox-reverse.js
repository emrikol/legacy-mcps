#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const { parseRequest, runCli, runReverse, safeIntegerField,
  stepPlan } = require('../lib/dosbox-reverse');
const { main: runBin, parseCli } = require('../bin/dosbox-reverse');

function outputBuffer() {
  let value = '';
  return { stream: { write: chunk => { value += chunk; } }, read: () => value };
}

function fakeSession(options = {}) {
  const log = [];
  let sequence = options.checkpointSequence ?? 40;
  const session = {
    log,
    status: async () => { log.push('status');
      return `OK STOPPED=${options.stopped ?? 1} SEQUENCE=${options.originalSequence ?? 100}`; },
    restoreCheckpoint: async name => { log.push(`restore:${name}`);
      return `OK CHECKPOINT=RESTORED NAME=${options.restoredName ?? name} SEQUENCE=${sequence}`; },
    verifyDeterminism: async () => { log.push('determinism:verify');
      return `OK MODE=VERIFY SEQUENCE=${options.armSequence ?? sequence} FAILED=0`; },
    replayInput: async () => { log.push('input:replay'); return `OK FROM_SEQUENCE=${sequence}`; },
    registers: async () => { log.push('registers');
      return `OK STOPPED=${options.registersStopped ?? 1} EAX=0 SEQUENCE=${sequence}`; },
    step: async count => { log.push(`step:${count}`); sequence += count;
      if (options.wrongStep) sequence++;
      return `OK STOPPED=${options.stepStopped ?? 1} SEQUENCE=${sequence}`; },
    determinismStatus: async () => { log.push('determinism:status');
      return `OK MODE=${options.mode ?? 'VERIFY'} SEQUENCE=${options.statusSequence ?? sequence} FAILED=${options.failed ?? 0}`; },
    inputStatus: async () => { log.push('input:status');
      return `OK ACTIVE=${options.active ?? 1} SEQUENCE=${options.statusSequence ?? sequence} SKIPPED=${options.skipped ?? 0}`; },
  };
  return session;
}

async function main() {
  assert.deepEqual(parseRequest(['step', 'boot-1', '10']),
    { operation: 'step', checkpoint: 'boot-1', count: 10 });
  assert.deepEqual(parseCli(['--port', '10199', '--lease-dir', '/tmp/mcp',
    'step', 'boot-1', '10']), { options: { port: 10199, leaseDirectory: '/tmp/mcp' },
    operation: ['step', 'boot-1', '10'] });
  assert.throws(() => parseCli(['--timeout', '34999', 'step', 'x', '1']), /35000/);
  for (const invalid of [[], ['step', '../x', '1'], ['step', 'x', '0'],
    ['step', 'x', String(Number.MAX_SAFE_INTEGER + 1)],
    ['continue', 'x', '1234:1']]) assert.equal(parseRequest(invalid), undefined);
  assert.deepEqual(stepPlan(20001), [10000, 10000, 1]);
  assert.throws(() => stepPlan(-1), /nonnegative safe integer/);
  assert.throws(() => stepPlan(100000001), /command bound/);
  assert.throws(() => safeIntegerField('OK SEQUENCE=1 SEQUENCE=2', 'SEQUENCE'), /Duplicate/);

  let session = fakeSession();
  let result = await runReverse(session, parseRequest(['step', 'base', '10']));
  assert.equal(result.targetSequence, 90);
  assert.equal(result.stoppedSequence, 90);
  assert.deepEqual(session.log, ['status', 'restore:base', 'determinism:verify', 'input:replay',
    'registers', 'step:50', 'determinism:status', 'input:status']);

  session = fakeSession({ originalSequence: 200100 });
  result = await runReverse(session, parseRequest(['step', 'base', '10']));
  assert.equal(session.log.filter(entry => entry.startsWith('step:10000')).length, 20);
  assert.equal(session.log.filter(entry => entry === 'step:50').length, 1);
  assert.equal(result.stoppedSequence, 200090);

  session = fakeSession();
  await assert.rejects(() => runReverse(session,
    parseRequest(['step', 'base', '61'])), /precedes/);
  assert.deepEqual(session.log, ['status', 'restore:base'],
    'invalid reverse target must fail before replay is armed');
  await assert.rejects(() => runReverse(fakeSession({ stopped: 0 }),
    parseRequest(['step', 'base', '10'])), /originally stopped/);
  await assert.rejects(() => runReverse(fakeSession({ restoredName: 'other' }),
    parseRequest(['step', 'base', '10'])), /receipt/);
  await assert.rejects(() => runReverse(fakeSession({ armSequence: 41 }),
    parseRequest(['step', 'base', '10'])), /did not arm/);
  await assert.rejects(() => runReverse(fakeSession({ registersStopped: 0 }),
    parseRequest(['step', 'base', '10'])), /register receipt is not stopped/);
  await assert.rejects(() => runReverse(fakeSession({ wrongStep: true }),
    parseRequest(['step', 'base', '10'])), /STEP did not report/);
  await assert.rejects(() => runReverse(fakeSession({ stepStopped: 0 }),
    parseRequest(['step', 'base', '10'])), /leave the debugger stopped/);
  await assert.rejects(() => runReverse(fakeSession({ failed: 1 }),
    parseRequest(['step', 'base', '10'])), /diverged/);
  await assert.rejects(() => runReverse(fakeSession({ mode: 'RECORD' }),
    parseRequest(['step', 'base', '10'])), /diverged/);
  await assert.rejects(() => runReverse(fakeSession({ skipped: 1 }),
    parseRequest(['step', 'base', '10'])), /skipped/);
  await assert.rejects(() => runReverse(fakeSession({ active: 0 }),
    parseRequest(['step', 'base', '10'])), /skipped/);
  await assert.rejects(() => runReverse(fakeSession({ statusSequence: 89 }),
    parseRequest(['step', 'base', '10'])), /exact stopped sequence/);
  session = fakeSession();
  const output = outputBuffer();
  let leases = 0;
  result = await runCli(['step', 'base', '10'], { output: output.stream,
    withSession: async (options, callback) => {
      assert.deepEqual(options, {}); leases++; return callback(session);
    } });
  assert.equal(leases, 1);
  assert.equal(JSON.parse(output.read()).stoppedSequence, result.stoppedSequence);
  const binOutput = outputBuffer();
  let binOptions;
  await runBin(['--port', '10200', 'step', 'base', '10'], {
    output: binOutput.stream,
    withSession: async (options, callback) => { binOptions = options; return callback(fakeSession()); },
  });
  assert.deepEqual(binOptions, { port: 10200 });
  assert.equal(JSON.parse(binOutput.read()).targetSequence, 90);
  await assert.rejects(() => runCli(['step', 'bad..name', '1'], {
    withSession: async () => { throw new Error('must not acquire'); },
  }), /Usage/);
  await assert.rejects(() => runCli(['step', 'base', '1']), /adapter/);

  console.log('DOSBox reverse workflow tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
