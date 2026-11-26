// Adds Google Analytics to every page of a built site, just before </head>. Run by action.yml:
//
//   node inject.mjs <site-dir> <measurement-id>
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, id] = process.argv.slice(2);
function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}
// An older Node lists only the top folder, and would leave the other pages out without a word.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 18 || (major === 18 && minor < 17)) fail(`Node ${process.versions.node} is too old: use 18.17 or newer`);
// The ID goes into the page's HTML, and only a measurement ID works with this snippet.
if (!/^G-[A-Z0-9]+$/.test(id ?? '')) fail(`The tag ID must look like G-XXXXXXXXXX, not "${id ?? ''}"`);

// Marks a page that has the tag, so a second run does not count each visit twice.
const MARK = `<!-- google-analytics ${id} -->`;
const tag = `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${id}');
</script>`;

const HEAD_END = /<\/head>/i;

let count = 0;
for (const name of readdirSync(dir, { recursive: true })) {
  if (!name.endsWith('.html')) continue;
  const path = join(dir, name);
  if (!statSync(path).isFile()) continue;
  const html = readFileSync(path, 'utf8');
  if (!HEAD_END.test(html)) continue; // such as a site verification file
  if (!html.includes(MARK)) writeFileSync(path, html.replace(HEAD_END, (end) => `${MARK}\n${tag}\n${end}`));
  count++;
}
if (!count) fail(`Found no HTML page with a <head> in ${dir}`);
console.log(`${id} is on ${count} ${count === 1 ? 'page' : 'pages'} in ${dir}`);
