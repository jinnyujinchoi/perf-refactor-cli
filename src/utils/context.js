import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_TOTAL_BYTES = 100 * 1024;
const MAX_FILES_WHEN_OVERSIZE = 20;
const ALLOWED_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.css', '.html']);

export async function collectProjectContext(sourceOption) {
  const sourceRoot = path.resolve(sourceOption ?? process.cwd());
  const srcDir = path.join(sourceRoot, 'src');
  const rootDir = path.basename(sourceRoot);

  const framework = await detectFramework(sourceRoot);
  const filesWithSize = await collectSourceFiles(srcDir);

  let files = filesWithSize;
  let warning = null;

  const totalBytes = filesWithSize.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    files = [...filesWithSize]
      .sort((a, b) => b.size - a.size)
      .slice(0, MAX_FILES_WHEN_OVERSIZE);
    warning =
      `Project context exceeded 100KB (${totalBytes} bytes). ` +
      `Only top ${MAX_FILES_WHEN_OVERSIZE} files by size were included.`;
  }

  return {
    sourceRoot,
    projectContext: {
      rootDir,
      framework,
      files: files.map((file) => ({
        path: file.relativePath,
        content: file.content,
      })),
    },
    warning,
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

async function directoryExists(dirPath) {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
