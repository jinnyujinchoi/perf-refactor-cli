import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function runPatchApplyLoop({ sourceRoot, patchesDir, patchFileNames, tooLargeFiles = [] }) {
  await ensureGitClean(sourceRoot);

  let lastAppliedPatchFile = null;
  let shouldRollback = false;
  const skippedPatchFiles = [];
  try {
    const tooLargeSet = new Set(tooLargeFiles.map((file) => normalizePath(file)));

    for (const patchFileName of patchFileNames) {
      const patchFilePath = path.join(patchesDir, patchFileName);
      const patchText = await fs.readFile(patchFilePath, 'utf8');
      const touchesTooLargeFile = patchTouchesTooLargeFile(patchText, tooLargeSet);
      if (touchesTooLargeFile) {
        console.log(`⚠ ${patchFileName} skipped: 대상 파일이 500줄 초과입니다. 수동으로 적용해주세요.`);
        skippedPatchFiles.push(patchFileName);
        continue;
      }

      await runCommand('git', ['apply', '--ignore-whitespace', '-C1', patchFilePath], { cwd: sourceRoot });
      lastAppliedPatchFile = patchFileName;
      shouldRollback = true;
    }

    if (patchFileNames.length === 0) {
      shouldRollback = false;
    }

    await runCommand('npm', ['run', 'build'], { cwd: sourceRoot });
    return {
      ok: true,
      failedPatchFile: null,
      errorMessage: null,
      rolledBack: false,
      skippedPatchFiles,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    let rolledBack = false;

    if (shouldRollback) {
      try {
        await runCommand('git', ['checkout', '.'], { cwd: sourceRoot });
        rolledBack = true;
      } catch {
        rolledBack = false;
      }
    }

    return {
      ok: false,
      failedPatchFile: lastAppliedPatchFile,
      errorMessage,
      rolledBack,
      skippedPatchFiles,
    };
  }
}

async function ensureGitClean(cwd) {
  const output = await runCommand('git', ['status', '--porcelain'], { cwd, captureStdout: true });
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);

  const hasModifiedOrDeleted = lines.some((line) => {
    const x = line[0] ?? ' ';
    const y = line[1] ?? ' ';
    return x === 'M' || x === 'D' || y === 'M' || y === 'D';
  });

  if (hasModifiedOrDeleted) {
    throw new Error(
      `Working tree has modified/deleted files at ${cwd}. Commit/stash or discard them before --apply.`,
    );
  }
}

function runCommand(command, args, options = {}) {
  const { captureStdout = false, ...spawnOptions } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      ...spawnOptions,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(captureStdout ? stdout : undefined);
      } else {
        const details = stderr.trim() || stdout.trim();
        reject(new Error(`${command} ${args.join(' ')} failed (code ${code})${details ? `\n${details}` : ''}`));
      }
    });
  });
}

function patchTouchesTooLargeFile(patchText, tooLargeSet) {
  if (tooLargeSet.size === 0) {
    return false;
  }

  const lines = String(patchText).split('\n');
  for (const line of lines) {
    if (!line.startsWith('+++ ')) {
      continue;
    }

    const rawPath = line.slice(4).trim();
    if (rawPath === '/dev/null') {
      continue;
    }

    const normalized = normalizePatchPath(rawPath);
    if (tooLargeSet.has(normalized)) {
      return true;
    }
  }

  return false;
}

function normalizePatchPath(patchPath) {
  const withoutPrefix = patchPath.startsWith('a/') || patchPath.startsWith('b/')
    ? patchPath.slice(2)
    : patchPath;
  return normalizePath(withoutPrefix);
}

function normalizePath(filePath) {
  return String(filePath ?? '').trim().replaceAll('\\', '/');
}
