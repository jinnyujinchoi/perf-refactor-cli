import { promises as fs } from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { mdToPdf } from 'md-to-pdf';
import {
  buildVersionedReportTarget,
  resolveProjectName,
  resolveResultJsonFile,
} from '../utils/naming.js';

export function registerReportCommand(program) {
  program
    .command('report')
    .description('Generate markdown/pdf comparison report')
    .requiredOption('--from <name>', 'Source measure name (e.g. as-is)')
    .requiredOption('--to <name>', 'Target measure name (e.g. to-be)')
    .option('--optimize <name>', 'Optimize result name to source plan/risks/patches')
    .option('--project <name>', 'Project name for resolving result files')
    .option('--format <types>', 'Output formats (comma separated)', 'md,pdf')
    .action(async (options) => {
      try {
        const resultsDir = path.resolve('results');
        const projectName = await resolveProjectName(options.project);
        const fromTarget = await resolveResultJsonFile({
          resultsDir,
          inputName: options.from,
          projectName,
        });
        const toTarget = await resolveResultJsonFile({
          resultsDir,
          inputName: options.to,
          projectName,
        });
        const optimizeTarget = options.optimize
          ? await resolveResultJsonFile({
              resultsDir,
              inputName: options.optimize,
              projectName,
            })
          : null;

        const [fromResult, toResult, optimizeResult] = await Promise.all([
          readJsonFile(fromTarget.filePath),
          readJsonFile(toTarget.filePath),
          optimizeTarget ? readJsonFile(optimizeTarget.filePath) : Promise.resolve(null),
        ]);

        const markdown = buildReportMarkdown({
          fromName: fromTarget.baseName,
          toName: toTarget.baseName,
          fromFileName: fromTarget.fileName,
          toFileName: toTarget.fileName,
          fromResult,
          toResult,
          optimizeFileName: optimizeTarget?.fileName ?? null,
          optimizeResult,
        });

        const reportsDir = path.resolve('reports');
        const reportTarget = await buildVersionedReportTarget({
          reportsDir,
          fromBaseName: fromTarget.baseName,
          toBaseName: toTarget.baseName,
        });
        await fs.writeFile(reportTarget.mdPath, markdown, 'utf8');
        console.log(chalk.green(`Markdown report saved: ${reportTarget.mdPath}`));

        const formats = parseFormats(options.format);
        if (formats.has('pdf')) {
          const pdfResult = await mdToPdf({ path: reportTarget.mdPath }, { dest: reportTarget.pdfPath });
          if (!pdfResult?.filename) {
            throw new Error('PDF conversion failed.');
          }
          console.log(chalk.green(`PDF report saved: ${reportTarget.pdfPath}`));
        }
      } catch (error) {
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
      }
    });
}

