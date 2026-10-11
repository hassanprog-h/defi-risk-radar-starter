import solc from 'solc';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const content = await readFile(new URL('../contracts/ForkPolicyMigrator.sol', import.meta.url), 'utf8');
const settings = { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } };
const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'ForkPolicyMigrator.sol': { content } }, settings })));
for (const error of compiled.errors ?? []) {
  if (error.severity === 'error') throw new Error(error.formattedMessage);
  console.error(error.formattedMessage);
}
const contract = compiled.contracts['ForkPolicyMigrator.sol'].ForkPolicyMigrator;
const artifact = { compiler: solc.version(), sourceSha256: createHash('sha256').update(content).digest('hex'), settings, abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` };
await mkdir(new URL('../contracts/artifacts/', import.meta.url), { recursive: true });
await writeFile(new URL('../contracts/artifacts/ForkPolicyMigrator.json', import.meta.url), JSON.stringify(artifact, null, 2) + '\n');
console.log(`Compiled fork-only migrator with ${artifact.compiler}`);
