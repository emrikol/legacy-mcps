/** Serialized, identity-checked client for the patched DOSBox-X debugger. */

'use strict';

const fs = require('fs');
const path = require('path');
const { DosboxControl, encodeDebugBatch } = require('./dosbox-control');
const { HostCommandLease } = require('./host-command-lease');
const { validateIdentity } = require('../scripts/verify-dosbox-identity');

const CONFIRMATION = '--confirm-manipulated-oracle';
const UNCERTAIN_MARKER = '.dosbox-debugger-host-command.inflight';
const UNCERTAIN_MARKER_BYTES = Buffer.from('uncertain-debugger-command-v1\n');
const MUTATION_AUTHORITY = Symbol('audited DOSBox-X mutation');
const parsedMutations = new WeakSet();
const REGISTER_WIDTHS = Object.freeze({
  AH: 2, AL: 2, BH: 2, BL: 2, CH: 2, CL: 2, DH: 2, DL: 2,
  AX: 4, BX: 4, CX: 4, DX: 4, SI: 4, DI: 4, BP: 4, SP: 4, IP: 4,
  EAX: 8, EBX: 8, ECX: 8, EDX: 8, ESI: 8, EDI: 8, EBP: 8, ESP: 8,
  EIP: 8, FLAGS: 8,
});
const REQUIRED_DEBUG_FEATURES = Object.freeze(['STATUS', 'PAUSE', 'REGISTERS', 'SELECTOR',
  'MEMORY', 'DISASM', 'STACK', 'SNAPSHOT', 'STEP', 'NEXT', 'FINISH', 'RUN', 'BREAK',
  'WATCH', 'INTERRUPT', 'EXCEPTION', 'BATCH', 'MUTATE', 'FILEIO', 'APITRACE',
  'COVERAGE', 'CHECKPOINT', 'HASH', 'INPUT', 'DETERMINISM', 'WAIT', 'CONTINUE']);

function validateDebuggerIdentity(response) {
  const base = validateIdentity(response);
  const fields = {};
  for (const item of response.slice(3).split(' ')) {
    const separator = item.indexOf('=');
    if (separator < 1 || separator === item.length - 1) {
      throw new Error('Malformed DOSBox-X debugger identity field');
    }
    const key = item.slice(0, separator);
    if (Object.hasOwn(fields, key)) throw new Error(`Duplicate DOSBox-X identity field: ${key}`);
    fields[key] = item.slice(separator + 1);
  }
  if (fields.DEBUG_PROTOCOL !== '1') throw new Error('DOSBox-X debugger protocol must be version 1');
  const debugFeatures = fields.DEBUG_FEATURES?.split(',') ?? [];
  if (debugFeatures.length === 0 || new Set(debugFeatures).size !== debugFeatures.length ||
      debugFeatures.some(feature => !/^[A-Z][A-Z0-9_]*$/.test(feature))) {
    throw new Error('Malformed DOSBox-X debugger feature inventory');
  }
  for (const feature of REQUIRED_DEBUG_FEATURES) {
    if (!debugFeatures.includes(feature)) throw new Error(`DOSBox-X debugger is missing ${feature}`);
  }
  return Object.freeze({ ...base, debugProtocol: 1,
    debugFeatures: Object.freeze(debugFeatures) });
}

function checkedName(value, description = 'name') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(value) ||
      value.includes('..')) throw new Error(`Debugger ${description} is invalid`);
  return value;
}

function checkedAddress(value) {
  if (typeof value !== 'string' || !/^[0-9A-Fa-f]{1,4}:[0-9A-Fa-f]{1,8}$/.test(value)) {
    throw new Error('Debugger address must be selector:offset hexadecimal');
  }
  return value.toUpperCase();
}

