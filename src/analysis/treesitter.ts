import { createRequire } from 'node:module';
import { Language, Parser, Query, type Node } from 'web-tree-sitter';
import { languageOf, type TreeSitterLang as Lang } from '../util/language.js';
import type { Decl, DeclKind, EntryHint, FileSymbols } from './symbols.js';

// Tree-sitter parsing for non-TS source languages. Grammars are prebuilt WASM files
// from tree-sitter-wasms, so there is no native build. If loading fails, callers
// fall back to the regex parser in symbols.ts.

const parsers = new Map<Lang, Parser>();
const callQueries = new Map<Lang, Query>();
const CALL_QUERY: Record<Lang, string> = {
  python: '(call) @reference.call',
  go: '(call_expression) @reference.call',
  kotlin: '(call_expression) @reference.call',
  c: '(call_expression) @reference.call',
  cpp: '(call_expression) @reference.call',
  java: '(method_invocation) @reference.call\n(object_creation_expression) @reference.call',
  ruby: '(call) @reference.call',
  rust: '(call_expression) @reference.call',
};
const ALL_LANGS: Lang[] = ['python', 'go', 'kotlin', 'c', 'cpp', 'java', 'ruby', 'rust'];
let ready = false;
let runtime: Promise<boolean> | undefined;
const grammarLoads = new Map<Lang, Promise<boolean>>();

function grammarOf(path: string, source?: string): Lang | undefined {
  return languageOf(path, source)?.treeSitter;
}

export function supportsTreeSitter(path: string): boolean {
  const lang = grammarOf(path);
  return lang !== undefined && parsers.has(lang);
}

export function treeSitterReady(): boolean {
  return ready;
}

// Grammars a set of paths needs. A .h file may be parsed as C++.
function languagesFor(paths: Iterable<string>): Lang[] {
  const langs = new Set<Lang>();
  for (const p of paths) {
    const lang = grammarOf(p);
    if (!lang) continue;
    langs.add(lang);
    if (lang === 'c' && /\.h$/i.test(p)) langs.add('cpp');
  }
  return ALL_LANGS.filter((l) => langs.has(l));
}

function initRuntime(): Promise<boolean> {
  runtime ??= Parser.init().then(
    () => true,
    () => {
      runtime = undefined; // retry on the next call
      return false;
    },
  );
  return runtime;
}

// Loads one grammar once; concurrent callers share the load, and a failed load can be retried.
function loadGrammar(lang: Lang): Promise<boolean> {
  if (parsers.has(lang)) return Promise.resolve(true);
  let load = grammarLoads.get(lang);
  if (!load) {
    load = (async () => {
      try {
        const require = createRequire(import.meta.url);
        const language = await Language.load(require.resolve(`tree-sitter-wasms/out/tree-sitter-${lang}.wasm`));
        const parser = new Parser();
        parser.setLanguage(language);
        parsers.set(lang, parser);
        try {
          callQueries.set(lang, new Query(language, CALL_QUERY[lang]));
        } catch {
          // A query mismatch should not remove the usable parser.
        }
        return true;
      } catch {
        // A missing grammar should only lower confidence for that language.
        return false;
      } finally {
        grammarLoads.delete(lang);
      }
    })();
    grammarLoads.set(lang, load);
  }
  return load;
}

// Initializes the tree-sitter runtime and loads grammars in parallel: only those the given
// paths need, or all of them when no paths are given. Parsing is synchronous, so a grammar
// must be loaded here before parseWithTreeSitter can use it. Without paths, resolves true when
// any grammar is usable; with paths, when every grammar they need is.
export async function initTreeSitter(paths?: Iterable<string>): Promise<boolean> {
  const langs = paths ? languagesFor(paths) : ALL_LANGS;
  const missing = langs.filter((l) => !parsers.has(l));
  if (missing.length && (await initRuntime())) await Promise.all(missing.map(loadGrammar));
  ready = parsers.size > 0;
  return paths ? langs.every((l) => parsers.has(l)) : ready;
}

