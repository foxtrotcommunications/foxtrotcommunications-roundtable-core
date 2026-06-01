// server/tools/urlReader.js — Fetch and extract text from URLs
const fetch = require('node-fetch');

module.exports = {
  name: 'read_url',
  description: 'Fetch a URL and extract its text content. Useful for reading articles, documentation, or web pages.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch and read',
      },
    },
    required: ['url'],
  },
  async execute({ url }) {
    try {
      // ── SSRF Protection: block internal/private network access ──
      const { URL } = require('url');
      const dns = require('dns');
      const { promisify } = require('util');
      const lookup = promisify(dns.lookup);

      let parsed;
      try { parsed = new URL(url); } catch {
        return { error: 'Invalid URL' };
      }

      // Block non-HTTP(S) schemes
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { error: 'Only http:// and https:// URLs are allowed' };
      }

      // Block cloud metadata endpoints, localhost, and private hostnames
      const blockedHosts = ['169.254.169.254', 'metadata.google.internal', 'metadata.internal'];
      if (blockedHosts.includes(parsed.hostname)) {
        return { error: 'Access to cloud metadata endpoints is blocked' };
      }

      // Block localhost variants by hostname (catches both IPv4 and IPv6 resolution)
      const localhostPatterns = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'];
      if (localhostPatterns.includes(parsed.hostname)) {
        return { error: 'Access to private/internal network addresses is blocked' };
      }

      // Resolve hostname and check for private/reserved IP ranges
      try {
        const { address } = await lookup(parsed.hostname);
        // Handle IPv6 loopback and link-local
        if (address === '::1' || address === '0:0:0:0:0:0:0:1' || address.startsWith('fe80:') || address.startsWith('fc00:') || address.startsWith('fd')) {
          return { error: 'Access to private/internal network addresses is blocked' };
        }
        const parts = address.split('.').map(Number);
        const isPrivate = parts.length === 4 && (
          parts[0] === 10 ||                                          // 10.0.0.0/8
          (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||  // 172.16.0.0/12
          (parts[0] === 192 && parts[1] === 168) ||                  // 192.168.0.0/16
          parts[0] === 127 ||                                        // 127.0.0.0/8
          (parts[0] === 169 && parts[1] === 254) ||                  // 169.254.0.0/16 (link-local)
          parts[0] === 0                                              // 0.0.0.0/8
        );
        if (isPrivate) {
          return { error: 'Access to private/internal network addresses is blocked' };
        }
      } catch (dnsErr) {
        return { error: `DNS resolution failed for ${parsed.hostname}: ${dnsErr.message}` };
      }

      const response = await fetch(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Roundtable/1.0 (URL Reader Tool)',
          Accept: 'text/html,application/xhtml+xml,text/plain',
        },
      });

      if (!response.ok) {
        return { error: `HTTP ${response.status}: ${response.statusText}` };
      }

      const contentType = response.headers.get('content-type') || '';
      let text = await response.text();

      // Basic HTML stripping if content is HTML
      if (contentType.includes('html')) {
        // Remove scripts, styles, and HTML tags
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<nav[\s\S]*?<\/nav>/gi, '')
          .replace(/<footer[\s\S]*?<\/footer>/gi, '')
          .replace(/<header[\s\S]*?<\/header>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ')
          .trim();
      }

      // Truncate to avoid blowing up context
      const maxLength = 8000;
      if (text.length > maxLength) {
        text = text.substring(0, maxLength) + '\n\n[... content truncated at 8000 characters]';
      }

      return { url, content: text, length: text.length };
    } catch (err) {
      return { error: `Failed to fetch URL: ${err.message}` };
    }
  },
};
