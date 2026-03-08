import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export async function resolveProjectName(projectOption, cwd = process.cwd()) {
  const explicit = sanitizeSegment(projectOption);
  if (explicit) {
    return explicit;
  }

  const detected = sanitizeSegment(path.basename(cwd));
  if (detected) {
    return detected;
  }

  if (!input.isTTY || !output.isTTY) {
    throw new Error('Failed to detect project name. Provide --project <name>.');
  }

  const rl = createInterface({ input, output });
  try {
    const answer = sanitizeSegment(await rl.question('Project name: '));
    if (!answer) {
      throw new Error('Project name is required.');
    }
    return answer;
  } finally {
    rl.close();
  }
}

export async function buildVersionedResultTarget({
  resultsDir,
  projectName,
  resultName,
  now = new Date(),
}) {
  const safeProject = sanitizeSegment(projectName);
  const safeResult = sanitizeSegment(resultName);
  if (!safeProject) {
    throw new Error('Project name is required.');
  }
  if (!safeResult) {
    throw new Error('Result name is required.');
  }

  const dateStamp = formatDateStamp(now);
  const nextVersion = await getNextVersion(resultsDir, safeProject, safeResult, dateStamp);
  const baseName = `${safeProject}_${safeResult}_${dateStamp}_v.${nextVersion}`;

  return {
    projectName: safeProject,
    resultName: safeResult,
    dateStamp,
    version: nextVersion,
    baseName,
    fileName: `${baseName}.json`,
    filePath: path.join(resultsDir, `${baseName}.json`),
    patchesDir: path.join(resultsDir, `${baseName}-patches`),
  };
}

export async function buildVersionedReportTarget({
  reportsDir,
  fromBaseName,
  toBaseName,
  now = new Date(),
}) {
  const safeFrom = sanitizeSegment(fromBaseName);
  const safeTo = sanitizeSegment(toBaseName);
  if (!safeFrom || !safeTo) {
    throw new Error('Report source names are required.');
  }

  const reportStem = `${safeFrom}--${safeTo}`;
  const dateStamp = formatDateStamp(now);
  const nextVersion = await getNextReportVersion(reportsDir, reportStem, dateStamp);
  const baseName = `${reportStem}_${dateStamp}_v.${nextVersion}`;

  return {
    reportStem,
    dateStamp,
    version: nextVersion,
    baseName,
    mdPath: path.join(reportsDir, `${baseName}.md`),
    pdfPath: path.join(reportsDir, `${baseName}.pdf`),
  };
}

export async function resolveResultJsonFile({ resultsDir, inputName, projectName }) {
  const rawInput = String(inputName ?? '').trim();
  if (!rawInput) {
    throw new Error('Result name is required.');
  }

  if (rawInput.endsWith('.json')) {
    const directPath = path.join(resultsDir, rawInput);
    if (await isFile(directPath)) {
      const fileName = path.basename(directPath);
      return { filePath: directPath, fileName, baseName: stripJsonExtension(fileName) };
    }
    throw new Error(`Result file not found: ${rawInput}`);
  }

  const safeProject = sanitizeSegment(projectName);
  const safeResult = sanitizeSegment(rawInput);

  if (safeProject && safeResult) {
    const versionedFileName = await findLatestVersionedFile(resultsDir, safeProject, safeResult);
    if (versionedFileName) {
      return {
        filePath: path.join(resultsDir, versionedFileName),
        fileName: versionedFileName,
        baseName: stripJsonExtension(versionedFileName),
      };
    }
  }

  for (const candidate of [`${rawInput}.json`, rawInput]) {
    const candidatePath = path.join(resultsDir, candidate);
    if (await isFile(candidatePath)) {
      const fileName = path.basename(candidatePath);
      return { filePath: candidatePath, fileName, baseName: stripJsonExtension(fileName) };
    }
  }

  if (!safeProject || !safeResult) {
    throw new Error(`Result file not found: ${rawInput}`);
  }

  throw new Error(
    `Result file not found for project="${safeProject}", result="${safeResult}" in ${resultsDir}`,
  );
}

function formatDateStamp(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}_${mm}_${dd}`;
}

async function getNextVersion(resultsDir, projectName, resultName, dateStamp) {
  await fs.mkdir(resultsDir, { recursive: true });
  const entries = await fs.readdir(resultsDir, { withFileTypes: true });
  const prefix = `${projectName}_${resultName}_${dateStamp}_v.`;
  let maxVersion = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.json')) {
      continue;
    }
    const match = entry.name.match(/_v\.(\d+)\.json$/);
    if (!match) {
      continue;
    }
    const version = Number.parseInt(match[1], 10);
    if (Number.isFinite(version) && version > maxVersion) {
      maxVersion = version;
    }
  }

  return maxVersion + 1;
}

async function findLatestVersionedFile(resultsDir, projectName, resultName) {
  const entries = await fs.readdir(resultsDir, { withFileTypes: true });
  const pattern = new RegExp(
    `^${escapeRegex(projectName)}_${escapeRegex(resultName)}_(\\d{4}_\\d{2}_\\d{2})_v\\.(\\d+)\\.json$`,
  );

  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const match = entry.name.match(pattern);
    if (!match) {
      continue;
    }
    matches.push({
      fileName: entry.name,
      dateStamp: match[1],
      version: Number.parseInt(match[2], 10),
    });
  }

  matches.sort((a, b) => {
    if (a.dateStamp !== b.dateStamp) {
      return a.dateStamp.localeCompare(b.dateStamp);
    }
    return a.version - b.version;
  });

  return matches.at(-1)?.fileName ?? null;
}

async function getNextReportVersion(reportsDir, reportStem, dateStamp) {
  await fs.mkdir(reportsDir, { recursive: true });
  const entries = await fs.readdir(reportsDir, { withFileTypes: true });
  const pattern = new RegExp(
    `^${escapeRegex(reportStem)}_${escapeRegex(dateStamp)}_v\\.(\\d+)\\.(md|pdf)$`,
    'i',
  );

  let maxVersion = 0;
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const match = entry.name.match(pattern);
    if (!match) {
      continue;
    }
    const version = Number.parseInt(match[1], 10);
    if (Number.isFinite(version) && version > maxVersion) {
      maxVersion = version;
    }
  }

  return maxVersion + 1;
}

function stripJsonExtension(fileName) {
  return fileName.endsWith('.json') ? fileName.slice(0, -5) : fileName;
}

function sanitizeSegment(value) {
  return String(value ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-');
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function isFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}
