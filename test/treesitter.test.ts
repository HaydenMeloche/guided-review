import { beforeAll, describe, expect, it } from 'vitest';
import type { DiffFile, Hunk } from '../src/types.js';
import { parseUnifiedDiff } from '../src/diff/parse.js';
import { classifyFiles } from '../src/analysis/kinds.js';
import { defaultRepoConfig } from '../src/config.js';
import { buildSymbolIndex } from '../src/analysis/symbols.js';
import { initTreeSitter, parseWithTreeSitter, treeSitterReady } from '../src/analysis/treesitter.js';
import { extractTestCases, pairTests } from '../src/analysis/tests.js';
import { buildChapters } from '../src/analysis/flows.js';
import { scoreRisk } from '../src/analysis/risk.js';

// A diff that adds each file whole.
function addedDiff(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([p, text]) => {
      const lines = text.replace(/\n$/, '').split('\n');
      return [`diff --git a/${p} b/${p}`, 'new file mode 100644', '--- /dev/null', `+++ b/${p}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');
    })
    .join('\n');
}

function analyze(files: Record<string, string>) {
  const { files: diffFiles, hunks: list } = parseUnifiedDiff(addedDiff(files));
  const hunks: Record<string, Hunk> = Object.fromEntries(list.map((h) => [h.id, h]));
  const readHead = (p: string) => files[p];
  classifyFiles(diffFiles, hunks, { gitattributes: '', readHead, config: defaultRepoConfig() });
  const index = buildSymbolIndex(diffFiles, hunks, { readHead, readBase: () => undefined });
  pairTests(diffFiles, hunks, { root: '/nonexistent', readHead, listFiles: () => Object.keys(files) });
  return { files: diffFiles, hunks, index };
}

const fileOf = (files: DiffFile[], hunks: Record<string, Hunk>, id: string) => files.find((f) => f.path === hunks[id].file)!.path;

const KOTLIN = {
  'src/main/kotlin/com/acme/billing/InvoiceController.kt': `package com.acme.billing

import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/invoices")
class InvoiceController(private val service: InvoiceService) {
    @PostMapping
    fun create(@RequestBody req: CreateInvoice): Invoice {
        return service.createInvoice(req)
    }
}
`,
  'src/main/kotlin/com/acme/billing/InvoiceService.kt': `package com.acme.billing

class InvoiceService(private val repo: InvoiceRepository) {
    fun createInvoice(req: CreateInvoice): Invoice {
        val invoice = Invoice(id = 0, amountCents = req.amountCents)
        return repo.save(invoice)
    }

    private fun audit(i: Invoice) = println(i)
}
`,
  'src/main/kotlin/com/acme/billing/InvoiceRepository.kt': `package com.acme.billing

class InvoiceRepository(private val jdbc: Jdbc) {
    fun save(invoice: Invoice): Invoice {
        jdbc.update("insert into invoices(amount_cents) values (?)", invoice.amountCents)
        return invoice
    }
}
`,
  'src/test/kotlin/com/acme/billing/InvoiceServiceTest.kt': `package com.acme.billing

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

class InvoiceServiceTest {
    @Test
    fun \`creates an invoice\`() {
        val service = InvoiceService(FakeRepo())
        val i = service.createInvoice(CreateInvoice(100))
        assertEquals(100, i.amountCents)
    }

    @Test
    fun rejectsNegative() {
        assertEquals(1, 1)
    }
}
`,
};

const PYTHON = {
  'app/routes/invoices.py': `from fastapi import APIRouter
from app.services.invoices import create_invoice

router = APIRouter()

@router.post("/invoices")
async def create(req: CreateInvoice):
    return await create_invoice(req)
`,
  'app/services/invoices.py': `def create_invoice(req):
    invoice = build(req)
    return save_invoice(invoice)

def save_invoice(invoice):
    db.execute("insert into invoices values (%s)", invoice.amount)
    return invoice

def _helper():
    pass
`,
  'tests/test_invoices.py': `from app.services.invoices import create_invoice

class TestCreate:
    def test_creates(self):
        assert create_invoice(Req(1)).amount == 1

def test_standalone():
    assert True
`,
};

const GO = {
  'cmd/server/main.go': `package main

import "net/http"

func main() {
	http.HandleFunc("/invoices", createInvoiceHandler)
	http.ListenAndServe(":8080", nil)
}

func createInvoiceHandler(w http.ResponseWriter, r *http.Request) {
	store := NewStore()
	store.Save(Invoice{})
}
`,
  'cmd/server/store.go': `package main

type Store struct{ db *DB }

func NewStore() *Store { return &Store{} }

func (s *Store) Save(i Invoice) error {
	return s.db.Exec("insert", i)
}
`,
  'cmd/server/store_test.go': `package main

import "testing"

func TestSave(t *testing.T) {
	s := NewStore()
	if err := s.Save(Invoice{}); err != nil {
		t.Fatal(err)
	}
}
`,
};

beforeAll(async () => {
  expect(await initTreeSitter()).toBe(true);
});

it('does not invent a call edge when changed targets share a name', () => {
  const { index } = analyze({
    'src/run.ts': 'export function run() { return new A().save(); }\n',
    'src/a.ts': 'export class A { save() { return 1; } }\n',
    'src/b.ts': 'export class B { save() { return 2; } }\n',
  });
  expect(index.edges.filter((e) => e.from === 'src/run.ts#run' && e.to.endsWith('.save'))).toEqual([]);
});

describe('tree-sitter: C, C++, Java, Ruby, and Rust', () => {
  it('finds C and C++ functions, methods, calls, and main entry points', () => {
    const c = parseWithTreeSitter('src/main.c', 'int save(int x) { return x; }\nint main(void) { return save(1); }\n', 'head')!;
    expect(c.decls.find((d) => d.name === 'main')?.calls).toContain('save');
    expect(c.entries).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'CLI entry (main)' })]));

    const cpp = parseWithTreeSitter('src/main.cpp', 'class Store { public: int save(int x) { return x; } };\nint main() { Store s; return s.save(1); }\n', 'head')!;
    expect(cpp.decls).toEqual(expect.arrayContaining([expect.objectContaining({ qualified: 'src/main.cpp#Store.save', kind: 'method' })]));
    expect(cpp.decls.find((d) => d.name === 'main')?.calls).toContain('save');
    expect(parseWithTreeSitter('include/store.h', 'class Store { public: int save() { return 1; } };', 'head')?.decls.map((d) => d.name)).toContain('save');
  });

  it('extracts calls from a C++ .h file with the C++ call query', () => {
    const h = parseWithTreeSitter('include/store.h', 'namespace db {\nclass Store {\n public:\n  int save(int x) { return flush(x) + std::max(x, 1); }\n};\n}\n', 'head')!;
    expect(h.decls.find((d) => d.name === 'save')?.calls).toEqual(expect.arrayContaining(['flush', 'max']));
  });

  it('finds Java controller routes and calls through services', () => {
    const files = {
      'src/Api.java': 'class Api {\n  @PostMapping("/invoices")\n  public int create(int x) { return new Service().save(x); }\n}\n',
      'src/Service.java': 'class Service {\n  public int save(int x) { return x; }\n}\n',
      'src/ServiceTest.java': 'import org.junit.jupiter.api.Test;\nclass ServiceTest {\n  @Test\n  void saves() { new Service().save(1); }\n}\n',
    };
    const { files: classified, hunks, index } = analyze(files);
    expect(classified.find((f) => f.path === 'src/ServiceTest.java')?.kind).toBe('test');
    expect(index.entries).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'route POST /invoices', symbol: 'src/Api.java#Api.create' })]));
    expect(index.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: 'src/Api.java#Api.create', to: 'src/Service.java#Service.save', source: 'name-match' })]));
    expect(
      Object.values(hunks)
        .find((h) => h.file === 'src/Service.java')
        ?.tests.some((t) => t.testName === 'saves'),
    ).toBe(true);
  });

  it('finds Ruby methods and Rust functions', () => {
    const ruby = parseWithTreeSitter('app/api.rb', 'class Api\n  def create(x)\n    save(x)\n  end\n  def save(x)\n    x\n  end\nend\n', 'head')!;
    expect(ruby.decls.find((d) => d.name === 'create')).toEqual(expect.objectContaining({ qualified: 'app/api.rb#Api.create', calls: ['save'] }));
    const rust = parseWithTreeSitter('src/main.rs', 'pub fn save(x: i32) -> i32 { x }\nfn main() { save(1); }\n', 'head')!;
    expect(rust.decls.find((d) => d.name === 'main')?.calls).toContain('save');
    expect(rust.entries).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'CLI entry (main)' })]));
  });

  it('links C++ Google Test cases and Ruby RSpec examples to changed code', () => {
    const cpp = analyze({
      'src/store.cpp': 'int save(int value) { return value; }\n',
      'src/store_test.cpp': '#include <gtest/gtest.h>\nTEST(Store, Saves) { EXPECT_EQ(save(2), 2); }\n',
    });
    expect(cpp.files.find((f) => f.path === 'src/store_test.cpp')?.kind).toBe('test');
    expect(
      Object.values(cpp.hunks)
        .find((h) => h.file === 'src/store.cpp')
        ?.tests.some((t) => t.testName === 'Store.Saves'),
    ).toBe(true);

    const ruby = analyze({
      'app/invoice.rb': 'def create_invoice(input)\n  input\nend\n',
      'spec/invoice_spec.rb': 'describe Invoice do\n  it "creates an invoice" do\n    create_invoice(1)\n  end\nend\n',
    });
    expect(
      Object.values(ruby.hunks)
        .find((h) => h.file === 'app/invoice.rb')
        ?.tests.some((t) => t.testName === 'creates an invoice'),
    ).toBe(true);
  });
});

