#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const input = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? process.env.npm_package_version;
if (!input) {
  console.error('Usage: node scripts/sync-app-version.mjs <version-or-tag>');
  process.exit(1);
}

const version = input.replace(/^refs\/tags\//, '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Invalid semver: ${input}`);
  process.exit(1);
}

const jsonFiles = [
  'package.json',
  'apps/desktop/package.json',
  'apps/mobile/package.json',
  'apps/desktop/src-tauri/tauri.conf.json',
  'apps/mobile/src-tauri/tauri.conf.json',
];

for (const path of jsonFiles) {
  const content = readFileSync(path, 'utf8');
  JSON.parse(content);
  if (!/"version"\s*:\s*"[^"]+"/.test(content)) {
    console.error(`Could not find version in ${path}`);
    process.exit(1);
  }
  const next = content.replace(/("version"\s*:\s*)"[^"]+"/, `$1"${version}"`);
  writeFileSync(path, next);
}

const tomlFiles = [
  'apps/desktop/src-tauri/Cargo.toml',
  'apps/mobile/src-tauri/Cargo.toml',
];

for (const path of tomlFiles) {
  const content = readFileSync(path, 'utf8');
  if (!/^(\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m.test(content)) {
    console.error(`Could not find package version in ${path}`);
    process.exit(1);
  }
  const next = content.replace(
    /^(\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m,
    `$1"${version}"`,
  );
  writeFileSync(path, next);
}

console.log(`Synced app versions to ${version}`);
