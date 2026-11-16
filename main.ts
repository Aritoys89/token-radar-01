// main.ts — the Token Launch Radar entry (Node 22, standard library only).
//
// Reads the sealed snapshot (at /input/snapshot.json in the grader, or --input <file|dir> locally),
// scores every launch candidate with the model in lib/model.ts, and writes into the output directory:
//   board.json    the ranked board (the gate reads this)
//   data.js       the dashboard's whole dataset, written beside the page it copies in
//   dashboard/    this repository's dashboard, copied
//   screenshots/  this repository's screenshots, copied
//   dossier.json  buildDossier's summary of the dashboard and screenshots, written last
//
// The program is deterministic: it reads no clock, rolls no dice and touches no network, so the two
// runs the grader makes write the same bytes.
//
// Local run:  mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoDir = fileURLToPath(new URL('.', import.meta.url));

/** The dossier's text cap, the one number that shapes its bytes. */
const TEXT_MAX_BYTES = 65_536;
/** Screenshot names the dossier accepts: letters, digits and . _ -, never starting with a dot. */
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Read `--name value` or `--name=value` from the arguments, else the fallback. */
function readArg(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const at = args.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < args.length) return args[at + 1]!;
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

/** Copy every regular file of one flat directory into another, skipping dot names; returns the names. */
function copyFlat(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, join(to, name));
    names.push(name);
  }
  return names.sort();
}

function fail(message: string): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(1);
}

const inputArg = readArg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) fail(`no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input`);
const outputDir = readArg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, data } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) fail(`the model produced a board the gate refuses: ${issue}`);

mkdirSync(outputDir, { recursive: true });
const boardBytes = `${JSON.stringify({ rows: board })}\n`;
if (Buffer.byteLength(boardBytes, 'utf8') > 8 * 1024 * 1024) fail('board.json would exceed 8 MiB');
writeFileSync(join(outputDir, 'board.json'), boardBytes);
writeFileSync(join(outputDir, 'data.js'), dataScript(data));

const dashFiles = copyFlat(join(repoDir, 'dashboard'), join(outputDir, 'dashboard'));
if (!dashFiles.includes('index.html')) fail('dashboard/ holds no index.html');
if (!dashFiles.some((n) => n.endsWith('.css'))) fail('dashboard/ holds no .css file');
if (!dashFiles.some((n) => n.endsWith('.js'))) fail('dashboard/ holds no .js file');

const shots = copyFlat(join(repoDir, 'screenshots'), join(outputDir, 'screenshots'));
if (shots.length < 3 || shots.length > 4) fail(`screenshots/ holds ${shots.length} images: hand in 3 or 4`);
for (const name of shots) if (!IMAGE_NAME.test(name)) fail(`screenshots/${name}: not a name the dossier accepts`);

// The dossier goes last: the scorer rebuilds it from this same output directory and compares bytes.
writeFileSync(join(outputDir, 'dossier.json'), buildDossier(outputDir, { text_max_bytes: TEXT_MAX_BYTES }));

process.stdout.write(
  `token radar: ${data.stats.protocols} protocols (${data.stats.pre_token} record no token, ${data.stats.tokenised} tokenised), ` +
    `${board.length} board rows covering all ${data.stats.watchlist} watchlist slugs, ${data.stats.comparables} comparables\n` +
    `token radar: wrote board.json, data.js, dashboard/ (${dashFiles.length} files), screenshots/ (${shots.length} images), dossier.json into ${outputDir}\n`,
);
