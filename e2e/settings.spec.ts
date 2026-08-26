import { expect, test } from "@playwright/test";

/**
 * 全局设置页（开发者面）。
 *
 * 设置是**单份文档**而不是可按前缀清理的实体，所以这里的纪律不是 e2e 前缀，
 * 而是先把整份文档存下来、跑完原样写回——用例失败也不会给本机留下残留配置。
 */
test.describe("全局设置", () => {
  let saved: unknown;

  test.beforeAll(async ({ request }) => {
    saved = await (await request.get("/api/settings")).json();
  });

  test.afterAll(async ({ request }) => {
    await request.put("/api/settings", { data: saved });
  });

  test("四个分区与插件面板都在，面板列出下次运行会挂的 entry", async ({ page }) => {
    await page.goto("/settings");

    for (const section of ["模型与凭据", "凭据引用", "MCP 服务器", "默认停用的工具", "插件面板"]) {
      await expect(
        page.getByRole("heading", { name: section, exact: true }),
        `应有「${section}」分区`,
      ).toBeVisible();
    }

    // 面板报的是推导结果，和 API 的 entry 清单逐条对齐
    const entries = (
      (await (await page.request.get("/api/settings/composition")).json()) as {
        entries: Array<{ id: string }>;
      }
    ).entries;
    expect(entries.length, "组合里应有 entry").toBeGreaterThan(0);
    const panel = page.locator('section:has(h2:text-is("插件面板"))');
    for (const id of ["llm-deepseek", "tools", "agent-loop", "ontoflow-rpc"]) {
      expect(entries.some((e) => e.id === id), `组合应含 entry「${id}」`).toBe(true);
      await expect(panel.getByText(id, { exact: true }).first()).toBeVisible();
    }
  });

  test("凭据形 env 键被拒绝，合法 MCP 服务器进入下次运行的组合", async ({ request }) => {
    // 凭据不该走组合配置：那个对象会原样落盘到运行目录
    const bad = await request.put("/api/settings", {
      data: {
        mcpServers: [
          { name: "e2e-bad", transport: "stdio", command: "x", env: { API_TOKEN: "sk-1" } },
        ],
      },
    });
    expect(bad.status()).toBe(400);
    expect(await bad.text()).toContain("凭据");

    const ok = await request.put("/api/settings", {
      data: {
        modelApiKeyEnv: "DEEPSEEK_API_KEY",
        mcpServers: [
          { name: "e2e-fs", enabled: true, transport: "stdio", command: "echo", args: ["hi"] },
        ],
        disabledTools: ["bash"],
      },
    });
    expect(ok.ok()).toBe(true);

    const composition = (await (await request.get("/api/settings/composition")).json()) as {
      entries: Array<{ id: string; disabled: boolean }>;
    };
    const entry = composition.entries.find((e) => e.id === "mcp-e2e-fs");
    expect(entry, "启用的 MCP 服务器应出现在下次运行的组合里").toBeTruthy();
    expect(entry!.disabled).toBe(false);

    // 停用后整条省略：每运行组合只描述这次运行的真实能力
    await request.put("/api/settings", {
      data: {
        modelApiKeyEnv: "DEEPSEEK_API_KEY",
        mcpServers: [
          { name: "e2e-fs", enabled: false, transport: "stdio", command: "echo", args: ["hi"] },
        ],
      },
    });
    const after = (await (await request.get("/api/settings/composition")).json()) as {
      entries: Array<{ id: string; disabled: boolean }>;
    };
    expect(after.entries.find((e) => e.id === "mcp-e2e-fs")?.disabled).toBe(true);
  });
});
