#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { checkedContract, renderedIdentity, sourceDigest, verifyTrackedBinaries } =
  require('../lib/guest-tool-identity');

const repoRoot = path.resolve(__dirname, '..');

function fail(message) { throw new Error(message); }

function main(argv) {
  const check = argv.length === 1 && argv[0] === '--check';
  if (argv.length !== 0 && !check) {
    fail('Usage: update-guest-tool-identities.js [--check]');
  }
  const contract = checkedContract();
  for (const [name, tool] of Object.entries(contract.tools)) {
    const digest = sourceDigest(tool.paths);
    const expected = renderedIdentity(name, tool.macro, digest);
    const output = path.join(repoRoot, tool.output);
    if (check) {
      if (fs.readFileSync(output, 'utf8') !== expected) {
        fail(`${name} build identity is stale`);
      }
      verifyTrackedBinaries(name, tool, digest);
    } else {
      fs.writeFileSync(output, expected);
    }
    process.stdout.write(`${name} ${digest}\n`);
  }
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  checkedContract,
  renderedIdentity,
  sourceDigest,
  verifyTrackedBinaries,
};
