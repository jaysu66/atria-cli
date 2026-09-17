#!/usr/bin/env node
const args = process.argv.slice(2);
let input = {};
if (args[1]) input = JSON.parse(args[1]);
process.stdout.write(JSON.stringify({ tool: args[0], input }) + '\n');
