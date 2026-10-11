import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

// Standalone test files preserve detailed TAP output across local Node test-isolation setups.
const directory = new URL('../tests/', import.meta.url);
const files = (await readdir(directory)).filter(name => name.endsWith('.test.mjs')).sort();
for (const file of files) {
  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL(file, directory).pathname], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
  if (status !== 0) process.exit(status);
}