function checkedDecimal(value, minimum, maximum, description) {
  if (typeof value !== 'string' || !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${description} must be an integer from ${minimum} through ${maximum}`);
  }
  return String(Number(value));
}

function checkedHex(value, maximum, description) {
  if (typeof value !== 'string' || !/^[0-9A-Fa-f]{1,8}$/.test(value) ||
      parseInt(value, 16) < 1 || parseInt(value, 16) > maximum) {
    throw new Error(`${description} must be hexadecimal 1 through ${maximum.toString(16).toUpperCase()}`);
  }
  return value.toUpperCase();
}

function debuggerTransportOptions(command, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Debugger command options must be an object');
  }
  let serverTimeout = 30000;
  const wait = typeof command === 'string' && command.trim().match(/^WAIT(?: +\+?(\d+))?$/i);
  if (wait?.[1] !== undefined) {
    const requestedWait = Number(wait[1]);
    if (!Number.isSafeInteger(requestedWait) || requestedWait < 1 || requestedWait > 295000) {
      throw new Error('Debugger WAIT must be 1-295000ms so transport settlement remains bounded');
    }
    serverTimeout = requestedWait;
  }
  const minimumTimeout = serverTimeout + 5000;
  const timeout = options.timeout ?? minimumTimeout;
  if (!Number.isSafeInteger(timeout) || timeout < minimumTimeout || timeout > 300000) {
    throw new Error(`Debugger transport timeout must be ${minimumTimeout}-300000ms for this command`);
  }
  return Object.freeze({ timeout });
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function uncertainMarkerPath(directory) {
  return path.join(path.resolve(directory), UNCERTAIN_MARKER);
}

function inspectUncertainMarker(directory, required) {
  const marker = uncertainMarkerPath(directory);
  let before;
  try { before = fs.lstatSync(marker); }
  catch (error) {
    if (error.code === 'ENOENT' && !required) return undefined;
    throw error;
  }
  const bytes = fs.readFileSync(marker);
  const after = fs.lstatSync(marker);
  const identity = status => `${status.dev}:${status.ino}:${status.size}:` +
    `${status.mtimeMs}:${status.ctimeMs}`;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      identity(before) !== identity(after) || !bytes.equals(UNCERTAIN_MARKER_BYTES)) {
    throw new Error('Debugger uncertainty marker is malformed or changed while read');
  }
  return Object.freeze({ marker, identity: identity(before) });
}

function createUncertainMarker(directory) {
  const marker = uncertainMarkerPath(directory);
  const descriptor = fs.openSync(marker, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, UNCERTAIN_MARKER_BYTES);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  syncDirectory(path.dirname(marker));
  return marker;
}

function clearUncertainMarker(directory) {
  const receipt = inspectUncertainMarker(directory, true);
  const before = fs.lstatSync(receipt.marker);
  if (`${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}` !==
      receipt.identity) {
    throw new Error('Debugger uncertainty marker changed before removal');
  }
  fs.unlinkSync(receipt.marker);
  try { syncDirectory(path.dirname(receipt.marker)); }
  catch (error) {
    try { createUncertainMarker(directory); }
    catch (recoveryError) {
      error.markerRecoveryError = recoveryError.message;
    }
    throw error;
  }
}

async function resetDebuggerSession(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      options.confirmEmulatorReset !== true) {
    throw new Error('Debugger reset requires confirmEmulatorReset=true after external emulator reset');
  }
  const leaseDirectory = path.resolve(options.leaseDirectory ??
    path.join(__dirname, '..', 'share', '_MAGIC_'));
  const lease = await new HostCommandLease({ directory: leaseDirectory,
    name: 'dosbox-debugger', timeout: options.leaseTimeout ?? 30000,
    pollMs: options.pollMs ?? 25 }).acquire();
  let primary;
  try {
    if (!inspectUncertainMarker(leaseDirectory, false)) {
      return Object.freeze({ reset: false, marker: uncertainMarkerPath(leaseDirectory) });
    }
    clearUncertainMarker(leaseDirectory);
    return Object.freeze({ reset: true, marker: uncertainMarkerPath(leaseDirectory) });
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try { lease.release(); }
    catch (error) { if (primary) primary.leaseCleanupError = error.message; else throw error; }
  }
}

function parseBatchResponse(response, commands) {
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 8) {
    throw new Error('Debugger batch commands are invalid');
  }
  const header = response.match(/^(OK|ERR) BATCH(?: INDEX=(\d+))? N=(\d+)/);
  if (!header) throw new Error(`Malformed debugger batch response: ${response}`);
  const resultCount = Number(header[3]);
  let cursor = header[0].length;
  const results = [];
  for (let index = 0; index < resultCount; index++) {
    if (response[cursor++] !== ' ') throw new Error(`Missing batch response frame ${index}`);
    const colon = response.indexOf(':', cursor);
    const lengthText = response.slice(cursor, colon);
    if (colon < 0 || !/^\d+$/.test(lengthText)) {
      throw new Error(`Malformed batch response length at frame ${index}`);
    }
    const length = Number(lengthText);
    const start = colon + 1;
    const end = start + length;
    if (!Number.isSafeInteger(length) || length < 1 || end > response.length) {
      throw new Error(`Truncated batch response frame ${index}`);
    }
    results.push(Object.freeze({ index, command: commands[index], response: response.slice(start, end) }));
    cursor = end;
  }
  const ok = header[1] === 'OK';
  const failedIndex = header[2] === undefined ? undefined : Number(header[2]);
  if (cursor !== response.length || resultCount > commands.length ||
      (ok && (failedIndex !== undefined || resultCount !== commands.length)) ||
      (!ok && (failedIndex === undefined || failedIndex !== resultCount - 1))) {
    throw new Error('Debugger batch response has inconsistent completion metadata');
  }
  return Object.freeze({ ok, ...(failedIndex === undefined ? {} : { failedIndex }),
    requestedCount: commands.length, executedCount: resultCount,
    results: Object.freeze(results) });
}

function parseMutationArguments(args) {
  if (!Array.isArray(args) || args.at(-1) !== CONFIRMATION) {
    throw new Error(`Unsafe debugger mutation requires ${CONFIRMATION} as the final argument`);
  }
  const reasonIndex = args.indexOf('--reason');
  if (reasonIndex < 0 || reasonIndex !== args.length - 3 ||
      !/^[\x20-\x7e]{1,160}$/.test(args[reasonIndex + 1] || '')) {
    throw new Error('Unsafe debugger mutation requires one printable 1-160 character --reason');
  }
  const values = args.slice(0, reasonIndex);
  const target = values.shift();
  let summary;
  if (target === 'register') {
    if (values.length !== 2 || !Object.hasOwn(REGISTER_WIDTHS, values[0].toUpperCase()) ||
        !/^[0-9A-Fa-f]{1,8}$/.test(values[1])) {
      throw new Error('mutate register requires a supported register and hexadecimal value');
    }
    const register = values[0].toUpperCase();
    if (values[1].length > REGISTER_WIDTHS[register]) {
      throw new Error(`Register ${register} accepts at most ${REGISTER_WIDTHS[register]} hexadecimal digits`);
    }
    summary = Object.freeze({ target, register, value: values[1].toUpperCase() });
  } else if (target === 'memory') {
    const address = checkedAddress(values.shift());
    if (values.length < 1 || values.length > 64 ||
        values.some(value => !/^[0-9A-Fa-f]{2}$/.test(value))) {
      throw new Error('mutate memory requires 1-64 two-digit hexadecimal bytes');
    }
    summary = Object.freeze({ target, address,
      bytes: Object.freeze(values.map(value => value.toUpperCase())) });
  } else {
    throw new Error('mutate requires register or memory');
  }
  const parsed = Object.freeze({ kind: 'mutation', reason: args[reasonIndex + 1], summary });
  parsedMutations.add(parsed);
  return parsed;
}

function mutationCommand(summary) {
  if (summary.target === 'register') {
    return `MUTATE REGISTER ${summary.register} ${summary.value} CONFIRM_MANIPULATED_ORACLE`;
  }
  return `MUTATE MEMORY ${summary.address} ${summary.bytes.join(' ')} CONFIRM_MANIPULATED_ORACLE`;
}

function parseMutationResponse(response, summary) {
  const common = 'OK MUTATED=1 ORACLE=MANIPULATED MUTATIONS=([1-9][0-9]*)';
  if (summary.target === 'register') {
    const width = REGISTER_WIDTHS[summary.register];
    const hex = `[0-9A-F]{${width}}`;
    const match = response.match(new RegExp(`^${common} TYPE=REGISTER REGISTER=([A-Z]+) ` +
      `BEFORE=(${hex}) AFTER=(${hex}) READBACK=(${hex})$`));
    const expected = summary.value.padStart(width, '0');
    if (!match || !Number.isSafeInteger(Number(match[1])) || match[2] !== summary.register ||
        match[4] !== expected || match[5] !== expected) {
      throw new Error(`Register mutation response does not verify the request: ${response}`);
    }
    return Object.freeze({ mutationCount: Number(match[1]), type: 'register', register: match[2],
      before: match[3], after: match[4], readback: match[5] });
  }
  const [selector, offset] = summary.address.split(':');
  const expectedAddress = `${selector.padStart(4, '0')}:${offset.padStart(8, '0')}`;
  const match = response.match(new RegExp(`^${common} TYPE=MEMORY ` +
    'ADDRESS=([0-9A-F]{4}:[0-9A-F]{8}) COUNT=([1-9][0-9]*) ' +
    'BEFORE=([0-9A-F]{2}(?:,[0-9A-F]{2})*) ' +
    'AFTER=([0-9A-F]{2}(?:,[0-9A-F]{2})*) READBACK=([0-9A-F]{2}(?:,[0-9A-F]{2})*)$'));
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    throw new Error(`Memory mutation response does not verify the request: ${response}`);
  }
  const count = Number(match[3]);
  const before = match[4].split(',');
  const after = match[5].split(',');
  const readback = match[6].split(',');
  if (match[2] !== expectedAddress || count !== summary.bytes.length || before.length !== count ||
      after.join(',') !== summary.bytes.join(',') || readback.join(',') !== summary.bytes.join(',')) {
    throw new Error(`Memory mutation response does not verify the request: ${response}`);
  }
  return Object.freeze({ mutationCount: Number(match[1]), type: 'memory', address: match[2], count,
    before: Object.freeze(before), after: Object.freeze(after), readback: Object.freeze(readback) });
}

function openAudit(file) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  if (typeof fs.constants.O_NOFOLLOW !== 'number') {
    throw new Error('This host cannot safely open a no-follow debugger mutation audit log');
  }
  const descriptor = fs.openSync(resolved, fs.constants.O_APPEND | fs.constants.O_CREAT |
    fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  const status = fs.fstatSync(descriptor);
  if (!status.isFile() || status.nlink !== 1 ||
      (typeof process.getuid === 'function' && status.uid !== process.getuid())) {
    fs.closeSync(descriptor);
    throw new Error('Debugger mutation audit must be an owned regular single-link file');
  }
  const directoryDescriptor = fs.openSync(path.dirname(resolved), 'r');
  try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  return Object.freeze({ descriptor, path: resolved });
}

function appendAudit(descriptor, record) {
  const bytes = Buffer.from(`${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`);
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written < 1) throw new Error('Debugger mutation audit write made no progress');
    offset += written;
  }
  fs.fsyncSync(descriptor);
}

function parseDebuggerArguments(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(value => typeof value !== 'string')) {
    throw new Error('Debugger operation is required');
  }
  const [action, ...args] = argv;
  if (action === 'batch') {
    if (args.length !== 1) throw new Error('batch requires one JSON file');
    return Object.freeze({ kind: 'batch', file: path.resolve(args[0]) });
  }
  if (action === 'mutate') return parseMutationArguments(args);
  const exact = new Map([
    ['status', 'STATUS'], ['pause', 'PAUSE'], ['registers', 'REGISTERS'],
    ['continue', 'CONTINUE'], ['next', 'NEXT'], ['input-status', 'INPUT STATUS'],
    ['input-replay', 'INPUT REPLAY'], ['determinism-status', 'DETERMINISM STATUS'],
    ['determinism-verify', 'DETERMINISM VERIFY'],
  ]);
  if (exact.has(action)) {
    if (args.length) throw new Error(`${action} does not accept arguments`);
    return Object.freeze({ kind: 'command', command: exact.get(action) });
  }
  if (action === 'step') {
    if (args.length > 1) throw new Error('step accepts at most one count');
    return Object.freeze({ kind: 'command', command: `STEP${args.length ? ` ${checkedDecimal(args[0], 1, 10000, 'Step count')}` : ''}` });
  }
  if (action === 'finish') {
    if (args.length > 1) throw new Error('finish accepts at most one instruction limit');
    return Object.freeze({ kind: 'command', command: `FINISH${args.length ?
      ` ${checkedDecimal(args[0], 1, 10000000, 'Finish instruction limit')}` : ''}` });
  }
  if (action === 'run-until') {
    if (args.length !== 1) throw new Error('run-until requires one address');
    return Object.freeze({ kind: 'command', command: `RUN UNTIL ${checkedAddress(args[0])}` });
  }
  if (action === 'checkpoint-restore') {
    if (args.length !== 1) throw new Error('checkpoint-restore requires one name');
    return Object.freeze({ kind: 'command', command: `CHECKPOINT RESTORE ${checkedName(args[0], 'checkpoint name')}` });
  }
  if (action === 'checkpoint') {
    if (args.length !== 2 || !/^(?:save|restore)$/i.test(args[0])) {
      throw new Error('checkpoint requires save|restore and one name');
    }
    return Object.freeze({ kind: 'command',
      command: `CHECKPOINT ${args[0].toUpperCase()} ${checkedName(args[1], 'checkpoint name')}` });
  }
  if (action === 'hash') {
    if (args.length !== 2) {
      throw new Error('hash requires an address and hexadecimal count');
    }
    return Object.freeze({ kind: 'command',
      command: `HASH ${checkedAddress(args[0])} ${checkedHex(args[1], 0x10000, 'Hash count')}` });
  }
  if (action === 'snapshot') {
    if (args.length !== 1 || !args[0].toLowerCase().endsWith('.png')) {
      throw new Error('snapshot requires one safe .png name');
    }
    return Object.freeze({ kind: 'command', command: `SNAPSHOT ${checkedName(args[0], 'snapshot name')}` });
  }
  if (action === 'wait') {
    if (args.length > 1) throw new Error('wait accepts at most one millisecond timeout');
    const wait = args.length ? checkedDecimal(args[0], 1, 295000, 'Wait timeout') : '30000';
    return Object.freeze({ kind: 'command', command: `WAIT${args.length ? ` ${wait}` : ''}`,
      timeout: Number(wait) + 5000 });
  }
  if (action === 'selector') {
    if (args.length !== 1 || !/^[0-9A-Fa-f]{1,4}$/.test(args[0])) {
      throw new Error('selector requires one hexadecimal selector');
    }
    return Object.freeze({ kind: 'command', command: `SELECTOR ${args[0].toUpperCase()}` });
  }
  if (action === 'memory' || action === 'linear-memory') {
    const addressPattern = action === 'memory' ? /^[0-9A-Fa-f]{1,4}:[0-9A-Fa-f]{1,8}$/ :
      /^[0-9A-Fa-f]{1,8}$/;
    if (args.length !== 2 || !addressPattern.test(args[0])) {
      throw new Error(`${action} requires an address and hexadecimal count`);
    }
    const verb = action === 'memory' ? 'MEMORY READ' : 'MEMORY LINEAR';
    return Object.freeze({ kind: 'command',
      command: `${verb} ${args[0].toUpperCase()} ${checkedHex(args[1], 0x200, 'Memory count')}` });
  }
  if (action === 'disasm') {
    if (args.length > 2 || (args[0] !== undefined &&
        !/^[0-9A-Fa-f]{1,4}:[0-9A-Fa-f]{1,8}$/.test(args[0])) ||
        (args[1] !== undefined && (!/^[0-9A-Fa-f]{1,8}$/.test(args[1]) ||
          parseInt(args[1], 16) < 1 || parseInt(args[1], 16) > 0x20))) {
      throw new Error('disasm accepts an optional address and hexadecimal count');
    }
    return Object.freeze({ kind: 'command', command: `DISASM${args.length ? ` ${args.map(value => value.toUpperCase()).join(' ')}` : ''}` });
  }
  if (action === 'stack') {
    if (args.length > 1) throw new Error('stack accepts at most one count');
    return Object.freeze({ kind: 'command', command: `STACK${args.length ?
      ` ${checkedDecimal(args[0], 1, 64, 'Stack count')}` : ''}` });
  }
  if (action === 'input') {
    if (args.length === 1 && /^(?:status|log|clear|replay)$/i.test(args[0])) {
      return Object.freeze({ kind: 'command', command: `INPUT ${args[0].toUpperCase()}` });
    }
    if (args.length >= 4 && /^add$/i.test(args[0]) && /^\d{1,20}$/.test(args[1]) &&
        BigInt(args[1]) <= 0xffffffffffffffffn) {
      const sequence = args[1];
      if (args.length === 5 && /^key$/i.test(args[2]) && /^[A-Za-z0-9]{1,9}$/.test(args[3]) &&
          /^(?:down|up)$/i.test(args[4])) {
        return Object.freeze({ kind: 'command', command:
          `INPUT ADD ${sequence} KEY ${args[3].toUpperCase()} ${args[4].toUpperCase()}` });
      }
      if (args.length === 6 && /^mouse$/i.test(args[2]) && /^move$/i.test(args[3]) &&
          /^\d{1,5}$/.test(args[4]) && Number(args[4]) <= 32767 &&
          /^\d{1,5}$/.test(args[5]) && Number(args[5]) <= 32767) {
        return Object.freeze({ kind: 'command', command:
          `INPUT ADD ${sequence} MOUSE MOVE ${args[4]} ${args[5]}` });
      }
      if (args.length === 5 && /^mouse$/i.test(args[2]) && /^left$/i.test(args[3]) &&
          /^(?:down|up)$/i.test(args[4])) {
        return Object.freeze({ kind: 'command', command:
          `INPUT ADD ${sequence} MOUSE LEFT ${args[4].toUpperCase()}` });
      }
    }
    throw new Error('Invalid input operation');
  }
  if (action === 'determinism') {
    if (args.length === 1 && /^(?:status|record|verify|stop|clear)$/i.test(args[0])) {
      return Object.freeze({ kind: 'command', command: `DETERMINISM ${args[0].toUpperCase()}` });
    }
    if (args[0]?.toLowerCase() === 'log' && (args.length === 1 ||
        (args.length === 2 && /^\d+$/.test(args[1]) && Number(args[1]) >= 1 && Number(args[1]) <= 256))) {
      return Object.freeze({ kind: 'command', command: `DETERMINISM LOG${args[1] ? ` ${Number(args[1])}` : ''}` });
    }
    throw new Error('Invalid determinism operation');
  }
  if (action === 'coverage') {
    const operation = args[0]?.toLowerCase();
    if (args.length === 1 && /^(?:status|stop|clear)$/.test(operation)) {
      return Object.freeze({ kind: 'command', command: `COVERAGE ${operation.toUpperCase()}` });
    }
    if (operation === 'drain' && (args.length === 1 || (args.length === 2 &&
        /^\d+$/.test(args[1]) && Number(args[1]) >= 1 && Number(args[1]) <= 256))) {
      return Object.freeze({ kind: 'command', command: `COVERAGE DRAIN${args[1] ? ` ${Number(args[1])}` : ''}` });
    }
    if (operation === 'start' && args.length === 6 && /^(?:ANY|[0-9A-Fa-f]{1,4})$/i.test(args[1]) &&
        /^[0-9A-Fa-f]{1,8}$/.test(args[2]) && /^[0-9A-Fa-f]{1,8}$/.test(args[3]) &&
        /^\d+$/.test(args[4]) && Number(args[4]) >= 16 && Number(args[4]) <= 65536 &&
        /^\d+$/.test(args[5]) && Number(args[5]) >= 8 && Number(args[5]) <= 256) {
      return Object.freeze({ kind: 'command', command: `COVERAGE START ${args[1].toUpperCase()} ` +
        `${args[2].toUpperCase()} ${args[3].toUpperCase()} ${Number(args[4])} ${Number(args[5])}` });
    }
    throw new Error('Invalid coverage operation');
  }
  if (['interrupt', 'exception', 'break', 'watch', 'fileio', 'apitrace'].includes(action)) {
    const command = `${action.toUpperCase()} ${args.join(' ')}`.trimEnd();
    if (!/^[\x20-\x7e]{1,512}$/.test(command)) throw new Error(`Invalid ${action} operation`);
    return Object.freeze({ kind: 'command', command });
  }
  if (action === 'raw') {
    const command = args.join(' ');
    if (!/^[\x20-\x7e]{1,512}$/.test(command) || /^(?:MUTATE|BATCH)(?: |$)/i.test(command)) {
      throw new Error('raw requires a bounded non-mutation debugger command');
    }
    return Object.freeze({ kind: 'command', command });
  }
  throw new Error(`Unknown debugger operation: ${action}`);
}

function loadBatch(file) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      before.size < 1 || before.size > 65536) {
    throw new Error('Debugger batch must be a bounded regular single-link file');
  }
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file);
  const identity = status => `${status.dev}:${status.ino}:${status.size}:` +
    `${status.mtimeMs}:${status.ctimeMs}`;
  if (identity(before) !== identity(after) || bytes.length !== before.size) {
    throw new Error('Debugger batch changed while being read');
  }
  let commands;
  try { commands = JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`Could not read debugger batch ${file}: ${error.message}`); }
  const wireCommand = encodeDebugBatch(commands);
  return Object.freeze({ commands: Object.freeze(commands.slice()), wireCommand });
}

class DebuggerSession {
  #control;
  #lease;
  #commandQueue = Promise.resolve();
  #pending = new Set();
  #revoked = false;

  constructor(options = {}) {
    this.leaseDirectory = path.resolve(options.leaseDirectory ??
      path.join(__dirname, '..', 'share', '_MAGIC_'));
    this.leaseTimeout = options.leaseTimeout ?? 30000;
    this.pollMs = options.pollMs ?? 25;
    this.commandTimeout = options.timeout;
    this.auditPath = path.resolve(options.auditPath ?? process.env.DOSBOX_DEBUG_AUDIT_LOG ??
      path.join(this.leaseDirectory, 'dosbox-debugger-mutations.jsonl'));
    this.#control = options.control ?? new DosboxControl(options);
    this.identityValidator = options.identityValidator ?? validateDebuggerIdentity;
    if (typeof this.identityValidator !== 'function') throw new Error('Identity validator is required');
  }

  async open() {
    if (this.#lease) throw new Error('Debugger session is already open');
    this.#lease = await new HostCommandLease({ directory: this.leaseDirectory,
      name: 'dosbox-debugger', timeout: this.leaseTimeout, pollMs: this.pollMs }).acquire();
    this.#revoked = false;
    this.#commandQueue = Promise.resolve();
    this.#pending.clear();
    try {
      if (inspectUncertainMarker(this.leaseDirectory, false)) {
        throw new Error('Debugger command outcome is retained as uncertain; reset the emulator and explicitly confirm reset');
      }
      this.runtimeIdentity = this.identityValidator(await this.#control.identity());
      return this;
    } catch (error) {
      try { this.#lease.release(); } catch (cleanupError) { error.leaseCleanupError = cleanupError.message; }
      this.#lease = undefined;
      throw error;
    }
  }

  async close() {
    this.#revoked = true;
    if (!this.#lease) return;
    let primary;
    const outcomes = await Promise.all([...this.#pending]);
    this.#pending.clear();
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    if (failure) primary = failure.error;
    try { this.#lease.release(); }
    catch (error) { if (primary) primary.leaseCleanupError = error.message; else primary = error; }
    this.#lease = undefined;
    if (primary) throw primary;
  }

  #assertOpen() {
    if (this.#revoked) throw new Error('Debugger session has been revoked');
    if (!this.#lease) throw new Error('Debugger session is not open');
  }

  #track(operation) {
    const outcome = Promise.resolve(operation).then(
      () => Object.freeze({ status: 'fulfilled' }),
      error => Object.freeze({ status: 'rejected', error }));
    this.#pending.add(outcome);
    return operation;
  }

  #enqueue(callback) {
    const operation = this.#commandQueue.then(callback);
    this.#commandQueue = operation;
    return this.#track(operation);
  }

  async #runCheckedCommand(callback) {
    createUncertainMarker(this.leaseDirectory);
    let response;
    try {
      response = await callback();
    } catch (error) {
      error.debuggerDisposition = 'retained-uncertain';
      error.uncertainMarker = uncertainMarkerPath(this.leaseDirectory);
      throw error;
    }
    if (typeof response !== 'string' || !/^(?:OK|ERR)(?: |$)/.test(response) ||
        /^ERR (?:PAUSE_TIMEOUT|COMMAND_TIMEOUT|BUSY)(?: |$)/.test(response)) {
      const error = new Error(`Debugger command outcome is retained as uncertain: ${response}`);
      error.debuggerDisposition = 'retained-uncertain';
      error.uncertainMarker = uncertainMarkerPath(this.leaseDirectory);
      throw error;
    }
    try { clearUncertainMarker(this.leaseDirectory); }
    catch (error) {
      error.debuggerDisposition = 'retained-uncertain';
      error.uncertainMarker = uncertainMarkerPath(this.leaseDirectory);
      throw error;
    }
    return response;
  }

  #dispatch(command, options, authority) {
    this.#assertOpen();
    if (typeof command !== 'string' || !/^[\x20-\x7e]{1,4096}$/.test(command)) {
      throw new Error('Debugger command must contain 1-4096 printable ASCII characters');
    }
    if (authority !== MUTATION_AUTHORITY && /^(?:\s*)MUTATE(?:\s|$)/i.test(command)) {
      throw new Error('Use mutate() for confirmed, audited debugger mutation');
    }
    if (/^(?:\s*)BATCH(?:\s|$)/i.test(command)) {
      throw new Error('Use batch() for framed debugger batches');
    }
    const transportOptions = debuggerTransportOptions(command,
      options?.timeout === undefined && this.commandTimeout !== undefined ?
        { timeout: this.commandTimeout } : options);
    return this.#enqueue(() => this.#runCheckedCommand(
      () => this.#control.debug(command, transportOptions)));
  }
  command(command, options) { return this.#dispatch(command, options); }
  batch(commands, options) {
    this.#assertOpen();
    const transportOptions = debuggerTransportOptions('BATCH',
      options?.timeout === undefined && this.commandTimeout !== undefined ?
        { timeout: this.commandTimeout } : options);
    return this.#enqueue(() => this.#runCheckedCommand(
      () => this.#control.debugBatch(commands, transportOptions)));
  }
  status() { return this.command('STATUS'); }
  registers() { return this.command('REGISTERS'); }
  restoreCheckpoint(name) { return this.command(`CHECKPOINT RESTORE ${checkedName(name, 'checkpoint name')}`); }
  verifyDeterminism() { return this.command('DETERMINISM VERIFY'); }
  replayInput() { return this.command('INPUT REPLAY'); }
  determinismStatus() { return this.command('DETERMINISM STATUS'); }
  inputStatus() { return this.command('INPUT STATUS'); }
  step(count) {
    return this.command(`STEP${count === undefined ? '' : ` ${checkedDecimal(String(count), 1, 10000, 'Step count')}`}`);
  }
  runUntil(address) { return this.command(`RUN UNTIL ${checkedAddress(address)}`); }

  mutate(parsed) {
    let operation;
    try {
      this.#assertOpen();
      if (!parsedMutations.has(parsed)) {
        throw new Error('Mutation must come from parseMutationArguments');
      }
      operation = (async () => {
        const audit = openAudit(this.auditPath);
        const base = { pid: process.pid, reason: parsed.reason, mutation: parsed.summary };
        let intentWritten = false;
        let primary;
        let response;
        try {
          appendAudit(audit.descriptor, { phase: 'intent', ...base });
          intentWritten = true;
          response = await this.#dispatch(mutationCommand(parsed.summary), undefined,
            MUTATION_AUTHORITY);
          const verification = parseMutationResponse(response, parsed.summary);
          appendAudit(audit.descriptor, { phase: 'verified', ...base, response, verification });
          return Object.freeze({ ok: true, pristineOracle: false, auditLog: audit.path,
            warning: 'This DOSBox-X session is manipulated and is not pristine oracle evidence.',
            response, verification });
        } catch (error) {
          primary = error;
          if (intentWritten) {
            try {
              appendAudit(audit.descriptor, { phase: 'failed', ...base,
                ...(response === undefined ? {} : { response }), error: error.message });
            } catch (auditError) {
              error.auditFailure = auditError.message;
            }
          }
          throw error;
        } finally {
          try { fs.closeSync(audit.descriptor); }
          catch (error) {
            if (primary) primary.auditCleanupError = error.message;
            else throw error;
          }
        }
      })();
    } catch (error) {
      operation = Promise.reject(error);
    }
    return this.#track(operation);
  }
}

function sessionFacade(session) {
  const methods = ['command', 'batch', 'status', 'registers', 'restoreCheckpoint',
    'verifyDeterminism', 'replayInput', 'determinismStatus', 'inputStatus', 'step',
    'runUntil', 'mutate'];
  return Object.freeze(Object.fromEntries(methods.map(name =>
    [name, (...args) => session[name](...args)])));
}

async function withDebuggerSession(options, callback) {
  if (typeof callback !== 'function') throw new Error('Debugger callback is required');
  const session = await new DebuggerSession(options).open();
  let primary;
  try { return await callback(sessionFacade(session)); }
  catch (error) { primary = error; throw error; }
  finally {
    try { await session.close(); }
    catch (error) { if (primary) primary.leaseCleanupError = error.message; else throw error; }
  }
}

module.exports = { DebuggerSession, appendAudit, checkedAddress, debuggerTransportOptions,
  loadBatch, mutationCommand, resetDebuggerSession,
  openAudit, parseBatchResponse, parseDebuggerArguments, parseMutationArguments,
  parseMutationResponse, sessionFacade, validateDebuggerIdentity, withDebuggerSession };
