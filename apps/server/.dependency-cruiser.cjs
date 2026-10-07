// Architecture rules for apps/server (CONCEPT §8):
// src/{domain,db,http,mcp,auth}; the domain imports none of the others and no
// infrastructure package. Run: pnpm --filter @proa/server depcruise
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment: 'Domain use cases must not depend on adapters (db, http, mcp, auth).',
      from: { path: '^src/domain/' },
      to: { path: '^src/(db|http|mcp|auth)/' },
    },
    {
      name: 'domain-no-infrastructure-packages',
      severity: 'error',
      comment: 'Domain code must not import web, MCP or database libraries.',
      from: { path: '^src/domain/' },
      to: {
        // pnpm paths end in …/node_modules/<package>/…
        path: 'node_modules/(hono|@hono|pg|drizzle-orm|@modelcontextprotocol)/',
      },
    },
    {
      name: 'src-not-to-test',
      severity: 'error',
      comment: 'Production code must not import test code.',
      from: { path: '^src/' },
      to: { path: '^test/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular imports make the layering meaningless.',
      from: { path: '^src/' },
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: 'Every import must resolve.',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules', '^\\.\\./\\.\\./packages/'] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'node', 'default'],
      extensions: ['.ts', '.js', '.mjs', '.json'],
    },
  },
};
