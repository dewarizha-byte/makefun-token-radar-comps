// A working token-radar-01 entry (Node 22, standard library only) — comps-radar-2.
//
// Pipeline, in order:
//   1. Resolve the sealed snapshot (/input/snapshot.json, or --input <file|dir>) and the output
//      directory (--output <dir>, or MAKEFUN_OUTPUT_DIR, or /output).
//   2. Score every pre-token protocol with the comps model in lib/model.ts.
//   3. Validate the board's own output shape (positive implied values, non-empty farm plans)
//      and run the gate's boardIssue checks.
//   4. Write board.json and data.js, copy dashboard/ and screenshots/, write dossier.json last.
//
// The dashboard is a static page, no framework and no network: dashboard/index.html,
// dashboard/app.css and dashboard/app.js read /output/data.js, which this program writes
// from the same board.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

// ---------------------------------------------------------------------------
// Section 1: arguments — the scorer's caps and the CLI's two options.
// ---------------------------------------------------------------------------

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`comps radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

// ---------------------------------------------------------------------------
// Section 2: run the model, then validate its output before anything is written.
// ---------------------------------------------------------------------------

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);

// Validation pass: before anything is written, assert the model's own output shape — every row
// must carry a positive, finite implied_value_usd and a non-empty farm plan. The gate (boardIssue)
// checks ranking invariants and byte limits; this pass catches a structurally broken row (e.g. a
// zero/NaN implied value or an empty farm_steps array) earlier and with a clearer message, so a
// bad snapshot figure fails fast here instead of surfacing as a corrupt board or dashboard later.
{
  let bad = 0;
  for (const row of board) {
    const issues: string[] = [];
    if (typeof row.implied_value_usd !== 'number' || !Number.isFinite(row.implied_value_usd) || row.implied_value_usd <= 0) {
      issues.push(`implied_value_usd=${row.implied_value_usd}`);
    }
    if (!Array.isArray(row.farm_steps) || row.farm_steps.length === 0) {
      issues.push(`farm_steps=${JSON.stringify(row.farm_steps)}`);
    }
    if (issues.length > 0) {
      process.stderr.write(`comps radar: ${row.slug}: ${issues.join('; ')}\n`);
      bad += 1;
    }
  }
  if (bad > 0) {
    process.stderr.write(`comps radar: validation failed on ${bad} of ${board.length} rows\n`);
    process.exit(1);
  }
  const lowRisk = board.filter((r) => r.risk === 'low').length;
  process.stdout.write(
    `comps radar: validation ok — ${board.length} rows, all with a positive implied_value_usd and ${board.reduce((n, r) => n + r.farm_steps.length, 0)} farm steps ` +
      `(risk: ${lowRisk} low / ${board.length - lowRisk} medium+high)\n`,
  );
}

// The gate's own checks: coverage of the watchlist, rank order, and byte/step limits.
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`comps radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Section 3: write the output — board, data.js, dashboard, screenshots, dossier.
// ---------------------------------------------------------------------------

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`comps radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`comps radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

// ---------------------------------------------------------------------------
// Section 4: the run's summary on stdout.
// ---------------------------------------------------------------------------

process.stdout.write(
  `comps radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `comps radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (3 files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