function buildReportMarkdown({
  fromName,
  toName,
  fromFileName,
  toFileName,
  fromResult,
  toResult,
  optimizeFileName,
  optimizeResult,
}) {
  const toBeNotice = resolveToBeNotice(toResult);
  const asIsWeb = fromResult?.web ?? toResult?.asIs?.web ?? null;
  const asIsRn = fromResult?.rn ?? toResult?.asIs?.rn ?? null;
  const toBeWeb = toResult?.estimatedMetrics?.web ?? toResult?.web ?? toResult?.toBe?.web ?? null;
  const toBeRn = toResult?.estimatedMetrics?.rn ?? toResult?.rn ?? toResult?.toBe?.rn ?? null;
  const planSource = optimizeResult ?? toResult;

  const metricRows = [];

  metricRows.push(
    buildMetricRow('Web', 'Performance Score', asIsWeb?.performanceScore, toBeWeb?.performanceScore, false),
  );
  metricRows.push(buildMetricRow('Web', 'LCP (ms)', asIsWeb?.lcpMs, toBeWeb?.lcpMs, true));

  const interactionLabel = `Interaction (${asIsWeb?.interactionMetric ?? toBeWeb?.interactionMetric ?? 'INP/TBT'}) (ms)`;
  metricRows.push(
    buildMetricRow('Web', interactionLabel, asIsWeb?.interactionMs, toBeWeb?.interactionMs, true),
  );

  metricRows.push(buildMetricRow('Web', 'CLS', asIsWeb?.cls, toBeWeb?.cls, true));

  metricRows.push(
    buildMetricRow(
      'RN',
      'JS Bundle (MB)',
      pickMetricNumber(asIsRn?.jsBundleSize),
      pickMetricNumber(toBeRn?.jsBundleSize),
      true,
    ),
  );
  metricRows.push(
    buildMetricRow(
      'RN',
      'Assets (MB)',
      pickMetricNumber(asIsRn?.assetsSize),
      pickMetricNumber(toBeRn?.assetsSize),
      true,
    ),
  );

  const filteredRows = metricRows.filter((row) => row !== null);

  const tableLines = [
    '| Target | Metric | as-is | to-be | Δ |',
    '| --- | --- | ---: | ---: | ---: |',
    ...filteredRows.map(
      (row) =>
        `| ${row.target} | ${row.metric} | ${row.asIs} | ${row.toBe} | ${row.delta} |`,
    ),
  ];

  const plan = Array.isArray(planSource?.plan) ? planSource.plan : [];
  const risks = Array.isArray(planSource?.risks) ? planSource.risks : [];
  const patches = Array.isArray(planSource?.patches) ? planSource.patches : [];

  const planLines =
    plan.length === 0
      ? ['- 없음']
      : plan.map((item, index) => {
          const metrics = Array.isArray(item.targetMetrics) ? item.targetMetrics.join(', ') : '-';
          return `${index + 1}. **${escapeMd(item.title)}**\n   - rationale: ${escapeMd(item.rationale)}\n   - targetMetrics: ${escapeMd(metrics)}`;
        });

  const riskLines = risks.length === 0 ? ['- 없음'] : risks.map((risk) => `- ${escapeMd(risk)}`);

  const patchLines =
    patches.length === 0
      ? ['- 없음']
      : patches.map((patch, index) => {
          const file = patch.file ?? '-';
          const patchFile = patch.patchFile ?? patch.diffFile ?? '-';
          const idx = patch.index ?? index + 1;
          return `- #${idx} | file: ${escapeMd(file)} | patch: ${escapeMd(patchFile)}`;
        });

  const asIsCreated = fromResult?.createdAt ?? '-';
  const toBeCreated = toResult?.createdAt ?? '-';

  return [
    `# Perf Report: ${fromName} -> ${toName}`,
    '',
    toBeNotice,
    '',
    `- as-is source: results/${fromFileName}`,
    `- to-be source: results/${toFileName}`,
    optimizeFileName ? `- optimize source: results/${optimizeFileName}` : null,
    `- as-is createdAt: ${asIsCreated}`,
    `- to-be createdAt: ${toBeCreated}`,
    '',
    '## Metrics Comparison',
    '',
    ...tableLines,
    '',
    '## Plan',
    '',
    ...planLines,
    '',
    '## Risks',
    '',
    ...riskLines,
    '',
    '## Patches',
    '',
    ...patchLines,
    '',
  ].filter(Boolean).join('\n');
}

function resolveToBeNotice(toResult) {
  const hasEstimatedMetrics =
    toResult &&
    typeof toResult === 'object' &&
    Object.prototype.hasOwnProperty.call(toResult, 'estimatedMetrics');

  if (hasEstimatedMetrics) {
    return '⚠️ to-be 수치는 AI 추정치이며 실측값이 아닙니다';
  }

  const hasMeasuredMetrics = Boolean(toResult?.web || toResult?.rn);
  if (hasMeasuredMetrics) {
    return '✅ to-be 수치는 실제 측정값입니다';
  }

  return '⚠️ to-be 수치는 AI 추정치이며 실측값이 아닙니다';
}

function buildMetricRow(target, metric, asIsRaw, toBeRaw, lowerIsBetter) {
  const hasAny = Number.isFinite(asIsRaw) || Number.isFinite(toBeRaw);
  if (!hasAny) {
    return null;
  }

  const asIs = formatNumber(asIsRaw);
  const toBe = formatNumber(toBeRaw);
  const delta = formatDelta(asIsRaw, toBeRaw, lowerIsBetter);

  return {
    target,
    metric,
    asIs,
    toBe,
    delta,
  };
}

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return '-';
  }
  return String(round(value));
}

function formatDelta(asIs, toBe, lowerIsBetter) {
  if (!Number.isFinite(asIs) || !Number.isFinite(toBe)) {
    return '-';
  }

  const diff = round(toBe - asIs);
  if (diff === 0) {
    return '0';
  }

  const sign = diff > 0 ? '+' : '';
  const absolute = `${sign}${diff}`;

  if (lowerIsBetter) {
    return diff < 0 ? `${absolute} (improved)` : `${absolute} (regressed)`;
  }

  return diff > 0 ? `${absolute} (improved)` : `${absolute} (regressed)`;
}

function round(value) {
  const p = 100;
  return Math.round(value * p) / p;
}

function pickMetricNumber(value) {
  if (Number.isFinite(value)) {
    return value;
  }
  if (value && typeof value === 'object' && Number.isFinite(value.mb)) {
    return value.mb;
  }
  return Number.NaN;
}

function parseFormats(input) {
  return new Set(
    String(input)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function escapeMd(text) {
  return String(text ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
    .trim();
}

async function readJsonFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Result file not found: ${filePath}`);
    }
    throw new Error(`Failed to read JSON file: ${filePath}`);
  }
}
