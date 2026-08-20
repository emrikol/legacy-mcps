#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const contractPath = path.join(__dirname, 'guest-tool-source-contract.json');

function fail(message) { throw new Error(message); }

function isSafeRelative(value) {
  return typeof value === 'string' && value.length > 0 &&
    !path.isAbsolute(value) && !value.split('/').includes('..');
}

function checkedContract() {
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  if (contract.format !== 'legacy-mcps-guest-tool-source-contract-v1' ||
      Object.keys(contract).join(',') !== 'format,tools' ||
      Object.keys(contract.tools).join(',') !== 'DOSMCP,WINMCP') {
    fail('Invalid guest-tool source contract');
  }
  for (const [name, tool] of Object.entries(contract.tools)) {
    if (Object.keys(tool).join(',') !==
          'paths,output,macro,buildBinary,trackedBinary,companions' ||
        !Array.isArray(tool.paths) || tool.paths.length === 0 ||
        tool.paths.some((member, index) => typeof member !== 'string' ||
          path.isAbsolute(member) || member.split('/').includes('..') ||
          (index > 0 && tool.paths[index - 1] >= member)) ||
        !isSafeRelative(tool.output) || typeof tool.macro !== 'string' ||
        !isSafeRelative(tool.buildBinary) || !isSafeRelative(tool.trackedBinary) ||
        !Array.isArray(tool.companions) || tool.companions.some((companion) =>
          Object.keys(companion).join(',') !== 'buildBinary,trackedBinary' ||
          !isSafeRelative(companion.buildBinary) ||
          !isSafeRelative(companion.trackedBinary))) {
      fail(`Invalid ${name} source contract`);
    }
  }
  return contract;
}

function verifyTrackedBinaries(name, tool, digest) {
  const tracked = fs.readFileSync(path.join(repoRoot, tool.trackedBinary));
  if (!tracked.includes(Buffer.from(digest, 'ascii'))) {
    fail(`${name} tracked binary does not embed its current build identity`);
  }
  const buildPath = path.join(repoRoot, tool.buildBinary);
  let build = null;
  try { build = fs.readFileSync(buildPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (build !== null && !build.equals(tracked)) {
    fail(`${name} build and tracked binaries differ`);
  }
  for (const companion of tool.companions) {
    const companionTracked = fs.readFileSync(path.join(repoRoot, companion.trackedBinary));
    const companionBuildPath = path.join(repoRoot, companion.buildBinary);
    let companionBuild = null;
    try { companionBuild = fs.readFileSync(companionBuildPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (companionBuild !== null && !companionBuild.equals(companionTracked)) {
      fail(`${name} companion build and tracked binaries differ`);
    }
  }
}

function sourceDigest(paths) {
  const digest = crypto.createHash('sha256');
  for (const relative of paths) {
    const absolute = path.join(repoRoot, relative);
    const status = fs.lstatSync(absolute);
    if (!status.isFile() || status.isSymbolicLink()) {
      fail(`Guest-tool source is not a regular file: ${relative}`);
    }
    digest.update(relative, 'utf8');
    digest.update(Buffer.from([0]));
    digest.update(fs.readFileSync(absolute));
    digest.update(Buffer.from([0]));
  }
  return digest.digest('hex');
}

function renderedIdentity(name, macro, digest) {
  if (name === 'DOSMCP') {
    return '; SHA-256 of the legacy-mcps DOSMCP source contract.\n' +
      `%define ${macro} "${digest}"\n`;
  }
  return '/* SHA-256 of the legacy-mcps WINMCP source contract. */\n' +
    `#define ${macro} "${digest}"\n`;
}

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
