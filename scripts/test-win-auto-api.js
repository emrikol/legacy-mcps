#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { expectedRuntimeIdentity } = require('../lib/guest-tool-identity');
const { WinAuto, Window } = require('../lib/win-auto');

class FakeMailbox {
  constructor(responses) { this.responses = [...responses]; this.commands = []; }
  async send(command) {
    this.commands.push(command);
    if (this.responses.length === 0) throw new Error(`Unexpected command: ${command}`);
    return this.responses.shift();
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-mcps-win-auto-'));
  try {
    const expected = expectedRuntimeIdentity('WINMCP');
    const features = ['META', 'WINDOW', 'TASK', 'MODULE', 'MEMORY', 'CONTROL',
      'RECORD', 'PLAY', 'CONTROL_FINDID'];
    const mailbox = new FakeMailbox([
      `OK TOOL=WINMCP PROTOCOL=${expected.protocol} BUILD=${expected.build} ` +
        `FEATURES=${features.join(',')}`,
      'OK TASK=1234', 'OK CS:IP=1000:0100', 'OK #0=TEST!1:0100',
      'OK MODULE=TEST HMODULE=1234', 'OK ADDRESS=1000:0100',
      'OK MODULE=TEST START=1 SEG=1 SEL=1000 HANDLE=1001 TYPE=1 DATA=1 BASE=00010000 SIZE=00001000 FLAGS=0001 LOCKS=1 NEXT=2',
      'OK MODULE=TEST START=2 SEG=2 SEL=2000 HANDLE=2001 TYPE=2 DATA=2 BASE=00020000 SIZE=00002000 FLAGS=0002 LOCKS=0 NEXT=0',
      'OK 1000:00000010 N=4 01 02 03 04',
      'OK MUTATED=1 1000:00000010 N=2 BEFORE=AABB AFTER=0102',
      'OK 4321', 'OK PLAYING 1/2', 'OK IDLE',
    ]);
    const win = new WinAuto({ magicDir: root, mailbox });
    assert.equal((await win.identity()).build, expected.build);
    assert.equal(await win.taskInfo('TEST'), 'TASK=1234');
    assert.equal(await win.taskCsip('1234'), 'CS:IP=1000:0100');
    assert.equal(await win.taskStack('TEST'), '#0=TEST!1:0100');
    assert.equal(await win.moduleInfo('TEST'), 'MODULE=TEST HMODULE=1234');
    assert.equal(await win.moduleProc('TEST', '#1'), 'ADDRESS=1000:0100');
    const segments = await win.moduleSegments('TEST');
    assert.deepEqual(segments.map(segment => segment.segment), [1, 2]);
    assert(Object.isFrozen(segments) && segments.every(Object.isFrozen));
    const memory = await win.readMemory('1000:00000010', 4);
    assert.equal(memory.bytes.toString('hex'), '01020304');
    const mutation = await win.writeMemoryUnsafe('1000:00000010', Buffer.from([1, 2]),
      { confirmUnsafe: true });
    assert.equal(mutation.before.toString('hex'), 'aabb');
    assert.equal(win.manipulated, true);
    const child = await new Window(win, '1111').locatorById(42);
    assert.equal(child.hwnd, '4321');
    await win.waitForPlayback({ timeout: 1000, pollMs: 1 });
    assert.deepEqual(mailbox.commands.slice(-3),
      ['CONTROL FINDID 1111 42', 'PLAY STATUS', 'PLAY STATUS']);

    await assert.rejects(() => win.writeMemoryUnsafe('1000:00000010', Buffer.of(1)),
      /confirmUnsafe/);
    await assert.rejects(() => win.readMemory('0000:00000000', 1), /nonzero selector/);
    await assert.rejects(() => new Window(win, '1111').locatorById(0), /Control ID/);
    const commandCount = mailbox.commands.length;
    await assert.rejects(() => win.send('memory write unsafe 1000:00000010 01'),
      /writeMemoryUnsafe/);
    await assert.rejects(() => win._dispatch('MEMORY WRITE UNSAFE 1000:00000010 01',
      undefined, true), /writeMemoryUnsafe/);
    assert.equal(mailbox.commands.length, commandCount,
      'raw unsafe writes must be rejected before mailbox dispatch');

    const find = new WinAuto({ magicDir: root,
      mailbox: new FakeMailbox(['ERR NOT_FOUND', 'ERR INTERNAL', 'OK 2222']) });
    assert.equal(await find.findWindow('Missing'), null);
    await assert.rejects(() => find.findWindow('Broken'), /Malformed WINDOW FIND/);
    assert.equal((await find.findWindow('Present')).hwnd, '2222');

    const stalled = new WinAuto({ magicDir: root, mailbox: new FakeMailbox([
      'OK MODULE=TEST START=1 SEG=1 SEL=1000 HANDLE=1001 TYPE=1 DATA=1 BASE=00010000 SIZE=00001000 FLAGS=0001 LOCKS=1 NEXT=1',
    ]) });
    await assert.rejects(() => stalled.moduleSegments('TEST'), /did not advance/);

    const duplicate = new WinAuto({ magicDir: root, mailbox: new FakeMailbox([
      'OK MODULE=TEST START=1 SEG=1 SEL=1000 HANDLE=1001 TYPE=1 DATA=1 BASE=00010000 SIZE=00001000 FLAGS=0001 LOCKS=1 NEXT=2',
      'OK MODULE=TEST START=2 SEG=1 SEL=2000 HANDLE=2001 TYPE=2 DATA=2 BASE=00020000 SIZE=00002000 FLAGS=0002 LOCKS=0 NEXT=0',
    ]) });
    await assert.rejects(() => duplicate.moduleSegments('TEST'), /unique and forward-moving/);

    const wrongHeader = new WinAuto({ magicDir: root, mailbox: new FakeMailbox([
      'OK SEG=1 SEL=1000 HANDLE=1001 TYPE=1 DATA=1 BASE=00010000 SIZE=00001000 FLAGS=0001 LOCKS=1 NEXT=0',
    ]) });
    await assert.rejects(() => wrongHeader.moduleSegments('TEST'), /header/);

    const malformed = new WinAuto({ magicDir: root,
      mailbox: new FakeMailbox(['OK 1000:00000010 N=3 01 02 03']) });
    await assert.rejects(() => malformed.readMemory('1000:00000010', 4), /Malformed/);
    const uncertainMutation = new WinAuto({ magicDir: root,
      mailbox: new FakeMailbox(['ERR AUDIT_FAILED RESTORED=FALSE']) });
    await assert.rejects(() => uncertainMutation.writeMemoryUnsafe('1000:00000010',
      Buffer.of(1), { confirmUnsafe: true }), /Command failed/);
    assert.equal(uncertainMutation.manipulated, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('WinAuto structured API tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
