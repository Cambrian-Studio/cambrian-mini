#!/usr/bin/env node
// probe-net.mjs — the network arms of the wall probe (line-probe.sh). Exit 0 = it worked, 1 = it did not.
//   http <port>                    a plain HTTP request to 127.0.0.1:<port>; any HTTP answer counts
//   tunnel <proxy-port> <host:port> CONNECT through the allow-list tunnel; only "200" counts
//   tcp <host> <port>              a direct TCP connection, no proxy
//   fetch <url>                    node's own fetch (DNS, TLS and all), no proxy
import { connect } from 'node:net';

const [mode, a, b] = process.argv.slice(2);
const done = (ok, words) => {
  console.log(words);
  process.exit(ok ? 0 : 1);
};
const dial = (host, port, onOpen) => {
  const s = connect({ host, port: Number(port) }, () => onOpen(s));
  s.setTimeout(8000, () => {
    s.destroy();
    done(false, 'timed out');
  });
  s.on('error', (e) => done(false, String(e.code ?? e.message)));
  return s;
};
const firstLine = (s, then) => {
  let buf = '';
  s.on('data', (d) => {
    buf += d;
    const i = buf.indexOf('\r\n');
    if (i >= 0) {
      s.destroy();
      then(buf.slice(0, i));
    }
  });
  s.on('close', () => done(false, 'closed with no answer'));
};

if (mode === 'http') {
  dial('127.0.0.1', a, (s) => {
    s.write('GET / HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: close\r\n\r\n');
    firstLine(s, (l) => done(/^HTTP\/1\.[01] \d{3}/.test(l), l));
  });
} else if (mode === 'tunnel') {
  dial('127.0.0.1', a, (s) => {
    s.write(`CONNECT ${b} HTTP/1.1\r\nhost: ${b}\r\n\r\n`);
    firstLine(s, (l) => done(/^HTTP\/1\.[01] 200/.test(l), l));
  });
} else if (mode === 'tcp') {
  dial(a, b, (s) => {
    s.destroy();
    done(true, 'connected');
  });
} else if (mode === 'fetch') {
  const no = (e) => done(false, String(e.cause?.code ?? e.message));
  fetch(a, { signal: AbortSignal.timeout(8000) }).then((r) => done(true, `http ${r.status}`), no);
} else {
  console.error('usage: probe-net.mjs http <port> | tunnel <proxy-port> <host:port> | tcp <host> <port> | fetch <url>');
  process.exit(2);
}
