import chalk from 'chalk';

export function registerReportCommand(program) {
  program
    .command('report')
    .description('Generate markdown/pdf comparison report')
    .requiredOption('--from <name>', 'Source measure name (e.g. as-is)')
    .requiredOption('--to <name>', 'Target measure name (e.g. to-be)')
    .option('--format <types>', 'Output formats (comma separated)', 'md,pdf')
    .action((options) => {
      console.log(chalk.cyan('[report]'), 'not implemented yet');
      console.log(options);
    });
}
