# 架构评审记录

基线：`c3a54e6`（origin/master）· 分支：`codex/deepen-runtime-environment`
生成方式：`improve-codebase-architecture` 技能（HTML 报告写在 OS 临时目录，不随仓库保留，已丢失）

本文件只记录评审结论与未决问题，不含代码改动。

## 三个候选

| # | 候选 | 强度 | 涉及文件 |
|---|---|---|---|
| 1 | 深化本机运行环境 module | Strong | `lib/index.mjs`、`install-core.py`、`skill/scripts/resolve_env.ps1`、`skill/config.json`、`skill/references/env.md` |
| 2 | 深化素材包准备 module | Worth exploring | `skill/scripts/read_excel.py`、`skill/scripts/build_product.py` |
| 3 | 深化虚拟 SKU 表读写与核验 module | Strong | `skill/scripts/pdd_flow.js`、`skill/scripts/run_listing.js`、`test_pdd_flow.js` |

## 候选 1 · 本机运行环境 module

### 已确认的摩擦（均有代码或复现证据）

1. **两个文件来源，三套读取规则。** `config.local.json` 只有 `lib/index.mjs:123` 读；`resolve_env.ps1:13` 和 `build_product.py:156` 只读被跟踪的 `config.json`。
2. **优先级三份说法互相矛盾。** 模板 `_note_paths` 说「环境变量 > 本文件 > 自动探测」；`references/env.md:25` 说「config.json > 环境变量 > 自动探测」；`lib/index.mjs:150 exportEnv` 实际是「进程 env > 插件配置 > config.local」。
3. **解析结果没传给自己的体检。** `exportEnv` 用了 `config.local.python`，`checkPython(cfg.pythonPath)`（`lib/index.mjs:334`）只看插件配置和 PATH。隔离探针复现：本机配置已选中可用 Python，体检仍只尝试 `python/python3/py` 并报警。
4. **声明了却没接线。** `configOverrides` 在 schema（`:54`）和 `normalizeConfig`（`:100`）都在，没有消费者。复现：`configOverrides.default_port=9444` 无效果，模板仍是 9222。
5. **运行期写被跟踪文件。** `mergeShopsIntoTemplate`（`lib/index.mjs:168`）在运行期写 `config.json`。
6. **升级丢本机状态。** `install-core.py:145` 先 `rmtree` 再复制，`config.local.json` 里的手工值会丢（之后会重新探测）。
7. **打包冲突（阻塞验证）。** 根 `package.json` 是 `type: module`，但 `skill/scripts/*.js` 是 CommonJS 写法。Node 24.15.0 下 `node skill/scripts/test_pdd_flow.js` 直接报 `require is not defined in ES module scope`。`node --check lib/index.mjs` 通过。
8. **文档过期。** README:80 仍说插件把路径写回 `config.json`（`c3a54e6` 已改为 `config.local.json`）。

### 第一轮未决问题（已提出，用户尚未回答）

- **Q1 职责边界** — module 拥有：来源优先级、路径与依赖探测、本机状态读写、结构化诊断。同时把 ESM/CommonJS 打包修复并入本分支。不做：改 `pdd_flow.js` 行为、改 `shops`/`page_kind` 语义、改 Excel 解析、新增配置键。
- **Q2 规范优先级** — `PDD_*` 进程环境变量 > 插件配置 > `config.local.json` > `config.json` 模板 > 自动探测；三处文档一起改齐。
- **Q3 本机状态与写入方** — 位置先不动；明确成「唯一机器本机文件、只由运行环境 module 写」，安装器覆盖前保留；运行期永不写被跟踪的 `config.json`。
- **Q4 跨语言共享** — 一份优先级规范 + 每种语言薄 adapter + 同一组 fixture；CLI 方案作为后续可选。
- **Q5 诊断形态** — 结构化数组（key / 状态 / 值 / 来源 / 说明），文案渲染留在调用方。

推荐 Q1–Q5 全部采纳；均未定案。

## 候选 2 · 素材包准备 module

- `copy_ascii` 只对主图/详情图做 3MB 检查（`build_product.py:108`）；SKU 映射直接复制（`:212`）；rows 模式只统计缺失预览图后照写 `product.json`（`:234`）。
- 隔离复现：3MiB+1 字节的 preview、以及不存在的 preview，都是 `exit 0` 且写出 `product.json`。
- 要点：先定位全部实际图片，再统一检查并生成；保留 Excel 阶段对异目录图片的非阻塞提示。

## 候选 3 · 虚拟 SKU 表读写与核验 module

- 行身份识别分散在 `pdd_flow.js:773`、`:1694`、`:3572`、`:3740`：扫描每窗口重置 sticky（`:1707`），写值跨窗口保留（`:804`），mapper 用另一套评分（`:3588`）。
- `handoff.md:136`：共享前缀曾把 72 行识别成 24 行，导致删掉正确规格值；同一修复分别落在扫描与写值。
- `run_listing.js:251` 在 `spec.ok === false` 时只打印并继续填值。
- 要点：集中行身份、跨窗口覆盖与字段归属证据；用真实缺陷场景做测试 adapter，不预建通用浏览器抽象。

## 状态

- 无代码改动，无提交，未 push。GitHub 上仍是 `c3a54e6`。

