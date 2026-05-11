// server/tools/calculator.js — Safe math expression evaluator
const { evaluate } = require('mathjs');

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
      const result = evaluate(expression);
      return {
        expression,
        result: typeof result === 'object' ? result.toString() : String(result),
      };
    } catch (err) {
      return { error: `Math error: ${err.message}`, expression };
    }
  },
};
