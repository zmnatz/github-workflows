import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'inject.mjs');
const PAGE = '<!doctype html>\n<html><head><meta charset="utf-8"><title>t</title></head><body>hi</body></html>\n';
// What a page gets: a marker, then the tag as Google gave it for the container.
const TAG = `<!-- google-analytics GTM-ABC123 -->
<script async src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC123"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
</script>`;

/** A built site with these files, and the script run on it. */
function run(files, tagId = 'GTM-ABC123', dir = mkdtempSync(join(tmpdir(), 'site-'))) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const result = spawnSync(process.execPath, [SCRIPT, dir, tagId], { encoding: 'utf8' });
  return { ...result, dir, read: (path) => readFileSync(join(dir, path), 'utf8') };
}

describe('inject', () => {
  it("adds the tag at the end of every page's head", () => {
    const site = run({ 'index.html': PAGE, 'guide/install/index.html': PAGE });
    assert.equal(site.status, 0, site.stderr);
    for (const path of ['index.html', 'guide/install/index.html']) {
      assert.equal(site.read(path), PAGE.replace('</head>', `${TAG}\n</head>`));
    }
    assert.match(site.stdout, /2 pages/);
  });

  it('leaves a file with no head, and a file that is not HTML, as they were', () => {
    const files = { 'index.html': PAGE, 'google123.html': 'google-site-verification: google123\n', 'search.json': '"</head>"\n' };
    const site = run(files);
    assert.equal(site.status, 0, site.stderr);
    assert.equal(site.read('google123.html'), files['google123.html']);
    assert.equal(site.read('search.json'), files['search.json']);
    assert.match(site.stdout, /1 page\b/);
  });

  it('adds the tag once, however often it runs', () => {
    const first = run({ 'index.html': PAGE });
    const again = run({}, 'GTM-ABC123', first.dir);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.read('index.html'), PAGE.replace('</head>', `${TAG}\n</head>`));
  });

  it('fails when it finds no page, such as on the wrong directory', () => {
    const site = run({ 'notes.txt': 'not a site' });
    assert.notEqual(site.status, 0);
    assert.match(site.stderr, /no HTML page/);
  });

  it('refuses what is not a tag manager ID, and changes nothing', () => {
    for (const id of ['', 'G-ABC123', 'GTM-ABC"></script>']) {
      const site = run({ 'index.html': PAGE }, id);
      assert.notEqual(site.status, 0, id);
      assert.match(site.stderr, /GTM-/);
      assert.equal(site.read('index.html'), PAGE);
    }
  });
});
