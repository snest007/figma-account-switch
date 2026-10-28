#!/usr/bin/env node
import { stopService } from '../src/service-client.mjs';
import { cleanError } from '../src/rpc.mjs';

try { console.log((await stopService()).message); }
catch (error) { console.error(cleanError(error.message)); process.exitCode = 1; }
