import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import ora from 'ora';
import { z } from 'zod';

const MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

const OptimizeResponseSchema = z.object({
  plan: z.array(
    z.object({
      title: z.string().min(1),
      rationale: z.string().min(1),
      targetMetrics: z.array(z.string().min(1)).min(1),
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
    .option('--yes', 'Apply non-interactive defaults')
    .action(async (options) => {
      const spinner = ora('Preparing optimize workflow...').start();

      try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
          throw new Error('GEMINI_API_KEY is not set.');
        }

        const fromPath = path.resolve('results', `${options.from}.json`);
        const baseline = await readJsonFile(fromPath);

        spinner.text = 'Generating optimization plan...';
        const planPayload = await requestOptimizeJson(apiKey, {
          mode: 'plan',
          userPrompt: options.prompt,
          fromName: options.from,
          baseline,
        });
        const planResult = OptimizeResponseSchema.parse(planPayload);

        spinner.stop();
        printPlan(planResult.plan, planResult.risks);

        const shouldGeneratePatches = options.yes ? true : await askForPatchApproval();

        let finalPatches = [];
        let finalRisks = planResult.risks;
        let finalEstimatedMetrics = planResult.estimatedMetrics;

        if (shouldGeneratePatches) {
          spinner.start('Generating patch suggestions...');
          const patchPayload = await requestOptimizeJson(apiKey, {
            mode: 'patch',
            userPrompt: options.prompt,
            fromName: options.from,
            baseline,
            plan: planResult.plan,
          });

          const patchResult = OptimizeResponseSchema.parse(patchPayload);
          finalPatches = patchResult.patches;
          finalRisks = uniqueStrings([...planResult.risks, ...patchResult.risks]);
          finalEstimatedMetrics = patchResult.estimatedMetrics ?? planResult.estimatedMetrics;

          const patchesDir = path.resolve('results', `${options.name}-patches`);
          await fs.mkdir(patchesDir, { recursive: true });
          await savePatchFiles(patchesDir, finalPatches);
          spinner.succeed(`Patch files saved: ${patchesDir}`);
        } else {
          spinner.info('Patch generation skipped by user choice.');
        }

        const resultPath = path.resolve('results', `${options.name}.json`);
        const outputJson = {
          name: options.name,
          from: options.from,
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
          outputJson.patches = finalPatches.map((patch, index) => ({
            index: index + 1,
            file: patch.file,
            patchFile: `patch-${String(index + 1).padStart(3, '0')}.diff`,
          }));
        }

        await fs.mkdir(path.dirname(resultPath), { recursive: true });
        await fs.writeFile(resultPath, JSON.stringify(outputJson, null, 2), 'utf8');

        console.log(chalk.green(`Saved optimize result: ${resultPath}`));
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
    '{"plan":[{"title":"string","rationale":"string","targetMetrics":["string"]}],"patches":[{"file":"string","diff":"string"}],"risks":["string"],"estimatedMetrics":{"web":{"performanceScore":"number|null","lcpMs":"number|null","interactionMs":"number|null","cls":"number|null"},"rn":{"jsBundleSize":"number|null","assetsSize":"number|null"}}}',
  ].join('\n');

  const modeInstruction =
    params.mode === 'plan'
      ? 'PLAN MODE: Provide plan and risks only. Set patches to an empty array ([]).'
      : 'PATCH MODE: Generate concrete unified-diff patches based on the given plan. Fill patches array.';

  const message = {
    mode: params.mode,
    userGoal: params.userPrompt,
    sourceResultName: params.fromName,
    baselineMetrics: {
      web: params.baseline.web ?? null,
      rn: params.baseline.rn ?? null,
    },
    existingPlan: params.plan ?? null,
    rules: [
      modeInstruction,
      'Keep output valid JSON object only.',
      'Do not include explanations outside JSON.',
      'targetMetrics should reference measurable metrics like LCP/INP/TBT/CLS/Score/BundleSize/AssetsSize.',
      'Patch diffs must be unified diff format when patches are present.',
      'Always include estimatedMetrics in the response JSON.',
    ],
  };

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;

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

  const parsed = parseJsonResponse(rawText);
  return parsed;
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
  await Promise.all(
    patches.map(async (patch, index) => {
      const fileName = `patch-${String(index + 1).padStart(3, '0')}.diff`;
      const header = `# file: ${patch.file}\n`;
      await fs.writeFile(path.join(patchesDir, fileName), `${header}${patch.diff}\n`, 'utf8');
    }),
  );
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
