# packages/

Drop-in directory for private workspace plugins installed at image-build time.

Plugins are optional at runtime — core probes for them with `try/require` and
falls back to built-in behavior when absent (see `server/tools/index.ts` and
the sync/demographics routes in `server/index.js`).

Known plugins:

- **`@pendragon/tools-plaid`** — domain-isolated Plaid financial tools for
  Pendragon workspaces. Maintained in the private `pendragon` repository
  (`packages/tools-plaid`) and published to Google Artifact Registry
  (`us-central1-npm.pkg.dev/roundtable-public/pendragon-npm`). Production
  workspace images install it during the Docker build:

  ```dockerfile
  RUN npm install @pendragon/tools-plaid --registry=https://us-central1-npm.pkg.dev/roundtable-public/pendragon-npm/
  ```

This directory is intentionally empty in the open-source tree.
