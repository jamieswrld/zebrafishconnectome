/**
 * Module resolution hooks so build scripts can import the app's TypeScript
 * directly, instead of maintaining a duplicate JS copy of any generator.
 *
 * Handles the two things Node does not do on its own:
 *   - the "@/..." path alias, which maps to src/
 *   - extensionless specifiers, which TypeScript allows and ESM does not
 *
 * Node 24 strips the types itself once the file resolves.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(process.cwd(), 'src');

function withExtension(url) {
  if (!url.startsWith('file:')) return url;
  const filePath = fileURLToPath(url);
  if (existsSync(filePath) && path.extname(filePath)) return url;
  for (const candidate of ['.ts', '.tsx', '.mjs', '.js', '/index.ts']) {
    if (existsSync(filePath + candidate)) return pathToFileURL(filePath + candidate).href;
  }
  return url;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const target = withExtension(pathToFileURL(path.join(SRC, specifier.slice(2))).href);
    return { url: target, shortCircuit: true };
  }
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const resolved = new URL(specifier, context.parentURL).href;
    const withExt = withExtension(resolved);
    if (withExt !== resolved) return { url: withExt, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
