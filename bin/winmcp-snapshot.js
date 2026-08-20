#!/usr/bin/env node

'use strict';

const path = require('path');
const {
  captureSnapshot,
  diffSnapshots,
  publishJsonNoReplace,
  readJsonFile,
} = require('../lib/win-memory-snapshot');

function integer(value, option) {
  if (!/^[1-9][0-9]{0,5}$/.test(value ?? '')) {
    throw new Error(`${option} requires milliseconds from 1 through 300000`);
  }
  const parsed = Number(value);
  if (parsed > 300000) throw new Error(`${option} exceeds 300000ms`);
  return parsed;
}

function parseArguments(argv) {
  const sessionOptions = {};
  let index = 0;
  while (index < argv.length && argv[index].startsWith('--')) {
    const option = argv[index++];
    if (option === '--magic-dir') {
      if (!argv[index]) throw new Error('--magic-dir requires a path');
      sessionOptions.magicDir = path.resolve(argv[index++]);
    } else if (option === '--timeout' || option === '--ready-timeout' ||
        option === '--lease-timeout') {
      const value = integer(argv[index++], option);
      if (option === '--timeout') sessionOptions.timeout = value;
      else if (option === '--ready-timeout') sessionOptions.readyTimeout = value;
      else sessionOptions.leaseTimeout = value;
    } else {
      throw new Error(`unknown option: ${option}`);
    }
  }
  const command = argv[index++];
  const args = argv.slice(index);
  if (command === 'capture' && args.length === 2) {
    return Object.freeze({ command, args: Object.freeze(args),
      sessionOptions: Object.freeze(sessionOptions) });
  }
  if (command === 'diff' && args.length === 3 && Object.keys(sessionOptions).length === 0) {
    return Object.freeze({ command, args: Object.freeze(args),
      sessionOptions: Object.freeze(sessionOptions) });
  }
  throw new Error('Usage: winmcp-snapshot.js [SESSION-OPTIONS] capture MANIFEST OUTPUT\n' +
    '       winmcp-snapshot.js diff BEFORE AFTER OUTPUT');
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const request = parseArguments(argv);
  const readJson = dependencies.readJsonFile ?? readJsonFile;
  const publish = dependencies.publishJsonNoReplace ?? publishJsonNoReplace;
  const output = dependencies.output ?? process.stdout;
  if (request.command === 'capture') {
    const manifest = readJson(path.resolve(request.args[0]), 'snapshot manifest', 1024 * 1024);
    const capture = dependencies.captureSnapshot ?? captureSnapshot;
    const snapshot = await capture(manifest, { sessionOptions: request.sessionOptions });
    const destination = publish(path.resolve(request.args[1]), snapshot);
    output.write(`${JSON.stringify({ output: destination,
      ranges: snapshot.ranges.length, atomic: false })}\n`);
    return snapshot;
  }
  const before = readJson(path.resolve(request.args[0]), 'before snapshot');
  const after = readJson(path.resolve(request.args[1]), 'after snapshot');
  const diff = diffSnapshots(before, after);
  const destination = publish(path.resolve(request.args[2]), diff);
  output.write(`${JSON.stringify({ output: destination,
    changedByteCount: diff.changedByteCount, atomic: false })}\n`);
  return diff;
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { main, parseArguments };
