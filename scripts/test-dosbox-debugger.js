#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { DosboxControl, encodeDebugBatch } = require('../lib/dosbox-control');
const { DebuggerSession, debuggerTransportOptions, loadBatch, parseBatchResponse, parseDebuggerArguments,
  parseMutationArguments, parseMutationResponse, resetDebuggerSession,
  withDebuggerSession } = require('../lib/dosbox-debugger');
const { validateDebuggerIdentity } = require('../lib/dosbox-debugger');
const { expectedIdentity } = require('./verify-dosbox-identity');
const { parseCli, run: runDebuggerCli } = require('../bin/dosbox-debugger');

const DEBUG_FEATURES = 'STATUS,PAUSE,REGISTERS,SELECTOR,MEMORY,DISASM,STACK,SNAPSHOT,STEP,NEXT,' +
  'FINISH,RUN,BREAK,WATCH,INTERRUPT,EXCEPTION,BATCH,MUTATE,FILEIO,APITRACE,COVERAGE,' +
  'CHECKPOINT,HASH,INPUT,DETERMINISM,WAIT,CONTINUE';
const IDENTITY = 'OK TOOL=DOSBOX-X PROTOCOL=CONTROL/1 BUILD=' + expectedIdentity() +
  ' FEATURES=PING,IDENTITY,STATUS,DEBUG,QUIT DEBUG_PROTOCOL=1 DEBUG_FEATURES=' + DEBUG_FEATURES;

class FakeControl {
  constructor(responses = []) { this.responses = responses; this.commands = []; this.options = []; }
  async identity() { this.commands.push('IDENTITY'); return IDENTITY; }
  async debug(command, options) {
    this.commands.push(`DEBUG ${command}`);
    this.options.push(options);
    if (this.markerPath) {
      assert.equal(fs.readFileSync(this.markerPath, 'utf8'),
        'uncertain-debugger-command-v1\n');
    }
    const response = this.responses.shift() ?? 'OK';
    return typeof response === 'function' ? response() : response;
  }
  async debugBatch(commands, options) {
    this.commands.push(encodeDebugBatch(commands));
    this.options.push(options);
    if (this.markerPath) {
      assert.equal(fs.readFileSync(this.markerPath, 'utf8'),
        'uncertain-debugger-command-v1\n');
    }
    return this.responses.shift() ?? 'OK BATCH N=1 2:OK';
  }
}

