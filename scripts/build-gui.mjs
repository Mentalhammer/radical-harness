import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(ROOT, 'dist');
const BUNDLE = join(DIST, 'gui.cjs');
const wantExe = process.argv.includes('--exe');

mkdirSync(DIST, { recursive: true });

await build({
  entryPoints: [join(ROOT, 'src', 'gui', 'server.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: BUNDLE,
  loader: { '.html': 'text' },
  logLevel: 'info',
});

if (!wantExe) {
  console.log(`bundled ${BUNDLE}`);
  process.exit(0);
}

const configPath = join(DIST, 'sea-config.json');
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      main: 'gui.cjs',
      output: 'sea-prep.blob',
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  )}\n`,
);

execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], {
  cwd: DIST,
  stdio: 'inherit',
});

const exePath = join(ROOT, 'RadicalHarness.exe');

// Windows can keep the previous image locked (antivirus scan, a still-closing
// process). Deleting may fail while renaming aside still works, so try both.
function clearPreviousExe() {
  try {
    rmSync(exePath, { force: true, maxRetries: 5, retryDelay: 300 });
    return;
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
  }

  const parked = `${exePath}.old-${Date.now()}`;
  renameSync(exePath, parked);
  try {
    rmSync(parked, { force: true });
  } catch {
    console.warn(`Could not delete ${parked}; remove it manually later.`);
  }
}

clearPreviousExe();
copyFileSync(process.execPath, exePath);

execFileSync(
  process.execPath,
  [
    join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
    exePath,
    'NODE_SEA_BLOB',
    join(DIST, 'sea-prep.blob'),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ],
  { cwd: ROOT, stdio: 'inherit' },
);

rmSync(join(DIST, 'sea-prep.blob'), { force: true });

/**
 * node.exe (and so every SEA copy of it) is a console program, which means a
 * double-click leaves a black terminal window behind the app. Windows picks
 * the window mode from the PE optional header's Subsystem field, so rewrite it
 * from 3 (console) to 2 (GUI). Nothing else in the image changes.
 */
function useGuiSubsystem(exe) {
  const image = readFileSync(exe);
  const peOffset = image.readUInt32LE(0x3c);
  if (image.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error(`${exe} is not a PE image`);
  }
  // Subsystem is at optional-header + 68 for both PE32 and PE32+.
  const subsystem = peOffset + 24 + 68;
  const current = image.readUInt16LE(subsystem);
  if (current === 2) return;
  if (current !== 3) throw new Error(`unexpected PE subsystem ${current} in ${exe}`);
  image.writeUInt16LE(2, subsystem);
  writeFileSync(exe, image);
}

if (process.platform === 'win32') useGuiSubsystem(exePath);
console.log(`packaged ${exePath}`);
