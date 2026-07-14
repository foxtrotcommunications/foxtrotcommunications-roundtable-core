
import { resolveTools, toOpenAITools, toAnthropicTools, executeTool, registerDynamicTools, clearDynamicTools } from '../../server/tools/index';

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

  // A registry entry without a .name (e.g. a module-interop wrapper object
  // registered by a plugin) must never reach a provider tools array —
  // OpenAI rejects the whole request with 400 "tools[N].function.name",
  // taking chat down (observed live 2026-07-14).
  it('drops nameless tool definitions from provider payloads', () => {
    registerDynamicTools([
      { default: { name: 'wrapped_tool' }, execute: async () => ({}) } as any,
      { name: 'legit_dynamic_tool', description: 'ok', parameters: { type: 'object', properties: {} }, execute: async () => ({}) } as any,
    ]);
    try {
      const openai = toOpenAITools(null);
      expect(openai.every(t => typeof t.function.name === 'string' && t.function.name.length > 0)).toBe(true);
      expect(openai.find(t => t.function.name === 'legit_dynamic_tool')).toBeDefined();
      const anthropic = toAnthropicTools(null);
      expect(anthropic.every(t => typeof t.name === 'string' && t.name.length > 0)).toBe(true);
    } finally {
      clearDynamicTools('wrapped_tool');
      clearDynamicTools('legit_dynamic_tool');
      clearDynamicTools('undefined');
    }
  });
});
