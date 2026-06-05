import 'dotenv/config';
import { execSync } from 'node:child_process';

const port = Number(process.env.PORT || 3210);

if (!Number.isInteger(port) || port <= 0) {
  console.error(`Invalid PORT value: ${process.env.PORT ?? ''}`);
  process.exit(1);
}

const pids = process.platform === 'win32' ? findWindowsPids(port) : findUnixPids(port);

if (pids.length === 0) {
  console.log(`No process is listening on port ${port}.`);
  process.exit(0);
}

for (const pid of pids) {
  stopPid(pid);
}

console.log(`Stopped ${pids.length} process${pids.length === 1 ? '' : 'es'} on port ${port}.`);

function findWindowsPids(targetPort) {
  const output = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
  const pids = new Set();

  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);

    if (parts.length < 4) {
      continue;
    }

    const localAddress = parts[1] || '';
    const pid = parts.at(-1);

    if (!localAddress.endsWith(`:${targetPort}`) || !/^\d+$/.test(pid || '')) {
      continue;
    }

    pids.add(pid);
  }

  return [...pids];
}

function findUnixPids(targetPort) {
  try {
    const output = execSync(`lsof -ti tcp:${targetPort}`, { encoding: 'utf8' });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line));
  } catch {
    return [];
  }
}

function stopPid(pid) {
  if (process.platform === 'win32') {
    execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
    return;
  }

  process.kill(Number(pid), 'SIGTERM');
}