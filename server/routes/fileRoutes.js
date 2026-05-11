// server/routes/fileRoutes.js — REST API for browsing workspace files (read-only)
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', 'workspace');

/**
 * GET /api/workspace — list all repos in the workspace
 */
router.get('/workspace', (req, res) => {
  try {
    if (!fs.existsSync(WORKSPACE_DIR)) {
      return res.json({ repos: [] });
    }
    const entries = fs.readdirSync(WORKSPACE_DIR, { withFileTypes: true });
    const repos = entries
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(WORKSPACE_DIR, e.name, '.git')))
      .map((e) => {
        let branch = '';
        try {
          branch = fs
            .readFileSync(path.join(WORKSPACE_DIR, e.name, '.git', 'HEAD'), 'utf-8')
            .trim()
            .replace('ref: refs/heads/', '');
        } catch (_) {}
        return { name: e.name, branch };
      });
    res.json({ repos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/workspace/:repo/tree — recursive file tree
 */
router.get('/workspace/:repo/tree', (req, res) => {
  try {
    const repoPath = path.resolve(WORKSPACE_DIR, req.params.repo);
    if (!repoPath.startsWith(WORKSPACE_DIR) || !fs.existsSync(repoPath)) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    function buildTree(dir, prefix = '') {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const items = [];
      for (const entry of entries) {
        // Skip hidden files and common junk
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') {
          continue;
        }
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          items.push({
            name: entry.name,
            path: relPath,
            type: 'directory',
            children: buildTree(path.join(dir, entry.name), relPath),
          });
        } else {
          const stats = fs.statSync(path.join(dir, entry.name));
          items.push({
            name: entry.name,
            path: relPath,
            type: 'file',
            size: stats.size,
          });
        }
      }
      // Sort: directories first, then alphabetical
      items.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return items;
    }

    res.json({ repo: req.params.repo, tree: buildTree(repoPath) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/workspace/:repo/status — git status (changed files)
 */
router.get('/workspace/:repo/status', (req, res) => {
  try {
    const repoPath = path.resolve(WORKSPACE_DIR, req.params.repo);
    if (!repoPath.startsWith(WORKSPACE_DIR) || !fs.existsSync(repoPath)) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    const { execSync } = require('child_process');
    const output = execSync('git status --porcelain', { cwd: repoPath, encoding: 'utf-8' }).trim();
    const files = {};
    if (output) {
      for (const line of output.split('\n')) {
        if (line.length < 4) continue;
        // Porcelain format: XY filepath — positions 0,1 are status, position 2 is space, 3+ is path
        // But some statuses may only use position 0 (e.g. "M  file" vs " M file")
        const x = line[0];
        const y = line[1];
        // Find the filepath: skip the XY status and any spaces
        const filePath = line.slice(2).replace(/^\s+/, '').replace(/^"(.*)"$/, '$1');
        if (!filePath) continue;
        
        let status = 'modified';
        if (x === '?' || y === '?') status = 'untracked';
        else if (x === 'A') status = 'added';
        else if (x === 'D' || y === 'D') status = 'deleted';
        else if (x === 'R') status = 'renamed';
        else if (x === 'M' || y === 'M') status = 'modified';

        files[filePath] = status;
      }
    }

    res.json({ repo: req.params.repo, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/workspace/:repo/file?path=... — read a single file
 */
router.get('/workspace/:repo/file', (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'path query parameter required' });

    const fullPath = path.resolve(WORKSPACE_DIR, req.params.repo, filePath);
    if (!fullPath.startsWith(WORKSPACE_DIR)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Check if binary
    const stats = fs.statSync(fullPath);
    if (stats.size > 512 * 1024) {
      return res.json({ path: filePath, content: '(File too large to display)', lines: 0, truncated: true });
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    const ext = path.extname(filePath).slice(1);
    res.json({
      path: filePath,
      content,
      lines: content.split('\n').length,
      language: ext,
      size: stats.size,
    });
  } catch (err) {
    if (err.code === 'ERR_INVALID_ARG_VALUE' || err.message.includes('encoding')) {
      return res.json({ path: req.query.path, content: '(Binary file)', lines: 0 });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/workspace/:repo/raw?path=... — serve raw file (images, etc.)
 */
router.get('/workspace/:repo/raw', (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'path query parameter required' });

    const fullPath = path.resolve(WORKSPACE_DIR, req.params.repo, filePath);
    if (!fullPath.startsWith(WORKSPACE_DIR)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Serve file with proper content type
    res.sendFile(fullPath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
