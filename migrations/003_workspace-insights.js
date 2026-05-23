exports.up = (pgm) => {
  pgm.createTable('workspace_insights', {
    id: 'id',
    workspace_id: { type: 'text', notNull: true, references: 'workspaces(id)', onDelete: 'CASCADE' },
    user_id: { type: 'integer', references: 'users(id)' },
    title: { type: 'text', notNull: true },
    content: { type: 'text', notNull: true },
    source_message_id: { type: 'integer', references: 'messages(id)', onDelete: 'SET NULL' },
    category: { type: 'text', default: "'general'" },
    pinned_at: { type: 'timestamp', notNull: true, default: pgm.func('CURRENT_TIMESTAMP') },
  });

  pgm.createIndex('workspace_insights', ['workspace_id', { name: 'pinned_at', sort: 'DESC' }], {
    name: 'idx_insights_workspace',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('workspace_insights');
};
