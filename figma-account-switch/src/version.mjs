import { readFileSync } from 'node:fs';

// One version is shared by MCP discovery, the local service and Codex RPC.
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
