/**
 * 约定测试化：把根 AGENTS.md 里能机械核对的约定写成断言，测试名引用它的原句。
 *
 * 规则按仓库现状定。白名单列的是「今天恰好例外的文件」，并且断言它们**仍然是**例外：
 * 修好一个例外就必须把它从白名单删掉，白名单不会悄悄变成长期豁免。
 *
 * 只扫源码文本，不加载被测模块、不碰数据库：CI 的 check 作业里没有 data/ 也能跑。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ENTITY_KINDS } from "@/db/schema";

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join("/");
const read = (file: string): string => fs.readFileSync(file, "utf8");
const isSource = (file: string): boolean => /\.tsx?$/.test(file);
const isTest = (file: string): boolean => /\.test\.tsx?$/.test(file);

// 本文件的测试名引用了被禁的写法（await db.、"use server"），扫描集要把自己排除。
const SELF = path.join(ROOT, "src", "rules.test.ts");
const sourceFiles = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "scripts"))].filter(
  (file) => isSource(file) && file !== SELF,
);

const apiRoutes = sourceFiles.filter(
  (file) => rel(file).startsWith("src/app/api/") && path.basename(file) === "route.ts",
);

/** 一行 `a.b.c: <file>` 的违规清单，`toEqual([])` 失败时直接列出位置。 */
function violations(files: string[], check: (content: string, file: string) => string[]): string[] {
  return files.flatMap((file) =>
    check(read(file), file).map((detail) => `${rel(file)}: ${detail}`),
  );
}

describe("AGENTS.md · Repository layout", () => {
  it('src/app/api 的每个 route.ts 都 `export const dynamic = "force-dynamic"`', () => {
    expect(apiRoutes.length).toBeGreaterThan(0);
    const missing = apiRoutes
      .filter((file) => !read(file).includes('export const dynamic = "force-dynamic";'))
      .map(rel);
    expect(missing).toEqual([]);
  });
});

