/** Generic, receipt-backed Win16 memory snapshots and byte-level diffs. */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { withWinAutoSession } = require('./win-auto');

const SNAPSHOT_SCHEMA = 'legacy-mcps.win16-memory-snapshot/v1';
const DIFF_SCHEMA = 'legacy-mcps.win16-memory-diff/v1';
const MAX_READ_LENGTH = 512;
const MAX_RANGES = 128;
const MAX_RANGE_LENGTH = 65536;

function requireInteger(value, description, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${description} must be an integer from ${minimum} through ${maximum}`);
  }
}

function validateName(value, description) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value)) {
    throw new Error(`${description} must begin with a letter and contain at most 80 ` +
      'letters, digits, periods, underscores, or hyphens');
  }
}

function fieldWidth(field) {
  const widths = { u8: 1, i8: 1, u16le: 2, i16le: 2, u32le: 4, i32le: 4 };
  if (Object.hasOwn(widths, field.type)) {
    if (field.length !== undefined) {
      throw new Error(`numeric field ${field.name} must not declare length`);
    }
    return widths[field.type];
  }
  if (field.type === 'bytes' || field.type === 'ascii') {
    requireInteger(field.length, `field ${field.name} length`, 1, MAX_RANGE_LENGTH);
    return field.length;
  }
  throw new Error(`field ${field.name} has unsupported type ${JSON.stringify(field.type)}`);
}

function validateManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('manifest must be a JSON object');
  }
  if (typeof input.module !== 'string' || !/^[A-Za-z0-9!_.-]{1,32}$/.test(input.module)) {
    throw new Error('module is required and must contain 1-32 DOS module-name characters');
  }
  if (!Array.isArray(input.ranges) || input.ranges.length < 1 ||
      input.ranges.length > MAX_RANGES) {
    throw new Error(`ranges must contain 1-${MAX_RANGES} entries`);
  }
  const rangeNames = new Set();
  const ranges = input.ranges.map((range, rangeIndex) => {
    if (!range || typeof range !== 'object' || Array.isArray(range)) {
      throw new Error(`range ${rangeIndex} must be an object`);
    }
    validateName(range.name, `range ${rangeIndex} name`);
    if (rangeNames.has(range.name)) throw new Error(`duplicate range name ${range.name}`);
    rangeNames.add(range.name);
    requireInteger(range.segment, `range ${range.name} segment`, 1, 255);
    requireInteger(range.offset, `range ${range.name} offset`, 0, 0xffffffff);
    requireInteger(range.length, `range ${range.name} length`, 1, MAX_RANGE_LENGTH);
    if (range.offset + range.length > 0x100000000) {
      throw new Error(`range ${range.name} extends beyond a 32-bit segment offset`);
    }
    if (range.fields !== undefined && !Array.isArray(range.fields)) {
      throw new Error(`range ${range.name} fields must be an array`);
    }
    const fieldNames = new Set();
    const fields = (range.fields ?? []).map((field, fieldIndex) => {
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        throw new Error(`field ${fieldIndex} in ${range.name} must be an object`);
      }
      validateName(field.name, `field ${fieldIndex} in ${range.name}`);
      if (fieldNames.has(field.name)) {
        throw new Error(`duplicate field name ${range.name}.${field.name}`);
      }
      fieldNames.add(field.name);
      requireInteger(field.offset, `field ${range.name}.${field.name} offset`,
        0, range.length - 1);
      const width = fieldWidth(field);
      if (field.offset + width > range.length) {
        throw new Error(`field ${range.name}.${field.name} extends beyond its range`);
      }
      return Object.freeze({ name: field.name, offset: field.offset, type: field.type,
        ...(field.length === undefined ? {} : { length: field.length }) });
    });
    return Object.freeze({ name: range.name, segment: range.segment,
      offset: range.offset, length: range.length,
      ...(fields.length ? { fields: Object.freeze(fields) } : {}) });
  });
  return Object.freeze({ module: input.module, ranges: Object.freeze(ranges) });
}

function checkedSegments(segments) {
  if (!Array.isArray(segments)) throw new Error('module segment inventory must be an array');
  const byNumber = new Map();
  for (const [index, segment] of segments.entries()) {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
      throw new Error(`module segment ${index} must be an object`);
    }
    requireInteger(segment.segment, `module segment ${index} number`, 1, 255);
    if (byNumber.has(segment.segment)) {
      throw new Error(`module segment ${segment.segment} is duplicated`);
    }
    if (typeof segment.selector !== 'string' || !/^[0-9A-Fa-f]{4}$/.test(segment.selector) ||
        segment.selector === '0000') {
      throw new Error(`module segment ${segment.segment} selector is invalid`);
    }
    requireInteger(segment.size, `module segment ${segment.segment} size`, 0, 0xffffffff);
    if (typeof segment.linearBase !== 'string' ||
        !/^[0-9A-Fa-f]{8}$/.test(segment.linearBase)) {
      throw new Error(`module segment ${segment.segment} linear base is invalid`);
    }
    byNumber.set(segment.segment, Object.freeze({ ...segment,
      selector: segment.selector.toUpperCase(), linearBase: segment.linearBase.toUpperCase() }));
  }
  return byNumber;
}

function buildCapturePlan(manifestInput, segments) {
  const manifest = validateManifest(manifestInput);
  const segmentByNumber = checkedSegments(segments);
  const reads = [];
  for (const range of manifest.ranges) {
    const segment = segmentByNumber.get(range.segment);
    if (!segment) {
      throw new Error(`module ${manifest.module} has no loaded segment ${range.segment}`);
    }
    if (range.offset + range.length > segment.size) {
      throw new Error(`range ${range.name} extends beyond segment ${range.segment}`);
    }
    for (let consumed = 0; consumed < range.length; consumed += MAX_READ_LENGTH) {
      const count = Math.min(MAX_READ_LENGTH, range.length - consumed);
      const offset = range.offset + consumed;
      const address = `${segment.selector}:${offset.toString(16).toUpperCase().padStart(8, '0')}`;
      reads.push(Object.freeze({ range: range.name, segment: range.segment,
        selector: segment.selector, linearBase: segment.linearBase, offset, count,
        command: `MEMORY READ ${address} ${count}` }));
    }
  }
  return Object.freeze({ manifest, reads: Object.freeze(reads), segmentByNumber });
}

function isOkResponse(response) {
  return response === 'OK' || (typeof response === 'string' && response.startsWith('OK '));
}

function checkedReceipt(receipt, expectedCommand, description) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
      receipt.command !== expectedCommand || typeof receipt.response !== 'string') {
    throw new Error(`${description} does not match command ${expectedCommand}`);
  }
  if (!isOkResponse(receipt.response)) {
    throw new Error(`${expectedCommand} failed: ${receipt.response}`);
  }
  return Object.freeze({ command: receipt.command, response: receipt.response });
}

function parseMemoryResponse(response, expectedCount) {
  requireInteger(expectedCount, 'expected memory byte count', 1, MAX_READ_LENGTH);
  const match = typeof response === 'string' &&
    response.match(/^OK ([0-9A-F]{4}):([0-9A-F]{8}) N=(\d+)((?: [0-9A-F]{2})+)$/);
  if (!match) throw new Error(`malformed MEMORY READ response: ${response}`);
  const bytes = Buffer.from(match[4].trim().split(' ').map(value => parseInt(value, 16)));
  if (Number(match[3]) !== expectedCount || bytes.length !== expectedCount) {
    throw new Error(`MEMORY READ returned ${bytes.length} bytes; expected ${expectedCount}`);
  }
  return Object.freeze({ selector: match[1], offset: parseInt(match[2], 16), bytes });
}

function decodeField(bytes, field) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const value = source.subarray(field.offset, field.offset + fieldWidth(field));
  if (value.length !== fieldWidth(field)) throw new Error(`field ${field.name} is truncated`);
  switch (field.type) {
    case 'u8': return value.readUInt8();
    case 'i8': return value.readInt8();
    case 'u16le': return value.readUInt16LE();
    case 'i16le': return value.readInt16LE();
    case 'u32le': return value.readUInt32LE();
    case 'i32le': return value.readInt32LE();
    case 'bytes': return value.toString('hex').toUpperCase();
    case 'ascii': return value.toString('latin1').replace(/\0.*$/s, '');
    default: throw new Error(`unsupported field type ${field.type}`);
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assembleSnapshot(manifestInput, segments, capture, capturedAt = new Date().toISOString()) {
  const plan = buildCapturePlan(manifestInput, segments);
  const taskCommand = `TASK INFO ${plan.manifest.module}`;
  if (!capture || typeof capture !== 'object' || Array.isArray(capture) ||
      !Array.isArray(capture.reads) || capture.reads.length !== plan.reads.length) {
    throw new Error(`capture must contain exactly ${plan.reads.length} memory receipts`);
  }
  const taskBefore = checkedReceipt(capture.taskBefore, taskCommand, 'task-before receipt');
  const taskAfter = checkedReceipt(capture.taskAfter, taskCommand, 'task-after receipt');
  const bytesByRange = new Map(plan.manifest.ranges.map(range => [range.name, []]));
  const readReceipts = plan.reads.map((read, index) => {
    const receipt = checkedReceipt(capture.reads[index], read.command,
      `memory receipt ${index}`);
    const parsed = parseMemoryResponse(receipt.response, read.count);
    if (parsed.selector !== read.selector || parsed.offset !== read.offset) {
      throw new Error(`MEMORY READ response address does not match range ${read.range}`);
    }
    bytesByRange.get(read.range).push(parsed.bytes);
    return receipt;
  });
  const ranges = plan.manifest.ranges.map(range => {
    const segment = plan.segmentByNumber.get(range.segment);
    const bytes = Buffer.concat(bytesByRange.get(range.name));
    if (bytes.length !== range.length) throw new Error(`range ${range.name} byte count is incomplete`);
    const decodedFields = Object.fromEntries((range.fields ?? [])
      .map(field => [field.name, decodeField(bytes, field)]));
    return Object.freeze({ ...range, selector: segment.selector,
      linearBase: segment.linearBase, bytes: bytes.toString('hex').toUpperCase(),
      sha256: sha256(bytes),
      ...(range.fields ? { decodedFields: Object.freeze(decodedFields) } : {}) });
  });
  if (typeof capturedAt !== 'string' || !Number.isFinite(Date.parse(capturedAt))) {
    throw new Error('capturedAt must be an ISO-compatible timestamp');
  }
  return Object.freeze({
    schema: SNAPSHOT_SCHEMA,
    capturedAt,
    module: plan.manifest.module,
    evidence: Object.freeze({
      provenance: 'diagnostic-read',
      atomic: false,
      note: 'Reads share one leased FIFO session, but the cooperative guest can run between commands.',
      taskBefore,
      taskAfter,
      taskResponseUnchanged: taskBefore.response === taskAfter.response,
      readReceipts: Object.freeze(readReceipts),
    }),
    ranges: Object.freeze(ranges),
  });
}

async function rawReceipt(win, command) {
  const response = await win.send(command);
  return checkedReceipt({ command, response }, command, 'WINMCP receipt');
}

async function captureSnapshot(manifestInput, options = {}) {
  const manifest = validateManifest(manifestInput);
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('capture options must be an object');
  }
  const withSession = options.withSession ?? withWinAutoSession;
  if (typeof withSession !== 'function') throw new Error('withSession must be a function');
  const sessionOptions = options.sessionOptions ?? {};
  if (!sessionOptions || typeof sessionOptions !== 'object' || Array.isArray(sessionOptions)) {
    throw new Error('sessionOptions must be an object');
  }
  if (sessionOptions.requiredFeatures !== undefined &&
      (!Array.isArray(sessionOptions.requiredFeatures) ||
       sessionOptions.requiredFeatures.some(feature => typeof feature !== 'string'))) {
    throw new Error('sessionOptions.requiredFeatures must be an array of strings');
  }
  const requiredFeatures = [...new Set([
    ...(sessionOptions.requiredFeatures ?? []), 'TASK', 'MODULE', 'MEMORY',
  ])];
  return withSession({ ...sessionOptions, requiredFeatures }, async win => {
    const taskCommand = `TASK INFO ${manifest.module}`;
    const taskBefore = await rawReceipt(win, taskCommand);
    const segments = await win.moduleSegments(manifest.module);
    const plan = buildCapturePlan(manifest, segments);
    const reads = [];
    for (const read of plan.reads) reads.push(await rawReceipt(win, read.command));
    const taskAfter = await rawReceipt(win, taskCommand);
    return assembleSnapshot(manifest, segments, { taskBefore, reads, taskAfter },
      options.capturedAt ?? new Date().toISOString());
  });
}

function snapshotSegments(snapshot, manifest) {
  const segments = new Map();
  for (const range of snapshot.ranges) {
    if (typeof range.selector !== 'string' || !/^[0-9A-F]{4}$/.test(range.selector) ||
        range.selector === '0000' || typeof range.linearBase !== 'string' ||
        !/^[0-9A-F]{8}$/.test(range.linearBase)) {
      throw new Error(`snapshot range ${range.name} has invalid segment metadata`);
    }
    const existing = segments.get(range.segment);
    if (existing && (existing.selector !== range.selector ||
        existing.linearBase !== range.linearBase)) {
      throw new Error(`snapshot segment ${range.segment} has inconsistent metadata`);
    }
    const size = Math.max(existing?.size ?? 0, range.offset + range.length);
    segments.set(range.segment, { segment: range.segment, selector: range.selector,
      linearBase: range.linearBase, size });
  }
  for (const range of manifest.ranges) {
    if (!segments.has(range.segment)) throw new Error(`snapshot range ${range.name} is missing`);
  }
  return [...segments.values()];
}

function validateSnapshot(snapshot, description = 'snapshot') {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      snapshot.schema !== SNAPSHOT_SCHEMA || !Array.isArray(snapshot.ranges)) {
    throw new Error(`${description} is not a ${SNAPSHOT_SCHEMA} document`);
  }
  if (typeof snapshot.capturedAt !== 'string' || !Number.isFinite(Date.parse(snapshot.capturedAt))) {
    throw new Error(`${description} has an invalid capturedAt timestamp`);
  }
  const manifest = validateManifest({ module: snapshot.module, ranges: snapshot.ranges });
  const segments = snapshotSegments(snapshot, manifest);
  const plan = buildCapturePlan(manifest, segments);
  if (!snapshot.evidence || typeof snapshot.evidence !== 'object' ||
      snapshot.evidence.atomic !== false || snapshot.evidence.provenance !== 'diagnostic-read' ||
      !Array.isArray(snapshot.evidence.readReceipts) ||
      snapshot.evidence.readReceipts.length !== plan.reads.length) {
    throw new Error(`${description} has invalid non-atomic evidence`);
  }
  const taskCommand = `TASK INFO ${manifest.module}`;
  const taskBefore = checkedReceipt(snapshot.evidence.taskBefore, taskCommand,
    `${description} task-before receipt`);
  const taskAfter = checkedReceipt(snapshot.evidence.taskAfter, taskCommand,
    `${description} task-after receipt`);
  if (snapshot.evidence.taskResponseUnchanged !==
      (taskBefore.response === taskAfter.response)) {
    throw new Error(`${description} taskResponseUnchanged is inconsistent`);
  }
  const receiptBytes = new Map(manifest.ranges.map(range => [range.name, []]));
  plan.reads.forEach((read, index) => {
    const receipt = checkedReceipt(snapshot.evidence.readReceipts[index], read.command,
      `${description} memory receipt ${index}`);
    const parsed = parseMemoryResponse(receipt.response, read.count);
    if (parsed.selector !== read.selector || parsed.offset !== read.offset) {
      throw new Error(`${description} memory receipt ${index} has the wrong address`);
    }
    receiptBytes.get(read.range).push(parsed.bytes);
  });
  manifest.ranges.forEach((range, index) => {
    const stored = snapshot.ranges[index];
    if (stored.name !== range.name || stored.segment !== range.segment ||
        stored.offset !== range.offset || stored.length !== range.length) {
      throw new Error(`${description} range order or coordinates are inconsistent`);
    }
    const bytes = Buffer.concat(receiptBytes.get(range.name));
    if (typeof stored.bytes !== 'string' || stored.bytes.length !== range.length * 2 ||
        !/^[0-9A-F]+$/.test(stored.bytes) || !bytes.equals(Buffer.from(stored.bytes, 'hex')) ||
        stored.sha256 !== sha256(bytes)) {
      throw new Error(`${description} range ${range.name} byte data does not match its receipts`);
    }
    if (range.fields) {
      const decoded = Object.fromEntries(range.fields.map(field =>
        [field.name, decodeField(bytes, field)]));
      if (!util.isDeepStrictEqual(stored.decodedFields, decoded)) {
        throw new Error(`${description} range ${range.name} decoded fields are inconsistent`);
      }
    } else if (stored.decodedFields !== undefined) {
      throw new Error(`${description} range ${range.name} has undeclared decoded fields`);
    }
  });
  return Object.freeze({ snapshot, manifest });
}

function diffSnapshots(beforeInput, afterInput) {
  const { snapshot: before, manifest: beforeManifest } =
    validateSnapshot(beforeInput, 'before snapshot');
  const { snapshot: after, manifest: afterManifest } =
    validateSnapshot(afterInput, 'after snapshot');
  if (before.module !== after.module) throw new Error('snapshots refer to different modules');
  const afterByName = new Map(after.ranges.map((range, index) =>
    [range.name, { range, manifest: afterManifest.ranges[index] }]));
  if (afterByName.size !== before.ranges.length || after.ranges.length !== before.ranges.length) {
    throw new Error('snapshots contain different range sets');
  }
  let changedByteCount = 0;
  const ranges = before.ranges.map((left, leftIndex) => {
    const match = afterByName.get(left.name);
    const right = match?.range;
    if (!right || left.segment !== right.segment || left.offset !== right.offset ||
        left.length !== right.length || !util.isDeepStrictEqual(
          beforeManifest.ranges[leftIndex].fields ?? [], match.manifest.fields ?? [])) {
      throw new Error(`range ${left.name} is missing or has incompatible coordinates or fields`);
    }
    const leftBytes = Buffer.from(left.bytes, 'hex');
    const rightBytes = Buffer.from(right.bytes, 'hex');
    const changes = [];
    for (let index = 0; index < leftBytes.length;) {
      if (leftBytes[index] === rightBytes[index]) {
        index++;
        continue;
      }
      const start = index;
      while (index < leftBytes.length && leftBytes[index] !== rightBytes[index]) index++;
      changedByteCount += index - start;
      changes.push(Object.freeze({ relativeOffset: start,
        segmentOffset: `0x${(left.offset + start).toString(16).toUpperCase().padStart(8, '0')}`,
        before: leftBytes.subarray(start, index).toString('hex').toUpperCase(),
        after: rightBytes.subarray(start, index).toString('hex').toUpperCase() }));
    }
    const fieldChanges = [];
    for (const field of beforeManifest.ranges[leftIndex].fields ?? []) {
      const oldValue = decodeField(leftBytes, field);
      const newValue = decodeField(rightBytes, field);
      if (!util.isDeepStrictEqual(oldValue, newValue)) {
        fieldChanges.push(Object.freeze({ name: field.name, type: field.type,
          before: oldValue, after: newValue }));
      }
    }
    return Object.freeze({ name: left.name,
      changedByteCount: changes.reduce((sum, change) => sum + change.before.length / 2, 0),
      changes: Object.freeze(changes), fieldChanges: Object.freeze(fieldChanges) });
  });
  return Object.freeze({ schema: DIFF_SCHEMA, module: before.module, atomic: false,
    beforeCapturedAt: before.capturedAt, afterCapturedAt: after.capturedAt,
    changedByteCount, ranges: Object.freeze(ranges) });
}

function stableFileIdentity(status) {
  return `${status.dev}:${status.ino}:${status.size}:${status.mtimeMs}:${status.ctimeMs}`;
}

function readJsonFile(file, description, maximumBytes = 64 * 1024 * 1024) {
  const absolute = path.resolve(file);
  const before = fs.lstatSync(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      before.size < 1 || before.size > maximumBytes) {
    throw new Error(`${description} must be a bounded regular single-link file`);
  }
  const bytes = fs.readFileSync(absolute);
  const after = fs.lstatSync(absolute);
  if (stableFileIdentity(before) !== stableFileIdentity(after) || bytes.length !== before.size) {
    throw new Error(`${description} changed while being read`);
  }
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`${description} is invalid JSON: ${error.message}`); }
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function publishJsonNoReplace(file, value) {
  const requested = path.resolve(file);
  const directory = fs.realpathSync(path.dirname(requested));
  const destination = path.join(directory, path.basename(requested));
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const temporary = path.join(directory,
    `.win-memory-snapshot-${crypto.randomBytes(16).toString('hex')}.tmp`);
  let temporaryExists = false;
  let destinationPublished = false;
  let primary;
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    temporaryExists = true;
    try {
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.linkSync(temporary, destination);
    destinationPublished = true;
    syncDirectory(directory);
    fs.unlinkSync(temporary);
    temporaryExists = false;
    syncDirectory(directory);
    const status = fs.lstatSync(destination);
    const published = fs.readFileSync(destination);
    const after = fs.lstatSync(destination);
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1 ||
        stableFileIdentity(status) !== stableFileIdentity(after) || !published.equals(bytes)) {
      throw new Error('published JSON failed its durable output check');
    }
    return destination;
  } catch (error) {
    primary = error;
    if (destinationPublished) {
      error.publicationDisposition = 'retained-uncertain';
      error.retainedDestination = destination;
    }
    throw error;
  } finally {
    if (temporaryExists) {
      try {
        fs.unlinkSync(temporary);
        syncDirectory(directory);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          if (primary) primary.temporaryCleanupError = error.message;
          else throw error;
        }
      }
    }
  }
}

module.exports = {
  DIFF_SCHEMA,
  MAX_READ_LENGTH,
  SNAPSHOT_SCHEMA,
  assembleSnapshot,
  buildCapturePlan,
  captureSnapshot,
  decodeField,
  diffSnapshots,
  parseMemoryResponse,
  publishJsonNoReplace,
  readJsonFile,
  validateManifest,
  validateSnapshot,
};
