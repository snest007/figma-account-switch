#!/usr/bin/env node
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { AccountManager, atomicJson } from '../src/manager.mjs';
import { createPanelServer } from '../src/http.mjs';
import { cleanError } from '../src/rpc.mjs';
import { VERSION } from '../src/version.mjs';
import { removeServiceRecord } from '../src/service-client.mjs';

const manager = await new AccountManager().init();
// Startup is serialized by ensureService; discard a mutation lock left by a crash.
await unlink(join(manager.dir, 'mutation.lock')).catch(() => {});
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true; manager.close(); await app.close();
  await removeServiceRecord(manager.dir, record);
  process.exit(0);
};
const app = createPanelServer(manager, { onShutdown: stop });
const info = await app.listen();
const record = { ...info, pid: process.pid, version: VERSION, startedAt: new Date().toISOString() };
await atomicJson(join(manager.dir, 'service.json'), record);
process.stderr.write('Figma Accounts is listening on ' + info.origin + '\n');
process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.on('unhandledRejection', error => process.stderr.write(cleanError(error?.message) + '\n'));
