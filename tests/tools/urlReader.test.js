// tests/tools/urlReader.test.js — URL reader tool tests (with SSRF protection)
const urlReader = require('../../server/tools/urlReader');

describe('url_reader tool', () => {
  it('should fetch and return content from a valid URL', async () => {
    const result = await urlReader.execute({ url: 'https://httpbin.org/html' });
    // In CI, external URLs may fail due to network — accept either success or network error
    if (result.error) {
      expect(result.error).not.toContain('private');
      expect(result.error).not.toContain('metadata');
    } else {
      expect(result.content).toBeDefined();
      expect(result.url).toBe('https://httpbin.org/html');
      expect(result.length).toBeGreaterThan(0);
    }
  }, 30000);

  it('should strip HTML tags from HTML content', async () => {
    const result = await urlReader.execute({ url: 'https://httpbin.org/html' });
    if (result.content) {
      expect(result.content).not.toContain('<html');
      expect(result.content).not.toContain('<script');
    }
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
    const result = await urlReader.execute({ url: 'https://httpbin.org/html' });
    if (result.content) {
      expect(result.content.length).toBeLessThanOrEqual(8100);
    }
  }, 15000);

  // ── SSRF Protection Tests ──────────────────────────────────
  describe('SSRF protection', () => {
    it('should block GCP metadata endpoint', async () => {
      const result = await urlReader.execute({ url: 'http://169.254.169.254/computeMetadata/v1/' });
      expect(result.error).toContain('metadata');
    });

    it('should block metadata.google.internal', async () => {
      const result = await urlReader.execute({ url: 'http://metadata.google.internal/computeMetadata/v1/' });
      expect(result.error).toContain('metadata');
    });

    it('should block non-HTTP schemes', async () => {
      const result = await urlReader.execute({ url: 'file:///etc/passwd' });
      expect(result.error).toContain('http');
    });

    it('should block FTP scheme', async () => {
      const result = await urlReader.execute({ url: 'ftp://evil.com/file' });
      expect(result.error).toContain('http');
    });

    it('should block localhost', async () => {
      const result = await urlReader.execute({ url: 'http://localhost:3000/api/health' });
      expect(result.error).toContain('private');
    });

    it('should block 127.0.0.1', async () => {
      const result = await urlReader.execute({ url: 'http://127.0.0.1:3000/' });
      expect(result.error).toContain('private');
    });
  });
});
