// A stand-in for `tsc`: fails with a tsc-style error for every line containing BROKEN.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
let errors = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'out' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(name)) {
      readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (line.includes('BROKEN')) {
          errors++;
          console.log(`${path.relative('.', p).split(path.sep).join('/')}(${i + 1},1): error TS2304: Cannot find name 'BROKEN'.`);
        }
      });
    }
  }
};
walk('.');
if (errors) {
  console.log(`Found ${errors} error(s).`);
  process.exit(1);
}
console.log('ok');
