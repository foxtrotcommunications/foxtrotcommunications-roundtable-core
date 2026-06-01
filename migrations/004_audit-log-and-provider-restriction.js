/* eslint-disable camelcase */
// migrations/004_audit-log-and-provider-restriction.js
// Adds audit_log table and allowed_providers column to workspaces

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Audit log table
  pgm.createTable('audit_log', {
    id: 'id',
    workspace_id: {
      type: 'text',
      notNull: true,
      references: 'workspaces',
      onDelete: 'CASCADE',
    },
    user_id: {
      type: 'integer',
      references: 'users',
    },
    username: { type: 'text' },
    event_type: { type: 'text', notNull: true },
    event_name: { type: 'text' },
    event_detail: { type: 'jsonb', default: pgm.func("'{}'::jsonb") },
    ip_address: { type: 'text' },
    created_at: {
      type: 'timestamp',
      default: pgm.func('current_timestamp'),
    },
  });

  pgm.createIndex('audit_log', ['workspace_id', { name: 'created_at', sort: 'DESC' }], {
    name: 'idx_audit_workspace',
  });
  pgm.createIndex('audit_log', ['event_type', { name: 'created_at', sort: 'DESC' }], {
    name: 'idx_audit_event',
  });

  // Provider restriction column
  pgm.addColumn('workspaces', {
    allowed_providers: { type: 'text', default: null },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('audit_log');
  pgm.dropColumn('workspaces', 'allowed_providers');
};
