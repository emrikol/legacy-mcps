#!/usr/bin/env node

'use strict';

const path = require('path');
const { resetDosMcpMailbox, withDosMcpClient } = require('../lib/dos-mcp');

function parseArguments(argv) {
  const options = {};
  let index = 0;
  while (index < argv.length && argv[index].startsWith('--')) {
    const option = argv[index++];
    if (option === '--magic-dir') {
      if (!argv[index]) throw new Error('--magic-dir requires a path');
      options.magicDir = path.resolve(argv[index++]);
    } else if (option === '--timeout' || option === '--lease-timeout') {
      const value = argv[index++];
      if (!/^[1-9][0-9]{0,5}$/.test(value || '')) throw new Error(`${option} requires milliseconds`);
      const parsed = Number(value);
      if (parsed > 300000) throw new Error(`${option} exceeds 300000ms`);
      if (option === '--timeout') options.timeout = parsed;
      else options.leaseTimeout = parsed;
    }
    else throw new Error(`Unknown option: ${option}`);
  }
  const operation = argv[index++];
  const rest = argv.slice(index);
  if (operation === 'identity' && rest.length === 0) return { options, operation };
  if (operation === 'reset' && rest.length === 1 && rest[0] === '--confirm-guest-reset') {
    return { options, operation };
  }
  if (operation === 'send' && rest[0] === '--' && rest.length > 1) {
    return { options, operation, command: rest.slice(1).join(' ') };
  }
  throw new Error('Usage: dosmcp.js [--magic-dir PATH] [--timeout MS] ' +
    '[--lease-timeout MS] <identity|reset --confirm-guest-reset|send -- COMMAND>');
}

async function run(argv = process.argv.slice(2), output = process.stdout) {
  const request = parseArguments(argv);
  if (request.operation === 'reset') {
    await resetDosMcpMailbox({ ...request.options, confirmGuestReset: true });
    output.write('OK RESET\n');
    return;
  }
  return withDosMcpClient(request.options, async client => {
    const result = request.operation === 'identity'
      ? JSON.stringify(client.runtimeIdentity)
      : await client.send(request.command);
    output.write(`${result}\n`);
  });
}

if (require.main === module) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { parseArguments, run };
