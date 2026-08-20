#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { expectedRuntimeIdentity } = require('../lib/guest-tool-identity');
const { withWinAutoSession } = require('../lib/win-session');

function identityResponse() {
  const expected = expectedRuntimeIdentity('WINMCP');
  return `OK TOOL=WINMCP PROTOCOL=${expected.protocol} BUILD=${expected.build} ` +
    'FEATURES=META,WINDOW,TASK,MODULE,MEMORY,CONTROL,RECORD,PLAY,CONTROL_FINDID';
}

async function agent(directory, exchanges) {
  for (const exchange of exchanges) {
    const deadline = Date.now() + 2000;
    let request;
    while (Date.now() < deadline && !request) {
      request = fs.readdirSync(directory).find(name => name.toLowerCase() === '__win__.tx');
      if (!request) await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert(request, 'WINMCP request did not appear');
    /* The host validates the published request identity immediately after its
     * atomic rename. Model the guest poll interval instead of consuming the
     * file in that validation window. */
    await new Promise(resolve => setTimeout(resolve, 5));
    const command = fs.readFileSync(path.join(directory, request), 'ascii').trim();
    fs.unlinkSync(path.join(directory, request));
    assert.equal(command, exchange.command);
    if (exchange.response !== undefined) {
      if (exchange.delayMs) await new Promise(resolve => setTimeout(resolve, exchange.delayMs));
      if (exchange.assertLeaseHeld) {
        assert.equal(fs.existsSync(path.join(directory, '.winmcp-host-command.lock')), true,
          'session lease was released before an unawaited command drained');
      }
      fs.writeFileSync(path.join(directory, '__WIN__.RX'), `${exchange.response}\r\n`,
        { flag: 'wx', mode: 0o600 });
    }
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-mcps-win-session-'));
  try {
    fs.writeFileSync(path.join(root, '__WIN__.ST'), 'READY\n', { mode: 0o600 });
    let responder = agent(root, [
      { command: 'META PING', response: 'OK PONG' },
      { command: 'META IDENTITY', response: identityResponse() },
      { command: 'WINDOW LIST', response: 'OK 1234:Test:Example' },
    ]);
    const windows = await withWinAutoSession({ magicDir: root, pollMs: 2 },
      win => win.listWindows());
    assert.deepEqual(windows, [{ hwnd: '1234', className: 'Test', title: 'Example' }]);
    await responder;
    assert.equal(fs.existsSync(path.join(root, '.winmcp-host-command.lock')), false);

    responder = agent(root, [
      { command: 'META PING', response: 'OK PONG' },
      { command: 'META IDENTITY', response: identityResponse() },
    ]);
    await assert.rejects(() => withWinAutoSession({ magicDir: root, pollMs: 2 }, win => {
      assert.equal(Object.getOwnPropertyDescriptor(win, 'mailbox'), undefined);
      void win.mailbox;
    }), /does not expose mailbox/);
    await responder;
    assert.equal(fs.existsSync(path.join(root, '.winmcp-host-command.lock')), false);

    responder = agent(root, [
      { command: 'META PING', response: 'OK PONG' },
      { command: 'META IDENTITY', response: identityResponse() },
      { command: 'WINDOW LIST', response: 'ERR FAILED' },
    ]);
    await assert.rejects(() => withWinAutoSession({ magicDir: root, pollMs: 2 }, async win => {
      win.listWindows();
      await new Promise(resolve => setTimeout(resolve, 30));
    }), /Command failed/);
    await responder;
    assert.equal(fs.existsSync(path.join(root, '.winmcp-host-command.lock')), false);

    responder = agent(root, [
      { command: 'META PING', response: 'OK PONG' },
      { command: 'META IDENTITY', response: identityResponse() },
      { command: 'WINDOW LIST', response: 'OK 4321:Test:Drained', delayMs: 25,
        assertLeaseHeld: true },
    ]);
    let escapedWin;
    const unawaitedResult = await withWinAutoSession({ magicDir: root, pollMs: 2 }, win => {
      escapedWin = win;
      win.listWindows();
      return 'callback returned';
    });
    assert.equal(unawaitedResult, 'callback returned');
    await responder;
    await assert.rejects(() => escapedWin.listWindows(), /revoked/);
    assert.equal(fs.existsSync(path.join(root, '.winmcp-host-command.lock')), false);

    responder = agent(root, [
      { command: 'META PING', response: 'OK PONG' },
      { command: 'META IDENTITY', response: identityResponse() },
      { command: 'EXEC NOTEPAD.EXE', response: 'OK 0042' },
      { command: 'WAIT WINDOW Untitled 10000', response: 'OK 5678' },
    ]);
    let escapedWindow;
    await withWinAutoSession({ magicDir: root, pollMs: 2 }, async win => {
      escapedWindow = await win.exec('NOTEPAD.EXE', { waitFor: 'Untitled' });
    });
    await responder;
    await assert.rejects(() => escapedWindow.title(), /revoked/);
    assert.equal(fs.readdirSync(root).some(name => name.toLowerCase() === '__win__.tx'), false,
      'escaped Window must reject before publishing after lease release');

    let unhandledWindow;
    const onUnhandledWindow = error => { unhandledWindow = error; };
    process.on('unhandledRejection', onUnhandledWindow);
    responder = agent(root, [
      { command: 'META PING', response: 'OK PONG' },
      { command: 'META IDENTITY', response: identityResponse() },
      { command: 'EXEC NOTEPAD.EXE', response: 'OK 0042' },
      { command: 'WAIT WINDOW Untitled 10000', response: 'OK 5678' },
      { command: 'WINDOW TITLE 5678', response: 'ERR FAILED', delayMs: 25,
        assertLeaseHeld: true },
    ]);
    await assert.rejects(() => withWinAutoSession({ magicDir: root, pollMs: 2 }, async win => {
      const window = await win.exec('NOTEPAD.EXE', { waitFor: 'Untitled' });
      assert.equal(Object.getOwnPropertyDescriptor(window, 'auto'), undefined);
      assert.throws(() => window.auto, /does not expose its transport/);
      window.title();
      return 'callback returned';
    }), /Command failed/);
    await responder;
    await new Promise(resolve => setImmediate(resolve));
    process.off('unhandledRejection', onUnhandledWindow);
    assert.equal(unhandledWindow, undefined,
      'drained unawaited Window failure must not reject an unobserved wrapper');
    assert.equal(fs.existsSync(path.join(root, '.winmcp-host-command.lock')), false);

    responder = agent(root, [
      { command: 'META PING', response: 'OK PONG' },
      { command: 'META IDENTITY', response: identityResponse() },
      { command: 'EXEC NOTEPAD.EXE', response: 'OK 0042' },
      { command: 'WAIT WINDOW Untitled 10000', response: 'OK 5678', delayMs: 25,
        assertLeaseHeld: true },
    ]);
    await withWinAutoSession({ magicDir: root, pollMs: 2 }, win => {
      win.exec('NOTEPAD.EXE', { waitFor: 'Untitled' });
    });
    await responder;
    assert.equal(fs.existsSync(path.join(root, '.winmcp-host-command.lock')), false);

    responder = agent(root, [
      { command: 'META PING', response: 'OK PONG' },
      { command: 'META IDENTITY', response: identityResponse() },
    ]);
    const callbackError = new Error('callback failed');
    await assert.rejects(() => withWinAutoSession({ magicDir: root, pollMs: 2 },
      async () => { throw callbackError; }), error => error === callbackError);
    await responder;
    assert.equal(fs.existsSync(path.join(root, '.winmcp-host-command.lock')), false);

    responder = agent(root, [
      { command: 'META PING', response: 'OK PONG' },
      { command: 'META IDENTITY', response: identityResponse() },
      { command: 'WINDOW LIST' },
    ]);
    await assert.rejects(() => withWinAutoSession({ magicDir: root, pollMs: 2, timeout: 10 },
      win => win.listWindows()), /timed out/);
    await responder;
    assert.equal(fs.readFileSync(path.join(root, '.winmcp-host-command.inflight'), 'utf8'),
      'uncertain-command-v1\n');
    await assert.rejects(() => withWinAutoSession({ magicDir: root, pollMs: 2 }, () => {}),
      /retained as uncertain/);
    const request = fs.readdirSync(root).find(name => name.toLowerCase() === '__win__.tx');
    if (request) fs.unlinkSync(path.join(root, request));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('WinAuto session tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
