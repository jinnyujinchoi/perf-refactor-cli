import chalk from 'chalk';

export function registerOptimizeCommand(program) {
  program
    .command('optimize')
    .description('Generate AI optimization plan and patches')
    .requiredOption('--from <name>', 'Baseline measure name (e.g. as-is)')
    .requiredOption('--name <name>', 'Target result name (e.g. to-be)')
    .requiredOption('--prompt <text>', 'Optimization prompt')
    .option('--yes', 'Apply non-interactive defaults')
    .action((options) => {
      console.log(chalk.cyan('[optimize]'), 'not implemented yet');
      console.log(options);
    });
}
