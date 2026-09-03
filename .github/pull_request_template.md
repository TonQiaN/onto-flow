<!-- 三段都必填。空着的一段视为没做。 -->

## 改了什么

<!-- 行为层面说：哪个契约变了、为什么；不是逐文件复述 diff。触及 ADR / DESIGN / CONTEXT 的写明改了哪份。 -->

## 跑了哪些命令

- [ ] `npm run check`（typecheck + lint + fmt:check + vitest）
- [ ] `npm run build`（触及 `src/app/`、`next.config.ts`、`tsconfig.json` 时必跑）
- [ ] e2e：`npx playwright test e2e/<哪一个>.spec.ts` ← 写明是哪个 spec；没有用户可见改动写「不适用」
- [ ] 付费冒烟：`smoke-harness` / `smoke-engine` / 都没跑 ← 触及 harness 接缝时写明跑了哪个与结论

## 对照 .github/REVIEW.md 自查了哪几条

<!-- 列出你逐条核对过的编号（如 0、2、4、8）。每一条写一句本 PR 为什么满足或为什么不适用。 -->
