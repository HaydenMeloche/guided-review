import { unionRe as union } from '../util/regex.js';

// Path and line patterns that several analyses share, so they agree on what a migration,
// route or public API is.

// Migration files: their own chapter, high risk, and evidence that a repo keeps migrations.
export const MIGRATION_PATH = /(^|\/)(migrations?|migrate|alembic\/versions|db\/changelog)\/|(^|\/)V\d+(_\d+)*__[^/]+\.sql$/i;
// Hand-written SQL and schema dumps, scored like migrations.
export const SQL_SCHEMA_PATH = /(^|\/)db\/schema\/|\.sql$/i;
// Files whose lines may declare tables, for entity diagrams.
export const SCHEMA_PATH = union([MIGRATION_PATH, SQL_SCHEMA_PATH, /\.prisma$|schema\.(rb|ts)$/], 'i');

// `create table [if not exists] x`, `alter table x`, `drop table [if exists] x`.
const SQL_TABLE = /\b(alter|create|drop)\s+table\s+(?:if\s+(?:not\s+)?exists\s+)?[`"]?(\w+)[`"]?/gi;

interface SqlTableRef {
  verb: 'alter' | 'create' | 'drop';
  table: string;
  rest: string; // the line after the table name
}

export function sqlTableRefs(text: string): SqlTableRef[] {
  return [...text.matchAll(SQL_TABLE)].map((m) => ({ verb: m[1].toLowerCase() as SqlTableRef['verb'], table: m[2], rest: text.slice(m.index + m[0].length) }));
}

// Route registrations, by framework.
export const PY_DECORATOR_ROUTE = /@(app|router|bp|blueprint)\.(route|get|post|put|patch|delete)\(/; // Flask, FastAPI
export const GO_ROUTE = /\bhttp\.HandleFunc\(|\b(HandleFunc|Handle)\(\s*"\/|\.(GET|POST|PUT|DELETE|PATCH)\("/; // net/http, gin, echo
export const ROUTE_LINE = union([
  /\b(app|router|routes|server|api|fastify|r)\.(get|post|put|patch|delete|all|use|route)\s*\(\s*['"`]/, // express, hono, fastify
  /@(Get|Post|Put|Patch|Delete)\b|@(Get|Post|Put|Patch|Delete|Request)Mapping\b/, // NestJS, Spring
  PY_DECORATOR_ROUTE,
  GO_ROUTE,
  /^\s*(get|post|put|patch|delete)\s*\(\s*"\//, // Ktor
]);

// A declaration other modules or packages can use.
export const PUBLIC_API_LINE = union([
  /^\s*export\s+(default\s+)?(async\s+)?(function|class|const|let|var|interface|type|enum|abstract\s+class)\b/, // TS/JS
  /^\s*export\s*\{/, // TS/JS named exports
  /^\s*pub\s+(async\s+)?(fn|struct|enum|trait|type|const|mod)\b/, // Rust
  /^func\s+(\([^)]*\)\s*)?[A-Z]\w*\s*[[(]/, // Go exported func
  /^\s*def\s+[a-z]\w*\(/, // Python, without a leading underscore
  /^\s*public\s+(static\s+)?(final\s+)?(abstract\s+)?[\w<>[\],\s]+\s+\w+\s*\(/, // Java public method
  /^\s*public\s+(class|interface|enum|record|fun|val|var|object)\b/, // Java/Kotlin public types
  /^\s*(?:(?:public|open|override|suspend|inline|data|sealed|abstract|enum|operator)\s+)*(fun|class|interface|object)\s+[\w.`<>]+/, // Kotlin (public by default)
]);

export const DOC_PATH = /\.(md|mdx|rst|adoc)$|(^|\/)(docs?|documentation)\/|(^|\/)(LICENSE|CHANGELOG|AUTHORS)[^/]*$/i;

export const PROTOBUF_OUTPUT = /\.pb\.go$|\.pb\.(cc|h)$|_pb2(_grpc)?\.pyi?$|_pb\.(js|ts|d\.ts)$|_grpc_pb\.(js|ts|d\.ts)$/;
