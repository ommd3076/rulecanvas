import fs from 'node:fs';
import path from 'node:path';

const ruixenComponents = [
  'magnetic-tabs',
  'breadcrumb-dropdown',
  'progress-button',
  'inline-copy-input'
];

async function fetchRuixen() {
  fs.mkdirSync('components/ruixen', { recursive: true });
  for (const name of ruixenComponents) {
    console.log(`Fetching Ruixen ${name}...`);
    const res = await fetch(`https://ruixen.com/r/${name}.json`);
    const data = await res.json();
    for (const f of data.files) {
      const filename = path.basename(f.path);
      const outPath = path.join('components/ruixen', filename);
      fs.writeFileSync(outPath, f.content);
      console.log('Saved Ruixen:', outPath);
    }
  }
}

const rareUiComponents = [
  { name: 'folder-component', path: 'components/ui/folder-component.tsx' },
  { name: 'step-player', path: 'components/ui/step-player.tsx' },
  { name: 'code-block', path: 'components/ui/code-block.tsx' },
  { name: 'toast', path: 'components/ui/toast.tsx' }
];

async function fetchRareUI() {
  fs.mkdirSync('components/rareui', { recursive: true });
  for (const comp of rareUiComponents) {
    console.log(`Fetching RareUI ${comp.name}...`);
    const url = `https://raw.githubusercontent.com/swamimalode07/rare-ui/main/${comp.path}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Failed to fetch ${comp.name}: ${res.status} ${res.statusText}`);
      continue;
    }
    const text = await res.text();
    const outPath = path.join('components/rareui', path.basename(comp.path));
    fs.writeFileSync(outPath, text);
    console.log('Saved RareUI:', outPath);
  }
}

async function main() {
  await fetchRuixen();
  await fetchRareUI();
  console.log('Done fetching external components!');
}

main().catch(console.error);
