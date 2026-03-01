import { promises as fs } from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { mdToPdf } from 'md-to-pdf';

export function registerReportCommand(program) {
  program
    .command('report')
    .description('Generate markdown/pdf comparison report')
    .requiredOption('--from <name>', 'Source measure name (e.g. as-is)')
    .requiredOption('--to <name>', 'Target measure name (e.g. to-be)')
    .option('--format <types>', 'Output formats (comma separated)', 'md,pdf')
    .action(async (options) => {
      try {
        const fromPath = path.resolve('results', `${options.from}.json`);
        const toPath = path.resolve('results', `${options.to}.json`);

        const [fromResult, toResult] = await Promise.all([
          readJsonFile(fromPath),
          readJsonFile(toPath),
        ]);

        const markdown = buildReportMarkdown({
          fromName: options.from,
          toName: options.to,
          fromResult,
          toResult,
        });

        const reportsDir = path.resolve('reports');
        await fs.mkdir(reportsDir, { recursive: true });

        const baseName = `${options.from}-${options.to}`;
        const mdPath = path.join(reportsDir, `${baseName}.md`);
        await fs.writeFile(mdPath, markdown, 'utf8');
        console.log(chalk.green(`Markdown report saved: ${mdPath}`));

        const formats = parseFormats(options.format);
        if (formats.has('pdf')) {
          const pdfPath = path.join(reportsDir, `${baseName}.pdf`);
          const pdfResult = await mdToPdf({ path: mdPath }, { dest: pdfPath });
          if (!pdfResult?.filename) {
            throw new Error('PDF conversion failed.');
          }
          console.log(chalk.green(`PDF report saved: ${pdfPath}`));
        }
      } catch (error) {
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
      }
    });
}

function buildReportMarkdown({ fromName, toName, fromResult, toResult }) {
  const asIsWeb = fromResult?.web ?? toResult?.asIs?.web ?? null;
  const asIsRn = fromResult?.rn ?? toResult?.asIs?.rn ?? null;
  const toBeWeb = toResult?.estimatedMetrics?.web ?? toResult?.web ?? toResult?.toBe?.web ?? null;
  const toBeRn = toResult?.estimatedMetrics?.rn ?? toResult?.rn ?? toResult?.toBe?.rn ?? null;

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

  const plan = Array.isArray(toResult?.plan) ? toResult.plan : [];
  const risks = Array.isArray(toResult?.risks) ? toResult.risks : [];
  const patches = Array.isArray(toResult?.patches) ? toResult.patches : [];

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
    '⚠️ to-be 수치는 AI 추정치이며 실측값이 아닙니다',
    '',
    `- as-is source: results/${fromName}.json`,
    `- to-be source: results/${toName}.json`,
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
  ].join('\n');
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
