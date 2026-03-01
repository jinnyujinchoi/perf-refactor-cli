#!/usr/bin/env node
import { Command } from 'commander';
import { registerMeasureCommand } from './commands/measure.js';
import { registerOptimizeCommand } from './commands/optimize.js';
import { registerReportCommand } from './commands/report.js';

const program = new Command();

program
  .name('perf-refactor-cli')
  .description('Measure, optimize, and report frontend performance for Web + RN projects')
  .version('0.1.0');

registerMeasureCommand(program);
registerOptimizeCommand(program);
registerReportCommand(program);

program.parse(process.argv);
