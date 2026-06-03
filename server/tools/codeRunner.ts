// @ts-nocheck
// server/tools/codeRunner.js — Sandboxed JavaScript code execution
import vm from 'vm';

import type { Tool } from '../types';
// @ts-ignore


const tool: Tool = {
  name: 'run_code',
  description: 'Execute JavaScript code in a sandboxed environment. Useful for calculations, data processing, or testing logic. No filesystem or network access. Console.log output is captured.',
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'The JavaScript code to execute',
      },
    },
    required: ['code'],
  },
  async execute(args: any, workspaceConfig: any = {}, _context?: any) {
    const { code } = args;
    try {
      const logs = [];
      const sandbox = {
        console: {
          log: (...args) => logs.push(args.map(String).join(' ')),
          error: (...args) => logs.push('[ERROR] ' + args.map(String).join(' ')),
          warn: (...args) => logs.push('[WARN] ' + args.map(String).join(' ')),
        },
        JSON,
        Math,
        Date,
        Array,
        Object,
        String,
        Number,
        Boolean,
        RegExp,
        Map,
        Set,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
      };

      const context = vm.createContext(sandbox);
      const script = new vm.Script(code);
      const result = script.runInContext(context, { timeout: 5000 });

      return {
        result: result !== undefined ? String(result) : undefined,
        output: logs.length > 0 ? logs.join('\n') : undefined,
      };
    } catch (err: any) {
      return { error: `Execution error: ${err.message}` };
    }
  },
};

export default tool;
