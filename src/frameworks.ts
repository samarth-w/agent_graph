/**
 * Framework-aware route extraction.
 *
 * Detects web-framework routing patterns and emits route nodes
 * linked by 'references' edges to their handler functions.
 *
 * Supported frameworks:
 * - Express (app.get/post/..., router.get/post/...)
 * - React Router (Route component, path prop)
 * - Next.js (file-based routes from pages/ and app/ dirs)
 * - Django (path(), re_path(), url())
 * - Flask (@app.route, @blueprint.route)
 * - FastAPI (@app.get, @router.post, etc.)
 */
import type { ParsedRoute } from './types';

// ─── Express / Koa / Hono ──────────────────────────────────────
const EXPRESS_RE = /(?:app|router|server)\.(get|post|put|delete|patch|all|use)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(?:.*?,\s*)?(\w+)/gi;

// ─── Flask ─────────────────────────────────────────────────────
const FLASK_RE = /@(?:\w+)\.(route)\s*\(\s*['"`]([^'"`]+)['"`](?:.*?methods\s*=\s*\[([^\]]*)\])?\s*\)/gi;
const FLASK_FUNC_RE = /def\s+(\w+)\s*\(/;

// ─── FastAPI ───────────────────────────────────────────────────
const FASTAPI_RE = /@(?:\w+)\.(get|post|put|delete|patch|options|head)\s*\(\s*['"`]([^'"`]+)['"`]/gi;

// ─── Django ────────────────────────────────────────────────────
const DJANGO_RE = /(?:path|re_path|url)\s*\(\s*['"`]([^'"`]*)['"`]\s*,\s*(?:views\.)?(\w+(?:\.\w+)*)/gi;

// ─── React Router (JSX) ───────────────────────────────────────
const REACT_ROUTE_RE = /<Route\s+[^>]*path\s*=\s*['"`{](['"`]?)([^'"`}]+)\1[^>]*(?:component\s*=\s*\{?(\w+)\}?|element\s*=\s*\{?\s*<(\w+))/gi;

// ─── Next.js file-based routing ────────────────────────────────
function detectNextRoute(filePath: string): string | null {
  // pages/api/users/[id].ts → /api/users/:id
  // app/api/users/[id]/route.ts → /api/users/:id
  const pagesMatch = filePath.match(/pages\/(.+)\.(tsx?|jsx?|mdx?)$/);
  const appMatch = filePath.match(/app\/(.+)\/(?:page|route|layout)\.(tsx?|jsx?|mdx?)$/);

  const raw = pagesMatch?.[1] ?? appMatch?.[1];
  if (!raw) return null;

  return '/' + raw
    .replace(/\/index$/, '')
    .replace(/\[\.\.\.(\w+)\]/g, '*$1')
    .replace(/\[(\w+)\]/g, ':$1');
}

// ─── Public API ────────────────────────────────────────────────
export function extractRoutes(content: string, filePath: string, language: string): ParsedRoute[] {
  const routes: ParsedRoute[] = [];
  const lines = content.split('\n');

  // Next.js file-based routing
  const nextRoute = detectNextRoute(filePath);
  if (nextRoute) {
    // Find the default export as handler
    const defaultExport = content.match(/export\s+default\s+(?:function\s+)?(\w+)/);
    routes.push({
      method: '*',
      pattern: nextRoute,
      handler: defaultExport?.[1] ?? 'default',
      line: 1,
      framework: 'nextjs',
    });
  }

  // Express / Koa / Hono
  if (language === 'javascript' || language === 'typescript' || language === 'jsx' || language === 'tsx') {
    let m: RegExpExecArray | null;
    EXPRESS_RE.lastIndex = 0;
    while ((m = EXPRESS_RE.exec(content)) !== null) {
      routes.push({
        method: m[1].toUpperCase(),
        pattern: m[2],
        handler: m[3],
        line: lineOfOffset(lines, m.index),
        framework: 'express',
      });
    }

    // React Router
    REACT_ROUTE_RE.lastIndex = 0;
    while ((m = REACT_ROUTE_RE.exec(content)) !== null) {
      routes.push({
        method: '*',
        pattern: m[2],
        handler: m[3] ?? m[4] ?? 'unknown',
        line: lineOfOffset(lines, m.index),
        framework: 'react-router',
      });
    }
  }

  // Python frameworks
  if (language === 'python') {
    let m: RegExpExecArray | null;

    // Flask
    FLASK_RE.lastIndex = 0;
    while ((m = FLASK_RE.exec(content)) !== null) {
      const methods = m[3]
        ? m[3].replace(/['"`\s]/g, '').split(',').map(m => m.toUpperCase()).join(',')
        : 'GET';
      const line = lineOfOffset(lines, m.index);
      // Look for the function defined after the decorator
      const afterDecorator = content.slice(m.index + m[0].length);
      const funcMatch = afterDecorator.match(FLASK_FUNC_RE);
      routes.push({
        method: methods,
        pattern: m[2],
        handler: funcMatch?.[1] ?? 'unknown',
        line,
        framework: 'flask',
      });
    }

    // FastAPI
    FASTAPI_RE.lastIndex = 0;
    while ((m = FASTAPI_RE.exec(content)) !== null) {
      const line = lineOfOffset(lines, m.index);
      const afterDecorator = content.slice(m.index + m[0].length);
      const funcMatch = afterDecorator.match(/(?:async\s+)?def\s+(\w+)/);
      routes.push({
        method: m[1].toUpperCase(),
        pattern: m[2],
        handler: funcMatch?.[1] ?? 'unknown',
        line,
        framework: 'fastapi',
      });
    }

    // Django
    DJANGO_RE.lastIndex = 0;
    while ((m = DJANGO_RE.exec(content)) !== null) {
      routes.push({
        method: '*',
        pattern: '/' + m[1],
        handler: m[2],
        line: lineOfOffset(lines, m.index),
        framework: 'django',
      });
    }
  }

  return routes;
}

function lineOfOffset(lines: string[], offset: number): number {
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    pos += lines[i].length + 1;
    if (pos > offset) return i + 1;
  }
  return lines.length;
}