export function parseWithTreeSitter(path: string, text: string, side: 'head' | 'base'): FileSymbols | undefined {
  const lang = grammarOf(path, text);
  const parser = lang && parsers.get(lang);
  if (!lang || !parser) return undefined;
  const tree = parser.parse(text);
  if (!tree) return undefined;
  try {
    const out: FileSymbols = { decls: [], entries: [] };
    const ctx: Ctx = { path, lang, side, out };
    if (lang === 'python') walkPython(tree.rootNode, ctx);
    else if (lang === 'go') walkGo(tree.rootNode, ctx);
    else if (lang === 'kotlin') walkKotlin(tree.rootNode, ctx);
    else if (lang === 'c' || lang === 'cpp') walkC(tree.rootNode, ctx);
    else if (lang === 'java') walkJava(tree.rootNode, ctx);
    else if (lang === 'ruby') walkRuby(tree.rootNode, ctx);
    else walkRust(tree.rootNode, ctx);
    return out;
  } finally {
    tree.delete();
  }
}

// ---------- shared helpers ----------

interface Ctx {
  path: string;
  lang: Lang; // a .h file may be C or C++
  side: 'head' | 'base';
  out: FileSymbols;
}

const kids = (n: Node): Node[] => n.namedChildren.filter((c): c is Node => !!c);
const line = (n: Node) => n.startPosition.row + 1;
const endLine = (n: Node) => n.endPosition.row + 1;
const firstOfType = (n: Node, type: string) => kids(n).find((c) => c.type === type);
const descendants = (n: Node, types: string | string[]) => n.descendantsOfType(types).filter((c): c is Node => !!c);
function callNodes(n: Node, lang: Lang, fallbackTypes: string | string[]): Node[] {
  const query = callQueries.get(lang);
  return query ? query.captures(n).map((capture) => capture.node) : descendants(n, fallbackTypes);
}

function stringValue(n: Node | undefined): string | undefined {
  if (!n) return undefined;
  const content = descendants(n, ['string_content', 'interpreted_string_literal', 'raw_string_literal'])[0];
  const raw = content ? content.text : n.text;
  return raw.replace(/^[`"']|[`"']$/g, '');
}

function addDecl(ctx: Ctx, d: Omit<Decl, 'file' | 'qualified' | 'side'> & { owner?: string }) {
  const { owner, ...rest } = d;
  ctx.out.decls.push({
    ...rest,
    file: ctx.path,
    qualified: `${ctx.path}#${owner ? `${owner}.` : ''}${d.name}`,
    side: ctx.side,
  });
}

function entry(ctx: Ctx, e: EntryHint) {
  ctx.out.entries.push(e);
}

const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];

// ---------- Python ----------

function pyCallee(call: Node): string | undefined {
  const fn = call.childForFieldName('function');
  if (!fn) return undefined;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'attribute') return fn.childForFieldName('attribute')?.text;
  return undefined;
}

function pyCalls(n: Node): string[] {
  return uniq(callNodes(n, 'python', 'call').map(pyCallee));
}

