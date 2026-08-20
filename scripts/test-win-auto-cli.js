#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArguments, runCli } = require('../lib/win-auto-cli');

function outputBuffer() {
  let value = '';
  return { stream: { write: chunk => { value += chunk; } }, read: () => value };
}

async function main() {
  assert.equal(parseArguments(['windows']).command, 'windows');
  assert.equal(parseArguments(['send', '--', 'META', 'PING']).args.join(' '), '-- META PING');
  assert.equal(parseArguments(['send', '--', 'X'.repeat(511)]).command, 'send');
  assert.equal(parseArguments(['memory', 'read', '1000:00000000', '16']).command, 'memory');
  assert.equal(parseArguments(['exec', '--wait-for', 'Untitled', '--', 'NOTEPAD.EXE'])
    .args.join(' '), '--wait-for Untitled -- NOTEPAD.EXE');
  assert.equal(parseArguments(['exec', '--no-wait', '--', 'WINFILE.EXE', '/e'])
    .args.join(' '), '--no-wait -- WINFILE.EXE /e');
  assert.equal(parseArguments(['reset', '--confirm-guest-reset']).command, 'reset');
  for (const invalid of [[], ['--timeout', '0', 'windows'], ['send', 'META PING'],
    ['send', '--', 'MEMORY', 'WRITE', 'UNSAFE', '1000:00000000', '01'],
    ['send', '--', 'memory', 'write', 'unsafe', '1000:00000000', '01'],
    ['memory', 'write-unsafe', '1000:0', '01'], ['window', 'unknown'],
    ['play', 'status', '100'], ['send', '--', 'X'.repeat(512)], ['exec', 'NOTEPAD.EXE'],
    ['exec', '--no-wait', '--', 'X'.repeat(507)],
    ['exec', '--wait-for', 'Untitled', 'NOTEPAD.EXE'], ['exec', '--no-wait', '--']]) {
    assert.throws(() => parseArguments(invalid));
  }

  let sessions = 0;
  const win = {
    listWindows: async () => [{ hwnd: '1234', className: 'Test', title: 'Example' }],
    send: async command => command === 'META PING' ? 'OK PONG' : 'ERR FAILED',
    readMemory: async () => ({ selector: '1000', offset: '00000000', bytes: Buffer.of(1, 2) }),
    ok: async command => { assert.equal(command, 'EXEC WINFILE.EXE /e'); return '0042'; },
    exec: async (program, options) => {
      assert.equal(program, 'NOTEPAD.EXE');
      assert.deepEqual(options, { waitFor: 'Untitled' });
      return { hwnd: '1234' };
    },
  };
  const withSession = async (_options, callback) => { sessions++; return callback(win); };
  let resets = 0;
  let output = outputBuffer();
  await runCli(['reset', '--confirm-guest-reset'], {
    withSession,
    resetSession: async options => { assert.equal(options.confirmGuestReset, true); resets++; },
    output: output.stream,
  });
  assert.equal(output.read(), 'OK RESET\n');
  assert.equal(resets, 1);
  assert.equal(sessions, 0, 'reset must not enter a command session');
  output = outputBuffer();
  await runCli(['--json', 'windows'], { withSession, output: output.stream });
  assert.match(output.read(), /"hwnd":"1234"/);
  output = outputBuffer();
  await runCli(['memory', 'read', '1000:00000000', '2'],
    { withSession, output: output.stream });
  assert.match(output.read(), /"hex":"0102"/);
  output = outputBuffer();
  await runCli(['exec', '--wait-for', 'Untitled', '--', 'NOTEPAD.EXE'],
    { withSession, output: output.stream });
  assert.equal(output.read(), '{"hwnd":"1234"}\n');
  output = outputBuffer();
  await runCli(['exec', '--no-wait', '--', 'WINFILE.EXE', '/e'],
    { withSession, output: output.stream });
  assert.equal(output.read(), '{"instance":"0042"}\n');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-mcps-cli-'));
  try {
    const sequence = path.join(root, 'sequence.json');
    fs.writeFileSync(sequence, '["META PING"]\n', { mode: 0o600 });
    output = outputBuffer();
    await runCli(['sequence', sequence], { withSession, output: output.stream });
    assert.equal(output.read(), '{"index":0,"command":"META PING","response":"OK PONG"}\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }

  const before = sessions;
  await assert.rejects(() => runCli(['--timeout', '0', 'windows'], { withSession }), /timeout/);
  assert.equal(sessions, before, 'invalid CLI input must not acquire a session');
  console.log('WinAuto CLI tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
