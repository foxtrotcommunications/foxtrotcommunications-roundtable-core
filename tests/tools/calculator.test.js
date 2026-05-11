// tests/tools/calculator.test.js — Calculator tool tests
const calculator = require('../../server/tools/calculator');

describe('calculator tool', () => {
  it('should evaluate basic arithmetic', async () => {
    const result = await calculator.execute({ expression: '2 + 2' });
    expect(result.result).toBe('4');
  });

  it('should evaluate exponents', async () => {
    const result = await calculator.execute({ expression: '2^10' });
    expect(result.result).toBe('1024');
  });

  it('should evaluate trigonometry', async () => {
    const result = await calculator.execute({ expression: 'sin(pi/2)' });
    expect(parseFloat(result.result)).toBeCloseTo(1);
  });

  it('should evaluate unit conversions', async () => {
    const result = await calculator.execute({ expression: '5 inches to cm' });
    expect(parseFloat(result.result)).toBeCloseTo(12.7, 1);
  });

  it('should evaluate statistical functions', async () => {
    const result = await calculator.execute({ expression: 'mean([1,2,3,4,5])' });
    expect(result.result).toBe('3');
  });

  it('should return error for invalid expressions', async () => {
    const result = await calculator.execute({ expression: 'foo bar baz' });
    expect(result.error).toContain('Math error');
  });

  it('should handle division by zero', async () => {
    const result = await calculator.execute({ expression: '1/0' });
    expect(result.result).toBe('Infinity');
  });

  it('should handle complex expressions', async () => {
    const result = await calculator.execute({ expression: 'sqrt(144) + log(1)' });
    expect(result.result).toBe('12');
  });
});
