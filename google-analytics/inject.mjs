// Adds a Google tag to every page of a built site, just before </head>. Run by action.yml:
//
//   node inject.mjs <site-dir> <tag-id>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, id] = process.argv.slice(2);
function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}
// The ID goes into the page's HTML, and only a tag manager ID works with this snippet.
if (!/^GTM-[A-Z0-9]+$/.test(id ?? '')) fail(`The tag ID must look like GTM-XXXXXXX, not "${id ?? ''}"`);

// Marks a page that has the tag, so a second run does not count each visit twice.
const MARK = `<!-- google-analytics ${id} -->`;
const tag = `<script async src="https://www.googletagmanager.com/gtm.js?id=${id}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
</script>`;

const HEAD_END = /<\/head>/i;

let count = 0;
for (const name of readdirSync(dir, { recursive: true })) {
  if (!name.endsWith('.html')) continue;
  const path = join(dir, name);
  const html = readFileSync(path, 'utf8');
  if (!HEAD_END.test(html)) continue; // such as a site verification file
  if (!html.includes(MARK)) writeFileSync(path, html.replace(HEAD_END, (end) => `${MARK}\n${tag}\n${end}`));
  count++;
}
if (!count) fail(`Found no HTML page with a <head> in ${dir}`);
console.log(`${id} is on ${count} ${count === 1 ? 'page' : 'pages'} in ${dir}`);
