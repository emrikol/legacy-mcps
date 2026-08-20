#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { McpMailbox } = require('../lib/mcp-mailbox');

function find(directory, name) {
  return fs.readdirSync(directory).find(member => member.toLowerCase() === name.toLowerCase());
}

function publish(directory, stem, extension, contents) {
  const temporary = path.join(directory, `${stem}.${extension[0]}W`);
  const final = path.join(directory, `${stem}.${extension}`);
  fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, final);
}

async function respond(directory, stem, response, options = {}) {
  const deadline = Date.now() + 2000;
  let request;
  while (Date.now() < deadline && !request) {
    request = find(directory, `${stem}.tx`);
    if (!request) await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert(request, 'request did not appear');
  const command = fs.readFileSync(path.join(directory, request), 'ascii');
  if (options.retainEmptyRequest) fs.truncateSync(path.join(directory, request), 0);
  else fs.unlinkSync(path.join(directory, request));
  if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
  if (options.longResponse) {
    publish(directory, stem, 'LR', options.longResponse);
    response = 'OK @LR\r\n';
  }
  publish(directory, stem, options.upper ? 'RX' : 'rx', response);
  return command;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-mcps-mailbox-'));
  try {
    const mailbox = new McpMailbox({ directory: root, stem: '__MCP__', pollMs: 2 });
    const responder = respond(root, '__mcp__', 'OK PONG\r\n', { upper: true });
    assert.equal(await mailbox.send('META PING'), 'OK PONG');
    assert.equal(await responder, 'META PING\r\n');

    const longResponder = respond(root, '__mcp__', '', { longResponse: 'OK LONG RESPONSE\r\n' });
    assert.equal(await mailbox.send('META VERSION'), 'OK LONG RESPONSE');
    await longResponder;

    const partialResponder = (async () => {
      const deadline = Date.now() + 2000;
      let request;
      while (Date.now() < deadline && !request) {
        request = find(root, '__mcp__.tx');
        if (!request) await new Promise(resolve => setTimeout(resolve, 2));
      }
      assert(request, 'partial-response request did not appear');
      fs.unlinkSync(path.join(root, request));
      const temporary = path.join(root, '__MCP__.RW');
      fs.writeFileSync(temporary, 'OK PART', { flag: 'wx', mode: 0o600 });
      await new Promise(resolve => setTimeout(resolve, 20));
      fs.appendFileSync(temporary, 'IAL\r\n');
      fs.renameSync(temporary, path.join(root, '__MCP__.RX'));
    })();
    assert.equal(await mailbox.send('META STATUS'), 'OK PARTIAL');
    await partialResponder;

    await assert.rejects(() => mailbox.send('bad\ncommand'), /printable ASCII/);
    fs.writeFileSync(path.join(root, 'foreign-response'), 'old', { mode: 0o600 });
    fs.symlinkSync('foreign-response', path.join(root, '__MCP__.RX'));
    await assert.rejects(() => mailbox.send('META PING'), /regular single-link/);
    fs.unlinkSync(path.join(root, '__MCP__.RX'));
    fs.unlinkSync(path.join(root, 'foreign-response'));

    const timeoutMailbox = new McpMailbox({ directory: root, stem: '__WIN__', pollMs: 2,
      timeout: 10 });
    await assert.rejects(() => timeoutMailbox.send('META PING'), /timed out/);
    assert.equal(timeoutMailbox.poisoned, true);
    assert.equal(fs.readFileSync(path.join(root, '.winmcp-host-command.inflight'), 'ascii'),
      'uncertain-command-v1\n');
    const replacement = new McpMailbox({ directory: root, stem: '__WIN__', pollMs: 2 });
    await assert.rejects(() => replacement.send('META PING'), /retained as uncertain/);
    assert.throws(() => replacement.resetUncertain(), /confirmGuestReset=true/);
    const request = find(root, '__win__.tx');
    assert(request);
    assert.throws(() => replacement.resetUncertain({ confirmGuestReset: true }), /unconsumed/);
    fs.truncateSync(path.join(root, request), 0);
    fs.writeFileSync(path.join(root, '__WIN__.RX'), 'OK LATE\r\n', { mode: 0o600 });
    assert.throws(() => replacement.resetUncertain({ confirmGuestReset: true }), /response is pending/);
    assert.equal(fs.existsSync(path.join(root, '.winmcp-host-command.inflight')), true);
    fs.unlinkSync(path.join(root, '__WIN__.RX'));
    replacement.resetUncertain({ confirmGuestReset: true });
    assert.equal(fs.existsSync(path.join(root, '.winmcp-host-command.inflight')), false);

    fs.writeFileSync(path.join(root, '__MCP__.TX'), 'foreign', { mode: 0o600 });
    await assert.rejects(() => new McpMailbox({ directory: root, stem: '__MCP__' })
      .send('META PING'), /already has a request/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('MCP mailbox tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
