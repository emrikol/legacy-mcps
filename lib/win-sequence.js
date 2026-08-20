/** Bounded literal-command sequences for one leased WINMCP session. */

'use strict';

const fs = require('fs');

const MAX_SEQUENCE_BYTES = 64 * 1024;
const MAX_SEQUENCE_STEPS = 256;
const MAX_COMMAND_BYTES = 511;

function validateSequence(commands) {
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > MAX_SEQUENCE_STEPS) {
    throw new Error(`A WINMCP sequence must contain 1-${MAX_SEQUENCE_STEPS} commands`);
  }
  for (const [index, command] of commands.entries()) {
    if (typeof command !== 'string' || !/^[\x20-\x7e]+$/.test(command) ||
        Buffer.byteLength(command, 'ascii') > MAX_COMMAND_BYTES) {
      throw new Error(`WINMCP sequence command ${index} is not bounded printable ASCII`);
    }
  }
  return Object.freeze([...commands]);
}

function loadSequence(file) {
  let descriptor;
  try { descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) {
    if (error.code === 'ELOOP') {
      throw new Error('WINMCP sequence must be a bounded regular single-link JSON file');
    }
    throw error;
  }
  let bytes;
  let before;
  let after;
  try {
    before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n ||
        before.size > BigInt(MAX_SEQUENCE_BYTES)) {
      throw new Error('WINMCP sequence must be a bounded regular single-link JSON file');
    }
    bytes = fs.readFileSync(descriptor);
    after = fs.fstatSync(descriptor, { bigint: true });
  } finally {
    fs.closeSync(descriptor);
  }
  const current = fs.lstatSync(file, { bigint: true });
  const identity = status => [status.dev, status.ino, status.mode, status.nlink,
    status.size, status.mtimeNs, status.ctimeNs].join(':');
  if (identity(before) !== identity(after) || identity(after) !== identity(current) ||
      bytes.length !== Number(before.size)) {
    throw new Error('WINMCP sequence changed while being read');
  }
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`WINMCP sequence JSON is invalid: ${error.message}`); }
  return validateSequence(parsed);
}

async function runSequence(win, commands, options = {}) {
  commands = validateSequence(commands);
  const requireOk = options.requireOk ?? true;
  const onResult = options.onResult;
  if (typeof requireOk !== 'boolean' ||
      (onResult !== undefined && typeof onResult !== 'function')) {
    throw new Error('WINMCP sequence options are invalid');
  }
  const results = [];
  for (const [index, command] of commands.entries()) {
    if (/^MEMORY WRITE UNSAFE(?: |$)/i.test(command)) {
      throw new Error(`WINMCP sequence command ${index} requires the dedicated unsafe-write API`);
    }
    const response = await win.send(command);
    const result = Object.freeze({ index, command, response });
    results.push(result);
    if (onResult) await onResult(result);
    if (requireOk && response !== 'OK' && !response.startsWith('OK ')) {
      const error = new Error(`WINMCP sequence command ${index} failed: ${response}`);
      error.result = result;
      throw error;
    }
  }
  return Object.freeze(results);
}

module.exports = { loadSequence, runSequence, validateSequence };