describe("AGENTS.md · Conventions · handle()", () => {
  /**
   * 「Every API route body runs inside handle() from @/lib/http. One does not:
   * api/runs/[id]/events returns a raw SSE Response — do not copy it.」
   */
  const EXEMPT = ["src/app/api/runs/[id]/events/route.ts"];
  const METHOD_NAME_RE = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/;
  // Next 认的是**对外**的导出名，三种写法都要认：函数声明、`export const GET = …`、
  // `export { post as POST }`（后者要回去找 post 的声明）。
  const EXPORTED_DECL_RE =
    /^export\s+(?:(?:async\s+)?function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  const EXPORT_CLAUSE_RE = /^export\s*\{([^}]*)\}/gm;
  const LEADING_TRIVIA_RE = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/;

  /** 对外方法名 → 声明它的本地名 */
  const exportedMethods = (content: string): Map<string, string> => {
    const out = new Map<string, string>();
    for (const match of content.matchAll(EXPORTED_DECL_RE))
      if (METHOD_NAME_RE.test(match[1])) out.set(match[1], match[1]);
    for (const clause of content.matchAll(EXPORT_CLAUSE_RE))
      for (const spec of clause[1].split(",")) {
        const parts = spec.split(/\bas\b/).map((part) => part.trim());
        const local = parts[0];
        const exported = parts.length > 1 ? parts[parts.length - 1] : local;
        if (local && exported && METHOD_NAME_RE.test(exported)) out.set(exported, local);
      }
    return out;
  };

  /**
   * 从声明处扫到函数体开头，返回体内第一段有效代码；箭头的表达式体补一个 return 以便同一条断言。
   * 扫描**不越过本条语句**：`export const GET = raw;` 这种别名要回去解析 raw，越过分号一路扫到
   * 下一个方法的 `{`，就会把别人的体当成自己的（Codex 对 #50 的四轮复审）。
   * 只按圆 / 方括号配平找体外的第一个 `{` 或 `=>`；定位不到就返回 null，断言报「定位不到函数体」
   * 而不是悄悄放行。
   */
  const bodyOf = (content: string, local: string, seen = new Set<string>()): string | null => {
    if (seen.has(local)) return null; // 别名成环
    seen.add(local);
    const decl = new RegExp(
      String.raw`^(?:export\s+)?(?:(?:async\s+)?function\s+${local}\b|(?:const|let|var)\s+${local}\s*=)`,
      "m",
    ).exec(content);
    if (!decl) return null;
    const init = decl.index + decl[0].length;
    let depth = 0;
    for (let i = init; i < content.length; i += 1) {
      const ch = content[i];
      if (ch === "(" || ch === "[") depth += 1;
      else if (ch === ")" || ch === "]") depth -= 1;
      else if (depth !== 0) continue;
      else if (ch === "{") return content.slice(i + 1);
      else if (ch === "=" && content[i + 1] === ">") {
        const rest = content.slice(i + 2).replace(LEADING_TRIVIA_RE, "");
        return rest.startsWith("{") ? rest.slice(1) : `return ${rest}`;
      } else if (ch === ";" || ch === "\n") {
        // 到这里还没见到函数字面量：整段初始化只是一个名字就是别名，回去解析它
        const alias = content.slice(init, i).trim();
        if (/^[A-Za-z_$][\w$]*$/.test(alias)) return bodyOf(content, alias, seen);
        // 分号结束了却既不是函数字面量也不是别名；换行则可能只是初始化还没写完，继续扫
        if (ch === ";") return null;
      }
    }
    return null;
  };

  it("唯一例外之外的每个 route，每个导出方法体都以 return handle( 起头并从 @/lib/http 导入 handle", () => {
    const files = apiRoutes.filter((file) => !EXEMPT.includes(rel(file)));
    const found = violations(files, (content) => {
      const out: string[] = [];
      const methods = exportedMethods(content);
      if (methods.size === 0) out.push("没有导出任何 HTTP 方法");
      // 逐个方法看体的**第一句**，不是全文件数 return handle( 的个数：数个数的话，一个方法里
      // 「先 return new Response(…) 再 return handle(…)」两条分支能把计数配平（Codex 对 #50 的三轮复审）。
      for (const [exported, local] of methods) {
        const body = bodyOf(content, local);
        if (body === null) {
          out.push(`${exported} 定位不到函数体（声明写法超出扫描能力）`);
          continue;
        }
        if (!body.replace(LEADING_TRIVIA_RE, "").startsWith("return handle("))
          out.push(`${exported} 的方法体第一句不是 return handle(`);
      }
      if (!/import \{[^}]*\bhandle\b[^}]*\} from "@\/lib\/http"/.test(content))
        out.push("没有从 @/lib/http 导入 handle");
      return out;
    });
    expect(found).toEqual([]);
  });

  it("白名单里的例外 route 仍然存在、仍然不用 handle()；修好了就把它从白名单删掉", () => {
    for (const relPath of EXEMPT) {
      const file = path.join(ROOT, relPath);
      expect(fs.existsSync(file), `${relPath} 不存在，白名单已过期`).toBe(true);
      expect(/\bhandle\(/.test(read(file)), `${relPath} 已经用了 handle()，白名单要缩`).toBe(false);
    }
  });
});

describe("AGENTS.md · Conventions · better-sqlite3 is synchronous", () => {
  it("「Drizzle calls end in .get() / .all() / .run(); never await db.…」——src 与 scripts 里没有 await db. / await tx.", () => {
    const found = violations(sourceFiles, (content) =>
      [...content.matchAll(/\bawait\s+(?:db|tx)\s*\./g)].map(
        (match) => `第 ${content.slice(0, match.index).split("\n").length} 行：${match[0].trim()}`,
      ),
    );
    expect(found).toEqual([]);
  });
});

describe("AGENTS.md · Checks · 单元测试的内存库", () => {
  it("「内存库一律经 createTestDb() 从 schema.ts 生成，不手写 CREATE TABLE」——src 下的测试里没有 CREATE TABLE", () => {
    // 手写子集 DDL 会在 schema 变化时悄悄失真：漏掉的外键让级联不发生、漏掉的唯一键让
    // 重复行静默落库，测试照样绿。白名单为空——出现例外就是要修，不是要加进来。
    const testFiles = sourceFiles.filter(isTest);
    expect(testFiles.length).toBeGreaterThan(0);
    const found = violations(testFiles, (content) =>
      [...content.matchAll(/CREATE\s+TABLE/gi)].map(
        (match) => `第 ${content.slice(0, match.index).split("\n").length} 行手写了建表语句`,
      ),
    );
    expect(found).toEqual([]);
  });
});

