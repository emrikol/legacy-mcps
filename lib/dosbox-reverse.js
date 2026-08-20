/** Deterministic reverse-step workflow over one leased DebuggerSession. */

'use strict';

const MAX_STEP_CHUNK = 10000;
const MAX_STEP_COMMANDS = 10000;
const CHECKPOINT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;

function response(value, label) {
  if (typeof value !== 'string' || value.length > 65536 ||
      !/^[\x20-\x7e]+$/.test(value) || (value !== 'OK' && !value.startsWith('OK '))) {
    throw new Error(`${label} returned a malformed debugger response`);
  }
  return value;
}

function field(value, name) {
  if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
    throw new Error('Debugger response field name is invalid');
  }
  const matches = [...value.matchAll(new RegExp(`(?:^| )${name}=([^ ]+)(?= |$)`, 'g'))];
  if (matches.length !== 1) {
    throw new Error(`${matches.length ? 'Duplicate' : 'Missing'} ${name} in debugger response: ${value}`);
  }
  return matches[0][1];
}

function safeIntegerField(value, name) {
  const raw = field(value, name);
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`Debugger ${name} is not a nonnegative decimal integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Debugger ${name} exceeds safe integer range`);
  return parsed;
}

function stepPlan(count) {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Forward step count must be a nonnegative safe integer');
  }
  if (Math.ceil(count / MAX_STEP_CHUNK) > MAX_STEP_COMMANDS) {
    throw new Error(`Forward replay exceeds its ${MAX_STEP_COMMANDS}-command bound`);
  }
  const chunks = [];
  while (count > 0) {
    const chunk = Math.min(count, MAX_STEP_CHUNK);
    chunks.push(chunk);
    count -= chunk;
  }
  return Object.freeze(chunks);
}

function parseRequest(args) {
  if (!Array.isArray(args)) throw new Error('Reverse debugger arguments must be an array');
  const operation = args[0];
  const checkpoint = args[1];
  if (args.length !== 3 || !CHECKPOINT_PATTERN.test(checkpoint || '') ||
      checkpoint.includes('..')) return undefined;
  if (operation === 'step' && /^[1-9][0-9]*$/.test(args[2] || '')) {
    const count = Number(args[2]);
    if (!Number.isSafeInteger(count)) return undefined;
    return Object.freeze({ operation, checkpoint, count });
  }
  return undefined;
}

function requireSession(session) {
  const common = ['status', 'restoreCheckpoint', 'verifyDeterminism', 'replayInput',
    'registers', 'step', 'determinismStatus', 'inputStatus'];
  if (!session || common.some(name => typeof session[name] !== 'function')) {
    throw new Error('Reverse workflow requires a compatible leased DebuggerSession');
  }
}

async function validateReplay(session, stoppedSequence) {
  const determinism = response(await session.determinismStatus(), 'DETERMINISM STATUS');
  if (field(determinism, 'MODE') !== 'VERIFY' || field(determinism, 'FAILED') !== '0') {
    throw new Error(`External-event replay diverged: ${determinism}`);
  }
  if (safeIntegerField(determinism, 'SEQUENCE') !== stoppedSequence) {
    throw new Error('DETERMINISM STATUS did not report the exact stopped sequence');
  }
  const input = response(await session.inputStatus(), 'INPUT STATUS');
  if (field(input, 'ACTIVE') !== '1' || field(input, 'SKIPPED') !== '0') {
    throw new Error(`Scheduled input replay is inactive or skipped a boundary: ${input}`);
  }
  if (safeIntegerField(input, 'SEQUENCE') !== stoppedSequence) {
    throw new Error('INPUT STATUS did not report the exact stopped sequence');
  }
  return Object.freeze({ determinism, input });
}

