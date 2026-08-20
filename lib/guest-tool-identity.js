/** Pure source-contract and live identity helpers for DOSMCP and WINMCP. */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const contractPath = path.join(repoRoot, 'scripts', 'guest-tool-source-contract.json');
const runtimeContracts = Object.freeze({
  DOSMCP: Object.freeze({ protocol: '0.11', requiredFeatures: Object.freeze(['META']) }),
  WINMCP: Object.freeze({ protocol: '0.9',
    requiredFeatures: Object.freeze(['META', 'WINDOW', 'TASK', 'MODULE', 'MEMORY',
      'CONTROL', 'RECORD', 'PLAY', 'CONTROL_FINDID']) }),
});

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
        !Array.isArray(tool.companions) || tool.companions.some(companion =>
          Object.keys(companion).join(',') !== 'buildBinary,trackedBinary' ||
          !isSafeRelative(companion.buildBinary) ||
          !isSafeRelative(companion.trackedBinary))) {
      fail(`Invalid ${name} source contract`);
    }
  }
  return contract;
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

function verifyTrackedBinaries(name, tool, digest) {
  const tracked = fs.readFileSync(path.join(repoRoot, tool.trackedBinary));
  if (!tracked.includes(Buffer.from(digest, 'ascii'))) {
    fail(`${name} tracked binary does not embed its current build identity`);
  }
  const compareOptional = (buildRelative, trackedBytes, description) => {
    let build = null;
    try { build = fs.readFileSync(path.join(repoRoot, buildRelative)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (build !== null && !build.equals(trackedBytes)) fail(description);
  };
  compareOptional(tool.buildBinary, tracked, `${name} build and tracked binaries differ`);
  for (const companion of tool.companions) {
    const companionTracked = fs.readFileSync(path.join(repoRoot, companion.trackedBinary));
    compareOptional(companion.buildBinary, companionTracked,
      `${name} companion build and tracked binaries differ`);
  }
}

function expectedRuntimeIdentity(name) {
  const contract = checkedContract();
  const tool = contract.tools[name];
  const runtime = runtimeContracts[name];
  if (!tool || !runtime) fail(`Unknown guest tool: ${name}`);
  return Object.freeze({ tool: name, protocol: runtime.protocol,
    build: sourceDigest(tool.paths), requiredFeatures: runtime.requiredFeatures });
}

function parseRuntimeIdentity(response) {
  if (typeof response !== 'string' || !response.startsWith('OK ')) {
    fail('Guest-tool identity response must begin with OK');
  }
  const fields = {};
  for (const item of response.slice(3).split(' ')) {
    const separator = item.indexOf('=');
    if (separator < 1 || separator === item.length - 1) fail('Malformed identity field');
    const key = item.slice(0, separator);
    if (Object.hasOwn(fields, key)) fail(`Duplicate identity field: ${key}`);
    fields[key] = item.slice(separator + 1);
  }
  if (Object.keys(fields).join(',') !== 'TOOL,PROTOCOL,BUILD,FEATURES' ||
      !/^[A-Z][A-Z0-9]*$/.test(fields.TOOL) ||
      !/^[0-9]+\.[0-9]+$/.test(fields.PROTOCOL) ||
      !/^[0-9a-f]{64}$/.test(fields.BUILD)) {
    fail('Malformed guest-tool identity');
  }
  const features = fields.FEATURES.split(',');
  if (features.length === 0 || new Set(features).size !== features.length ||
      features.some(feature => !/^[A-Z][A-Z0-9_]*$/.test(feature))) {
    fail('Malformed guest-tool feature inventory');
  }
  return Object.freeze({ tool: fields.TOOL, protocol: fields.PROTOCOL,
    build: fields.BUILD, features: Object.freeze(features) });
}

function verifyRuntimeIdentity(response, expectedName, additionalFeatures = []) {
  const actual = parseRuntimeIdentity(response);
  const expected = expectedRuntimeIdentity(expectedName);
  if (actual.tool !== expected.tool || actual.protocol !== expected.protocol ||
      actual.build !== expected.build) {
    fail(`${expectedName} runtime identity does not match the current source contract`);
  }
  const required = [...expected.requiredFeatures, ...additionalFeatures];
  for (const feature of required) {
    if (!actual.features.includes(feature)) fail(`${expectedName} runtime is missing ${feature}`);
  }
  return actual;
}

module.exports = { checkedContract, expectedRuntimeIdentity, parseRuntimeIdentity,
  renderedIdentity, sourceDigest, verifyRuntimeIdentity, verifyTrackedBinaries };
