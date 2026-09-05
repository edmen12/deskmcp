import { spawn } from 'node:child_process';

const child = spawn(
  process.execPath,
  ['-e', 'setInterval(() => {}, 1000)'],
  { stdio: 'ignore' }
);

if (!child.pid) {
  console.error('DESCENDANT_START_FAILED');
  process.exit(2);
}

child.unref();
console.log(`DESCENDANT_PID=${child.pid}`);
setTimeout(() => process.exit(0), 50);