describe('tree-sitter: Kotlin', () => {
  it('parses Spring controllers, classes, methods and extension functions', () => {
    const src = `${KOTLIN['src/main/kotlin/com/acme/billing/InvoiceController.kt']}
fun String.shout(): String = uppercase()
internal fun hidden() {}
interface Repo { fun save(i: Invoice): Invoice }
enum class Status { DRAFT, PAID }
fun Application.module() { routing { get("/health") { call.respond("ok") } } }
`;
    const r = parseWithTreeSitter('C.kt', src, 'head')!;
    const by = Object.fromEntries(r.decls.map((d) => [d.qualified.split('#')[1], d]));
    expect(by['InvoiceController']).toMatchObject({ kind: 'class', startLine: 5 }); // annotations included
    expect(by['InvoiceController.create']).toMatchObject({ kind: 'method', exported: true, calls: ['createInvoice'] });
    expect(by['String.shout']).toMatchObject({ kind: 'function' });
    expect(by['hidden'].exported).toBe(false);
    expect(by['Repo'].kind).toBe('interface');
    expect(by['Status'].kind).toBe('enum');
    expect(r.entries).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'route POST /invoices', handler: 'create' }), expect.objectContaining({ reason: 'route GET /health' })]));
  });

  it('builds a controller → service → repository flow with name-matched edges', () => {
    const { files, hunks, index } = analyze(KOTLIN);
    expect(index.lowConfidence).toBe(false);
    expect(index.edges.length).toBeGreaterThanOrEqual(2);
    expect(index.edges.every((e) => e.source === 'name-match')).toBe(true);
    expect(index.entries.some((e) => e.reason === 'route POST /invoices')).toBe(true);

    const { chapters } = buildChapters(files, hunks, index);
    const flow = chapters.find((c) => c.kind === 'flow')!;
    const order = flow.hunkIds.map((id) => fileOf(files, hunks, id).split('/').pop());
    expect(order.slice(0, 3)).toEqual(['InvoiceController.kt', 'InvoiceService.kt', 'InvoiceRepository.kt']);
  });

  it('pairs JUnit tests across the src/main ↔ src/test mirror', () => {
    const { files, hunks } = analyze(KOTLIN);
    const svc = Object.values(hunks).find((h) => h.file.endsWith('InvoiceService.kt'))!;
    expect(files.find((f) => f.path.endsWith('InvoiceServiceTest.kt'))!.kind).toBe('test');
    expect(svc.tests.map((t) => t.testName)).toContain('creates an invoice');
    expect(svc.tests.find((t) => t.testName === 'creates an invoice')!.source).toBe('name-match');
  });

  it('extracts JUnit and kotest cases', () => {
    const cases = extractTestCases(
      'FooSpec.kt',
      `class FooSpec : StringSpec({
    "adds numbers" {
        add(1, 2) shouldBe 3
    }
    test("subtracts") { sub(2, 1) shouldBe 1 }
})
class FooTest {
    @Test
    fun \`handles nulls\`() {
        assertNull(foo(null))
    }
    @ParameterizedTest @ValueSource(ints = [1])
    fun repeats(x: Int) { check(x) }
    fun helper() {}
}`,
    );
    expect(cases.map((c) => c.name)).toEqual(['adds numbers', 'subtracts', 'handles nulls', 'repeats']);
    expect(cases[2]).toMatchObject({ startLine: 9, endLine: 11 });
  });

  it('scores coroutine and transaction risk', () => {
    const { files, hunks } = analyze({
      'src/main/kotlin/Job.kt': `class Job {
    @Transactional
    fun run() = runBlocking { launch { work() } }
}
`,
    });
    const h = Object.values(hunks)[0];
    const r = scoreRisk(h, files[0]);
    expect(r.reasons).toEqual(expect.arrayContaining(['coroutines', 'transaction boundary']));
  });
});

