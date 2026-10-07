// Writes the OpenAPI document of @proa/contracts to packages/client/openapi.json,
// the input of hey-api. The version stays 0.0.0 so the file only changes with the API.
import { writeFile } from 'node:fs/promises';

import { buildOpenApiDocument } from '@proa/contracts';

const target = new URL('../openapi.json', import.meta.url);
await writeFile(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`wrote ${target.pathname}`);
