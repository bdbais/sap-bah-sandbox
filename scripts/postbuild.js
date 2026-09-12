// tsc only emits JavaScript. Copy the non-TS assets the runtime reads at
// startup so `node dist/server.js` works from a clean checkout.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const copies = [['src/db/schema.sql', 'dist/db/schema.sql']];

for (const [from, to] of copies) {
  const src = path.join(root, from);
  const dest = path.join(root, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`copied ${from} -> ${to}`);
}
