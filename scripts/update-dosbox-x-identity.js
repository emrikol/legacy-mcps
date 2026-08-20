#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const contractPath = path.join(repoRoot, 'patches', 'dosbox-x', 'source-contract.json');

function fail(message) {
  throw new Error(message);
}

function sourceDigest(sourceRoot) {
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  if (contract.format !== 'legacy-mcps-dosbox-x-source-contract-v1' ||
      !Array.isArray(contract.paths) || contract.paths.length === 0 ||
      contract.paths.some((item, index) => typeof item !== 'string' ||
        item.startsWith('/') || item.includes('..') ||
        (index > 0 && contract.paths[index - 1] >= item))) {
    fail('Invalid or unsorted DOSBox-X source contract');
  }
  const digest = crypto.createHash('sha256');
  for (const relative of contract.paths) {
    const absolute = path.join(sourceRoot, relative);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail(`DOSBox-X source contract member is not a regular file: ${relative}`);
    }
    digest.update(relative, 'utf8');
    digest.update(Buffer.from([0]));
    digest.update(fs.readFileSync(absolute));
    digest.update(Buffer.from([0]));
  }
  return digest.digest('hex');
}

function expectedHeader(digest) {
  return '/* SHA-256 of the legacy-mcps DOSBox-X source contract. */\n' +
    `#define DOSBOX_X_BUILD_ID "${digest}"\n`;
}

function main(argv) {
  const check = argv.includes('--check');
  const positional = argv.filter(arg => arg !== '--check');
  if (positional.length !== 1) {
    fail('Usage: update-dosbox-x-identity.js [--check] <dosbox-x-source-root>');
  }
  const sourceRoot = path.resolve(positional[0]);
  const digest = sourceDigest(sourceRoot);
  const headerPath = path.join(sourceRoot, 'include', 'tool_build_identity.h');
  const expected = expectedHeader(digest);
  if (check) {
    if (fs.readFileSync(headerPath, 'utf8') !== expected) {
      fail('DOSBox-X build identity header is stale');
    }
  } else {
    fs.writeFileSync(headerPath, expected);
  }
  process.stdout.write(`${digest}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { expectedHeader, sourceDigest };
