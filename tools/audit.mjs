#!/usr/bin/env node
/** Small static audit for dangerous patterns and missing runtime assets. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const warnings = [];
const sourceFiles = [];

async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (/\.(?:js|mjs|css|html)$/.test(entry.name)) sourceFiles.push(full);
  }
}

await walk(path.join(ROOT, 'src'));
await walk(path.join(ROOT, 'server'));

for (const file of sourceFiles) {
  const text = await fs.readFile(file, 'utf8');
  const relative = path.relative(ROOT, file);
  if (/\beval\s*\(/.test(text)) failures.push(`${relative}: eval() is forbidden`);
  if (/new Function\s*\(/.test(text)) failures.push(`${relative}: new Function() is forbidden`);
  if (/innerHTML\s*=\s*[^`'"\s]/.test(text)) warnings.push(`${relative}: check innerHTML source is escaped`);
  if (/TODO|FIXME|XXX/.test(text)) warnings.push(`${relative}: contains TODO/FIXME marker`);
}

for (const required of [
  'src/index.html',
  'src/manifest.webmanifest',
  'src/sw.js',
  'src/js/app.js',
  'server/hub.js',
  'server/ws.js',
]) {
  try {
    await fs.access(path.join(ROOT, required));
  } catch {
    failures.push(`missing required file: ${required}`);
  }
}

if (failures.length) {
  console.error('Audit failed:');
  for (const item of failures) console.error(`  ERROR ${item}`);
  process.exitCode = 1;
} else {
  console.log(`Audit passed (${sourceFiles.length} source files).`);
}
for (const item of warnings) console.warn(`  WARN ${item}`);
