// Launcher: the forge is the vendored Go binary (go/forge). This file only
// starts it and forwards its exit code; all serving is done by the binary.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(dir, 'go', 'forge');
const child = spawn(bin, [], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (err) => {
  process.stderr.write(`[launcher] failed to start Go binary: ${err.message}\n`);
  process.exit(1);
});
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
