// server/routes/insightRoutes.js — CRUD routes for pinned insights
const express = require('express');
const router = express.Router();
const config = require('../config');
const { getAdapter } = require('../db/adapter');

// GET /api/insights — list pinned insights for this workspace
router.get('/', async (req, res) => {
  try {
    const insights = await getAdapter().getInsights(config.workspaceId);
    res.json(insights);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/insights — pin a new insight
router.post('/', async (req, res) => {
  try {
    const { title, content, sourceMessageId, category } = req.body;
    if (!title || !content) {
      return res.status(400).json({ error: 'title and content are required' });
    }
    const insight = await getAdapter().addInsight(
      config.workspaceId,
      req.session.userId,
      title,
      content,
      sourceMessageId || null,
      category || 'general'
    );
    res.status(201).json(insight);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/insights/:id — unpin/delete an insight
router.delete('/:id', async (req, res) => {
  try {
    await getAdapter().deleteInsight(parseInt(req.params.id, 10), config.workspaceId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