async function main() {
  assert.equal(validateDebuggerIdentity(IDENTITY).debugProtocol, 1);
  assert.deepEqual(debuggerTransportOptions('STATUS'), { timeout: 35000 });
  assert.deepEqual(debuggerTransportOptions('WAIT 295000'), { timeout: 300000 });
  assert.deepEqual(debuggerTransportOptions('WAIT   +295000'), { timeout: 300000 });
  assert.throws(() => debuggerTransportOptions('WAIT 300000'), /1-295000ms/);
  assert.throws(() => debuggerTransportOptions('WAIT  +300000'), /1-295000ms/);
  assert.throws(() => debuggerTransportOptions('STATUS', { timeout: 5000 }), /35000-300000/);
  assert.throws(() => validateDebuggerIdentity(IDENTITY.replace('DEBUG_PROTOCOL=1',
    'DEBUG_PROTOCOL=0')), /protocol/);
  assert.throws(() => validateDebuggerIdentity(IDENTITY.replace(',CONTINUE', '')), /missing CONTINUE/);
  assert.equal(parseDebuggerArguments(['status']).command, 'STATUS');
  assert.equal(parseDebuggerArguments(['step', '1']).command, 'STEP 1');
  assert.equal(parseDebuggerArguments(['run-until', 'abcd:12']).command, 'RUN UNTIL ABCD:12');
  assert.equal(parseDebuggerArguments(['checkpoint-restore', 'clean']).command,
    'CHECKPOINT RESTORE clean');
  assert.equal(parseDebuggerArguments(['memory', '1234:56', '20']).command,
    'MEMORY READ 1234:56 20');
  assert.throws(() => parseDebuggerArguments(['memory', '1234:56', '201']), /1 through 200/);
  assert.throws(() => parseDebuggerArguments(['disasm', '1234:56', '21']), /optional address/);
  assert.throws(() => parseDebuggerArguments(['stack', '65']), /1 through 64/);
  assert.equal(parseDebuggerArguments(['input', 'add', '42', 'key', 'enter', 'down']).command,
    'INPUT ADD 42 KEY ENTER DOWN');
  assert.throws(() => parseDebuggerArguments(['input', 'add', '42', 'mouse', 'move', '32768', '0']),
    /Invalid input/);
  assert.equal(parseDebuggerArguments(['coverage', 'drain', '256']).command,
    'COVERAGE DRAIN 256');
  assert.equal(parseDebuggerArguments(['wait', '295000']).timeout, 300000);
  assert.throws(() => parseDebuggerArguments(['raw', 'MUTATE', 'REGISTER', 'AX', '1']), /non-mutation/);
  assert.throws(() => parseDebuggerArguments(['step', '0']), /1 through 10000/);
  assert.throws(() => parseDebuggerArguments(['step', '10001']), /1 through 10000/);
  assert.equal(parseDebuggerArguments(['finish', '10000000']).command, 'FINISH 10000000');
  assert.throws(() => parseDebuggerArguments(['run-until', '1234:0;QUIT']), /address/);
  for (const forbidden of ['BATCH', 'CONTINUE', 'NEXT', 'RUN', 'PAUSE', 'WAIT', 'STATUS', 'MUTATE']) {
    assert.throws(() => encodeDebugBatch([forbidden]), /forbidden/);
  }
  for (let count = 1; count <= 8; count++) {
    const commands = Array.from({ length: count }, (_, index) => `REGISTERS ${index}`);
    const encoded = encodeDebugBatch(commands);
    assert.equal(encoded.startsWith(`DEBUG BATCH ${count} `), true);
    let cursor = encoded.indexOf(' ') + 1;
    cursor = encoded.indexOf(' ', cursor) + 1;
    cursor = encoded.indexOf(' ', cursor) + 1;
    for (const command of commands) {
      const colon = encoded.indexOf(':', cursor);
      const length = Number(encoded.slice(cursor, colon));
      assert.equal(encoded.slice(colon + 1, colon + 1 + length), command);
      cursor = colon + 1 + length;
    }
    assert.equal(cursor, encoded.length, 'batch frames must consume the exact wire request');
  }

  const parsedBatch = parseBatchResponse('ERR BATCH INDEX=1 N=2 2:OK 10:ERR FAILED', ['A', 'B']);
  assert.equal(parsedBatch.ok, false);
  assert.equal(parsedBatch.failedIndex, 1);
  assert.throws(() => parseBatchResponse('OK BATCH N=1 2:OK trailing', ['A']), /inconsistent/);

  const register = parseMutationArguments(['register', 'ax', '2a', '--reason', 'test readback',
    '--confirm-manipulated-oracle']);
  assert.equal(parseMutationResponse('OK MUTATED=1 ORACLE=MANIPULATED MUTATIONS=1 ' +
    'TYPE=REGISTER REGISTER=AX BEFORE=0000 AFTER=002A READBACK=002A', register.summary).readback, '002A');
  assert.throws(() => parseMutationResponse('OK MUTATED=1 ORACLE=MANIPULATED MUTATIONS=1 ' +
    'TYPE=REGISTER REGISTER=AX BEFORE=0000 AFTER=002A READBACK=002B', register.summary), /does not verify/);
  assert.throws(() => parseMutationArguments(['register', 'AX', '1', '--reason', 'x']), /final argument/);
  assert.throws(() => parseMutationArguments(['register', 'AX', '10000', '--reason', 'x',
    '--confirm-manipulated-oracle']), /at most 4/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-mcps-debugger-'));
  try {
    const batchPath = path.join(root, 'batch.json');
    fs.writeFileSync(batchPath, '["REGISTERS","STACK 8"]\n');
    assert.equal(loadBatch(batchPath).wireCommand, 'DEBUG BATCH 2 9:REGISTERS7:STACK 8');
    fs.writeFileSync(batchPath, '["PAUSE"]\n');
    assert.throws(() => loadBatch(batchPath), /forbidden/);
    const batchLink = path.join(root, 'batch-link.json');
    fs.symlinkSync('batch.json', batchLink);
    assert.throws(() => loadBatch(batchLink), /single-link/);

    const control = new FakeControl(['OK STOPPED', 'OK REGISTERS',
      'OK MUTATED=1 ORACLE=MANIPULATED MUTATIONS=1 TYPE=REGISTER ' +
      'REGISTER=AX BEFORE=0000 AFTER=002A READBACK=002A']);
    const uncertaintyMarker = path.join(root, '.dosbox-debugger-host-command.inflight');
    control.markerPath = uncertaintyMarker;
    let escaped;
    const result = await withDebuggerSession({ control, leaseDirectory: root,
      auditPath: path.join(root, 'audit.jsonl'), identityValidator: response => {
        assert.equal(response, IDENTITY); return Object.freeze({ build: expectedIdentity() });
      } }, async session => {
      escaped = session;
      assert.equal(await session.status(), 'OK STOPPED');
      assert.equal(await session.registers(), 'OK REGISTERS');
      return session.mutate(register);
    });
    assert.equal(result.verification.readback, '002A');
    assert.equal(control.commands[0], 'IDENTITY', 'identity must precede every debugger command');
    assert(control.options.every(options => options.timeout === 35000));
    assert.throws(() => escaped.status(), /revoked/);
    assert.equal(escaped.open, undefined, 'scoped debugger facade must not expose open');
    assert.equal(escaped.close, undefined, 'scoped debugger facade must not expose close');
    assert.equal(fs.existsSync(path.join(root, '.dosbox-debugger-host-command.lock')), false);
    assert.equal(fs.existsSync(uncertaintyMarker), false);

    let activeCommands = 0;
    let maximumActiveCommands = 0;
    const serializedControl = new FakeControl();
    serializedControl.debug = async command => {
      serializedControl.commands.push(`DEBUG ${command}`);
      activeCommands++;
      maximumActiveCommands = Math.max(maximumActiveCommands, activeCommands);
      await new Promise(resolve => setTimeout(resolve, command === 'STEP 1' ? 20 : 1));
      activeCommands--;
      return `OK ${command}`;
    };
    await withDebuggerSession({ control: serializedControl, leaseDirectory: root,
      identityValidator: () => Object.freeze({ build: expectedIdentity() }) }, async session => {
      const first = session.step(1);
      const second = session.registers();
      assert.deepEqual(await Promise.all([first, second]), ['OK STEP 1', 'OK REGISTERS']);
    });
    assert.equal(maximumActiveCommands, 1, 'same-session commands must be serialized');
    assert.deepEqual(serializedControl.commands.slice(1), ['DEBUG STEP 1', 'DEBUG REGISTERS']);

    const failedQueueControl = new FakeControl([
      () => Promise.reject(new Error('injected debugger transport failure')),
      'OK MUST NOT RUN',
    ]);
    await assert.rejects(() => withDebuggerSession({ control: failedQueueControl,
      leaseDirectory: root,
      identityValidator: () => Object.freeze({ build: expectedIdentity() }),
    }, session => {
      session.status();
      session.registers();
      return 'callback returned';
    }), /injected debugger transport failure/);
    assert.deepEqual(failedQueueControl.commands,
      ['IDENTITY', 'DEBUG STATUS'], 'queue must stop dispatching after transport failure');
    assert.equal(fs.readFileSync(uncertaintyMarker, 'utf8'),
      'uncertain-debugger-command-v1\n');
    await assert.rejects(() => new DebuggerSession({ control: new FakeControl(),
      leaseDirectory: root,
      identityValidator: () => Object.freeze({ build: expectedIdentity() }),
    }).open(), /retained as uncertain/);
    await assert.rejects(() => resetDebuggerSession({ leaseDirectory: root }),
      /confirmEmulatorReset=true/);
    assert.equal((await resetDebuggerSession({ leaseDirectory: root,
      confirmEmulatorReset: true })).reset, true);
    assert.equal(fs.existsSync(uncertaintyMarker), false);

    const waitControl = new FakeControl(['OK STOPPED=1']);
    await withDebuggerSession({ control: waitControl, leaseDirectory: root,
      identityValidator: () => Object.freeze({ build: expectedIdentity() }),
    }, session => session.command('WAIT 295000'));
    assert.equal(waitControl.options[0].timeout, 300000);

    for (const uncertainResponse of ['ERR PAUSE_TIMEOUT', 'ERR COMMAND_TIMEOUT', 'ERR BUSY']) {
      await assert.rejects(() => withDebuggerSession({
        control: new FakeControl([uncertainResponse]), leaseDirectory: root,
        identityValidator: () => Object.freeze({ build: expectedIdentity() }),
      }, session => session.status()), error =>
        error.debuggerDisposition === 'retained-uncertain' &&
        /retained as uncertain/.test(error.message));
      assert.equal(fs.existsSync(uncertaintyMarker), true);
      await resetDebuggerSession({ leaseDirectory: root, confirmEmulatorReset: true });
    }
    const protocolQueue = new FakeControl(['ERR COMMAND_TIMEOUT', 'OK MUST NOT RUN']);
    await assert.rejects(() => withDebuggerSession({ control: protocolQueue,
      leaseDirectory: root,
      identityValidator: () => Object.freeze({ build: expectedIdentity() }),
    }, session => {
      session.status();
      session.registers();
      return 'callback returned';
    }), /retained as uncertain/);
    assert.deepEqual(protocolQueue.commands, ['IDENTITY', 'DEBUG STATUS']);
    await resetDebuggerSession({ leaseDirectory: root, confirmEmulatorReset: true });
    const safeTimeout = new FakeControl(['ERR WAIT_TIMEOUT']);
    assert.equal(await withDebuggerSession({ control: safeTimeout, leaseDirectory: root,
      identityValidator: () => Object.freeze({ build: expectedIdentity() }),
    }, session => session.command('WAIT 1')), 'ERR WAIT_TIMEOUT');

    const originalFsync = fs.fsyncSync;
    let injectedSyncFailure = false;
    fs.fsyncSync = descriptor => {
      if (!injectedSyncFailure && fs.fstatSync(descriptor).isDirectory() &&
          !fs.existsSync(uncertaintyMarker)) {
        injectedSyncFailure = true;
        throw new Error('injected marker directory sync failure');
      }
      return originalFsync(descriptor);
    };
    try {
      await assert.rejects(() => withDebuggerSession({ control: new FakeControl(['OK STOPPED=1']),
        leaseDirectory: root,
        identityValidator: () => Object.freeze({ build: expectedIdentity() }),
      }, session => session.status()), error =>
        error.debuggerDisposition === 'retained-uncertain' &&
        /injected marker directory sync failure/.test(error.message));
    } finally { fs.fsyncSync = originalFsync; }
    assert.equal(fs.readFileSync(uncertaintyMarker, 'utf8'),
      'uncertain-debugger-command-v1\n');
    await resetDebuggerSession({ leaseDirectory: root, confirmEmulatorReset: true });

    const truncatedServer = net.createServer(socket => {
      let command = '';
      socket.setEncoding('utf8');
      socket.on('data', chunk => { command += chunk; });
      socket.on('end', () => {
        if (command.trimEnd() === 'IDENTITY') socket.end(`${IDENTITY}\n`);
        else socket.end('OK PARTIAL');
      });
    });
    await new Promise((resolve, reject) => {
      truncatedServer.once('error', reject);
      truncatedServer.listen(0, '127.0.0.1', resolve);
    });
    try {
      await assert.rejects(() => withDebuggerSession({
        control: new DosboxControl({ port: truncatedServer.address().port, timeout: 1000 }),
        leaseDirectory: root,
      }, session => session.status()), error =>
        error.debuggerDisposition === 'retained-uncertain' && /terminal newline/.test(error.message));
      assert.equal(fs.readFileSync(uncertaintyMarker, 'utf8'),
        'uncertain-debugger-command-v1\n');
    } finally {
      await new Promise(resolve => truncatedServer.close(resolve));
    }
    await resetDebuggerSession({ leaseDirectory: root, confirmEmulatorReset: true });
    assert.equal(fs.existsSync(uncertaintyMarker), false);

    const multilineServer = net.createServer(socket => {
      let command = '';
      socket.setEncoding('utf8');
      socket.on('data', chunk => { command += chunk; });
      socket.on('end', () => {
        if (command.trimEnd() === 'IDENTITY') socket.end(`${IDENTITY}\n`);
        else socket.end('OK SCREEN\nROW ONE\nROW TWO\n');
      });
    });
    await new Promise((resolve, reject) => {
      multilineServer.once('error', reject);
      multilineServer.listen(0, '127.0.0.1', resolve);
    });
    try {
      assert.equal(await withDebuggerSession({
        control: new DosboxControl({ port: multilineServer.address().port, timeout: 1000 }),
        leaseDirectory: root,
      }, session => session.command('SCREEN')), 'OK SCREEN\nROW ONE\nROW TWO');
      assert.equal(fs.existsSync(uncertaintyMarker), false);
    } finally {
      await new Promise(resolve => multilineServer.close(resolve));
    }

    const failedAuditPath = path.join(root, 'failed-audit.jsonl');
    await assert.rejects(() => withDebuggerSession({
      control: new FakeControl(['OK MUTATED=1 ORACLE=MANIPULATED MUTATIONS=1 ' +
        'TYPE=REGISTER REGISTER=AX BEFORE=0000 AFTER=002A READBACK=0000']),
      leaseDirectory: root, auditPath: failedAuditPath,
      identityValidator: () => Object.freeze({ build: 'a'.repeat(64) }),
    }, session => session.mutate(register)), /does not verify/);
    const failedAudit = fs.readFileSync(failedAuditPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(failedAudit.map(record => record.phase), ['intent', 'failed']);
    assert.equal(failedAudit[1].response.endsWith('READBACK=0000'), true);
    const audit = fs.readFileSync(path.join(root, 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(audit.map(record => record.phase), ['intent', 'verified']);
    assert.equal(audit[1].verification.readback, '002A');

    let unhandled;
    const onUnhandled = error => { unhandled = error; };
    process.once('unhandledRejection', onUnhandled);
    await assert.rejects(() => withDebuggerSession({
      control: new FakeControl(['OK MUTATED=1 ORACLE=MANIPULATED MUTATIONS=1 ' +
        'TYPE=REGISTER REGISTER=AX BEFORE=0000 AFTER=002A READBACK=0000']),
      leaseDirectory: root, auditPath: path.join(root, 'unawaited-audit.jsonl'),
      identityValidator: () => Object.freeze({ build: 'b'.repeat(64) }),
    }, session => { session.mutate(register); return 'callback returned'; }), /does not verify/);
    await new Promise(resolve => setImmediate(resolve));
    process.removeListener('unhandledRejection', onUnhandled);
    assert.equal(unhandled, undefined, 'drained mutation failure must not reject unobserved');

    let observedLease = false;
    const delayed = new FakeControl([() => new Promise(resolve => setTimeout(() => {
      observedLease = fs.existsSync(path.join(root, '.dosbox-debugger-host-command.lock'));
      resolve('OK STOPPED');
    }, 20))]);
    await withDebuggerSession({ control: delayed, leaseDirectory: root,
      identityValidator: () => Object.freeze({ build: expectedIdentity() }) }, async session => {
      assert.throws(() => session.command('MUTATE REGISTER AX 1 CONFIRM_MANIPULATED_ORACLE'),
        /Use mutate/);
      assert.throws(() => session.command('BATCH 1 9:REGISTERS'), /Use batch/);
      session.status();
      return 'callback returned';
    });
    assert.equal(observedLease, true, 'debugger lease must remain held through unawaited commands');
    assert.equal(fs.existsSync(path.join(root, '.dosbox-debugger-host-command.lock')), false);

    await assert.rejects(() => withDebuggerSession({ control: new FakeControl(),
      leaseDirectory: root,
      identityValidator: () => Object.freeze({ build: expectedIdentity() }),
    }, session => session.mutate({ reason: 'forged', summary: register.summary })),
    /parseMutationArguments/);

    const bad = new DebuggerSession({ control: new FakeControl(), leaseDirectory: root,
      identityValidator: () => { throw new Error('identity mismatch'); } });
    await assert.rejects(() => bad.open(), /identity mismatch/);
    assert.equal(fs.existsSync(path.join(root, '.dosbox-debugger-host-command.lock')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.equal(parseCli(['--port', '10199', 'status']).operation.command, 'STATUS');
  assert.equal(parseCli(['reset', '--confirm-emulator-reset']).operation.kind, 'reset');
  let resetOptions;
  const resetResult = await runDebuggerCli(parseCli(['--lease-dir', '/tmp/debug-reset',
    'reset', '--confirm-emulator-reset']), {
    resetDebuggerSession: async options => { resetOptions = options; return { reset: true }; },
  });
  assert.equal(resetOptions.leaseDirectory, '/tmp/debug-reset');
  assert.equal(resetOptions.confirmEmulatorReset, true);
  assert.equal(JSON.parse(resetResult.output).reset, true);
  assert.throws(() => parseCli(['reset']), /Unknown debugger operation|operation is required/);
  assert.throws(() => parseCli(['--timeout']), /incomplete/);
  console.log('DOSBox-X debugger client tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
