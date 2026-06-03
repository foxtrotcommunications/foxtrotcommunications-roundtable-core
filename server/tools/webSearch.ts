// @ts-nocheck
// server/tools/webSearch.js — Web search tool
// Uses Google Custom Search JSON API if configured, otherwise uses Vertex AI grounding
import fetch from 'node-fetch';
import * as config from '../config';

import type { Tool } from '../types';
// @ts-ignore


const tool: Tool = {
  name: 'web_search',
  description: 'Search the web for current information. Returns relevant search results with titles, snippets, and URLs.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query to look up',
      },
    },
    required: ['query'],
  },
  async execute(args: any, workspaceConfig: any = {}, _context?: any) {
    const { query } = args;
    const model = workspaceConfig.model || 'gemini-2.5-flash';

    // Try Google Custom Search first (if configured and working)
    if (config.googleSearch.apiKey && config.googleSearch.engineId) {
      const result = await googleCustomSearch(query);
      if (!result.error) return result;
      console.warn('[WebSearch] Custom Search failed, trying Vertex grounding...');
    }

    // Fallback: Vertex AI grounding via Gemini
    if (config.vertexai.project) {
      return vertexGroundingSearch(query, model);
    }

    // Last resort: DuckDuckGo Instant Answer API
    return duckduckgoSearch(query);
  },
};

/**
 * Google Custom Search JSON API
 */
async function googleCustomSearch(query) {
  try {
    const params = new URLSearchParams({
      key: config.googleSearch.apiKey,
      cx: config.googleSearch.engineId,
      q: query,
      num: '5',
    });
    const url = `https://www.googleapis.com/customsearch/v1?${params}`;
    const response = await fetch(url, { timeout: 10000 });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[WebSearch] Google Custom Search error:', response.status, errText.substring(0, 200));
      return { error: `Custom Search API error (${response.status})` };
    }

    const data = await response.json();
    const results = (data.items || []).map(item => ({
      title: item.title || '',
      snippet: (item.snippet || '').substring(0, 300),
      url: item.link || '',
    }));

    return results.length > 0
      ? { results }
      : { results: [], message: `No results found for "${query}".` };
  } catch (err: any) {
    return { error: `Custom Search failed: ${err.message}` };
  }
}

/**
 * Vertex AI Grounding — uses Gemini + Google Search grounding to get search results.
 * This leverages existing ADC credentials, no extra API key needed.
 */
async function vertexGroundingSearch(query, model = 'gemini-2.5-flash') {
  try {
    const { GoogleGenAI   } = require('@google/genai');
    // Preview models need the global endpoint; GA models use regional
    const isPreview = model && model.includes('-preview');
    const ai = new GoogleGenAI({
      vertexai: true,
      project: config.vertexai.project,
      location: isPreview ? 'global' : config.vertexai.location,
    });

    const result = await ai.models.generateContent({
      model,
      contents: [{
        role: 'user',
        parts: [{ text: `Search the web for: ${query}\n\nReturn a concise list of the top 5 results with their title, URL, and a brief snippet. Format each result on its own line as: TITLE | URL | SNIPPET` }],
      }],
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    const text = result.text || '';

    // Also extract grounding metadata if available
    const groundingMeta = result.candidates?.[0]?.groundingMetadata;
    const searchResults = [];

    if (groundingMeta?.groundingChunks) {
      for (const chunk of groundingMeta.groundingChunks) {
        if (chunk.web) {
          searchResults.push({
            title: chunk.web.title || '',
            url: chunk.web.uri || '',
            snippet: '',
          });
        }
      }
    }

    // Include the grounded text as the primary answer + source links
    if (searchResults.length > 0 || text) {
      return {
        results: searchResults.slice(0, 5),
        summary: cleanSummary(text),
      };
    }

    // Parse text response as fallback
    if (text) {
      const lines = text.split('\n').filter(l => l.trim());
      for (const line of lines) {
        const parts = line.split('|').map(p => p.trim());
        if (parts.length >= 2) {
          searchResults.push({
            title: parts[0].replace(/^\d+\.\s*/, ''),
            url: parts[1] || '',
            snippet: parts[2] || '',
          });
        }
      }
    }

    return searchResults.length > 0
      ? { results: searchResults.slice(0, 5) }
      : { results: [], message: `No results found for "${query}".` };
  } catch (err: any) {
    console.error('[WebSearch] Vertex grounding error:', err.message);
    return duckduckgoSearch(query);
  }
}

/**
 * DuckDuckGo Instant Answer API (last resort — limited but no key needed)
 */
async function duckduckgoSearch(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const response = await fetch(url, { timeout: 10000 });
    const data = await response.json();

    const results = [];
    if (data.Abstract) {
      results.push({
        title: data.Heading || 'Summary',
        snippet: data.Abstract,
        url: data.AbstractURL || '',
      });
    }
    if (data.RelatedTopics) {
      for (const topic of data.RelatedTopics.slice(0, 5)) {
        if (topic.Text) {
          results.push({
            title: topic.Text.substring(0, 80),
            snippet: topic.Text,
            url: topic.FirstURL || '',
          });
        }
      }
    }

    return results.length > 0
      ? { results }
      : { results: [], message: `No results found for "${query}".` };
  } catch (err: any) {
    return { error: `Search failed: ${err.message}` };
  }
}

/**
 * Clean up Vertex AI grounding text — strip redirect URLs, markdown, and formatting artifacts
 */
function cleanSummary(text) {
  return text
    // Remove markdown links [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove raw URLs (http/https)
    .replace(/https?:\/\/[^\s)>\]]+/g, '')
    // Remove markdown bold **text** → text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    // Remove pipe-delimited formatting (TITLE | URL | SNIPPET)
    .replace(/\s*\|\s*/g, ' — ')
    // Collapse multiple spaces/newlines
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .substring(0, 800);
}

export default tool;
