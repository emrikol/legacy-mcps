#!/usr/bin/env node

'use strict';

const { DebuggerSession, loadBatch, parseBatchResponse,
  parseDebuggerArguments, resetDebuggerSession } = require('../lib/dosbox-debugger');

function usage() {
  return `Usage: dosbox-debugger.js [options] operation

Options:
  --host HOST                 DOSBox-X control host (default 127.0.0.1)
  --port PORT                 DOSBox-X control port (default 10199)
  --timeout MS                Host timeout, 35000-300000 and at least WAIT+5000
  --max-response-bytes N      Response bound, 1-16777216
  --lease-dir ABSOLUTE_PATH   Shared host lease directory
  --lease-timeout MS          Lease acquisition timeout, 1-300000
  --poll-ms MS                Lease poll interval, 1-1000
  --audit-log PATH            Durable mutation JSONL log

Operations:
  status | pause | registers | continue | next | step [count]
  finish [instruction-limit] | wait [milliseconds]
  run-until SELECTOR:OFFSET | checkpoint save|restore NAME | checkpoint-restore NAME
  hash SELECTOR:OFFSET HEX_COUNT | selector HEX | memory SELECTOR:OFFSET HEX_COUNT
  linear-memory HEX_ADDRESS HEX_COUNT | disasm [SELECTOR:OFFSET [HEX_COUNT]] | stack [count]
  snapshot SAFE_NAME.png | input ... | determinism ... | coverage ...
  interrupt ... | exception ... | break ... | watch ... | fileio ... | apitrace ...
  input-status | input-replay | determinism-status | determinism-verify
  batch JSON_FILE | raw NON-MUTATION_COMMAND...
  reset --confirm-emulator-reset
  mutate register NAME HEX --reason TEXT --confirm-manipulated-oracle
  mutate memory SELECTOR:OFFSET HEX_BYTE... --reason TEXT --confirm-manipulated-oracle`;
}

function parseCli(argv) {
  const options = {};
  let index = 0;
  const numeric = new Set(['--port', '--timeout', '--max-response-bytes',
    '--lease-timeout', '--poll-ms']);
  const names = new Map([
    ['--host', 'host'], ['--port', 'port'], ['--timeout', 'timeout'],
    ['--max-response-bytes', 'maxResponseBytes'], ['--lease-dir', 'leaseDirectory'],
    ['--lease-timeout', 'leaseTimeout'], ['--poll-ms', 'pollMs'], ['--audit-log', 'auditPath'],
  ]);
  while (index < argv.length && argv[index].startsWith('--')) {
    const flag = argv[index++];
    if (flag === '--help') return Object.freeze({ help: true });
    if (!names.has(flag) || index >= argv.length) throw new Error(`Unknown or incomplete option: ${flag}`);
    const value = argv[index++];
    options[names.get(flag)] = numeric.has(flag) ? Number(value) : value;
  }
  const operationArgs = argv.slice(index);
  const operation = operationArgs.length === 2 && operationArgs[0] === 'reset' &&
    operationArgs[1] === '--confirm-emulator-reset' ?
    Object.freeze({ kind: 'reset' }) : parseDebuggerArguments(operationArgs);
  return Object.freeze({ options: Object.freeze(options), operation });
}

async function run(parsed, dependencies = {}) {
  if (parsed.help) return { help: true, exitCode: 0, output: usage() };
  if (parsed.operation.kind === 'reset') {
    const reset = dependencies.resetDebuggerSession ?? resetDebuggerSession;
    const receipt = await reset({ leaseDirectory: parsed.options.leaseDirectory,
      leaseTimeout: parsed.options.leaseTimeout, pollMs: parsed.options.pollMs,
      confirmEmulatorReset: true });
    return { exitCode: 0, output: JSON.stringify(receipt, null, 2) };
  }
  const session = await new DebuggerSession(parsed.options).open();
  let primary;
  try {
    const operation = parsed.operation;
    if (operation.kind === 'mutation') {
      const receipt = await session.mutate(operation);
      return { exitCode: 0, output: JSON.stringify(receipt, null, 2) };
    }
    if (operation.kind === 'batch') {
      const batch = loadBatch(operation.file);
      const response = await session.batch(batch.commands);
      const receipt = parseBatchResponse(response, batch.commands);
      return { exitCode: receipt.ok ? 0 : 1, output: JSON.stringify(receipt, null, 2) };
    }
    const response = await session.command(operation.command,
      operation.timeout === undefined ? undefined : { timeout: operation.timeout });
    return { exitCode: response.startsWith('ERR') ? 1 : 0, output: response };
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try { await session.close(); }
    catch (error) { if (primary) primary.leaseCleanupError = error.message; else throw error; }
  }
}

async function main(argv = process.argv.slice(2)) {
  const result = await run(parseCli(argv));
  process.stdout.write(`${result.output}\n`);
  process.exitCode = result.exitCode;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 1;
  });
}

module.exports = { main, parseCli, run, usage };
