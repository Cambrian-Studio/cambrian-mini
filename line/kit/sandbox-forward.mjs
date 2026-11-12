#!/usr/bin/env node
// sandbox-forward.mjs — runs INSIDE a sandbox that has its own empty network namespace (bubblewrap, or a
// container with --network none). It gives the command the same two loopback ports it has on macOS:
// it listens on 127.0.0.1:<bridge-port> and 127.0.0.1:<proxy-port> inside the namespace and pipes every
// connection to the bridge's unix socket of the same name in <socket-dir>. Then it runs the command and
// ends the way the command ended. It adds no way out: the sockets are the bridge's own two doors.
// Usage: sandbox-forward.mjs <socket-dir> <bridge-port> <proxy-port> -- <command…>
import { connect, createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep !== 3 || argv.length < 5) {
  console.error('usage: sandbox-forward.mjs <socket-dir> <bridge-port> <proxy-port> -- <command…>');
  process.exit(2);
}
const [dir, bridgePort, proxyPort] = argv;
const cmd = argv.slice(sep + 1);

const pipeTo = (sockPath, port) =>
  new Promise((resolve, reject) => {
    const server = createServer((c) => {
      const u = connect(sockPath);
      const end = () => {
        c.destroy();
        u.destroy();
      };
      c.on('error', end);
      u.on('error', end);
      c.on('close', end);
      u.on('close', end);
      c.pipe(u);
      u.pipe(c);
    });
    server.once('error', reject);
    server.listen(Number(port), '127.0.0.1', () => {
      server.unref();
      resolve();
    });
  });

// A port below 1024 is the "no network" marker (nothing listens there on any platform); it gets no listener here either.
const doors = [['bridge.sock', bridgePort], ['proxy.sock', proxyPort]].filter(([f, p]) => Number(p) >= 1024 && existsSync(join(dir, f)));
try {
  await Promise.all(doors.map(([f, p]) => pipeTo(join(dir, f), p)));
} catch (e) {
  console.error(`sandbox-forward: could not listen on loopback (${e.code ?? e.message})`);
  process.exit(3);
}
const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' });
const signals = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGALRM'];
for (const s of signals) process.on(s, () => child.kill(s));
child.on('error', (e) => {
  console.error(`sandbox-forward: could not start ${cmd[0]} (${e.code ?? e.message})`);
  process.exit(127);
});
child.on('exit', (code, signal) => {
  if (!signal) process.exit(code ?? 1);
  for (const s of signals) process.removeAllListeners(s);
  process.kill(process.pid, signal);
});
