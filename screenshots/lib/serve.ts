import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

// Starts the site under test with the caller's command and waits until it answers.
// `{port}` in the command is replaced with a free port, which is also in $PORT.

const START_TIMEOUT_MS = 60_000;

export const DEFAULT_START = 'node_modules/.bin/next start -H 127.0.0.1 -p {port}';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

export async function startSite({
  command,
  cwd,
  timeoutMs = START_TIMEOUT_MS,
}: {
  command: string;
  cwd: string;
  timeoutMs?: number;
}): Promise<{ url: string; close: () => void }> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  // Its own process group, so closing it also stops whatever the shell started.
  const server = spawn('sh', ['-c', command.replaceAll('{port}', String(port))], {
    cwd: path.resolve(cwd),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  });
  let stopped = false;
  const close = () => {
    stopped = true;
    try {
      process.kill(-(server.pid as number), 'SIGTERM');
    } catch {
      // Already gone.
    }
  };
  const exited = new Promise<never>((_, reject) =>
    server.once('exit', (code) => {
      stopped = true;
      reject(new Error(`\`${command}\` exited with code ${code}`));
    })
  );
  const ready = (async () => {
    const deadline = Date.now() + timeoutMs;
    while (!stopped && Date.now() < deadline) {
      try {
        await fetch(url);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (stopped) {
      return;
    }
    throw new Error(`\`${command}\` did not answer at ${url} within ${timeoutMs}ms`);
  })();
  try {
    await Promise.race([ready, exited]);
  } catch (err) {
    close();
    throw err;
  }
  exited.catch(() => {});
  return { url, close };
}
