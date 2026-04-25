import { parseImageUrls } from './src/controllers/catalogueController.js';

const cases = [
  { name: 'pipe-separated image_urls', row: { image_urls: 'https://a.jpg|https://b.jpg|https://c.jpg', title: 'X' }, expect: ['https://a.jpg', 'https://b.jpg', 'https://c.jpg'] },
  { name: 'images alias, with whitespace', row: { images: '  https://a.jpg  |  https://b.jpg ' }, expect: ['https://a.jpg', 'https://b.jpg'] },
  { name: 'numbered columns out of order', row: { image_url_3: 'https://c.jpg', image_url_1: 'https://a.jpg', image_url_2: 'https://b.jpg' }, expect: ['https://a.jpg', 'https://b.jpg', 'https://c.jpg'] },
  { name: 'numbered columns with hyphen and double-digit', row: { 'image_url-1': 'https://a.jpg', 'image_url_10': 'https://j.jpg', 'image_url_2': 'https://b.jpg' }, expect: ['https://a.jpg', 'https://b.jpg', 'https://j.jpg'] },
  { name: 'legacy single image_url', row: { image_url: 'https://a.jpg', title: 'Y' }, expect: ['https://a.jpg'] },
  { name: 'legacy image_url with pipe-separated value', row: { image_url: 'https://a.jpg|https://b.jpg' }, expect: ['https://a.jpg', 'https://b.jpg'] },
  { name: 'dedup + ignore non-http', row: { image_urls: 'https://a.jpg|https://a.jpg|ftp://x|  |https://b.jpg' }, expect: ['https://a.jpg', 'https://b.jpg'] },
  { name: 'image_urls wins over numbered + single', row: { image_urls: 'https://x.jpg', image_url_1: 'https://y.jpg', image_url: 'https://z.jpg' }, expect: ['https://x.jpg'] },
  { name: 'no images at all', row: { title: 'no img' }, expect: [] },
  { name: 'URL with commas in path (no breakage)', row: { image_urls: 'https://a.com/img,1,2.jpg|https://b.com/x.jpg' }, expect: ['https://a.com/img,1,2.jpg', 'https://b.com/x.jpg'] },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const got = parseImageUrls(c.row);
  const ok = JSON.stringify(got) === JSON.stringify(c.expect);
  if (ok) { pass++; console.log(`  ok   ${c.name}`); }
  else    { fail++; console.log(`  FAIL ${c.name}\n        got:    ${JSON.stringify(got)}\n        expect: ${JSON.stringify(c.expect)}`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
