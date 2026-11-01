// Stands in for `npm install -g` when GR_FAKE_UPDATE is set (see fakeInstaller in src/updateCheck.ts):
// prints npm-like progress over a few seconds and ends the way GR_FAKE_UPDATE_RESULT says.
//   node scripts/fake-update.mjs <version> <ok|fail|eacces|elsewhere> <marker file>
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const [version, result, marker] = process.argv.slice(2);
const packages = ['ink', 'react', 'meow', 'shiki', 'zod', '@anthropic-ai/sdk', 'yaml', 'diff'];
for (const name of packages) {
  await sleep(350);
  console.log(`npm http fetch GET 200 https://registry.npmjs.org/${name} ${Math.floor(Math.random() * 90) + 10}ms (cache revalidated)`);
}
await sleep(400);
if (result === 'fail') {
  console.error('npm ERR! code ETARGET');
  console.error(`npm ERR! notarget No matching version found for @haydenmeloche/guided-review@${version}.`);
  process.exit(1);
}
if (result === 'eacces') {
  console.error('npm ERR! code EACCES');
  console.error('npm ERR! syscall rename');
  console.error('npm ERR! path /usr/local/lib/node_modules/@haydenmeloche/guided-review');
  console.error('npm ERR! errno -13');
  console.error('npm ERR! Error: EACCES: permission denied, rename');
  process.exit(243);
}
console.log(`\nchanged ${packages.length} packages in 3s`);
// "elsewhere": the install succeeds, but the gr on PATH still runs the old version.
if (result !== 'elsewhere') fs.writeFileSync(marker, `${version}\n`);
