import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import ora from 'ora';
import { z } from 'zod';
import { collectPatchProjectContext, collectPlanProjectContext } from '../utils/context.js';
import { runPatchApplyLoop } from '../utils/patch.js';
import {
  buildVersionedResultTarget,
  resolveProjectName,
  resolveResultJsonFile,
} from '../utils/naming.js';

const MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

const OptimizeResponseSchema = z.object({
  plan: z.array(
    z.object({
      title: z.string().min(1),
      rationale: z.string().min(1),
      targetMetrics: z.array(z.string().min(1)).min(1),
      targetFiles: z.array(z.string()),
    }),
  ),
  patches: z.array(
    z.object({
      file: z.string().min(1),
      diff: z.string().min(1),
    }),
  ),
  risks: z.array(z.string()),
  estimatedMetrics: z.object({
    web: z.object({
      performanceScore: z.number().nullable(),
      lcpMs: z.number().nullable(),
      interactionMs: z.number().nullable(),
      cls: z.number().nullable(),
    }).nullable(),
    rn: z.object({
      jsBundleSize: z.number().nullable(),
      assetsSize: z.number().nullable(),
    }).nullable(),
  }),
});

export function registerOptimizeCommand(program) {
  program
    .command('optimize')
    .description('Generate AI optimization plan and patches')
    .requiredOption('--from <name>', 'Baseline measure name (e.g. as-is)')
    .requiredOption('--name <name>', 'Target result name (e.g. to-be)')
    .requiredOption('--prompt <text>', 'Optimization prompt')
    .option('--project <name>', 'Project name for versioned result files')
    .option('--source <path>', 'Project source root path (default: process.cwd())')
    .option('--apply', 'Apply generated patches and run build loop automatically')
    .option('--yes', 'Apply non-interactive defaults')
    .action(async (options) => {
      const spinner = ora('Preparing optimize workflow...').start();

      try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
          throw new Error('GEMINI_API_KEY is not set.');
        }

        const resultsDir = path.resolve('results');
        const projectName = await resolveProjectName(options.project);
        const fromTarget = await resolveResultJsonFile({
          resultsDir,
          inputName: options.from,
          projectName,
        });
        const baseline = await readJsonFile(fromTarget.filePath);
        const outputTarget = await buildVersionedResultTarget({
          resultsDir,
          projectName,
          resultName: options.name,
        });
        spinner.text = 'Collecting plan context...';
        const planContextResult = await collectPlanProjectContext(options.source);
        if (planContextResult.warning) {
          spinner.warn(chalk.yellow(planContextResult.warning));
          spinner.start('Preparing optimize workflow...');
        }

        spinner.text = 'Generating optimization plan...';
        let planResult;
        try {
          const planPayload = await requestOptimizeJson(apiKey, {
            mode: 'plan',
            userPrompt: options.prompt,
            fromName: fromTarget.baseName,
            baseline,
            projectContext: planContextResult.projectContext,
          });
          planResult = OptimizeResponseSchema.parse(planPayload);
        } catch (error) {
          await saveRawResponseIfExists(resultsDir, options.name, error);
          throw error;
        }

        spinner.stop();
        printPlan(planResult.plan, planResult.risks);

        const shouldGeneratePatches = options.apply
          ? true
          : options.yes
            ? true
            : await askForPatchApproval();

        let finalPatches = [];
        let finalRisks = planResult.risks;
        let finalEstimatedMetrics = planResult.estimatedMetrics;
        let patchFileNames = [];

        if (shouldGeneratePatches) {
          const targetFiles = extractTargetFilesFromPlan(planResult.plan);
          spinner.start('Collecting patch context...');
          const patchContextResult = await collectPatchProjectContext(options.source, targetFiles);
          if (patchContextResult.warning) {
            spinner.warn(chalk.yellow(patchContextResult.warning));
            spinner.start('Generating patch suggestions...');
          } else {
            spinner.start('Generating patch suggestions...');
          }

          let patchPayload;
          try {
            patchPayload = await requestOptimizeJson(apiKey, {
              mode: 'patch',
              userPrompt: options.prompt,
              fromName: fromTarget.baseName,
              baseline,
              plan: planResult.plan,
              projectContext: patchContextResult.projectContext,
            });
          } catch (error) {
            await saveRawResponseIfExists(resultsDir, options.name, error);
            throw error;
          }

          const patchResult = OptimizeResponseSchema.parse(patchPayload);
          finalPatches = patchResult.patches;
          finalRisks = uniqueStrings([...planResult.risks, ...patchResult.risks]);
          finalEstimatedMetrics = patchResult.estimatedMetrics ?? planResult.estimatedMetrics;

          await fs.mkdir(outputTarget.patchesDir, { recursive: true });
          patchFileNames = await savePatchFiles(outputTarget.patchesDir, finalPatches);
          spinner.succeed(`Patch files saved: ${outputTarget.patchesDir}`);

          if (options.apply) {
            spinner.start(`Applying patches in ${patchContextResult.sourceRoot}...`);
            const applyResult = await runPatchApplyLoop({
              sourceRoot: patchContextResult.sourceRoot,
              patchesDir: outputTarget.patchesDir,
              patchFileNames,
              tooLargeFiles: patchContextResult.tooLargeFiles,
            });

            if (!applyResult.ok) {
              const failReportPath = path.resolve(resultsDir, `${options.name}-fail-report.json`);
              const failReport = {
                failedPatchFile: applyResult.failedPatchFile,
                errorMessage: applyResult.errorMessage,
                rolledBack: applyResult.rolledBack,
                skippedPatchFiles: applyResult.skippedPatchFiles,
                failedAt: new Date().toISOString(),
              };
              await fs.writeFile(failReportPath, JSON.stringify(failReport, null, 2), 'utf8');
              if (applyResult.skippedPatchFiles.length > 0) {
                console.log(chalk.yellow(`[Skipped patches] ${applyResult.skippedPatchFiles.join(', ')}`));
              }
              spinner.fail(`Patch apply/build failed. Fail report saved: ${failReportPath}`);
              throw new Error(applyResult.errorMessage ?? 'Patch apply/build failed.');
            }

            spinner.succeed('✅ Build succeeded');
            if (applyResult.skippedPatchFiles.length > 0) {
              console.log(chalk.yellow(`[Skipped patches] ${applyResult.skippedPatchFiles.join(', ')}`));
            }
          }
        } else {
          spinner.info('Patch generation skipped by user choice.');
        }

        const outputJson = {
          name: options.name,
          project: projectName,
          fileName: outputTarget.fileName,
          from: fromTarget.baseName,
          fromFileName: fromTarget.fileName,
          createdAt: new Date().toISOString(),
          prompt: options.prompt,
          asIs: {
            web: baseline.web,
            rn: baseline.rn,
          },
          plan: planResult.plan,
          risks: finalRisks,
          estimatedMetrics: finalEstimatedMetrics,
        };

        if (finalPatches.length > 0) {
          outputJson.patches = finalPatches.map((patch, index) => {
            const patchFile = patchFileNames[index] ?? `patch-${String(index + 1).padStart(3, '0')}.diff`;
            return {
              index: index + 1,
              file: patch.file,
              patchFile,
            };
          });
        }

        await fs.mkdir(path.dirname(outputTarget.filePath), { recursive: true });
        await fs.writeFile(outputTarget.filePath, JSON.stringify(outputJson, null, 2), 'utf8');

        console.log(chalk.green(`Saved optimize result: ${outputTarget.filePath}`));
      } catch (error) {
        spinner.fail('Optimize failed');
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exitCode = 1;
      }
    });
}

