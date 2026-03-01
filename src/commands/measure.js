import chalk from 'chalk';

export function registerMeasureCommand(program) {
  program
    .command('measure')
    .description('Measure Web(Lighthouse) and RN metrics')
    .requiredOption('--name <name>', 'Result name (e.g. as-is)')
    .option('--web <urlOrPath>', 'Target web URL or local path')
    .option('--rn <path>', 'React Native project path')
    .action((options) => {
      console.log(chalk.cyan('[measure]'), 'not implemented yet');
      console.log(options);
    });
}
