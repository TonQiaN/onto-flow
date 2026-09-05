import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  cleanupByPrefix,
  cleanupRevisions,
  createAction,
  createObjectType,
  createWorkflow,
  inputPort,
  outputPort,
  type RevisionOwner,
  uniqueSuffix,
} from "./helpers";
import { randomUUID } from "node:crypto";

const PREFIX = "e2e-连线-";
const owners: RevisionOwner[] = [];

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("测试目标不在画布上");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function drag(page: Page, from: Locator, to: Locator) {
  const a = await center(from);
  const b = await center(to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 20 });
  await page.mouse.up();
}

test.afterEach(async ({ request }) => {
  await cleanupByPrefix(request, "/api/workflows", PREFIX);
  await cleanupByPrefix(request, "/api/actions", PREFIX);
  await cleanupByPrefix(request, "/api/object-types", PREFIX);
  cleanupRevisions(owners);
  owners.length = 0;
});

test("从空画布实际创建六节点七边：扇出、同口汇总和返工回边保存重载不丢失", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  const suffix = uniqueSuffix();
  const typeName = `${PREFIX}资料-${suffix}`;
  const objectTypeId = await createObjectType(request, { name: typeName }, owners);
  const labels = ["起草", "评审甲", "评审乙", "裁决"].map((x) => `${PREFIX}${x}-${suffix}`);
  for (const [i, name] of labels.entries()) {
    await createAction(
      request,
      {
        name,
        maxReentries: i === 0 ? 2 : 0,
        ports:
          i === 0
            ? [
                inputPort("需求", objectTypeId),
                inputPort("意见", objectTypeId, 1),
                outputPort("草稿", objectTypeId, "draft.md"),
              ]
            : i === 3
              ? [
                  inputPort("评语", objectTypeId),
                  outputPort("定稿", objectTypeId, "final.md", 0, "通过"),
                  outputPort("意见", objectTypeId, "feedback.md", 1, "返工"),
                ]
              : [
                  inputPort("草稿", objectTypeId),
                  outputPort("评语", objectTypeId, `review-${i}.md`),
                ],
      },
      owners,
    );
  }
  const workflowId = await createWorkflow(request, { name: `${PREFIX}七边-${suffix}` }, owners);
  await page.goto(`/workflows/${workflowId}`);
  await expect(page.getByRole("heading", { name: "节点面板" })).toBeVisible();
  const panel = page
    .locator("aside")
    .filter({ has: page.getByRole("heading", { name: "节点面板" }) });
  let nodeCount = 0;
  const waitForNode = async () => {
    await expect(page.locator(".react-flow__node")).toHaveCount(++nodeCount);
  };
  for (const kind of ["输入", "输出"]) {
    await panel.getByRole("button", { name: `＋ ${kind}节点` }).click();
    await panel.getByPlaceholder("搜索对象类型…").fill(typeName);
    await panel.getByRole("button", { name: `${typeName} text` }).click();
    await waitForNode();
  }
  for (const label of labels) {
    await panel.getByPlaceholder("搜索 Action / 端口…").fill(label);
    await panel
      .getByRole("button")
      .filter({ has: page.getByText(label, { exact: true }) })
      .click();
    await waitForNode();
  }
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  await page.getByRole("button", { name: "适应视图", exact: true }).click();
  // 等待 300 ms 的视口动画，随后才读取用于真实拖线的坐标。
  await page.waitForTimeout(350);
  for (let i = 0; i < 3; i++) await page.locator(".react-flow__controls-zoomout").click();
  const positions = [
    [640, 430],
    [1600, 820],
    [930, 430],
    [1240, 210],
    [1240, 700],
    [1570, 430],
  ];
  for (const [i, [x, y]] of positions.entries()) {
    const item = page.locator(".react-flow__node").nth(i);
    await item.press("Enter");
    const box = await item.boundingBox();
    if (!box) throw new Error("待排列节点不可见");
    await page.mouse.move(box.x + box.width / 2, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 20 });
    await page.mouse.up();
  }
  await page.getByRole("button", { name: "适应视图", exact: true }).click();
  await page.waitForTimeout(350);
  const node = (label: string) =>
    label.startsWith("输入·") || label.startsWith("输出·")
      ? page
          .locator(".react-flow__node")
          .filter({ has: page.getByText(label.slice(0, 2), { exact: true }) })
      : page.locator(".react-flow__node").filter({ hasText: label });
  const port = (label: string, side: string, name: string) =>
    node(label).locator(`.react-flow__handle.${side}[data-handleid="${name}"]`);
  const input = `输入·${typeName}`;
  const output = `输出·${typeName}`;
  const links = [
    [input, "value", labels[0], "需求"],
    [labels[0], "草稿", labels[1], "草稿"],
    [labels[0], "草稿", labels[2], "草稿"],
    [labels[1], "评语", labels[3], "评语"],
    [labels[2], "评语", labels[3], "评语"],
    [labels[3], "意见", labels[0], "意见"],
    [labels[3], "定稿", output, "value"],
  ];
  for (const [i, [from, sourcePort, to, targetPort]] of links.entries()) {
    // 最后一条从输入端向输出端反拖，覆盖两种拖线方向。
    const source = port(from, "source", sourcePort);
    const target = port(to, "target", targetPort);
    await drag(page, i === 6 ? target : source, i === 6 ? source : target);
    await expect(page.locator(".react-flow__edge"), `第 ${i + 1} 条连线应可创建`).toHaveCount(
      i + 1,
    );
  }
  const saved = page.waitForResponse(
    (r) => r.request().method() === "PUT" && r.url().endsWith(`/api/workflows/${workflowId}`),
  );
  await page.getByRole("button", { name: "保存", exact: true }).click();
  expect((await (await saved).json()).issues).toEqual([]);
  await page.reload();
  await expect(page.locator(".react-flow__edge")).toHaveCount(7);
  await expect(page.getByText(/回边至.*重入 2 次/)).toBeVisible();
});