describe("AGENTS.md · Conventions · client / server boundary", () => {
  /**
   * 「Client code imports nothing from @/server or @/db, import type included.」豁免曾为
   * @/server/monitor/types 而开，客户端一处都没用过（前端在 src/app/monitor/lib.ts 自带视图模型），
   * 2026-09 收紧成零例外：客户端要用的类型先搬进 src/lib/。
   */
  // 客户端代码 = 含 "use client" 的文件 ∪ src/app（api/ 除外）与 src/components 下没有指令的共享模块：
  // 后者被客户端页面 import，同样不能把 @/server 的运行时值带进浏览器包。
  const clientFiles = sourceFiles.filter((file) => {
    if (isTest(file)) return false;
    if (/["']use client["']/.test(read(file).slice(0, 600))) return true;
    const r = rel(file);
    return (
      (r.startsWith("src/app/") && !r.startsWith("src/app/api/")) || r.startsWith("src/components/")
    );
  });
  // tool-form.ts 的 TOOL_EXECUTE_TEMPLATE 是给 Tool 作者的源码骨架，字符串里有一行
  // `import type { ToolContext } from "@/server/harness/tool-contract"`（类型导入，运行时被擦掉）；
  // 只扫它模板之前的真实导入。
  const TEMPLATE_CARRIER = "src/app/tools/tool-form.ts";
  const scanText = (file: string): string => {
    const content = read(file);
    if (rel(file) !== TEMPLATE_CARRIER) return content;
    // 截在声明本身而不是第一次提到这个名字的地方：前面的注释提一句不该把盲区上移
    const cut = content.indexOf("export const TOOL_EXECUTE_TEMPLATE = `");
    expect(
      cut,
      `${TEMPLATE_CARRIER} 里找不到 TOOL_EXECUTE_TEMPLATE 的声明，豁免失效`,
    ).toBeGreaterThan(0);
    return content.slice(0, cut);
  };
  const SERVER_SPECIFIER = /^@\/(?:server|db)(?:\/|$)/;
  // `[^;]*?` 把匹配限制在同一条语句里：`export type { X };` 没有 from，不能吞到下一条 import 的 from。
  const IMPORT_FROM_RE = /^(?:import|export)\s+(type\s+)?[^;]*?\s+from\s+["']([^"']+)["']/gm;
  const SIDE_EFFECT_IMPORT_RE = /^import\s+["']([^"']+)["']/gm;
  const DYNAMIC_IMPORT_RE = /\bimport\(\s*["']([^"']+)["']/g;

  it('含 "use client" 的文件与 src/app、src/components 下的共享模块不从 @/server 或 @/db 导入任何东西（含 import type）', () => {
    expect(clientFiles.length).toBeGreaterThan(0);
    const found = violations(clientFiles, (raw, file) => {
      const content = file === undefined ? raw : scanText(file);
      const out: string[] = [];
      for (const match of content.matchAll(IMPORT_FROM_RE)) {
        const [, typeOnly, specifier] = match;
        if (!SERVER_SPECIFIER.test(specifier)) continue;
        out.push(typeOnly ? `import type 来自 ${specifier}` : `从 ${specifier} 导入了运行时值`);
      }
      for (const match of content.matchAll(SIDE_EFFECT_IMPORT_RE)) {
        if (SERVER_SPECIFIER.test(match[1])) out.push(`副作用导入 ${match[1]}`);
      }
      for (const match of content.matchAll(DYNAMIC_IMPORT_RE)) {
        if (SERVER_SPECIFIER.test(match[1])) out.push(`动态导入 ${match[1]}`);
      }
      return out;
    });
    expect(found).toEqual([]);
  });

  it('「There are no Server Actions. Every mutation is a fetch to /api/*」——src 下没有 "use server"', () => {
    const found = sourceFiles.filter((file) => /["']use server["']/.test(read(file))).map(rel);
    expect(found).toEqual([]);
  });
});

describe("AGENTS.md · Conventions · globalThis", () => {
  /**
   * 「Process-level mutable state is parked on globalThis under an ontoflow-prefixed key so HMR
   * cannot lose it.」既查通过别名读写的属性，也查 cast 出来的类型字面量 / 接口声明的顶层键。
   */
  const KEY_RE = /^ontoflow[A-Z]/;
  const globalFiles = sourceFiles.filter(
    (file) => !isTest(file) && read(file).includes("globalThis"),
  );

  /** 从 `{` 起取平衡花括号内的正文（不含外层括号）。 */
  function braceBody(text: string, open: number): string {
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(open + 1, i);
      }
    }
    throw new Error("花括号不平衡");
  }

  /** 类型正文里深度为 0 的属性名（嵌套对象类型的键不算）。 */
  function topLevelKeys(body: string): string[] {
    const keys: string[] = [];
    let depth = 0;
    for (const line of body.split("\n")) {
      if (depth === 0) {
        const match = /^\s*(?:readonly\s+)?(\w+)\??\s*:/.exec(line);
        if (match) keys.push(match[1]);
      }
      depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
    }
    return keys;
  }

  /** 从 `(` 起找配对的右括号下标；`(globalThis as …).prop` 这种不经别名的内联 cast 靠它定位属性名。 */
  function parenClose(text: string, open: number): number {
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "(") depth += 1;
      else if (text[i] === ")") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    throw new Error("圆括号不平衡");
  }

  /** `globalThis as …` 之后声明的键：内联类型字面量，或同文件里的 interface / type 别名。 */
  function declaredKeys(content: string, afterAs: number): string[] {
    const tail = content.slice(afterAs);
    const inline = /^\s*(?:unknown\s+as|typeof\s+globalThis\s*&)\s*\{/.exec(tail);
    if (inline) return topLevelKeys(braceBody(tail, inline[0].length - 1));
    const named = /^\s*(?:unknown\s+as\s+)?(\w+)/.exec(tail);
    if (!named) return [];
    const decl = new RegExp(`(?:interface|type)\\s+${named[1]}\\b[^{]*\\{`).exec(content);
    if (!decl) return [];
    return topLevelKeys(braceBody(content, decl.index + decl[0].length - 1));
  }

  it("挂在 globalThis 上的每个键都以 ontoflow 开头（直接访问、别名访问、内联 cast 访问、声明的类型键四路都查）", () => {
    expect(globalFiles.length).toBeGreaterThan(0);
    let casts = 0;
    const found = violations(globalFiles, (content) => {
      const out: string[] = [];
      for (const match of content.matchAll(/\bglobalThis\.(\w+)/g)) {
        if (!KEY_RE.test(match[1])) out.push(`globalThis.${match[1]}`);
      }
      for (const match of content.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*globalThis\s+as\b/g)) {
        const alias = match[1];
        for (const access of content.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, "g"))) {
          if (!KEY_RE.test(access[1])) out.push(`${alias}.${access[1]}`);
        }
      }
      for (const match of content.matchAll(/\(\s*globalThis\s+as\b/g)) {
        const access = /^\s*\.(\w+)/.exec(content.slice(parenClose(content, match.index) + 1));
        if (access && !KEY_RE.test(access[1])) out.push(`(globalThis as …).${access[1]}`);
      }
      for (const match of content.matchAll(/\bglobalThis\s+as\b/g)) {
        casts += 1;
        for (const key of declaredKeys(content, match.index + match[0].length)) {
          if (!KEY_RE.test(key)) out.push(`声明的键 ${key}`);
        }
      }
      return out;
    });
    expect(found).toEqual([]);
    expect(casts, "至少应有 ontoflowDb 这一处 globalThis as …").toBeGreaterThan(0);
  });
});

describe("AGENTS.md · Conventions · revision restore", () => {
  /**
   * 「a route that can reach revision restore carries import "@/server/writers"; or restore
   * silently answers 501」——注册发生在 writers/index.ts 模块加载时。
   */
  it('引用 restoreRevision 的 route 带 import "@/server/writers";', () => {
    const restoreRoutes = apiRoutes.filter((file) => /\brestoreRevision\b/.test(read(file)));
    expect(restoreRoutes.map(rel)).toContain("src/app/api/revisions/[revId]/restore/route.ts");
    const missing = restoreRoutes
      .filter((file) => !read(file).includes('import "@/server/writers";'))
      .map(rel);
    expect(missing).toEqual([]);
  });

  it("「rollback replays the same write<Kind>()」——writers/index.ts 为每种 EntityKind 注册了写入器", () => {
    const registry = read(path.join(ROOT, "src/server/writers/index.ts"));
    const registered = [...registry.matchAll(/registerEntityWriter\("([a-z_]+)"/g)]
      .map((m) => m[1])
      .sort();
    expect(registered).toEqual([...ENTITY_KINDS].sort());
  });
});

describe("AGENTS.md · Conventions · library list GETs", () => {
  /**
   * 「The five library list GETs and /api/runs return { items, total, page, pageSize }（/api/runs
   * 另带 summary），built from parseListQuery + selectLibraryPage + listEnvelope in
   * src/server/writers/list.ts；/api/runs 自己组信封，但分页参数复用同一个 parsePageQuery。」
   */
  const LIBRARIES = ["actions", "skills", "tools", "object-types", "workflows"];

  it("五个库的列表 route 都从 @/server/writers/list 拿 parseListQuery、selectLibraryPage、listEnvelope", () => {
    const found = LIBRARIES.flatMap((library) => {
      const content = read(path.join(ROOT, `src/app/api/${library}/route.ts`));
      const block = /import \{([^}]*)\} from "@\/server\/writers\/list"/.exec(content)?.[1] ?? "";
      return ["parseListQuery", "selectLibraryPage", "listEnvelope"]
        .filter((name) => !new RegExp(`\\b${name}\\b`).test(block))
        .map((name) => `${library}: 未从 @/server/writers/list 导入 ${name}`);
    });
    expect(found).toEqual([]);
  });

  it("运行列表 route 复用 parsePageQuery，并返回同一套信封字段外加 summary", () => {
    const content = read(path.join(ROOT, "src/app/api/runs/route.ts"));
    const block = /import \{([^}]*)\} from "@\/server\/writers\/list"/.exec(content)?.[1] ?? "";
    // 分页默认值与上限只能有一个出处；自己再解析一遍 page/pageSize 就是第二处
    expect(block, "api/runs/route.ts 未从 @/server/writers/list 导入 parsePageQuery").toMatch(
      /\bparsePageQuery\b/,
    );
    const envelope = /return NextResponse\.json\(\{([\s\S]*?)\n {4}\}\);/.exec(content)?.[1] ?? "";
    for (const key of ["items", "total", "page", "pageSize", "summary"]) {
      expect(envelope, `api/runs 的返回信封缺 ${key}`).toMatch(new RegExp(`\\b${key}\\b`));
    }
  });
});

