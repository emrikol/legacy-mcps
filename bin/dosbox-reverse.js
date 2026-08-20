#!/usr/bin/env node

'use strict';

const path = require('path');
const { runCli } = require('../lib/dosbox-reverse');
const { withDebuggerSession } = require('../lib/dosbox-debugger');

function boundedInteger(value, minimum, maximum, option) {
  if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) ||
      Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${option} must be an integer from ${minimum} through ${maximum}`);
  }
  return Number(value);
}

function parseCli(argv) {
  const options = {};
  let index = 0;
  while (index < argv.length && argv[index].startsWith('--')) {
    const option = argv[index++];
    const value = argv[index++];
    if (value === undefined) throw new Error(`${option} requires a value`);
    if (option === '--host') options.host = value;
    else if (option === '--port') options.port = boundedInteger(value, 1, 65535, option);
    else if (option === '--timeout') {
      options.timeout = boundedInteger(value, 35000, 300000, option);
    } else if (option === '--max-response-bytes') {
      options.maxResponseBytes = boundedInteger(value, 1, 16 * 1024 * 1024, option);
    } else if (option === '--lease-dir') options.leaseDirectory = path.resolve(value);
    else if (option === '--lease-timeout') {
      options.leaseTimeout = boundedInteger(value, 1, 300000, option);
    } else if (option === '--poll-ms') options.pollMs = boundedInteger(value, 1, 1000, option);
    else throw new Error(`unknown option: ${option}`);
  }
  return Object.freeze({ options: Object.freeze(options), operation: Object.freeze(argv.slice(index)) });
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const request = parseCli(argv);
  return runCli(request.operation, {
    withSession: dependencies.withSession ?? withDebuggerSession,
    ...(dependencies.output === undefined ? {} : { output: dependencies.output }),
    sessionOptions: { ...request.options, ...(dependencies.sessionOptions ?? {}) },
  });
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { main, parseCli };
