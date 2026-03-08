import { promises as fs } from 'node:fs';
import path from 'node:path';

const PLAN_MAX_TOTAL_BYTES = 30 * 1024;
const PLAN_MAX_LINES_PER_FILE = 30;
const PATCH_MAX_LINES_PER_FILE = 500;
const ALLOWED_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.css', '.html']);

export async function collectPlanProjectContext(sourceOption) {
  const sourceRoot = path.resolve(sourceOption ?? process.cwd());
  const srcDir = path.join(sourceRoot, 'src');
  const rootDir = path.basename(sourceRoot);

  const framework = await detectFramework(sourceRoot);
  const filesWithSize = await collectSourceFiles(srcDir);

  let totalBytes = 0;
  const includedFiles = [];
  const excludedFiles = [];

  for (const file of filesWithSize) {
    if (isTestFile(file.relativePath)) {
      continue;
    }

    const summarizedContent = takeFirstLinesVerbatim(file.content, PLAN_MAX_LINES_PER_FILE);
    const summarizedBytes = Buffer.byteLength(summarizedContent, 'utf8');
    if (totalBytes + summarizedBytes > PLAN_MAX_TOTAL_BYTES) {
      excludedFiles.push(file.relativePath);
      continue;
    }

    includedFiles.push({
      path: file.relativePath,
      content: summarizedContent,
    });
    totalBytes += summarizedBytes;
  }

  const warning = excludedFiles.length > 0
    ? `Plan context exceeded 30KB. Excluded ${excludedFiles.length} files.`
    : null;

  return {
    sourceRoot,
    projectContext: {
      rootDir,
      framework,
      files: includedFiles,
    },
    warning,
  };
}

export async function collectPatchProjectContext(sourceOption, targetFiles) {
  const sourceRoot = path.resolve(sourceOption ?? process.cwd());
  const rootDir = path.basename(sourceRoot);
  const framework = await detectFramework(sourceRoot);

  const uniqueTargets = [...new Set((targetFiles ?? []).map((file) => normalizePath(file)).filter(Boolean))];
  const files = [];
  const missingFiles = [];
  const tooLargeFiles = [];

  for (const target of uniqueTargets) {
    const resolved = resolveTargetFile(sourceRoot, target);
    if (!resolved) {
      missingFiles.push(target);
      continue;
    }

    let raw;
    try {
      raw = await fs.readFile(resolved, 'utf8');
    } catch {
      missingFiles.push(target);
      continue;
    }

    const isTruncated = countLines(raw) > PATCH_MAX_LINES_PER_FILE;
    const normalizedPath = normalizePath(path.relative(sourceRoot, resolved));
    const content = isTruncated
      ? '// [file too large: manual apply required]'
      : raw;

    if (isTruncated) {
      tooLargeFiles.push(normalizedPath);
    }

    files.push({
      path: normalizedPath,
      content,
      tooLarge: isTruncated,
    });
  }

  const warning = missingFiles.length > 0
    ? `Patch context skipped ${missingFiles.length} unresolved target files.`
    : null;

  return {
    sourceRoot,
    projectContext: {
      rootDir,
      framework,
      files,
    },
    warning,
    tooLargeFiles,
  };
}

async function detectFramework(sourceRoot) {
  const packagePath = path.join(sourceRoot, 'package.json');
  try {
    const raw = await fs.readFile(packagePath, 'utf8');
    const json = JSON.parse(raw);
    const deps = json?.dependencies && typeof json.dependencies === 'object'
      ? json.dependencies
      : {};

    if ('vite' in deps) {
      return 'vite';
    }
    if ('next' in deps) {
      return 'next';
    }
    if ('react-scripts' in deps) {
      return 'cra';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

async function collectSourceFiles(srcDir) {
  const files = [];
  if (!(await directoryExists(srcDir))) {
    return files;
  }

  const sourceRoot = path.dirname(srcDir);
  await walk(sourceRoot, srcDir, files);
  return files;
}

async function walk(sourceRoot, currentDir, files) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build' || entry.name === '.git') {
      continue;
    }

    const fullPath = path.join(currentDir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      await walk(sourceRoot, fullPath, files);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      continue;
    }

    const content = await fs.readFile(fullPath, 'utf8');
    const size = Buffer.byteLength(content, 'utf8');
    const relativePath = path.relative(sourceRoot, fullPath).replaceAll(path.sep, '/');

    files.push({
      relativePath,
      content,
      size,
    });
  }
}

function resolveTargetFile(sourceRoot, targetPath) {
  const normalizedTarget = normalizePath(targetPath);
  if (!normalizedTarget) {
    return null;
  }

  const relPath = normalizedTarget.startsWith('src/')
    ? normalizedTarget
    : `src/${normalizedTarget.replace(/^\.?\//, '')}`;

  const absolute = path.resolve(sourceRoot, relPath);
  const normalizedAbsolute = normalizePath(absolute);
  const normalizedRoot = `${normalizePath(sourceRoot)}/`;
  if (!normalizedAbsolute.startsWith(normalizedRoot)) {
    return null;
  }

  if (!ALLOWED_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
    return null;
  }
  if (isTestFile(relPath)) {
    return null;
  }

  return absolute;
}

function takeFirstLinesVerbatim(text, maxLines) {
  // Keep file head exactly as-is (including leading comments and blank lines).
  const lines = String(text).split('\n');
  return lines.slice(0, maxLines).join('\n');
}

function countLines(text) {
  return String(text).split('\n').length;
}

function isTestFile(filePath) {
  const normalized = normalizePath(filePath);
  return /(^|\/)[^/]*\.(test|spec)\.[^.]+$/i.test(normalized);
}

function normalizePath(filePath) {
  return String(filePath ?? '').trim().replaceAll('\\', '/');
}

async function directoryExists(dirPath) {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
