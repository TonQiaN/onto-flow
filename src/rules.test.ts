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
/**
 * `/` 前面是这些就当正则字面量的开头，否则当除号。关键字列表取「除号的左操作数不可能是它」的那一批，
 * 宁滥勿缺：多认一个只会把某段多抹白 → 误报（红），少认一个才会让藏在正则里的假代码蒙混过关
 * （Codex 对 #50 的九、十二、十三轮各点出一种前缀）。
 */
const REGEX_START_RE =
  /(?:^|[=(,:[!&|?{};+\-*%^~<>])\s*$|\b(?:return|throw|typeof|instanceof|in|of|do|else|case|new|delete|void|yield|await|if|while|for|switch|with|as|satisfies)\s*$/;

/**
 * 抹掉注释；`literals` 为真时连字符串 / 模板串的**内容**一起抹成空白（换行与长度都保留）。
 * 只扫文本的断言都该先过它：注释掉的代码在原文里字还在，`// export const dynamic = "force-dynamic";`
 * 用 includes 判定会被当成真的导出，被注释掉的 `import "@/server/writers";` 同理；字符串里的分号
 * 还能把语句边界骗断（Codex 对 #50 的六、七两轮复审）。
 * 正则字面量不识别——今天仓库里的正则都不含引号；真出现引号会让整段被抹白，用它的地方各自有
 * 「抹完顶层 export 条数不变」这类自检兜底。
 */
function stripCode(content: string, literals = false): string {
  let out = "";
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const start = i;
      for (i += 1; i < content.length && content[i] !== ch; i += 1) if (content[i] === "\\") i += 1;
      const literal = content.slice(start, Math.min(i + 1, content.length));
      out += literals ? literal.replace(/[^\n]/g, " ") : literal;
      continue;
    }
    if (ch === "/" && (content[i + 1] === "/" || content[i + 1] === "*")) {
      const close =
        content[i + 1] === "/" ? content.indexOf("\n", i) : content.indexOf("*/", i + 2);
      const stop = close === -1 ? content.length : close + (content[i + 1] === "/" ? 1 : 2);
      out += content.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
      continue;
    }
    // 正则字面量：不认的话 `const marker = /export const dynamic = "…";/` 里那段像代码的文本会
    // 原样留在视图里，冒充真代码（Codex 对 #50 的九轮复审）。用「前一个有效字符决定除号还是正则」
    // 这条常规启发式；判错只会让某段被多抹白，方向是误报（红）不是漏放（绿）。
    if (ch === "/" && REGEX_START_RE.test(out)) {
      const start = i;
      let inClass = false;
      for (i += 1; i < content.length; i += 1) {
        const c = content[i];
        if (c === "\\") i += 1;
        else if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "\n") break;
        else if (c === "/" && !inClass) break;
      }
      if (i < content.length && content[i] === "/") {
        const literal = content.slice(start, i + 1);
        out += literals ? literal.replace(/[^\n]/g, " ") : literal;
        continue;
      }
      i = start; // 判错了，当普通除号
    }
    out += ch;
  }
  return out;
}

/** 这个位置前面在同一行里只有空白（顶层语句都在行首；正则字面量以 `/` 开头，永远不在行首） */
function atLineStart(raw: string, at: number): boolean {
  return raw.slice(raw.lastIndexOf("\n", at - 1) + 1, at).trim() === "";
}

/**
 * 这段文本是否作为**真代码**出现过。`stripCode` 抹白时长度与换行都保留，所以抹过的视图与原文
 * 偏移一一对应：先在原文里找到位置，再要求抹过字面量的视图在同一段偏移上是同样的「形状」。
 * 注释掉的那行在视图里只剩空白，藏进字符串的仿冒（`const marker = 'import "@/server/writers";'`）
 * 内容也被抹白，两种都对不上（Codex 对 #50 的七、八两轮复审）。
 *
 * 再加一条**行首锚定**：这三处判定的都是顶层语句，而正则字面量必以 `/` 开头，行首之后就再也藏不住
 * 一条语句。有了它，「这个 `/` 是除号还是正则」的启发式对这几条判定不再是承重的（十四轮复审）。
 */
function occursAsCode(raw: string, snippet: string): boolean {
  const view = stripCode(raw, true);
  const shape = stripCode(snippet, true);
  for (let at = raw.indexOf(snippet); at !== -1; at = raw.indexOf(snippet, at + 1)) {
    // 行首判定看抹过的视图：同行的注释前缀已成空白，不该挡住真语句；同行真代码仍然挡得住
    if (!atLineStart(view, at)) continue;
    if (view.slice(at, at + snippet.length) === shape) return true;
  }
  return false;
}

