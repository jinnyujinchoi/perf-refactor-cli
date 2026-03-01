import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import ora from 'ora';
import chalk from 'chalk';

const LIGHTHOUSE_RUNS = 3;

export function registerMeasureCommand(program) {
  program
    .command('measure')
    .description('Measure Web(Lighthouse) and RN metrics')
    .requiredOption('--name <name>', 'Result name (e.g. as-is)')
    .option('--web <url>', 'Target web URL or local path')
    .option('--rn <path>', 'React Native project path')
    .action(async (options) => {
      if (!options.web && !options.rn) {
        console.error(chalk.red('At least one target is required: use --web <url> and/or --rn <path>.'));
        process.exitCode = 1;
        return;
      }

      const spinner = ora('Starting measurements...').start();

      try {
        const output = {
          name: options.name,
          createdAt: new Date().toISOString(),
        };

        if (options.web) {
          spinner.text = 'Running Lighthouse (3 runs, mobile/simulate)...';
          const webTarget = normalizeWebTarget(options.web);
          output.web = await measureWeb(webTarget);
        }

        if (options.rn) {
          spinner.text = 'Collecting RN metrics (expo export + node_modules scan)...';
          const rnPath = path.resolve(options.rn);
          output.rn = await measureRn(rnPath);
        }

        const resultsDir = path.resolve('results');
        await fs.mkdir(resultsDir, { recursive: true });
        const outputPath = path.join(resultsDir, `${options.name}.json`);
        await fs.writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');

        spinner.succeed(`Measurement complete: ${outputPath}`);
      } catch (error) {
        spinner.fail('Measurement failed');
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
      }
    });
}

async function measureWeb(target) {
  const runs = [];

  for (let i = 0; i < LIGHTHOUSE_RUNS; i += 1) {
    const tmpOutput = path.join(tmpdir(), `lh-${Date.now()}-${i}.json`);

    await runCommand('npx', [
      'lighthouse',
      target,
      '--quiet',
      '--chrome-flags=--headless=new --no-sandbox --disable-gpu',
      '--only-categories=performance',
      '--form-factor=mobile',
      '--throttling-method=simulate',
      '--output=json',
      `--output-path=${tmpOutput}`,
    ]);

    const raw = await fs.readFile(tmpOutput, 'utf8');
    const lhr = JSON.parse(raw);
    await fs.rm(tmpOutput, { force: true });

    runs.push(extractWebRunMetrics(lhr));
  }

  const hasAnyInp = runs.some((run) => Number.isFinite(run.inpMs));
  const interactionValues = runs
    .map((run) => (hasAnyInp ? run.inpMs : run.tbtMs))
    .filter((value) => Number.isFinite(value));

  return {
    config: {
      formFactor: 'mobile',
      throttlingMethod: 'simulate',
      runs: LIGHTHOUSE_RUNS,
      aggregation: 'median',
    },
    performanceScore: round(median(runs.map((run) => run.performanceScore))),
    lcpMs: round(median(runs.map((run) => run.lcpMs))),
    interactionMetric: hasAnyInp ? 'INP' : 'TBT',
    interactionMs: round(median(interactionValues)),
    cls: round(median(runs.map((run) => run.cls)), 4),
    opportunitiesTop5: aggregateOpportunities(runs),
    rawRuns: runs.map((run) => ({
      performanceScore: run.performanceScore,
      lcpMs: run.lcpMs,
      inpMs: run.inpMs,
      tbtMs: run.tbtMs,
      cls: run.cls,
    })),
  };
}

function extractWebRunMetrics(lhr) {
  const perfScore = numberOrNaN(lhr?.categories?.performance?.score) * 100;
  const lcpMs = numberOrNaN(lhr?.audits?.['largest-contentful-paint']?.numericValue);
  const inpMs = numberOrNaN(lhr?.audits?.['interaction-to-next-paint']?.numericValue);
  const tbtMs = numberOrNaN(lhr?.audits?.['total-blocking-time']?.numericValue);
  const cls = numberOrNaN(lhr?.audits?.['cumulative-layout-shift']?.numericValue);

  const opportunities = Object.values(lhr?.audits ?? {})
    .filter((audit) => audit?.details?.type === 'opportunity')
    .map((audit) => ({
      title: audit.title ?? 'Unknown Opportunity',
      savingsMs: finiteOrZero(audit?.details?.overallSavingsMs),
      savingsBytes: finiteOrZero(audit?.details?.overallSavingsBytes),
    }));

  return {
    performanceScore: perfScore,
    lcpMs,
    inpMs,
    tbtMs,
    cls,
    opportunities,
  };
}