const PY_ROUTE = /^@\s*[\w.]*\.(get|post|put|patch|delete|head|options|route|api_route|websocket)\s*\(/;
const PY_COMMAND = /^@\s*([\w.]*\.)?(command|group)\b|^@\s*click\./;
const PY_TASK = /^@\s*(shared_task|[\w.]*\.task|periodic_task|[\w.]*\.(on_event|cron|schedule))\b/;

function walkPython(n: Node, ctx: Ctx, owner?: string) {
  for (const c of kids(n)) {
    if (c.type === 'decorated_definition') {
      const def = c.childForFieldName('definition') ?? kids(c).find((k) => k.type === 'function_definition' || k.type === 'class_definition');
      if (!def) continue;
      const name = def.childForFieldName('name')?.text;
      for (const dec of kids(c).filter((k) => k.type === 'decorator')) {
        const t = dec.text;
        const m = PY_ROUTE.exec(t);
        if (m) {
          const verb = m[1] === 'route' || m[1] === 'api_route' ? '' : `${m[1].toUpperCase()} `;
          const p = stringValue(descendants(dec, 'string')[0]);
          entry(ctx, { line: line(def), reason: `route ${verb}${p ?? ''}`.trim(), handler: name });
        } else if (PY_COMMAND.test(t)) entry(ctx, { line: line(def), reason: 'CLI command', handler: name });
        else if (PY_TASK.test(t)) entry(ctx, { line: line(def), reason: 'job', handler: name });
      }
      pyDef(def, ctx, owner, line(c));
    } else if (c.type === 'function_definition' || c.type === 'class_definition') {
      pyDef(c, ctx, owner, line(c));
    } else if (c.type === 'if_statement' && /__name__\s*==\s*['"]__main__['"]/.test(c.childForFieldName('condition')?.text ?? '')) {
      const first = callNodes(c, 'python', 'call')[0];
      entry(ctx, { line: line(c), reason: 'CLI entry (__main__)', handler: first ? pyCallee(first) : undefined });
    } else {
      // Django urlpatterns: path('x/', views.index) / re_path(...)
      for (const call of callNodes(c, 'python', 'call')) {
        const callee = pyCallee(call);
        if (callee !== 'path' && callee !== 're_path') continue;
        const args = kids(call.childForFieldName('arguments') ?? call).filter((a) => a.type !== 'comment');
        const p = args[0]?.type === 'string' ? stringValue(args[0]) : undefined;
        const view = args[1];
        if (p === undefined || !view) continue;
        const handler = view.type === 'attribute' ? view.childForFieldName('attribute')?.text : view.type === 'identifier' ? view.text : undefined;
        entry(ctx, { line: line(call), reason: `route ${p}`, handler });
      }
    }
  }
}

function pyDef(def: Node, ctx: Ctx, owner: string | undefined, start: number) {
  const name = def.childForFieldName('name')?.text;
  if (!name) return;
  if (def.type === 'class_definition') {
    addDecl(ctx, { name, owner, kind: 'class', startLine: start, endLine: endLine(def), exported: !name.startsWith('_'), calls: pyCalls(def) });
    const body = def.childForFieldName('body');
    if (body) walkPython(body, ctx, owner ? `${owner}.${name}` : name);
    return;
  }
  addDecl(ctx, {
    name,
    owner,
    kind: owner ? 'method' : 'function',
    startLine: start,
    endLine: endLine(def),
    exported: !name.startsWith('_'),
    calls: pyCalls(def.childForFieldName('body') ?? def),
  });
}

// ---------- Go ----------

function goCallee(call: Node): string | undefined {
  const fn = call.childForFieldName('function');
  if (!fn) return undefined;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'selector_expression') return fn.childForFieldName('field')?.text;
  if (fn.type === 'generic_type' || fn.type === 'index_expression') return fn.namedChildren[0]?.text;
  return undefined;
}

function goCalls(n: Node): string[] {
  return uniq(callNodes(n, 'go', 'call_expression').map(goCallee));
}

const GO_ROUTE = /^(HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any|Get|Post|Put|Patch|Delete|Head|Options|Method|MethodFunc)$/;
const isExported = (name: string) => /^[A-Z]/.test(name);

function goHandlerName(n: Node | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === 'identifier') return n.text;
  if (n.type === 'selector_expression') return n.childForFieldName('field')?.text;
  if (n.type === 'call_expression') return goHandlerName(kids(n.childForFieldName('arguments') ?? n).at(-1));
  return undefined;
}

