// test.mjs — `npm test`: every unit test and every attack test under test/, with node's own runner.
// Test files run one at a time: several of them start the line, which takes loopback ports, and two runs
// racing for a port made one of them stop as "blocked" now and then.
// Prints the runner's output, then one line a machine can read: "N passed, 0 failed".
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=240000', '--test-reporter=spec', 'test/**/*.test.mjs'], { cwd: root, encoding: 'utf8', maxBuffer: 64e6, env: { ...process.env, FORCE_COLOR: '0' } });
const out = (r.stdout ?? '') + (r.stderr ?? '');
process.stdout.write(out);
const num = (label) => Number(new RegExp(`^ℹ ${label} (\\d+)`, 'm').exec(out)?.[1] ?? NaN);
const pass = num('pass'), fail = num('fail'), skipped = num('skipped');
if (!Number.isFinite(pass) || !Number.isFinite(fail)) { console.log('test run produced no summary — counting it as failed'); process.exit(1); }
console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped (each prints its reason above)` : ''}`);
process.exit(fail === 0 && r.status === 0 ? 0 : 1);