async function runReverse(session, request) {
  if (!request || request.operation !== 'step') {
    throw new Error('A parsed reverse debugger request is required');
  }
  const canonical = parseRequest(['step', request.checkpoint, String(request.count)]);
  if (!canonical) throw new Error('A parsed reverse debugger request is required');
  request = canonical;
  requireSession(session);
  const before = response(await session.status(), 'STATUS');
  if (field(before, 'STOPPED') !== '1') {
    throw new Error('Reverse workflow requires an originally stopped debugger session');
  }
  const originalSequence = safeIntegerField(before, 'SEQUENCE');
  const restored = response(await session.restoreCheckpoint(request.checkpoint),
    'CHECKPOINT RESTORE');
  if (field(restored, 'CHECKPOINT') !== 'RESTORED' ||
      field(restored, 'NAME') !== request.checkpoint) {
    throw new Error('Checkpoint restore receipt does not match the requested checkpoint');
  }
  const checkpointSequence = safeIntegerField(restored, 'SEQUENCE');
  if (checkpointSequence > originalSequence) {
    throw new Error('Named checkpoint follows the original stopped sequence');
  }
  const targetSequence = originalSequence - request.count;
  if (!Number.isSafeInteger(targetSequence) || targetSequence < checkpointSequence) {
    throw new Error('Reverse-step target precedes the named checkpoint');
  }
  const forwardPlan = stepPlan(targetSequence - checkpointSequence);
  const determinismArmed = response(await session.verifyDeterminism(), 'DETERMINISM VERIFY');
  if (field(determinismArmed, 'MODE') !== 'VERIFY' ||
      field(determinismArmed, 'FAILED') !== '0' ||
      safeIntegerField(determinismArmed, 'SEQUENCE') !== checkpointSequence) {
    throw new Error('Determinism verification did not arm at the checkpoint sequence');
  }
  const inputArmed = response(await session.replayInput(), 'INPUT REPLAY');
  if (safeIntegerField(inputArmed, 'FROM_SEQUENCE') !== checkpointSequence) {
    throw new Error('Input replay did not arm at the checkpoint sequence');
  }

  let stopped = response(await session.registers(), 'REGISTERS');
  if (field(stopped, 'STOPPED') !== '1') {
    throw new Error('Restored register receipt is not stopped');
  }
  let stoppedSequence = safeIntegerField(stopped, 'SEQUENCE');
  if (stoppedSequence !== checkpointSequence) {
    throw new Error('Restored register sequence does not match the checkpoint receipt');
  }
  let expectedSequence = checkpointSequence;
  for (const chunk of forwardPlan) {
    stopped = response(await session.step(chunk), 'STEP');
    if (field(stopped, 'STOPPED') !== '1') {
      throw new Error('STEP did not leave the debugger stopped');
    }
    stoppedSequence = safeIntegerField(stopped, 'SEQUENCE');
    expectedSequence += chunk;
    if (stoppedSequence !== expectedSequence) {
      throw new Error('STEP did not report the exact requested sequence advance');
    }
  }
  if (stoppedSequence !== targetSequence) {
    throw new Error('Reverse step did not stop at the exact target sequence');
  }

  const replay = await validateReplay(session, stoppedSequence);
  return Object.freeze({ ok: true, operation: request.operation,
    checkpoint: request.checkpoint, originalSequence, checkpointSequence,
    targetSequence, stoppedSequence,
    before, restored, determinismArmed, inputArmed, stopped, ...replay });
}

async function runCli(argv, dependencies = {}) {
  const request = parseRequest(argv);
  if (!request) throw new Error(
    'Usage: dosbox-reverse step CHECKPOINT COUNT');
  if (typeof dependencies.withSession !== 'function') {
    throw new Error('DOSBox reverse CLI requires a DebuggerSession adapter');
  }
  const result = await dependencies.withSession(dependencies.sessionOptions ?? {},
    session => runReverse(session, request));
  const output = dependencies.output ?? process.stdout;
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

module.exports = { field, parseRequest, runCli, runReverse, safeIntegerField, stepPlan,
  validateReplay };