function walkGo(root: Node, ctx: Ctx) {
  for (const c of kids(root)) {
    if (c.type === 'function_declaration') {
      const name = c.childForFieldName('name')?.text;
      if (!name) continue;
      addDecl(ctx, { name, kind: 'function', startLine: line(c), endLine: endLine(c), exported: isExported(name), calls: goCalls(c) });
      if (name === 'main') entry(ctx, { line: line(c), reason: 'CLI entry (main)', handler: name });
    } else if (c.type === 'method_declaration') {
      const name = c.childForFieldName('name')?.text;
      if (!name) continue;
      const recv = c.childForFieldName('receiver');
      const recvType = recv ? descendants(recv, 'type_identifier')[0]?.text : undefined;
      addDecl(ctx, { name, owner: recvType, kind: 'method', startLine: line(c), endLine: endLine(c), exported: isExported(name), calls: goCalls(c) });
    } else if (c.type === 'type_declaration') {
      for (const spec of kids(c).filter((k) => k.type === 'type_spec' || k.type === 'type_alias')) {
        const name = spec.childForFieldName('name')?.text;
        if (!name) continue;
        const t = spec.childForFieldName('type');
        const kind: DeclKind = t?.type === 'interface_type' ? 'interface' : 'type';
        addDecl(ctx, { name, kind, startLine: line(c), endLine: endLine(c), exported: isExported(name), calls: [] });
      }
    }
  }
  // Entry points: route registrations and cobra commands, wherever they appear.
  for (const call of callNodes(root, 'go', 'call_expression')) {
    const fn = call.childForFieldName('function');
    if (fn?.type !== 'selector_expression') continue;
    const field = fn.childForFieldName('field')?.text ?? '';
    if (!GO_ROUTE.test(field)) continue;
    const args = kids(call.childForFieldName('arguments') ?? call);
    const p = args.find((a) => a.type === 'interpreted_string_literal' || a.type === 'raw_string_literal');
    if (!p) continue;
    const pathText = stringValue(p) ?? '';
    const verb = /^(Handle|HandleFunc|Any|Method|MethodFunc)$/.test(field) ? '' : `${field.toUpperCase()} `;
    entry(ctx, { line: line(call), reason: `route ${verb}${pathText}`.trim(), handler: goHandlerName(args.at(-1)) });
  }
  for (const lit of descendants(root, 'composite_literal')) {
    const type = lit.childForFieldName('type')?.text ?? '';
    if (!/(^|\.)Command$/.test(type) || !/cobra/.test(type)) continue;
    let handler: string | undefined;
    for (const kv of descendants(lit, 'keyed_element')) {
      const [k, v] = kids(kv);
      if (!/^(Run|RunE)$/.test(k?.text ?? '')) continue;
      const inner = v ? (kids(v)[0] ?? v) : undefined;
      handler = inner?.type === 'func_literal' ? goCalls(inner)[0] : goHandlerName(inner);
    }
    entry(ctx, { line: line(lit), reason: 'CLI command', handler });
  }
}

// ---------- Kotlin ----------

function ktCallee(call: Node): string | undefined {
  const fn = kids(call)[0];
  if (!fn) return undefined;
  if (fn.type === 'simple_identifier') return fn.text;
  if (fn.type === 'navigation_expression') {
    const suffix = kids(fn)
      .filter((k) => k.type === 'navigation_suffix')
      .at(-1);
    return suffix ? firstOfType(suffix, 'simple_identifier')?.text : undefined;
  }
  return undefined;
}

function ktCalls(n: Node): string[] {
  // Constructor calls look like plain calls (`Invoice(...)`), which is what we want.
  return uniq(callNodes(n, 'kotlin', 'call_expression').map(ktCallee));
}

const SPRING_MAPPING = /^(Get|Post|Put|Patch|Delete|Request)Mapping$/;
const KTOR_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

interface KtAnnotation {
  name: string;
  args: string[]; // string literal arguments
}

function ktAnnotations(nodes: Node[]): KtAnnotation[] {
  const out: KtAnnotation[] = [];
  for (const n of nodes) {
    for (const a of n.type === 'annotation' ? [n] : descendants(n, 'annotation')) {
      const name = descendants(a, 'type_identifier')[0]?.text;
      if (!name) continue;
      // Detached annotations (`@RequestMapping("/x")` above a top-level class) put their
      // arguments in a sibling parenthesized expression, so read literals from `n` too.
      const scope = n.type === 'prefix_expression' ? n : a;
      const args = descendants(scope, 'string_literal').map((s) => stringValue(s) ?? '');
      out.push({ name, args });
    }
  }
  return out;
}

function ktVisibilityExported(mods: Node | undefined): boolean {
  if (!mods) return true;
  return !descendants(mods, 'visibility_modifier').some((v) => v.text === 'private' || v.text === 'internal');
}

function joinPath(prefix: string | undefined, p: string | undefined): string {
  const a = (prefix ?? '').replace(/\/$/, '');
  const b = p ?? '';
  if (!a) return b;
  return b ? `${a}/${b.replace(/^\//, '')}` : a;
}

