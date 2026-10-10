#!/usr/bin/env node
// `proa-demo` entry point; Node 24 runs this TypeScript file directly (type stripping).
import { runDemo } from './program.ts';

process.exitCode = await runDemo(process.argv.slice(2));
