#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { DosboxControl } = require('../lib/dosbox-control');

const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(repoRoot, 'patches', 'dosbox-x', 'manifest.json');

function fail(message) {
  throw new Error(message);
}

function expectedIdentity() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.format !== 'legacy-mcps-dosbox-x-patch-series-v1' ||
      !/^[0-9a-f]{64}$/.test(manifest.sourceContractDigest)) {
    fail('Invalid DOSBox-X patch manifest identity');
  }
  return manifest.sourceContractDigest;
}

function validateIdentity(response, expectedBuild = expectedIdentity()) {
  if (typeof response !== 'string' || !response.startsWith('OK ')) {
    fail(`DOSBox-X identity request failed: ${String(response)}`);
  }
  if (!/^[0-9a-f]{64}$/.test(expectedBuild)) fail('Invalid expected DOSBox-X build identity');
  const fields = {};
  for (const field of response.slice(3).split(/\s+/)) {
    const separator = field.indexOf('=');
    if (separator < 1 || separator === field.length - 1) {
      fail('Malformed DOSBox-X control identity field');
    }
    const key = field.slice(0, separator);
    if (Object.hasOwn(fields, key)) fail(`Duplicate DOSBox-X identity field: ${key}`);
    fields[key] = field.slice(separator + 1);
  }
  if (fields.TOOL !== 'DOSBOX-X' || fields.PROTOCOL !== 'CONTROL/1') {
    fail('Unexpected DOSBox-X control identity');
  }
  if (fields.BUILD !== expectedBuild) {
    fail(`Unexpected DOSBox-X build identity: ${fields.BUILD || '<missing>'}`);
  }
  const features = new Set((fields.FEATURES || '').split(','));
  for (const required of ['PING', 'IDENTITY', 'STATUS', 'DEBUG', 'QUIT']) {
    if (!features.has(required)) fail(`DOSBox-X identity is missing ${required}`);
  }
  return Object.freeze({ build: fields.BUILD, features: Object.freeze([...features]) });
}

async function main(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--host') options.host = argv[++index];
    else if (argv[index] === '--port') options.port = Number(argv[++index]);
    else if (argv[index] === '--timeout') options.timeout = Number(argv[++index]);
    else fail(`Unknown argument: ${argv[index]}`);
  }
  const receipt = validateIdentity(await new DosboxControl(options).identity());
  process.stdout.write(`Verified DOSBox-X ${receipt.build}\n`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { expectedIdentity, validateIdentity };
