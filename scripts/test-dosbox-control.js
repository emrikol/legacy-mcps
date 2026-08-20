#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const net = require('net');
const { DosboxControl, encodeDebugBatch } = require('../lib/dosbox-control');
const { validateIdentity } = require('./verify-dosbox-identity');

assert.equal(encodeDebugBatch(['REGISTERS', 'STACK 8']),
  'DEBUG BATCH 2 9:REGISTERS7:STACK 8');
assert.throws(() => encodeDebugBatch([]), /1-8/);
assert.throws(() => encodeDebugBatch(['CONTINUE']), /forbidden verb/);
assert.throws(() => encodeDebugBatch(['REGISTERS\nSTEP']), /printable ASCII/);
assert.throws(() => new DosboxControl({ port: 0 }), /port/);
assert.throws(() => new DosboxControl({ timeout: 0 }), /timeout/);
assert.throws(() => new DosboxControl({ timeout: 300001 }), /timeout/);
assert.throws(() => new DosboxControl({ maxResponseBytes: 0 }), /response size/);
assert.throws(() => new DosboxControl({ maxResponseBytes: 16777217 }), /response size/);
assert.throws(() => new DosboxControl({ host: '' }), /host/);
const build = 'a'.repeat(64);
assert.equal(validateIdentity(
  `OK TOOL=DOSBOX-X PROTOCOL=CONTROL/1 BUILD=${build} ` +
  'FEATURES=PING,IDENTITY,STATUS,DEBUG,QUIT', build).build, build);
assert.throws(() => validateIdentity(
  `OK TOOL=DOSBOX-X PROTOCOL=CONTROL/1 BUILD=${'b'.repeat(64)} ` +
  'FEATURES=PING,IDENTITY,STATUS,DEBUG,QUIT', build), /build identity/);
assert.throws(() => validateIdentity(
  `OK TOOL=DOSBOX-X PROTOCOL=CONTROL/1 BUILD=${build} ` +
  'FEATURES=PING,IDENTITY,STATUS,QUIT', build), /missing DEBUG/);
assert.throws(() => validateIdentity(
  `OK TOOL=DOSBOX-X TOOL=DOSBOX-X PROTOCOL=CONTROL/1 BUILD=${build} ` +
  'FEATURES=PING,IDENTITY,STATUS,DEBUG,QUIT', build), /Duplicate/);

async function main() {
  const received = [];
  const server = net.createServer(socket => {
    let command = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => { command += chunk; });
    socket.on('end', () => {
      received.push(command.trimEnd());
      socket.end('OK TEST\n');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const client = new DosboxControl({ port: server.address().port, timeout: 1000 });
    assert.equal(await client.debug('REGISTERS'), 'OK TEST');
    assert.throws(() => client.send('PING', { timeout: 0 }), /timeout/);
    assert.equal(await client.debugBatch(['REGISTERS']), 'OK TEST');
    assert.deepEqual(received, ['DEBUG REGISTERS', 'DEBUG BATCH 1 9:REGISTERS']);
    const bounded = new DosboxControl({
      port: server.address().port, timeout: 1000, maxResponseBytes: 2 });
    await assert.rejects(() => bounded.status(), /exceeds 2 bytes/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  const truncated = net.createServer(socket => {
    socket.resume();
    socket.on('end', () => socket.end('OK PARTIAL'));
  });
  await new Promise((resolve, reject) => {
    truncated.once('error', reject);
    truncated.listen(0, '127.0.0.1', resolve);
  });
  try {
    const client = new DosboxControl({ port: truncated.address().port, timeout: 1000 });
    await assert.rejects(() => client.status(), /terminal newline/);
  } finally {
    await new Promise(resolve => truncated.close(resolve));
  }

  const multiline = net.createServer(socket => {
    socket.resume();
    socket.on('end', () => socket.end('OK SCREEN\nROW ONE\nROW TWO\n'));
  });
  await new Promise((resolve, reject) => {
    multiline.once('error', reject);
    multiline.listen(0, '127.0.0.1', resolve);
  });
  try {
    const client = new DosboxControl({ port: multiline.address().port, timeout: 1000 });
    assert.equal(await client.send('SCREEN'), 'OK SCREEN\nROW ONE\nROW TWO');
  } finally {
    await new Promise(resolve => multiline.close(resolve));
  }
  console.log('DOSBox-X control client tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
