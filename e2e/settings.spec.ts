import { expect, test } from "@playwright/test";

/**
 * 全局设置页（开发者面）——三层设置的最上层（ADR-0016）。
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
    // 写回失败不能静默：整份文档是本 spec 唯一的清理手段，残留会污染后续运行的组合
    const res = await request.put("/api/settings", { data: saved });
    expect(res.ok(), `全局设置写回失败：HTTP ${res.status()}`).toBe(true);
  });

  test("七个分区与插件面板都在，面板列出下次运行会挂的 entry", async ({ page }) => {
    await page.goto("/settings");

    for (const section of [
      "模型与凭据",
      "凭据引用",
      "MCP 服务器",
      "默认停用的工具",
      "插件开关",
      "默认指令（AGENTS.md）",
      "插件面板",
    ]) {
      await expect(
        page.getByRole("heading", { name: section, exact: true }),
        `应有「${section}」分区`,
      ).toBeVisible();
    }
    // 第一批的「搜索」分区已并入「插件开关」
    await expect(page.getByRole("heading", { name: "搜索", exact: true })).toHaveCount(0);

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

  test("设置校验与 MCP 启停状态分别进入组合和停用区", async ({ request, page }) => {
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

    for (const headers of [null, []]) {
      const badHeaders = await request.put("/api/settings", {
        data: {
          mcpServers: [
            {
              name: "e2e-http",
              transport: "streamable-http",
              url: "https://example.invalid/mcp",
              headers,
            },
          ],
        },
      });
      expect(badHeaders.status()).toBe(400);
      expect(await badHeaders.text()).toContain("headers 必须是对象");
    }
    const nonEmptyHeaders = await request.put("/api/settings", {
      data: {
        mcpServers: [
          {
            name: "e2e-http",
            transport: "streamable-http",
            url: "https://example.invalid/mcp",
            headers: { "X-Tenant": "development" },
          },
        ],
      },
    });
    expect(nonEmptyHeaders.status()).toBe(400);
    expect(await nonEmptyHeaders.text()).toContain("暂不支持自定义 headers");

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
      entries: Array<{ id: string }>;
      disabledEntries: Array<{ id: string }>;
    };
    const entry = composition.entries.find((e) => e.id === "mcp-e2e-fs");
    expect(entry, "启用的 MCP 服务器应出现在下次运行的组合里").toBeTruthy();
    expect(composition.disabledEntries.find((e) => e.id === "mcp-e2e-fs")).toBeUndefined();

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
      entries: Array<{ id: string }>;
      disabledEntries: Array<{ id: string }>;
    };
    expect(after.entries.find((e) => e.id === "mcp-e2e-fs")).toBeUndefined();
    expect(after.disabledEntries.find((e) => e.id === "mcp-e2e-fs")).toBeTruthy();

    await page.goto("/settings");
    const disabledSection = page.getByText("已停用的 MCP（不会进入组合）", { exact: true });
    await expect(disabledSection).toBeVisible();
    await expect(page.getByText("mcp-e2e-fs", { exact: true })).toBeVisible();
  });

  test("插件面板按目录分十组，组标题、默认方向与每组行数都与 API 一致", async ({ page }) => {
    // 分组来自 catalog.ts 的 PLUGIN_GROUPS，经 /api/settings/composition 投影；
    // 面板不得自己维护一份分组，所以这里逐组对齐 API 而不是写死组名。
    const { groups } = (await (await page.request.get("/api/settings/composition")).json()) as {
      groups: Array<{
        id: number;
        title: string;
        defaultStance: string;
        rows: Array<{ package: string; mounted: string }>;
      }>;
    };
    expect(groups.length, "目录固定分十组").toBe(10);

    await page.goto("/settings");
    const panel = page.locator('section:has(h2:text-is("插件面板"))');
    await expect(panel).toContainText("catalog.ts");
    await expect(panel.locator("details[data-plugin-group]")).toHaveCount(groups.length);

    for (const group of groups) {
      const details = panel.locator(`details[data-plugin-group="${group.id}"]`);
      const summary = details.locator("summary");
      await expect(summary, `组 ${group.id} 的标题应与 API 一致`).toContainText(group.title);
      await expect(summary).toContainText(group.defaultStance);
      // 组 1–4 与组 10 默认展开，组 5–9 默认折叠只露组名与方向
      if ([1, 2, 3, 4, 10].includes(group.id)) {
        await expect(details).toHaveAttribute("open", "");
      } else {
        await expect(details).not.toHaveAttribute("open", "");
      }
      await expect(details.locator("tr[data-plugin-row]")).toHaveCount(group.rows.length);
      for (const row of group.rows) {
        await expect(
          details.locator(`tr[data-plugin-row="${row.package}"]`),
          `「${row.package}」的挂载状态应与 API 推导一致`,
        ).toContainText(row.mounted);
      }
    }
  });

  test("插件开关五项与设置文档的 toggles 逐键对齐；搜索开关保存后把搜索三件套挂进下一次运行的组合", async ({
    page,
    request,
  }) => {
    await page.goto("/settings");
    // 说明文字必须点明这是账外支出
    await expect(page.getByText("DeepSeek 搜索的费用不计入本站用量")).toBeVisible();
    // 设置文档在 useEffect 里异步载入，分组渲染出来才说明文档已到位，此后勾选才不会被载入覆盖
    await expect(page.locator("details[data-plugin-group]")).toHaveCount(10);

    // 五个开关来自文档的 toggles 五键，页面按键渲染、勾选状态与文档一致
    const before = (await (await request.get("/api/settings")).json()) as {
      toggles: Record<string, boolean>;
    };
    const keys = Object.keys(before.toggles);
    expect(keys.sort()).toEqual(
      ["compaction", "fsSearch", "strReplaceEditor", "todo", "webSearch"].sort(),
    );
    await expect(page.locator("[data-toggle-key]")).toHaveCount(keys.length);
    for (const key of keys) {
      const box = page.locator(`[data-toggle-key="${key}"] input[type=checkbox]`);
      if (before.toggles[key]) await expect(box, `开关「${key}」应与文档一致`).toBeChecked();
      else await expect(box, `开关「${key}」应与文档一致`).not.toBeChecked();
    }

    // 等 PUT 真正返回再读 API：「已保存」在点击的同一帧被清空又重设，肉眼可见但不可靠
    const saveAndWait = async () => {
      const put = page.waitForResponse(
        (r) => r.url().endsWith("/api/settings") && r.request().method() === "PUT",
      );
      await page.getByRole("button", { name: "保存", exact: true }).click();
      expect((await put).ok()).toBe(true);
      await expect(page.getByText(/^已保存/)).toBeVisible();
    };

    const toggle = page.locator('[data-toggle-key="webSearch"] input[type=checkbox]');
    await toggle.check();
    await saveAndWait();

    const doc = (await (await request.get("/api/settings")).json()) as {
      toggles: { webSearch: boolean };
    };
    expect(doc.toggles.webSearch).toBe(true);

    // 面板与 API 同一份推导：开关打开后 tool-web 进入组合，目录行变成「按开关已挂」
    const on = (await (await request.get("/api/settings/composition")).json()) as {
      entries: Array<{ id: string }>;
      groups: Array<{ rows: Array<{ package: string; mounted: string }> }>;
    };
    expect(on.entries.some((e) => e.id === "tool-web")).toBe(true);
    const toolWeb = on.groups
      .flatMap((g) => g.rows)
      .find((r) => r.package === "@deepseek-ai/dsh-tool-web");
    expect(toolWeb?.mounted).toBe("按开关已挂");
    await expect(page.locator('tr[data-plugin-row="@deepseek-ai/dsh-tool-web"]')).toContainText(
      "按开关已挂",
    );

    await toggle.uncheck();
    await saveAndWait();
    const off = (await (await request.get("/api/settings/composition")).json()) as {
      entries: Array<{ id: string }>;
    };
    expect(off.entries.some((e) => e.id === "tool-web")).toBe(false);
    expect(
      ((await (await request.get("/api/settings")).json()) as { toggles: { webSearch: boolean } })
        .toggles.webSearch,
    ).toBe(false);
  });

  test("默认指令保存后原样进入设置文档；超过 64 KiB 与非布尔开关被 400 拒绝", async ({
    page,
    request,
  }) => {
    await page.goto("/settings");
    await expect(page.locator("details[data-plugin-group]")).toHaveCount(10);

    const text = `# e2e 默认指令\n\n只在本用例里出现的一行：${Date.now()}\n`;
    const textarea = page.getByLabel("默认指令");
    await textarea.fill(text);
    // 计数旁注跟着正文变：字节数是 UTF-8 长度
    const bytes = Buffer.byteLength(text, "utf8");
    await expect(page.getByText(`${bytes} 字节`)).toBeVisible();

    const put = page.waitForResponse(
      (r) => r.url().endsWith("/api/settings") && r.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "保存", exact: true }).click();
    expect((await put).ok()).toBe(true);
    await expect(page.getByText(/^已保存/)).toBeVisible();

    const doc = (await (await request.get("/api/settings")).json()) as {
      defaultInstructions: string;
    };
    expect(doc.defaultInstructions).toBe(text);

    // 写入口的两条校验：默认指令字节上限、开关只收布尔
    const tooLong = await request.put("/api/settings", {
      data: { defaultInstructions: "x".repeat(65_537) },
    });
    expect(tooLong.status()).toBe(400);
    const badToggle = await request.put("/api/settings", {
      data: { toggles: { webSearch: "yes" } },
    });
    expect(badToggle.status()).toBe(400);
  });
});
