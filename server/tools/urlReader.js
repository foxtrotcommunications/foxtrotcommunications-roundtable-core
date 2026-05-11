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