function walkKotlin(n: Node, ctx: Ctx, owner?: string, classPrefix?: string) {
  const children = kids(n);
  children.forEach((c, i) => {
    if (c.type === 'class_declaration' || c.type === 'object_declaration') {
      // Annotations on lines above a top-level class can parse as detached prefix
      // expressions; reattach the contiguous run immediately before the class.
      const detached: Node[] = [];
      for (let j = i - 1; j >= 0; j--) {
        const prev = children[j];
        if ((prev.type === 'prefix_expression' || prev.type === 'annotation') && /^@/.test(prev.text)) detached.unshift(prev);
        else break;
      }
      const name = firstOfType(c, 'type_identifier')?.text;
      if (!name) return;
      const mods = firstOfType(c, 'modifiers');
      const anns = ktAnnotations([...detached, ...(mods ? [mods] : [])]);
      const words = c.children.filter((k): k is Node => !!k && !k.isNamed).map((k) => k.type);
      const kind: DeclKind = words.includes('interface') ? 'interface' : firstOfType(c, 'enum_class_body') ? 'enum' : 'class';
      const start = detached.length ? line(detached[0]) : line(c);
      addDecl(ctx, { name, owner, kind, startLine: start, endLine: endLine(c), exported: ktVisibilityExported(mods), calls: ktCalls(c) });
      const mapping = anns.find((a) => a.name === 'RequestMapping');
      const body = firstOfType(c, 'class_body') ?? firstOfType(c, 'enum_class_body');
      if (body) walkKotlin(body, ctx, owner ? `${owner}.${name}` : name, mapping?.args[0] ?? classPrefix);
    } else if (c.type === 'function_declaration') {
      const nameNode = firstOfType(c, 'simple_identifier');
      if (!nameNode) return;
      const name = nameNode.text;
      // Extension function: a receiver type appears before the name (`fun Foo.bar()`).
      const receiver = kids(c).find((k) => k.type === 'user_type' && k.startIndex < nameNode.startIndex);
      const recvName = receiver ? descendants(receiver, 'type_identifier')[0]?.text : undefined;
      const fnOwner = owner ?? recvName;
      const mods = firstOfType(c, 'modifiers');
      addDecl(ctx, {
        name,
        owner: fnOwner,
        kind: owner ? 'method' : 'function',
        startLine: line(c),
        endLine: endLine(c),
        exported: ktVisibilityExported(mods),
        calls: ktCalls(firstOfType(c, 'function_body') ?? c),
      });
      for (const a of ktAnnotations(mods ? [mods] : [])) {
        const m = SPRING_MAPPING.exec(a.name);
        if (m) {
          const verb = m[1] === 'Request' ? '' : `${m[1].toUpperCase()} `;
          entry(ctx, { line: line(c), reason: `route ${verb}${joinPath(classPrefix, a.args[0])}`.trim(), handler: name });
        } else if (/^(KafkaListener|RabbitListener|JmsListener|SqsListener|EventListener|TransactionalEventListener)$/.test(a.name)) {
          entry(ctx, { line: line(c), reason: 'event handler', handler: name });
        } else if (a.name === 'Scheduled') {
          entry(ctx, { line: line(c), reason: 'cron job', handler: name });
        }
      }
      if (name === 'main' && !receiver) entry(ctx, { line: line(c), reason: 'CLI entry (main)', handler: name });
    }
  });
  // Ktor routing DSL: get("/x") { ... } anywhere under this node (top level only, to avoid repeats).
  if (owner === undefined && n.type === 'source_file') {
    for (const call of callNodes(n, 'kotlin', 'call_expression')) {
      // Two shapes: get("/x") { ... } parses as call(call(get, args), lambda);
      // post("/y", ::handler) is a single call.
      const head = kids(call)[0];
      const inner = head?.type === 'call_expression' ? head : undefined;
      const callee = inner ? kids(inner)[0] : head;
      if (callee?.type !== 'simple_identifier' || !KTOR_VERBS.has(callee.text)) continue;
      const argsSuffix = firstOfType(inner ?? call, 'call_suffix');
      const outerSuffix = firstOfType(call, 'call_suffix');
      const p = stringValue(descendants(argsSuffix ?? call, 'string_literal')[0]);
      if (p === undefined) continue;
      const ref = argsSuffix ? descendants(argsSuffix, 'callable_reference')[0] : undefined;
      const hasLambda = !!(outerSuffix && firstOfType(outerSuffix, 'annotated_lambda'));
      if (!hasLambda && !ref) continue;
      const handler = ref ? descendants(ref, 'simple_identifier').at(-1)?.text : undefined;
      entry(ctx, { line: line(call), reason: `route ${callee.text.toUpperCase()} ${p}`, handler });
    }
  }
}

