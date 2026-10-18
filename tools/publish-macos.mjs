#!/usr/bin/env node
import { publishDesktop } from './publish-linux.mjs';

const args = process.argv.slice(2);
try {
  if (args.includes('--help')) {
    console.log('Usage: ./release_macos.sh [--check] [--notes TEXT] [--private-key PATH] [--site PATH]\nBuilds, signs, notarizes, and publishes a macOS DMG to its architecture catalog.');
  } else {
    const options = { platform: 'macos' };
    for (let i = 0; i < args.length; i += 2) {
      if (args[i] === '--check') { options.check = true; i--; continue; }
      const key = { '--app': 'app', '--site': 'site', '--private-key': 'privateKey', '--notes': 'notes' }[args[i]];
      if (!key || !args[i + 1]) throw new Error(`Unknown option or missing value: ${args[i]}`);
      options[key] = args[i + 1];
    }
    for (const key of ['app', 'site', 'privateKey', 'notes']) {
      if (!options[key]) throw new Error(`Missing ${key}; run through release_macos.sh`);
    }
    await publishDesktop(options);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
