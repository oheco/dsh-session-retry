import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Use DSH's installed dependencies without downloading another runtime.
const runtime = process.env.DSH_TEST_RUNTIME ?? path.resolve(path.dirname(process.execPath), '../lib/node_modules/@deepseek-ai/dsh/runtime');
const parentURL = pathToFileURL(path.join(runtime, 'package.json')).href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/') || specifier.startsWith('@earendil-works/') || specifier === 'zod') {
    return next(specifier, { ...context, parentURL });
  }
  return next(specifier, context);
} });
