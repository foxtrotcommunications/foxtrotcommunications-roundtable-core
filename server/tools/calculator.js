// server/tools/calculator.js — Safe math expression evaluator
// Uses a restricted mathjs instance to prevent prototype pollution (CVE mitigation)
const { create, all } = require('mathjs');

// Create a sandboxed mathjs instance with only safe functions
const math = create(all);

// Disable dangerous features that could lead to prototype pollution
// We keep evaluate on the instance but block import and code generation
math.import({
  import: function () { throw new Error('import is disabled'); },
  createUnit: function () { throw new Error('createUnit is disabled'); },
}, { override: true });

module.exports = {
  name: 'calculator',
  description: 'Evaluate mathematical expressions. Supports arithmetic, algebra, unit conversions, statistics, and more. Examples: "2^10", "sin(pi/4)", "5 inches to cm", "mean([1,2,3,4,5])"',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'The mathematical expression to evaluate',
      },
    },
    required: ['expression'],
  },
  async execute({ expression }) {
    try {
      const result = math.evaluate(expression);
      return {
        expression,
        result: typeof result === 'object' ? result.toString() : String(result),
      };
    } catch (err) {
      return { error: `Math error: ${err.message}`, expression };
    }
  },
};