async function requestOptimizeJson(apiKey, params) {
  const systemPrompt = [
    'You are an expert frontend performance optimization assistant.',
    '반드시 JSON만 응답, 마크다운 코드블록 없이 순수 JSON.',
    'Output must match this exact schema:',
    '{"plan":[{"title":"string","rationale":"string","targetMetrics":["string"],"targetFiles":["string"]}],"patches":[{"file":"string","diff":"string"}],"risks":["string"],"estimatedMetrics":{"web":{"performanceScore":"number|null","lcpMs":"number|null","interactionMs":"number|null","cls":"number|null"},"rn":{"jsBundleSize":"number|null","assetsSize":"number|null"}}}',
  ].join('\n');

  const modeInstruction =
    params.mode === 'plan'
      ? 'PLAN MODE: Provide plan and risks only. Set patches to an empty array ([]). Every plan item must include targetFiles with concrete file paths.'
      : 'PATCH MODE: Generate concrete unified-diff patches based on the given plan and provided target files context. Fill patches array.';

  const message = {
    mode: params.mode,
    userGoal: params.userPrompt,
    sourceResultName: params.fromName,
    baselineMetrics: {
      web: params.baseline.web ?? null,
      rn: params.baseline.rn ?? null,
    },
    projectContext: params.projectContext ?? {
      rootDir: '',
      framework: 'unknown',
      files: [],
    },
    existingPlan: params.plan ?? null,
    rules: [
      modeInstruction,
      'Keep output valid JSON object only.',
      'Do not include explanations outside JSON.',
      'targetMetrics should reference measurable metrics like LCP/INP/TBT/CLS/Score/BundleSize/AssetsSize.',
      'targetFiles should be concrete paths under src/, like src/App.tsx.',
      'Every plan item MUST include at least one targetFiles entry.',
      'If no specific file can be identified for a plan item, omit that plan item entirely.',
      'Never return an empty targetFiles array.',
      'Patch diffs must be unified diff format when patches are present.',
      'Always include estimatedMetrics in the response JSON.',
    ],
  };

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let lastRawText = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `${systemPrompt}\n\nINPUT_JSON:\n${JSON.stringify(message)}`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API request failed (${response.status}): ${errorText}`);
    }

    const payload = await response.json();
    const rawText =
      payload?.candidates?.[0]?.content?.parts
        ?.map((part) => part?.text ?? '')
        .join('')
        .trim() ?? '';

    if (!rawText) {
      throw new Error('Gemini returned an empty response.');
    }
    lastRawText = rawText;

    try {
      return parseJsonResponse(rawText);
    } catch (error) {
      if (attempt === 2) {
        throw new JsonParseResponseError(
          error instanceof Error ? error.message : 'Gemini response is not valid JSON.',
          rawText,
        );
      }
    }
  }

  throw new JsonParseResponseError('Gemini response is not valid JSON.', lastRawText);
}

class JsonParseResponseError extends Error {
  constructor(message, rawText) {
    super(message);
    this.name = 'JsonParseResponseError';
    this.rawText = rawText;
  }
}

async function saveRawResponseIfExists(resultsDir, resultName, error) {
  if (!(error instanceof JsonParseResponseError)) {
    return;
  }
  if (!error.rawText) {
    return;
  }

  const rawPath = path.resolve(resultsDir, `${resultName}-raw-response.txt`);
  await fs.writeFile(rawPath, error.rawText, 'utf8');
}

function extractTargetFilesFromPlan(plan) {
  const files = [];
  for (const item of plan) {
    for (const file of item.targetFiles ?? []) {
      files.push(file);
    }
  }
  return uniqueStrings(files);
}

function parseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      throw new Error('Gemini response is not valid JSON.');
    }
  }
}

async function readJsonFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Baseline result not found: ${filePath}`);
    }
    throw new Error(`Failed to read JSON file: ${filePath}`);
  }
}

function printPlan(plan, risks) {
  console.log(chalk.cyan('\n[Optimization Plan]'));
  if (plan.length === 0) {
    console.log('- No plan items returned.');
  }

  for (const [index, item] of plan.entries()) {
    console.log(`${index + 1}. ${item.title}`);
    console.log(`   rationale: ${item.rationale}`);
    console.log(`   targetMetrics: ${item.targetMetrics.join(', ')}`);
    console.log(`   targetFiles: ${(item.targetFiles ?? []).join(', ')}`);
  }

  if (risks.length > 0) {
    console.log(chalk.yellow('\n[Risks]'));
    for (const risk of risks) {
      console.log(`- ${risk}`);
    }
  }

  console.log('');
}

async function askForPatchApproval() {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question('Generate patch files now? [y/N] ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function savePatchFiles(patchesDir, patches) {
  const fileNames = [];

  for (const [index, patch] of patches.entries()) {
    const fileName = `patch-${String(index + 1).padStart(3, '0')}.diff`;
    const header = `# file: ${patch.file}\n`;
    await fs.writeFile(path.join(patchesDir, fileName), `${header}${patch.diff}\n`, 'utf8');
    fileNames.push(fileName);
  }

  return fileNames;
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
