
import { resolveTools, toOpenAITools, toAnthropicTools, executeTool } from '../../server/tools/index';

describe('Tool Index', () => {
  it('should resolve specific enabled tools', () => {
    const tools = resolveTools(['calculator', 'read_url']);
    expect(Object.keys(tools).length).toBeGreaterThanOrEqual(2);
    expect(tools['calculator']).toBeDefined();
  });

  it('should format tools for OpenAI', () => {
    const openaiTools = toOpenAITools(['calculator']);
    expect(openaiTools.length).toBeGreaterThanOrEqual(1);
    expect(openaiTools.find(t => t.function.name === 'calculator')).toBeDefined();
  });

  it('should format tools for Anthropic', () => {
    const anthropicTools = toAnthropicTools(['calculator']);
    expect(anthropicTools.length).toBeGreaterThanOrEqual(1);
  });

  it('should execute a resolved tool', async () => {
    const result = await executeTool('calculator', { expression: '2+2' }, {});
    expect(result.result).toBe('4');
  });
});
