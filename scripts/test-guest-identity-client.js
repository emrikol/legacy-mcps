#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const { expectedRuntimeIdentity, parseRuntimeIdentity, verifyRuntimeIdentity } =
  require('../lib/guest-tool-identity');

function response(name, features) {
  const expected = expectedRuntimeIdentity(name);
  return `OK TOOL=${name} PROTOCOL=${expected.protocol} BUILD=${expected.build} ` +
    `FEATURES=${features.join(',')}`;
}

const dosFeatures = ['META', 'MEM'];
const winFeatures = ['META', 'WINDOW', 'TASK', 'MODULE', 'MEMORY', 'CONTROL',
  'RECORD', 'PLAY', 'CONTROL_FINDID'];
assert.equal(verifyRuntimeIdentity(response('DOSMCP', dosFeatures), 'DOSMCP').tool, 'DOSMCP');
const win = verifyRuntimeIdentity(response('WINMCP', winFeatures), 'WINMCP', ['MEMORY']);
assert.deepEqual(win.features, winFeatures);
assert(Object.isFrozen(win) && Object.isFrozen(win.features));

for (const invalid of [
  '', 'ERR NO',
  response('WINMCP', winFeatures).replace(' TOOL=', ' TOOL=WINMCP TOOL='),
  response('WINMCP', winFeatures).replace(' FEATURES=', ' EXTRA=x FEATURES='),
  response('WINMCP', winFeatures).replace('BUILD=', 'BUILD=xyz'),
  response('WINMCP', winFeatures).replace('META,', 'META,META,'),
]) assert.throws(() => parseRuntimeIdentity(invalid));

assert.throws(() => verifyRuntimeIdentity(
  response('WINMCP', winFeatures).replace(/BUILD=[0-9a-f]{64}/, `BUILD=${'0'.repeat(64)}`),
  'WINMCP'), /does not match/);
assert.throws(() => verifyRuntimeIdentity(response('WINMCP', winFeatures.filter(
  feature => feature !== 'CONTROL_FINDID')), 'WINMCP'), /CONTROL_FINDID/);
assert.throws(() => expectedRuntimeIdentity('UNKNOWN'), /Unknown guest tool/);

console.log('Guest-tool runtime identity tests passed');
