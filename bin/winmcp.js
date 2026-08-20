#!/usr/bin/env node

'use strict';

const { runCli } = require('../lib/win-auto-cli');

runCli().catch(error => { console.error(error.message); process.exitCode = 1; });
