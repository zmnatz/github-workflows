import { describe, it } from 'node:test';
import { startSite } from '../lib/serve.ts';
import { expect } from './expect.ts';

describe('startSite', () => {
  it('starts the command on a free port and stops it on close', async () => {
    const server = await startSite({
      command: `exec node -e "require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT, '127.0.0.1')"`,
      cwd: '.',
    });
    expect(await (await fetch(server.url)).text()).toBe('ok');
    server.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const stopped = await fetch(server.url).then(() => false, () => true);
    expect(stopped).toBe(true);
  });

  it('fails when the command exits before answering', async () => {
    const error = await startSite({ command: 'exit 3', cwd: '.' }).then(() => null, (err: Error) => err.message);
    expect(error).toContain('exited with code 3');
  });
});
