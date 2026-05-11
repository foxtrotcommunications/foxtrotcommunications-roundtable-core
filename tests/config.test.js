// tests/config.test.js — Configuration module tests
describe('config module', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  it('should parse PORT as integer', () => {
    process.env.PORT = '8080';
    const config = require('../server/config');
    expect(config.port).toBe(8080);
    expect(typeof config.port).toBe('number');
  });

  it('should default PORT to 3000', () => {
    delete process.env.PORT;
    const config = require('../server/config');
    expect(config.port).toBe(3000);
  });

  it('should read WORKSPACE_ID', () => {
    process.env.WORKSPACE_ID = 'backend';
    process.env.WORKSPACE_NAME = 'Backend Team';
    const config = require('../server/config');
    expect(config.workspaceId).toBe('backend');
    expect(config.workspaceName).toBe('Backend Team');
  });

  it('should read EMBED_MODE as boolean', () => {
    process.env.EMBED_MODE = 'true';
    const config = require('../server/config');
    expect(config.embedMode).toBe(true);
  });

  it('should default EMBED_MODE to false', () => {
    process.env.EMBED_MODE = '';
    const config = require('../server/config');
    expect(config.embedMode).toBe(false);
  });

  it('should read Vertex AI config', () => {
    process.env.GCP_PROJECT = 'my-project';
    process.env.GCP_LOCATION = 'europe-west1';
    const config = require('../server/config');
    expect(config.vertexai.project).toBe('my-project');
    expect(config.vertexai.location).toBe('europe-west1');
  });

  it('should default GCP_LOCATION to us-central1', () => {
    delete process.env.GCP_LOCATION;
    const config = require('../server/config');
    expect(config.vertexai.location).toBe('us-central1');
  });

  it('should read AI provider keys', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.ANTHROPIC_API_KEY = 'ant-test';
    const config = require('../server/config');
    expect(config.ai.openai).toBe('sk-test');
    expect(config.ai.anthropic).toBe('ant-test');
  });

  it('should read Google Search config', () => {
    process.env.GOOGLE_SEARCH_API_KEY = 'search-key';
    process.env.GOOGLE_SEARCH_ENGINE_ID = 'engine-id';
    const config = require('../server/config');
    expect(config.googleSearch.apiKey).toBe('search-key');
    expect(config.googleSearch.engineId).toBe('engine-id');
  });
});