/** 正则版的 occursAsCode：命中的那一段必须在抹过字面量的视图里是同样的形状 */
function matchesAsCode(raw: string, re: RegExp): boolean {
  const code = stripCode(raw); // 只抹注释：说明符那串字符还要参与匹配
  const view = stripCode(raw, true); // 再抹字面量：用来验证命中处不是藏在字面量里
  const all = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const match of code.matchAll(all))
    if (view.slice(match.index, match.index + match[0].length) === stripCode(match[0], true))
      return true;
  return false;
}
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
      .filter((file) => !occursAsCode(read(file), 'export const dynamic = "force-dynamic";'))
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
  const METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";
  // 每个 ^export 都容忍行首空白：注释被抹成空白后，`/* 说明 */ export async function POST(){}`
  // 这种同行前缀会把锚死在列 0 的匹配全部躲过去（Codex 对 #50 的十轮复审）。
  const FUNCTION_METHOD_RE = new RegExp(
    String.raw`^[ \t]*export\s+(?:async\s+)?function\s+(${METHODS})\b`,
    "gm",
  );
  const VAR_EXPORT_RE = /^[ \t]*export\s+(?:const|let|var)\b/gm;
  const EXPORT_AT_RE = /^[ \t]*export\b/gm;
  // route 顶层只许两种导出形状：方法用的函数声明，和 `export const <标识符> = …`（`dynamic`、
  // uploads 的字节上限）。别的一律记违规，不再逐种枚举——`export { post as "POST" }`、
  // `export const { POST } = handlers`、`export *`、`export default` 都被这一条一次性拦下
  // （Codex 对 #50 的九轮复审）。
  const ALLOWED_EXPORT_RE =
    /^[ \t]*export\s+(?:(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=)/;
  const LEADING_TRIVIA_RE = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/;

  /**
   * 抹过的视图里这个位置的花括号深度。顶层导出必须是 0：`namespace X { export async function GET(){} }`
   * 缩进之后仍能匹配 `^[ \t]*export`，但它根本不是模块级导出，请求会拿到 405（Codex 对 #50 的
   * 十七轮复审）。
   */
  const braceDepth = (view: string, index: number): number => {
    let depth = 0;
    for (let i = 0; i < index; i += 1) {
      if (view[i] === "{") depth += 1;
      else if (view[i] === "}") depth -= 1;
    }
    return depth;
  };

  /** 本条语句的结尾：括号全配平后的第一个 `;`。多声明符的 `const a = 1, POST = …` 要整条一起看 */
  const statementEnd = (content: string, from: number): number => {
    let depth = 0;
    for (let i = from; i < content.length; i += 1) {
      const ch = content[i];
      if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
      else if (ch === ";" && depth === 0) return i;
    }
    return content.length;
  };

  /** 函数声明的体内第一段有效代码；定位不到返回 null，断言报错而不是悄悄放行 */
  const functionBody = (content: string, from: number): string | null => {
    let depth = 0;
    for (let i = from; i < content.length; i += 1) {
      const ch = content[i];
      if (ch === "(" || ch === "[") depth += 1;
      else if (ch === ")" || ch === "]") depth -= 1;
      else if (depth === 0 && ch === "{")
        return content.slice(i + 1).replace(LEADING_TRIVIA_RE, "");
    }
    return null;
  };

  it("唯一例外之外的每个 route，每个导出方法体都以 return handle( 起头并从 @/lib/http 导入 handle", () => {
    const files = apiRoutes.filter((file) => !EXEMPT.includes(rel(file)));
    const found = violations(files, (raw) => {
      const out: string[] = [];
      const content = stripCode(raw, true);
      // 自检：抹字面量不该抹掉任何顶层 export（route 里 export 不会写在字面量里）。数量对不上说明
      // 扫描把一整段当成了字符串，后面的判断都不可信，直接记违规。两边都是抹过注释的视图，
      // 差别只在字面量，所以同行注释前缀不会让它误报。
      const topLevelExports = (text: string): number =>
        text.match(/^[ \t]*export\b/gm)?.length ?? 0;
      if (topLevelExports(content) !== topLevelExports(stripCode(raw)))
        out.push("抹字面量后顶层 export 数量变了，扫描不可信");
      let methods = 0;
      for (const match of content.matchAll(FUNCTION_METHOD_RE)) {
        if (braceDepth(content, match.index) !== 0) continue; // 嵌在 namespace / 块里的不是模块级导出
        methods += 1;
        const body = functionBody(content, match.index + match[0].length);
        if (body === null) out.push(`${match[1]} 定位不到函数体`);
        else if (!body.startsWith("return handle("))
          out.push(`${match[1]} 的方法体第一句不是 return handle(`);
      }
      // 方法只认「导出的函数声明」这一种写法，别的一律记违规而不是想办法看懂它：文本扫描追不上
      // TypeScript 的全部合法写法（`export const POST = raw`、`export { post as POST }`、
      // `export const a = 1, POST = …` 各绕过一次），把面收成仓库今天实际用的那一种，未知写法就朝
      // 红的一边倒（Codex 对 #50 的五轮复审）。
      for (const match of content.matchAll(VAR_EXPORT_RE)) {
        if (braceDepth(content, match.index) !== 0) continue;
        const stmt = content.slice(match.index, statementEnd(content, match.index));
        // 整条语句里凡出现方法名就违规，不限于 `POST =`：解构 `export const { POST } = handlers;`
        // 同样要拦（Codex 对 #50 的七轮复审）。抹过字面量，所以字符串里的 "POST" 不会误伤。
        for (const decl of stmt.matchAll(new RegExp(String.raw`\b(${METHODS})\b`, "g")))
          out.push(`${decl[1]} 出现在 export const / let / var 里，只能是导出的函数声明`);
      }
      for (const match of content.matchAll(EXPORT_AT_RE))
        if (braceDepth(content, match.index) !== 0)
          out.push(
            `第 ${content.slice(0, match.index).split("\n").length} 行的 export 不在模块顶层`,
          );
        else if (!ALLOWED_EXPORT_RE.test(content.slice(match.index))) {
          const line = content.slice(0, match.index).split("\n").length;
          out.push(`第 ${line} 行的 export 形状不认识，只允许函数声明或 export const <标识符> = …`);
        }
      if (methods === 0 && out.length === 0) out.push("没有导出任何 HTTP 方法");
      // `handle` 后面只许跟 `,` 或 `}`：`import { handle as wrapped }` 绑的本地名不是 handle，
      // route 就能自己声明一个 handle，让每个方法都以 return handle( 起头却绕开真正的错误包装。
      // 反过来 `import { jsonError as handle }` 把**别的**导出改名成 handle，同样能骗过
      // `return handle(` 那条（Codex 对 #50 的十五、十六两轮复审）。
      if (!matchesAsCode(raw, /^[ \t]*import \{[^}]*\bhandle\s*(?:,[^}]*)?\} from "@\/lib\/http"/m))
        out.push("没有从 @/lib/http 原名导入 handle");
      if (matchesAsCode(raw, /^[ \t]*import \{[^}]*\bas\s+handle\b/m))
        out.push("把别的导出改名成了 handle");
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
  // 指令按「整行只有这个串」找，不设字节窗口：窗口卡在 600 字节时，前面堆够注释就能把指令挤出扫描
  // 范围，那个文件整条断言都不再受检（Codex 对 #50 的二十轮复审）。注释已抹成空白，所以前面有多少
  // 注释都不影响；多认一个文件只会让判定更严，方向是误报不是漏放。
  const CLIENT_DIRECTIVE_RE = /^[ \t]*["']use client["']\s*;?[ \t]*$/m;
  const clientFiles = sourceFiles.filter((file) => {
    if (isTest(file)) return false;
    if (CLIENT_DIRECTIVE_RE.test(stripCode(read(file)))) return true;
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
  const SERVER_DIRS = [path.join(ROOT, "src", "server"), path.join(ROOT, "src", "db")];
  /**
   * 越界 = `@/server` / `@/db`，**或**相对路径解析后落进这两棵树。相对写法必须一起查：
   * `import type { X } from "../../server/foo"` 类型导入运行时被擦掉，typecheck 与 build 都不报
   * （Codex 对 #50 的十一轮复审）。
   */
  const crossesBoundary = (specifier: string, file: string): boolean => {
    if (SERVER_SPECIFIER.test(specifier)) return true;
    if (!specifier.startsWith(".")) return false;
    const target = path.resolve(path.dirname(file), specifier);
    return SERVER_DIRS.some((dir) => target === dir || target.startsWith(`${dir}${path.sep}`));
  };
  // `[^;]*?` 把匹配限制在同一条语句里：`export type { X };` 没有 from，不能吞到下一条 import 的 from。
  // 四条都容忍行首空白：注释抹成空白后 `/* c */ import type { X } from "…"` 不再从列 0 开始
  // （Codex 对 #50 的十九轮复审，与第十轮对 export 的那次同一类）。
  const IMPORT_FROM_RE = /^[ \t]*(?:import|export)\s+(type\s+)?[^;]*?\s+from\s+["']([^"']+)["']/gm;
  const SIDE_EFFECT_IMPORT_RE = /^[ \t]*import\s+["']([^"']+)["']/gm;
  // 反引号也要收：`await import(\`../../server/x\`)` 是合法的无插值模板串说明符（Codex 对 #50 的
  // 十二轮复审）。静态 import 的说明符按语法只能是引号串，所以上面两条不用管反引号。
  const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["'`]([^"'`]+)["'`]/g;
  // 所有 `require("…")`：既盖 TS 的 import 赋值（`import type Server = require("../server/x")`，
  // 既没有 from 也没有 import(，类型形式还会被擦掉），也盖普通表达式
  // （`const types = require("@/server/monitor/types")`）（Codex 对 #50 的十八、二十一两轮复审）。
  const REQUIRE_RE = /\brequire\s*\(\s*["'`]([^"'`]+)["'`]/g;

  it('含 "use client" 的文件与 src/app、src/components 下的共享模块不从 @/server 或 @/db 导入任何东西（含 import type）', () => {
    expect(clientFiles.length).toBeGreaterThan(0);
    const found = violations(clientFiles, (raw, file) => {
      // 抹掉注释再扫：`import /* c */ ("../../server/x")` 这种插在中间的注释会把匹配挡掉，
      // 注释掉的 import 也不该算数（Codex 对 #50 的十七轮复审）
      const content = stripCode(scanText(file));
      const out: string[] = [];
      for (const match of content.matchAll(IMPORT_FROM_RE)) {
        const [, typeOnly, specifier] = match;
        if (!crossesBoundary(specifier, file)) continue;
        out.push(typeOnly ? `import type 来自 ${specifier}` : `从 ${specifier} 导入了运行时值`);
      }
      for (const match of content.matchAll(SIDE_EFFECT_IMPORT_RE)) {
        if (crossesBoundary(match[1], file)) out.push(`副作用导入 ${match[1]}`);
      }
      for (const match of content.matchAll(DYNAMIC_IMPORT_RE)) {
        if (crossesBoundary(match[1], file)) out.push(`动态导入 ${match[1]}`);
      }
      for (const match of content.matchAll(REQUIRE_RE)) {
        if (crossesBoundary(match[1], file)) out.push(`require 引入 ${match[1]}`);
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
    const restoreRoutes = apiRoutes.filter((file) =>
      matchesAsCode(read(file), /\brestoreRevision\b/),
    );
    expect(restoreRoutes.map(rel)).toContain("src/app/api/revisions/[revId]/restore/route.ts");
    const missing = restoreRoutes
      .filter((file) => !occursAsCode(read(file), 'import "@/server/writers";'))
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

describe("AGENTS.md · Repository layout · src/lib 的四个规则模块", () => {
  /**
   * 「the four rule modules the write boundary and its editor both call so neither copies the
   * other」——这四组规则（技能资源文件、Tool 公名、对象根 schema 形状、列表排序键与页长）
   * 以前在客户端与写入口各写一份，靠注释和一条只为钉两份一致而存在的用例维持。收敛之后
   * 「只有一处定义」本身就是可机械核对的约定，所以它是断言而不是散文：
   * docs/simplifications/done/2026-09-03-share-pure-validators-in-lib.md。
   */
  const SINGLE_SOURCE: ReadonlyArray<{ home: string; names: readonly string[] }> = [
    {
      home: "src/lib/skill-files.ts",
      names: [
        "SKILL_FILE_MAX_COUNT",
        "SKILL_FILE_MAX_BYTES",
        "SKILL_FILE_PATH_MAX_LENGTH",
        "skillFilePathProblem",
        "foldSkillPath",
      ],
    },
    {
      home: "src/lib/tool-names.ts",
      names: [
        "TOOL_PUBLIC_NAME_PATTERN",
        "TOOL_RESERVED_PUBLIC_NAMES",
        "TOOL_RESERVED_PUBLIC_NAME_PREFIX",
        "publicNameProblem",
        "toolCodeProblem",
      ],
    },
    { home: "src/lib/json-schema-shape.ts", names: ["objectSchemaShapeProblem"] },
    {
      home: "src/lib/list-query.ts",
      names: [
        "SORT_KEYS",
        "SortKey",
        "DEFAULT_SORT",
        "DEFAULT_PAGE_SIZE",
        "MAX_PAGE_SIZE",
        "isSortKey",
      ],
    },
  ];

  it("四组规则各自只在它那个 src/lib 模块里声明一次，别处只能 import 或转出", () => {
    const problems = SINGLE_SOURCE.flatMap(({ home, names }) =>
      names.flatMap((name) => {
        // 只认声明（const / type / function …），不认 `export { X };` 这种转出
        const declares = new RegExp(
          `^(?:export )?(?:const|let|type|interface|function|class) ${name}\\b`,
          "m",
        );
        const where = sourceFiles.filter((file) => declares.test(read(file))).map(rel);
        return where.length === 1 && where[0] === home
          ? []
          : [`${name} 应只在 ${home} 声明，实际：${where.join(" / ") || "（一处也没有）"}`];
      }),
    );
    expect(problems).toEqual([]);
  });

  it("每个模块的两侧消费者都从 @/lib/<模块> 取，没有第二份手抄", () => {
    const CONSUMERS: ReadonlyArray<[specifier: string, files: readonly string[]]> = [
      [
        "@/lib/skill-files",
        [
          "src/server/writers/skill.ts",
          "src/app/skills/skill-files.ts",
          "src/app/skills/skill-editor.tsx",
        ],
      ],
      [
        "@/lib/tool-names",
        [
          "src/server/writers/tool.ts",
          "src/server/harness/tool-plugin.ts",
          "src/app/tools/tool-editor.tsx",
        ],
      ],
      [
        "@/lib/json-schema-shape",
        ["src/server/harness/tool-schema.ts", "src/app/tools/tool-form.ts"],
      ],
      ["@/lib/list-query", ["src/server/writers/list.ts", "src/components/library/types.ts"]],
    ];
    const problems = CONSUMERS.flatMap(([specifier, files]) =>
      files
        .filter((file) => !read(path.join(ROOT, file)).includes(`from "${specifier}"`))
        .map((file) => `${file} 未从 ${specifier} 取共享规则`),
    );
    expect(problems).toEqual([]);
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

  it("drizzle 的 sql 只以 sql 这个名字导入：没有 `sql as`，也没有 drizzle-orm 的命名空间导入", () => {
    // 上面两条按名字扫 `sql\`` / `sql<T>\``；改名导入（`sql as rawSql`）或命名空间导入
    // （`import * as d from "drizzle-orm"` 后 `d.sql\`…\``）都会让它们看不见，白名单形同虚设
    // （Codex 对 #50 的十五轮复审）。仓库今天两种写法都没有，这条把现状钉住。
    const found = violations(
      sourceFiles.filter((file) => !isTest(file)),
      (raw) => {
        const out: string[] = [];
        for (const match of stripCode(raw).matchAll(
          /^[ \t]*import\s+([^;]*?)\s+from\s+"drizzle-orm[^"]*"/gm,
        )) {
          const clause = match[1].trim();
          if (/\bsql\s+as\s+/.test(clause)) out.push(`把 sql 改名导入：${clause}`);
          if (/^\*\s+as\s+/.test(clause)) out.push(`命名空间导入 drizzle-orm：${clause}`);
        }
        return out;
      },
    );
    expect(found).toEqual([]);
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

  /**
   * 从 `](` 之后读出行内链接的**目标**，读不出就是空串。只解析目标、不去找配对的右括号：
   * 目标之后可以跟标题（`"…"` / `'…'`），标题里的括号不必配对，一起数深度会把整条链接丢掉；
   * 而被丢掉的链接正是坏链接的静默通道。目标本身允许成对的圆括号（`](a-(b).md)`）与反斜杠转义，
   * `<…>` 裹住的则原样取到配对的 `>`（容纳带空格的路径）。
   */
  function linkDestination(text: string, from: number): string {
    let i = from;
    while (/\s/.test(text[i] ?? "")) i += 1;
    let out = "";
    if (text[i] === "<") {
      for (i += 1; i < text.length; i += 1) {
        const ch = text[i] ?? "";
        if (ch === "\\") out += text[(i += 1)] ?? "";
        else if (ch === "\n") return "";
        else if (ch === ">") return out;
        else out += ch;
      }
      return "";
    }
    let depth = 0;
    for (; i < text.length; i += 1) {
      const ch = text[i] ?? "";
      if (ch === "\\") out += text[(i += 1)] ?? "";
      else if (/\s/.test(ch)) break;
      else if (ch === ")" && depth === 0) break;
      else {
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
        out += ch;
      }
    }
    return out;
  }

  /**
   * 块引用与列表项的容器前缀：`>` 与列表标记的任意组合，缩进不设上限。列表标记后面必须有空白
   * （或就是行尾的空项）才算标记——`-\`\`\`markdown` 按 CommonMark 是普通段落文字，剥掉那个
   * `-` 会把它当成开栏，之后的真链接被静默抹掉；`>` 则不要求后随空白。
   */
  const CONTAINER_PREFIX = String.raw`[ \t]*(?:>[ \t]*|(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|(?=$)))*`;
  const CONTAINER_PREFIX_RE = new RegExp(String.raw`^${CONTAINER_PREFIX}`);

  /** 制表符按 CommonMark 的 4 列停位展开；展开之后列宽就等于字符数，缩进判定不必再分两套。 */
  function expandTabs(line: string): string {
    let out = "";
    for (const ch of line) out += ch === "\t" ? " ".repeat(4 - (out.length % 4)) : ch;
    return out;
  }

  /**
   * ``` / ~~~ 围栏之间是逐字引用（rg 输出、示例 Markdown），里面的 `](…)` 渲染不成链接，
   * 要在记录里写一条字面的坏链接就放进围栏。行内的 `` `…` `` **不剥**：这些记录里的行内代码
   * 常常跟着正文折行，跨行配对一旦错位就会吞掉后面的真链接——漏报比误报坏，而误报会指名
   * 文件与链接、一眼可查。四空格缩进也不当代码块：记录的列表续行普遍缩进四格，那里面全是真链接。
   */
  function outsideFences(text: string): string {
    const kept: string[] = [];
    let opener: string | null = null;
    let openerColumn = 0;
    let openerQuotes = 0;
    for (const raw of text.split("\n")) {
      const line = expandTabs(raw);
      // 围栏也能嵌在块引用或列表项里（`> ```markdown`），先剥容器前缀再认，否则栏内的
      // 字面示例会被当成真链接报出来
      const prefix = CONTAINER_PREFIX_RE.exec(line)?.[0] ?? "";
      const quotes = (prefix.match(/>/g) ?? []).length;
      // 列一律相对**最后一个 `>` 之后**来数：`>` 前面的缩进是可选的，`   > \`\`\`` 与
      // `> \`\`\`` 是同一层容器，按原始列算会把下一行判成出栏。
      const inner = prefix.slice(prefix.lastIndexOf(">") + 1);
      const startsItem = /[-*+]|\d{1,9}[.)]/.test(inner);
      // 这一行的内容列：带列表标记的行从标记那一列算起（它新起一项，不是上一项的续行），
      // 其余行按（引用之后的）容器前缀宽度算。
      const column = startsItem ? (/^[ \t]*/.exec(inner)?.[0] ?? "").length : inner.length;
      // 围栏自己的可选缩进最多三格（相对容器）：顶层的 `    \`\`\`` 是缩进代码块而不是围栏，
      // 当成开栏会一路吞到文件末尾。容器标记之后的那段空白才是围栏自己的缩进，其中属于标记的
      // 那部分要先扣掉——`>` 后一格、列表标记后 1–4 格都是标记自带的填充，不是缩进。
      // 已在栏内时，缩进要相对**开栏所在容器的内容列**量：`-    \`\`\`` 的内容列是 5，
      // 同项里的收栏与其后的正文都缩进 5 格，按绝对列量会判成缩进代码、一路吞到容器结束。
      const afterMarker = /(>|[-*+]|\d{1,9}[.)])( *)$/.exec(prefix);
      const padding = (afterMarker?.[2] ?? "").length;
      // 显式标注类型：fenceIndent → opener → run → fence → fenceIndent 是一圈推断循环
      const fenceIndent: number = !afterMarker
        ? Math.max(0, prefix.length - (opener === null ? 0 : openerColumn))
        : afterMarker[1] === ">"
          ? Math.max(0, padding - 1)
          : padding <= 4
            ? 0
            : padding - 1;
      const fence = fenceIndent <= 3 ? /^(`{3,}|~{3,})(.*)$/.exec(line.slice(prefix.length)) : null;
      const run = fence?.[1] ?? "";
      const info = fence?.[2] ?? "";
      if (opener !== null) {
        // 容器结束，没写收栏的栏也跟着结束：块引用退回顶层、列表项换下一条或退回顶层，那一行
        // 已经不在栏内了。判据只有一条——内容列比开栏那一行浅（或块引用少了一层）就是离开了
        // 容器。栏内的列表标记一律是代码内容（顶层栏的内容列是 0，永远不会提前出栏；列表续行
        // 里开的栏，同缩进的 `- 示例` 也仍在栏内）。
        // 这一判要排在收栏判之前：块引用里未收栏、后面跟一条顶层 ```，那行按 Markdown 是**新开**
        // 一栏而不是收上一栏，先判收栏会把它吃掉、把新栏的内容当正文扫。
        const hasContent = line.slice(prefix.length).trim() !== "";
        if (hasContent && (column < openerColumn || quotes < openerQuotes)) opener = null;
        else {
          // 收栏只认「同字符、不短于开栏、后面没有别的内容」；栏内的 ```not-close 不是收栏，
          // 把它当收栏会让真正的收栏重新开栏，之后整份记录的链接就被静默抹掉
          if (fence && run[0] === opener[0] && run.length >= opener.length && info.trim() === "")
            opener = null;
          kept.push("");
          continue;
        }
      }
      // 反引号栏的信息串里不能再有反引号（CommonMark），带反引号的那行根本不是围栏
      if (fence && !(run.startsWith("`") && info.includes("`"))) {
        opener = run;
        // 出栏列只由**列表标记**确立（引用层数单独记在 openerQuotes 里）。裸缩进不算：围栏本身
        // 就允许 1–3 格的可选缩进，而更深的缩进要区分「顶层缩进的栏」与「列表续行里的栏」得有
        // 块解析器。代价是「列表续行里开的栏又忘了收栏」会一直抹到显式收栏为止——那要先有一份
        // 忘写收栏的记录才碰得上，而按裸缩进出栏会让合法的缩进围栏被当正文扫，是天天碰得上的误报。
        openerColumn = startsItem ? inner.length : 0;
        openerQuotes = quotes;
        kept.push("");
      } else kept.push(line);
    }
    return kept.join("\n");
  }

  /**
   * 一份记录里全部链接目标：行内 `[文字](目标)` 与引用式的定义行 `[标签]: 目标`，查询串
   * （GitHub 的 `?plain=1` 之类）与锚点都已切掉——不切就不以 `.md` 结尾，整条链接被跳过。
   * 定义的目标允许换到下一行写（CommonMark），只看定义行会取到空目标、把坏链接放过去；
   * 定义还可以嵌在块引用或列表项里（`> [标签]: 目标`），容器前缀要先剥掉才认得出；缩进不设
   * 上限，因为列表项的续行缩进四格及以上仍是合法定义（这里剥的是缩进，不是把它当代码块——
   * 记录的列表续行普遍缩进四格，当代码块会一次漏掉一大批真链接）。
   */
  // 标签里的 `]` 可以转义（`[ref\]]: 目标`）；把每个 `]` 都当终止符会让整条定义匹配不上
  const DEFINITION_RE = new RegExp(String.raw`^${CONTAINER_PREFIX}\[(?:[^\]\\]|\\.)+]:(.*)$`);

  function recordLinkTargets(raw: string): string[] {
    const text = outsideFences(raw);
    const targets: string[] = [];
    for (let open = text.indexOf("]("); open >= 0; open = text.indexOf("](", open + 2))
      targets.push(linkDestination(text, open + 2));
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      const definition = DEFINITION_RE.exec(line);
      if (!definition) continue;
      const tail = definition[1] ?? "";
      const next = (lines[index + 1] ?? "").replace(CONTAINER_PREFIX_RE, "");
      targets.push(linkDestination(tail.trim() === "" ? next : tail, 0));
    }
    // 原样返回，一步都不解：目标要按 Markdown 的顺序处理，切锚点必须排在字符引用之后
    // （`missing&#46;md` 里的 `#` 属于引用而不是锚点），判外链又必须排在百分号解码之前。
    return targets;
  }

  /** 无效码位按 CommonMark 变成替换字符，而不是抛 RangeError 把整条断言炸掉。 */
  function fromCodePoint(code: number): string {
    return code > 0 && code <= 0x10_ff_ff ? String.fromCodePoint(code) : "\uFFFD";
  }

  /**
   * 路径里用得上的命名字符引用——HTML5 的全表两千多条，本仓没有实体库也不为一条文档断言引一个，
   * 这里只收 ASCII 标点那一批（能出现在文件名与 URL 里的全部）。表外的引用不猜：`namedLeftover`
   * 会把它当成「解不动的目标」报出来，宁可响也不静默放行。
   */
  const NAMED_REFERENCES: Record<string, string> = {
    period: ".",
    sol: "/",
    bsol: "\\",
    colon: ":",
    num: "#",
    quest: "?",
    lowbar: "_",
    percnt: "%",
    lpar: "(",
    rpar: ")",
    commat: "@",
    excl: "!",
    ast: "*",
    plus: "+",
    comma: ",",
    equals: "=",
    semi: ";",
    tilde: "~",
    dollar: "$",
    apos: "'",
    quot: '"',
    lt: "<",
    gt: ">",
    amp: "&",
  };

  /** 解完之后还剩下的命名引用：表里没有，不猜。 */
  const NAMED_LEFTOVER_RE = /&[a-zA-Z][a-zA-Z0-9]{1,31};/;

  /**
   * 内联解析这一层：字符引用（`missing&#46;md` / `&#x2e;` / `&period;`）解成字符，结果才是
   * 这条链接真正的 URL。`&amp;` 与其余命名引用同一遍解，`&amp;#46;` 因此只解一次、留下字面的
   * `&#46;`，不会被二次解成 `.`。
   */
  function decodeCharacterReferences(destination: string): string {
    return destination
      .replace(/&#[xX]([0-9a-fA-F]{1,6});/g, (_all, hex: string) =>
        fromCodePoint(Number.parseInt(hex, 16)),
      )
      .replace(/&#(\d{1,7});/g, (_all, decimal: string) => fromCodePoint(Number(decimal)))
      .replace(
        /&([a-zA-Z][a-zA-Z0-9]{1,31});/g,
        (all, name: string) => NAMED_REFERENCES[name] ?? all,
      );
  }

  /**
   * URL 这一层：百分号编码解回来才落盘核对，非 ASCII 文件名（`01-%E9%AA%A8%E6%9E%B6.md`）
   * Markdown 解析得开、`existsSync` 拿字面量却找不到。编码坏了就按原样，交给存在性检查报出来。
   */
  function percentDecode(urlPath: string): string {
    try {
      return decodeURIComponent(urlPath);
    } catch {
      return urlPath;
    }
  }

  /**
   * 记录之间互相引用；一份记录从 proposed/ 搬到 done/ 时，指向它的相对链接必须跟着改，
   * 否则链接静默指向不存在的路径。归档只移动文件、不改链接是这里咬住的那个疏漏。
   */
  it("记录里的相对 .md 链接都能从所在目录解析到真实文件", () => {
    const problems: string[] = [];
    for (const state of STATES) {
      const dir = path.join(ROOT_DIR, state);
      for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".md"))) {
        for (const destination of recordLinkTargets(read(path.join(dir, name)))) {
          // 顺序照 Markdown 来：先解字符引用得到真正的 URL，再判外链（`&#58;` 解出来就是
          // 真 scheme），再切查询串与锚点，最后才解百分号编码——把百分号解码提到判外链之前，
          // `notes%3Aold.md` 会解出个 `notes:old.md` 冒充外链溜过去。
          const url = decodeCharacterReferences(destination);
          if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) continue;
          if (NAMED_LEFTOVER_RE.test(url)) {
            // 解不动就报出来：静默跳过等于给坏链接留通道，改法也现成——把 `&period;` 写成 `.`
            problems.push(`${state}/${name}: 链接「${url}」含表外的命名字符引用，核对不了`);
            continue;
          }
          const target = percentDecode(url.split(/[?#]/)[0] ?? "");
          if (!target.endsWith(".md")) continue;
          if (!fs.existsSync(path.resolve(dir, target)))
            problems.push(`${state}/${name}: 链接「${target}」解析不到文件`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
