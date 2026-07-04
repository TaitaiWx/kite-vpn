#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const input = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? process.env.npm_package_version;
if (!input) {
  console.error(
    'Usage: node scripts/sync-app-version.mjs <version-or-tag> [--msi-compatible|--macos-compatible]',
  );
  process.exit(1);
}

const requestedVersion = input.replace(/^refs\/tags\//, '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(requestedVersion)) {
  console.error(`Invalid semver: ${input}`);
  process.exit(1);
}

const msiCompatible = process.argv.includes('--msi-compatible');
const macosCompatible = process.argv.includes('--macos-compatible');
if (msiCompatible && macosCompatible) {
  console.error('--msi-compatible and --macos-compatible are mutually exclusive');
  process.exit(1);
}

const packageVersion = msiCompatible
  ? toMsiCompatibleVersion(requestedVersion)
  : requestedVersion;
const tauriVersion = macosCompatible ? toAppleBundleVersion(requestedVersion) : packageVersion;

function toMsiCompatibleVersion(value) {
  const match = value.match(/^(\d+\.\d+\.\d+)(?:-([^+]+))?(?:\+.+)?$/);
  if (!match) return value;

  const [, base, prerelease] = match;
  if (!prerelease) return base;

  const numericId = prerelease.split('.').findLast((part) => /^\d+$/.test(part));
  if (!numericId) {
    console.error(`MSI prerelease version requires a numeric identifier: ${value}`);
    process.exit(1);
  }

  const numeric = Number.parseInt(numericId, 10);
  if (numeric > 65535) {
    console.error(`MSI prerelease identifier must be <= 65535: ${numericId}`);
    process.exit(1);
  }

  return `${base}-${numeric}`;
}

function toAppleBundleVersion(value) {
  const match = value.match(/^(\d+\.\d+\.\d+)(?:[-+].*)?$/);
  if (!match) return value;
  return match[1];
}

const jsonFiles = [
  ['package.json', packageVersion],
  ['apps/desktop/package.json', packageVersion],
  ['apps/mobile/package.json', packageVersion],
  ['apps/desktop/src-tauri/tauri.conf.json', tauriVersion],
  ['apps/mobile/src-tauri/tauri.conf.json', tauriVersion],
];

for (const [path, version] of jsonFiles) {
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
    `$1"${packageVersion}"`,
  );
  writeFileSync(path, next);
}

if (macosCompatible && tauriVersion !== packageVersion) {
  console.log(
    `Synced package versions to ${packageVersion}; Tauri bundle versions to ${tauriVersion}`,
  );
} else {
  console.log(`Synced app versions to ${packageVersion}`);
}