describe('tree-sitter: Python', () => {
  it('finds FastAPI routes, functions and methods with name-matched calls', () => {
    const { files, hunks, index } = analyze(PYTHON);
    expect(index.lowConfidence).toBe(false);
    const entry = index.entries.find((e) => e.reason === 'route POST /invoices');
    expect(entry?.symbol).toBe('app/routes/invoices.py#create');
    expect(index.edges).toEqual(
      expect.arrayContaining([
        { from: 'app/routes/invoices.py#create', to: 'app/services/invoices.py#create_invoice', source: 'name-match' },
        { from: 'app/services/invoices.py#create_invoice', to: 'app/services/invoices.py#save_invoice', source: 'name-match' },
      ]),
    );
    const flow = buildChapters(files, hunks, index).chapters.find((c) => c.kind === 'flow')!;
    expect(flow.hunkIds.map((id) => hunks[id].file)[0]).toBe('app/routes/invoices.py');
  });

  it('extracts pytest functions and TestX methods and pairs tests/test_x.py', () => {
    expect(extractTestCases('tests/test_invoices.py', PYTHON['tests/test_invoices.py']).map((c) => c.name)).toEqual(['TestCreate::test_creates', 'test_standalone']);
    const { hunks } = analyze(PYTHON);
    const svc = Object.values(hunks).find((h) => h.file === 'app/services/invoices.py')!;
    expect(svc.tests.map((t) => t.testName)).toContain('TestCreate::test_creates');
  });

  it('flags shell=True and pickle', () => {
    const { files, hunks } = analyze({ 'app/x.py': 'import subprocess, pickle\nsubprocess.run(cmd, shell=True)\nobj = pickle.loads(data)\n' });
    expect(scoreRisk(Object.values(hunks)[0], files[0]).reasons).toEqual(expect.arrayContaining(['runs a shell command', 'deserializes untrusted data']));
  });
});