function aggregateOpportunities(runs) {
  const grouped = new Map();

  for (const run of runs) {
    for (const item of run.opportunities) {
      if (!grouped.has(item.title)) {
        grouped.set(item.title, { ms: [], bytes: [] });
      }

      const bucket = grouped.get(item.title);
      bucket.ms.push(item.savingsMs);
      bucket.bytes.push(item.savingsBytes);
    }
  }

  return [...grouped.entries()]
    .map(([title, values]) => ({
      title,
      estimatedSavingsMs: round(median(values.ms)),
      estimatedSavingsBytes: Math.round(median(values.bytes)),
    }))
    .sort((a, b) => {
      if (b.estimatedSavingsMs !== a.estimatedSavingsMs) {
        return b.estimatedSavingsMs - a.estimatedSavingsMs;
      }

      return b.estimatedSavingsBytes - a.estimatedSavingsBytes;
    })
    .slice(0, 5);
}

async function measureRn(rnPath) {
  const exportDir = path.join(rnPath, '.perf-refactor-export');
  await fs.rm(exportDir, { recursive: true, force: true });

  await runCommand(
    'npx',
    ['expo', 'export', '--output-dir', exportDir, '--clear'],
    { cwd: rnPath },
  );

  const jsBundleBytes = await sumFilesByPredicate(exportDir, (filePath) =>
    filePath.endsWith('.js') && !filePath.endsWith('.js.map'),
  );

  const assetsBytes = await sumFilesByPredicate(exportDir, (filePath) => {
    const normalized = filePath.replaceAll(path.sep, '/');
    const isAssetPath = normalized.includes('/assets/');
    const isJsOrMap = normalized.endsWith('.js') || normalized.endsWith('.js.map');
    return isAssetPath && !isJsOrMap;
  });

  const nodeModulesPath = path.join(rnPath, 'node_modules');
  const heaviestDependenciesTop5 = await findHeaviestDependencies(nodeModulesPath, 5);

  return {
    exportDir,
    jsBundleSize: {
      bytes: jsBundleBytes,
      mb: toMb(jsBundleBytes),
    },
    assetsSize: {
      bytes: assetsBytes,
      mb: toMb(assetsBytes),
    },
    heaviestDependenciesTop5,
  };
}

async function findHeaviestDependencies(nodeModulesPath, topN) {
  try {
    const entries = await fs.readdir(nodeModulesPath, { withFileTypes: true });
    const candidates = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.bin') {
        continue;
      }

      const entryPath = path.join(nodeModulesPath, entry.name);

      if (entry.name.startsWith('@')) {
        const scoped = await fs.readdir(entryPath, { withFileTypes: true });
        for (const scopedEntry of scoped) {
          if (!scopedEntry.isDirectory()) {
            continue;
          }

          candidates.push({
            name: `${entry.name}/${scopedEntry.name}`,
            dir: path.join(entryPath, scopedEntry.name),
          });
        }
        continue;
      }

      candidates.push({ name: entry.name, dir: entryPath });
    }

    const sizes = [];

    for (const candidate of candidates) {
      const bytes = await getDirectorySize(candidate.dir);
      sizes.push({
        package: candidate.name,
        bytes,
        mb: toMb(bytes),
      });
    }

    return sizes.sort((a, b) => b.bytes - a.bytes).slice(0, topN);
  } catch {
    return [];
  }
}

async function sumFilesByPredicate(rootDir, predicate) {
  const files = await listFilesRecursively(rootDir);
  let total = 0;

  for (const filePath of files) {
    if (!predicate(filePath)) {
      continue;
    }

    const stat = await fs.stat(filePath);
    total += stat.size;
  }

  return total;
}

async function getDirectorySize(dirPath) {
  const stat = await fs.stat(dirPath);
  if (!stat.isDirectory()) {
    return stat.size;
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  let total = 0;

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      total += await getDirectorySize(fullPath);
    } else if (entry.isFile()) {
      const fileStat = await fs.stat(fullPath);
      total += fileStat.size;
    }
  }

  return total;
}

async function listFilesRecursively(rootDir) {
  const result = [];

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        result.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  return result;
}

function normalizeWebTarget(input) {
  if (/^https?:\/\//i.test(input)) {
    return input;
  }

  const resolved = path.resolve(input);
  return `file://${resolved}`;
}

function median(values) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) {
    throw new Error('No numeric values available for median calculation.');
  }

  const mid = Math.floor(nums.length / 2);
  if (nums.length % 2 === 1) {
    return nums[mid];
  }

  return (nums[mid - 1] + nums[mid]) / 2;
}

function toMb(bytes) {
  return round(bytes / (1024 * 1024), 2);
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return value;
  }

  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function finiteOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function numberOrNaN(value) {
  return Number.isFinite(value) ? value : Number.NaN;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      ...options,
    });

    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed (code ${code})\n${stderr.trim()}`));
      }
    });
  });
}
