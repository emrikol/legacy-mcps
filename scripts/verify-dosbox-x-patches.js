#!/usr/bin/env node

'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { expectedHeader, sourceDigest } = require('./update-dosbox-x-identity');

const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(repoRoot, 'patches', 'dosbox-x', 'manifest.json');
const seriesRoot = path.join(repoRoot, 'patches', 'dosbox-x', 'series');
const hashPattern = /^[0-9a-f]{40}$/;
const shaPattern = /^[0-9a-f]{64}$/;

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} has unexpected keys`);
  }
}

function sha256(absolute) {
  return crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
}

function loadManifest() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  exactKeys(manifest,
    ['format', 'upstream', 'baseCommit', 'baseTree', 'finalTree', 'sourceContractDigest', 'patches'],
    'DOSBox-X patch manifest');
  if (manifest.format !== 'legacy-mcps-dosbox-x-patch-series-v1' ||
      manifest.upstream !== 'https://github.com/joncampbell123/dosbox-x.git' ||
      !hashPattern.test(manifest.baseCommit) || !hashPattern.test(manifest.baseTree) ||
      !hashPattern.test(manifest.finalTree) || !shaPattern.test(manifest.sourceContractDigest) ||
      !Array.isArray(manifest.patches) || manifest.patches.length !== 19) {
    fail('Invalid DOSBox-X patch manifest');
  }

  const paths = [];
  for (const [index, entry] of manifest.patches.entries()) {
    exactKeys(entry, ['path', 'sha256'], `DOSBox-X patch entry ${index + 1}`);
    const expectedPrefix = `patches/dosbox-x/series/${String(index + 1).padStart(4, '0')}-`;
    if (typeof entry.path !== 'string' || !entry.path.startsWith(expectedPrefix) ||
        entry.path.includes('..') || !shaPattern.test(entry.sha256)) {
      fail(`Invalid DOSBox-X patch entry ${index + 1}`);
    }
    const absolute = path.join(repoRoot, entry.path);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail(`DOSBox-X patch is not a regular file: ${entry.path}`);
    }
    if (sha256(absolute) !== entry.sha256) {
      fail(`DOSBox-X patch checksum mismatch: ${entry.path}`);
    }
    paths.push(entry.path);
  }

  const inventory = fs.readdirSync(seriesRoot)
    .filter(name => name.endsWith('.patch'))
    .sort()
    .map(name => `patches/dosbox-x/series/${name}`);
  if (JSON.stringify(inventory) !== JSON.stringify(paths)) {
    fail('DOSBox-X patch directory does not exactly match the manifest');
  }
  return manifest;
}

function gitTree(sourceRoot) {
  const result = childProcess.spawnSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD^{tree}'], {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    fail(`Unable to read DOSBox-X source tree: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function gitStatus(sourceRoot) {
  const result = childProcess.spawnSync('git', ['-C', sourceRoot, 'status', '--porcelain'], {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    fail(`Unable to inspect DOSBox-X source worktree: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function verifySource(manifest, sourceRoot) {
  const absolute = path.resolve(sourceRoot);
  if (gitStatus(absolute) !== '') {
    fail('Patched DOSBox-X source worktree is not clean');
  }
  if (gitTree(absolute) !== manifest.finalTree) {
    fail('Patched DOSBox-X Git tree does not match the manifest');
  }
  const digest = sourceDigest(absolute);
  if (digest !== manifest.sourceContractDigest) {
    fail('Patched DOSBox-X source digest does not match the manifest');
  }
  const header = fs.readFileSync(path.join(absolute, 'include', 'tool_build_identity.h'), 'utf8');
  if (header !== expectedHeader(digest)) {
    fail('Patched DOSBox-X build identity header is stale');
  }
}

function main(argv) {
  let sourceRoot = null;
  let printPatches = false;
  let printBase = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--source-root' && index + 1 < argv.length) {
      sourceRoot = argv[++index];
    } else if (argv[index] === '--print-patches') {
      printPatches = true;
    } else if (argv[index] === '--print-base') {
      printBase = true;
    } else {
      fail('Usage: verify-dosbox-x-patches.js [--source-root PATH] [--print-patches] [--print-base]');
    }
  }
  if (printPatches && printBase) fail('Choose only one print mode');
  const manifest = loadManifest();
  if (sourceRoot) verifySource(manifest, sourceRoot);
  if (printPatches) {
    for (const entry of manifest.patches) process.stdout.write(`${entry.path}\n`);
  } else if (printBase) {
    process.stdout.write(`${manifest.upstream} ${manifest.baseCommit} ${manifest.baseTree}\n`);
  } else {
    process.stdout.write('DOSBox-X patch contract OK\n');
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

module.exports = { loadManifest, verifySource };