describe('tree-sitter: Go', () => {
  it('finds http handlers, methods qualified by receiver, and name-matched calls', () => {
    const { index } = analyze(GO);
    expect(index.lowConfidence).toBe(false);
    expect(index.entries).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'route /invoices', symbol: 'cmd/server/main.go#createInvoiceHandler' })]));
    expect(index.decls.map((d) => d.qualified)).toEqual(expect.arrayContaining(['cmd/server/store.go#Store.Save', 'cmd/server/store.go#Store']));
    expect(index.edges).toEqual(expect.arrayContaining([{ from: 'cmd/server/main.go#createInvoiceHandler', to: 'cmd/server/store.go#Store.Save', source: 'name-match' }]));
  });

  it('pairs _test.go cases that call the function', () => {
    const { hunks } = analyze(GO);
    const store = Object.values(hunks).find((h) => h.file === 'cmd/server/store.go')!;
    expect(store.tests.find((t) => t.testName === 'TestSave')?.source).toBe('name-match');
  });

  it('recognises gin routes and cobra commands', () => {
    const r = parseWithTreeSitter(
      'x.go',
      `package main
func setup(r *gin.Engine, h *Handler) {
	r.GET("/invoices", h.List)
	cmd := &cobra.Command{Use: "serve", RunE: func(c *cobra.Command, a []string) error { return serve() }}
	_ = cmd
}
`,
      'head',
    )!;
    expect(r.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'route GET /invoices', handler: 'List' }), expect.objectContaining({ reason: 'CLI command', handler: 'serve' })]),
    );
  });
});

describe('kinds for JVM, Python and Go builds', () => {
  it('classifies build files as config and generated sources as generated', () => {
    const { files } = analyze({
      'build.gradle.kts': 'plugins { kotlin("jvm") }\n',
      'gradle/libs.versions.toml': '[versions]\n',
      'app/build/generated/ksp/main/kotlin/Foo.kt': 'class Foo\n',
      'src/main/kotlin/ApiGenerated.kt': 'class ApiGenerated\n',
      'setup.py': 'setup()\n',
      'go.mod': 'module x\n',
    });
    const kind = (p: string) => files.find((f) => f.path === p)!.kind;
    expect(kind('build.gradle.kts')).toBe('config');
    expect(kind('gradle/libs.versions.toml')).toBe('config');
    expect(kind('app/build/generated/ksp/main/kotlin/Foo.kt')).toBe('generated');
    expect(kind('src/main/kotlin/ApiGenerated.kt')).toBe('generated');
    expect(kind('setup.py')).toBe('config');
    expect(kind('go.mod')).toBe('config');
  });
});

it('reports tree-sitter as ready', () => {
  expect(treeSitterReady()).toBe(true);
});