describe("AGENTS.md · Conventions · raw SQL", () => {
  /**
   * 「Raw SQL goes through drizzle's sql tag … and only where the query builder cannot express
   * the aggregate」。允许范围按现状定：monitor/cleanup.ts 与 monitor/health.ts 的聚合、
   * writers/list.ts 的 LIKE 搜索、engine/action.ts 的按会话 SUM 汇总、
   * engine/events.ts 的 json_extract 查工具名、revisions.ts 的 max(version_no)、
   * api/runs/route.ts 的运行列表合计。
   * 两种拼法都要抓：sql`…` 与 sql<T>`…`——只认前者时后三处漏网，本测试曾空绿。
   */
  // 泛型参数里可以再套尖括号（sql<Record<string, number>>`…`），所以只在反引号与分号前停
  const RAW_SQL = /\bsql(<[^`;]*>)?`/;
  const ALLOWED_FILES = [
    "src/server/monitor/cleanup.ts",
    "src/server/monitor/health.ts",
    "src/server/writers/list.ts",
    "src/server/engine/action.ts",
    "src/server/engine/events.ts",
    "src/server/revisions.ts",
    "src/app/api/runs/route.ts",
  ];
  const ALLOWED = (file: string): boolean => ALLOWED_FILES.includes(file);

  it("sql` / sql<T>` 标签只出现在白名单点名的七个文件里", () => {
    const found = sourceFiles
      .filter((file) => !isTest(file) && RAW_SQL.test(read(file)))
      .map(rel)
      .filter((file) => !ALLOWED(file));
    expect(found).toEqual([]);
  });

  it("白名单点名的文件今天仍在用原生 SQL：改回查询构建器就把它从名单里删掉", () => {
    const listed = sourceFiles.filter((file) => ALLOWED_FILES.includes(rel(file)));
    expect(listed.map(rel).sort()).toEqual([...ALLOWED_FILES].sort());
    expect(listed.filter((file) => !RAW_SQL.test(read(file))).map(rel)).toEqual([]);
  });

  it("「User input inside LIKE is escaped and paired with escape '\\'」——插值进 like 的那一行带 escape '\\'", () => {
    const found = violations(sourceFiles, (content) =>
      content
        .split("\n")
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /\blike\s+\$\{/i.test(line) && !/escape\s+'\\\\'/.test(line))
        .map(({ index, line }) => `第 ${index + 1} 行：${line.trim()}`),
    );
    expect(found).toEqual([]);
  });
});

describe("AGENTS.md · The harness seam · Pin @deepseek-ai versions exactly", () => {
  it("package.json 里每个 @deepseek-ai/* 依赖与 override 都是精确版本，没有 ^ / ~ / latest", () => {
    const pkg = JSON.parse(read(path.join(ROOT, "package.json"))) as Record<
      string,
      Record<string, string> | undefined
    >;
    const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
    const found: string[] = [];
    for (const section of ["dependencies", "devDependencies", "overrides"]) {
      for (const [name, version] of Object.entries(pkg[section] ?? {})) {
        if (
          name.startsWith("@deepseek-ai/") &&
          typeof version === "string" &&
          !EXACT.test(version)
        ) {
          found.push(`${section}.${name}: ${version}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});

describe("AGENTS.md · Decisions and the glossary · skills 双树", () => {
  it("「.claude/skills/ and .codex/skills/ hold byte-identical copies of all five skills」", () => {
    const claude = path.join(ROOT, ".claude", "skills");
    const codex = path.join(ROOT, ".codex", "skills");
    const listing = (root: string): string[] =>
      walk(root)
        .map((file) => path.relative(root, file).split(path.sep).join("/"))
        .sort();
    const claudeFiles = listing(claude);
    expect(claudeFiles.length).toBeGreaterThan(0);
    expect(listing(codex)).toEqual(claudeFiles);
    const differing = claudeFiles.filter(
      (file) =>
        !fs.readFileSync(path.join(claude, file)).equals(fs.readFileSync(path.join(codex, file))),
    );
    expect(differing).toEqual([]);
  });
});

describe("AGENTS.md · Decisions and the glossary · docs/simplifications 记录树", () => {
  /**
   * 「A simplification candidate is one record under docs/simplifications/ (proposed / done /
   * rejected, skeleton pinned by src/rules.test.ts)」：状态目录、文件名与骨架按
   * docs/simplifications/README.md 机械核对，状态行必须与所在目录一致，rejected 必须带理由。
   */
  const ROOT_DIR = path.join(ROOT, "docs", "simplifications");
  const STATES = ["proposed", "done", "rejected"] as const;
  const SECTIONS = ["## 问题", "## 提议", "## 放弃了什么", "## 验收", "## 风险"];

  it("只有三个状态目录，记录文件名是 yyyy-mm-dd-slug.md", () => {
    const entries = fs.readdirSync(ROOT_DIR, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual([...STATES].sort());
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    expect(files).toEqual(["README.md"]);
    for (const state of STATES) {
      const bad = fs
        .readdirSync(path.join(ROOT_DIR, state))
        .filter((name) => name !== ".gitkeep")
        .filter((name) => !/^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(name));
      expect(bad, state).toEqual([]);
    }
  });

  it("每份记录：首行「# 简化：」、第 3 行状态与目录一致、rejected 带理由、五节齐全", () => {
    const problems: string[] = [];
    for (const state of STATES) {
      const dir = path.join(ROOT_DIR, state);
      for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".md"))) {
        const lines = read(path.join(dir, name)).split("\n");
        const where = `${state}/${name}`;
        if (!lines[0]?.startsWith("# 简化：")) problems.push(`${where}: 首行不是「# 简化：」`);
        const status = lines[2] ?? "";
        const expected =
          state === "rejected" ? /^状态: rejected — \S.*$/ : new RegExp(`^状态: ${state}$`);
        if (!expected.test(status)) problems.push(`${where}: 第 3 行状态「${status}」与目录不符`);
        for (const section of SECTIONS) {
          if (!lines.includes(section)) problems.push(`${where}: 缺「${section}」`);
        }
        if (state === "done" && !lines.includes("## 落地"))
          problems.push(`${where}: 缺「## 落地」`);
      }
    }
    expect(problems).toEqual([]);
  });
});
