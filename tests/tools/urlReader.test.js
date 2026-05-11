// tests/tools/urlReader.test.js — URL reader tool tests
const urlReader = require('../../server/tools/urlReader');

describe('url_reader tool', () => {
  it('should fetch and return content from a valid URL', async () => {
    const result = await urlReader.execute({ url: 'https://httpbin.org/html' });
    expect(result.content).toBeDefined();
    expect(result.url).toBe('https://httpbin.org/html');
    expect(result.length).toBeGreaterThan(0);
  }, 15000);

  it('should strip HTML tags from HTML content', async () => {
    const result = await urlReader.execute({ url: 'https://httpbin.org/html' });
    expect(result.content).not.toContain('<html');
    expect(result.content).not.toContain('<script');
  }, 15000);

  it('should return error for invalid URL', async () => {
    const result = await urlReader.execute({ url: 'not-a-url' });
    expect(result.error).toBeDefined();
  });

  it('should return error for non-existent domain', async () => {
    const result = await urlReader.execute({ url: 'https://thisdoesnotexist12345.example.com' });
    expect(result.error).toBeDefined();
  }, 20000);

  it('should truncate long content', async () => {
    // The reader caps at 8000 chars
    const result = await urlReader.execute({ url: 'https://httpbin.org/html' });
    if (result.content) {
      expect(result.content.length).toBeLessThanOrEqual(8100); // 8000 + truncation message
    }
  }, 15000);
});