test("拖线拒绝原因与按钮入口一致：类型、重复、无重入上限，合法汇总可用按钮完成", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1500, height: 950 });
  const suffix = uniqueSuffix();
  const type = await createObjectType(request, { name: `${PREFIX}同型-${suffix}` }, owners);
  const wrong = await createObjectType(request, { name: `${PREFIX}异型-${suffix}` }, owners);
  const a = await createAction(
    request,
    {
      name: `${PREFIX}未允许重入-${suffix}`,
      ports: [inputPort("x", type), outputPort("y", type, "a.md")],
    },
    owners,
  );
  const b = await createAction(
    request,
    {
      name: `${PREFIX}评审-${suffix}`,
      ports: [inputPort("x", type), outputPort("y", type, "b.md")],
    },
    owners,
  );
  const workflowId = await createWorkflow(request, { name: `${PREFIX}拒绝-${suffix}` }, owners);
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const nodes = [
    { id: ids[0], kind: "input", objectTypeId: type, label: "资料", x: 0, y: 40 },
    { id: ids[1], kind: "action", actionId: a, label: "起草", x: 320, y: 40 },
    { id: ids[2], kind: "action", actionId: b, label: "评审", x: 680, y: 40 },
    { id: ids[3], kind: "output", objectTypeId: wrong, label: "异型结果", x: 680, y: 360 },
  ];
  const edges = [
    {
      id: randomUUID(),
      sourceNodeId: ids[0],
      sourcePort: "value",
      targetNodeId: ids[1],
      targetPort: "x",
    },
    {
      id: randomUUID(),
      sourceNodeId: ids[1],
      sourcePort: "y",
      targetNodeId: ids[2],
      targetPort: "x",
    },
  ];
  expect((await request.put(`/api/workflows/${workflowId}`, { data: { nodes, edges } })).ok()).toBe(
    true,
  );
  await page.goto(`/workflows/${workflowId}`);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  const port = (id: string, side: string, name: string) =>
    page.locator(
      `.react-flow__node[data-id="${id}"] .react-flow__handle.${side}[data-handleid="${name}"]`,
    );
  await drag(page, port(ids[2], "source", "y"), port(ids[1], "target", "x"));
  await expect(page.getByRole("alert").filter({ hasText: "没有声明重入上限" })).toBeVisible();
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await page.getByRole("button", { name: "添加连线", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加连线" });
  const choose = async (from: string, sourcePort: string, to: string, targetPort: string) => {
    await dialog.getByLabel("起点输出").selectOption(JSON.stringify([from, sourcePort]));
    await dialog.getByLabel("终点输入").selectOption(JSON.stringify([to, targetPort]));
  };
  await choose(ids[0], "value", ids[1], "x");
  await expect(dialog.getByRole("alert")).toContainText("已经有连线");
  await expect(dialog.getByRole("button", { name: "连接", exact: true })).toBeDisabled();
  await choose(ids[0], "value", ids[3], "value");
  await expect(dialog.getByRole("alert")).toContainText("类型不匹配");
  await choose(ids[2], "y", ids[1], "x");
  await expect(dialog.getByRole("alert")).toContainText("没有声明重入上限");
  await expect(dialog.getByRole("button", { name: "调整重入设置" })).toBeVisible();
  await choose(ids[0], "value", ids[2], "x");
  await expect(dialog.getByRole("status")).toContainText("汇总输入");
  await dialog.getByRole("button", { name: "连接", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  await expect(page.locator(`.react-flow__node[data-id="${ids[2]}"]`)).toContainText("2 条入线");
});