// ---------- C and C++ ----------

function cName(declarator: Node | null | undefined): string | undefined {
  if (!declarator) return undefined;
  if (['identifier', 'field_identifier', 'type_identifier', 'operator_name', 'destructor_name'].includes(declarator.type)) return declarator.text;
  if (declarator.type === 'qualified_identifier') return kids(declarator).at(-1)?.text;
  return cName(declarator.childForFieldName('declarator')) ?? kids(declarator).map(cName).find(Boolean);
}

function cCalls(n: Node, lang: Lang): string[] {
  return uniq(
    callNodes(n, lang, 'call_expression').map((call) => {
      const fn = call.childForFieldName('function');
      if (!fn) return undefined;
      if (fn.type === 'field_expression') return fn.childForFieldName('field')?.text;
      return cName(fn);
    }),
  );
}

function walkC(n: Node, ctx: Ctx, owner?: string, defaultAccess: 'public' | 'private' = 'public') {
  for (const c of kids(n)) {
    if (['class_specifier', 'struct_specifier', 'union_specifier'].includes(c.type)) {
      const name = c.childForFieldName('name')?.text;
      if (name) addDecl(ctx, { name, owner, kind: 'class', startLine: line(c), endLine: endLine(c), exported: true, calls: [] });
      walkC(c.childForFieldName('body') ?? c, ctx, name ?? owner, c.type === 'class_specifier' ? 'private' : 'public');
    } else if (c.type === 'function_definition') {
      const name = cName(c.childForFieldName('declarator'));
      if (!name) continue;
      const qualifiedOwner = c.childForFieldName('declarator')?.text.match(/([A-Za-z_]\w*)::[~\w]+\s*\(/)?.[1];
      const fnOwner = owner ?? qualifiedOwner;
      const access = [...n.text.slice(0, c.startIndex - n.startIndex).matchAll(/\b(public|protected|private)\s*:/g)].at(-1)?.[1];
      addDecl(ctx, {
        name,
        owner: fnOwner,
        kind: fnOwner ? 'method' : 'function',
        startLine: line(c),
        endLine: endLine(c),
        exported: (access ?? defaultAccess) !== 'private' && !/^\s*static\b/.test(c.text),
        calls: cCalls(c.childForFieldName('body') ?? c, ctx.lang),
      });
      if (name === 'main' && !fnOwner) entry(ctx, { line: line(c), reason: 'CLI entry (main)', handler: name });
    } else if (
      ['namespace_definition', 'declaration_list', 'field_declaration_list', 'translation_unit', 'template_declaration', 'linkage_specification', 'preproc_ifdef', 'preproc_if'].includes(c.type)
    ) {
      walkC(c, ctx, owner, defaultAccess);
    }
  }
}

// ---------- Java ----------

function javaCalls(n: Node): string[] {
  return uniq(callNodes(n, 'java', ['method_invocation', 'object_creation_expression']).map((call) => call.childForFieldName(call.type === 'method_invocation' ? 'name' : 'type')?.text));
}

function walkJava(n: Node, ctx: Ctx, owner?: string) {
  for (const c of kids(n)) {
    if (['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration'].includes(c.type)) {
      const name = c.childForFieldName('name')?.text;
      if (!name) continue;
      const kind: DeclKind = c.type === 'interface_declaration' ? 'interface' : c.type === 'enum_declaration' ? 'enum' : 'class';
      addDecl(ctx, { name, owner, kind, startLine: line(c), endLine: endLine(c), exported: !/\bprivate\b/.test(firstOfType(c, 'modifiers')?.text ?? ''), calls: [] });
      walkJava(c.childForFieldName('body') ?? c, ctx, name);
    } else if (c.type === 'method_declaration' || c.type === 'constructor_declaration') {
      const name = c.childForFieldName('name')?.text;
      if (!name) continue;
      const modifiers = firstOfType(c, 'modifiers')?.text ?? '';
      addDecl(ctx, { name, owner, kind: 'method', startLine: line(c), endLine: endLine(c), exported: !/\bprivate\b/.test(modifiers), calls: javaCalls(c.childForFieldName('body') ?? c) });
      if (name === 'main' && /\bstatic\b/.test(modifiers)) entry(ctx, { line: line(c), reason: 'CLI entry (main)', handler: name });
      const mapping = /@(Get|Post|Put|Patch|Delete|Request)Mapping(?:\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)")?/.exec(modifiers);
      if (mapping) entry(ctx, { line: line(c), reason: `route ${mapping[1] === 'Request' ? '' : mapping[1].toUpperCase() + ' '}${mapping[2] ?? ''}`.trim(), handler: name });
    } else if (['program', 'class_body', 'interface_body', 'enum_body', 'record_body'].includes(c.type)) {
      walkJava(c, ctx, owner);
    }
  }
}

// ---------- Ruby ----------

function rubyCalls(n: Node): string[] {
  return uniq(callNodes(n, 'ruby', 'call').map((call) => call.childForFieldName('method')?.text));
}

function walkRuby(n: Node, ctx: Ctx, owner?: string) {
  for (const c of kids(n)) {
    if (c.type === 'class' || c.type === 'module') {
      const name = c.childForFieldName('name')?.text;
      if (!name) continue;
      addDecl(ctx, { name, owner, kind: 'class', startLine: line(c), endLine: endLine(c), exported: true, calls: [] });
      walkRuby(c.childForFieldName('body') ?? c, ctx, name);
    } else if (c.type === 'method' || c.type === 'singleton_method') {
      const name = c.childForFieldName('name')?.text;
      if (!name) continue;
      addDecl(ctx, { name, owner, kind: owner ? 'method' : 'function', startLine: line(c), endLine: endLine(c), exported: !name.startsWith('_'), calls: rubyCalls(c.childForFieldName('body') ?? c) });
    } else if (c.type === 'program' || c.type === 'body_statement') {
      walkRuby(c, ctx, owner);
    }
  }
}

// ---------- Rust ----------

function rustCalls(n: Node): string[] {
  return uniq(
    callNodes(n, 'rust', 'call_expression').map((call) => {
      const fn = call.childForFieldName('function');
      if (!fn) return undefined;
      return fn.type === 'field_expression' ? fn.childForFieldName('field')?.text : fn.text.split('::').pop();
    }),
  );
}

function walkRust(n: Node, ctx: Ctx, owner?: string) {
  for (const c of kids(n)) {
    if (['struct_item', 'enum_item', 'trait_item', 'type_item'].includes(c.type)) {
      const name = c.childForFieldName('name')?.text;
      if (name) addDecl(ctx, { name, owner, kind: c.type === 'enum_item' ? 'enum' : 'type', startLine: line(c), endLine: endLine(c), exported: !!firstOfType(c, 'visibility_modifier'), calls: [] });
    } else if (c.type === 'impl_item') {
      const implOwner = c.childForFieldName('type')?.text ?? descendants(c, 'type_identifier')[0]?.text;
      walkRust(c.childForFieldName('body') ?? c, ctx, implOwner ?? owner);
    } else if (c.type === 'function_item') {
      const name = c.childForFieldName('name')?.text;
      if (!name) continue;
      addDecl(ctx, {
        name,
        owner,
        kind: owner ? 'method' : 'function',
        startLine: line(c),
        endLine: endLine(c),
        exported: !!firstOfType(c, 'visibility_modifier') || name === 'main',
        calls: rustCalls(c.childForFieldName('body') ?? c),
      });
      if (name === 'main' && !owner) entry(ctx, { line: line(c), reason: 'CLI entry (main)', handler: name });
    } else if (['source_file', 'declaration_list', 'mod_item'].includes(c.type)) {
      walkRust(c, ctx, owner);
    }
  }
}
