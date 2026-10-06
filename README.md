# dsh-plugin-pdd-product-listing

给 **DeepSeek Harness**（`dsh`，桌面端/Web 端同一套 profile 机制）用的插件：
把「拼多多多店铺商品上架」技能（`pdd-product-listing`）以**运行时技能**的方式内嵌进来，
装完重启即可在会话里用 `/pdd-product-listing`，或直接说：

> 用这个素材包上架到店铺C：图片 `D:\...\拼多多\MZB-001`，Excel `D:\...\发品excel\MZB-001.xlsx`

> **只填空与校验，绝不代替你提交商品。** 脚本跑完会打印 `validateForm` 全量校验结果，
> 提交始终由你在拼多多商家后台自己点。插件不碰账号密码、不代登录、不绕过验证码。

---

## 一、怎么装（同事三步）

**前置**：Windows + DeepSeek Harness(`dsh`) + Python 3(带 openpyxl) + Node ≥18 +
已登录店铺的 Chrome（用 `--remote-debugging-port` 启动）。

```powershell
# 1) 克隆（或网页 Download ZIP 后解压）
git clone https://github.com/openclaw-xian/dsh-plugin-pdd-product-listing.git
cd dsh-plugin-pdd-product-listing

# 2) 一键安装（自动找 profile、复制插件、登记 bundles、体检依赖）
powershell -ExecutionPolicy Bypass -File .\install.ps1

# 3) 重启 DeepSeek Harness，然后在会话里用 /pdd-product-listing
```

`install.ps1` 做四件事（**不改凭据、不启动/重启 dsh、不碰你的店铺 Chrome**）：

1. 复制插件到 `~/.dsh/profiles/<profile>/node_modules/dsh-plugin-pdd-product-listing`；
2. 把包名追加进该 profile 的 `package.json → dsh.profile.bundles`；
3. 在 `cordis.patch.yml` 追加插件配置；
4. 依赖体检：**自动挑一个带 `openpyxl` 的 Python** 并写进插件配置，缺 `playwright-core` 会提示。

想指定 profile：`.\install.ps1 -ProfileDir "C:\Users\你\.dsh\profiles\web"`。
不想用脚本、想手动装：把本目录复制到上面的 `node_modules/` 下，再把包名加进 `bundles` 即可。

### 只想要技能、不用插件？

把 `skill/` 整个复制成 `~/.agents/skills/pdd-product-listing/` 也行（DSH 会扫描该目录）。
插件方式的额外好处：跨会话稳定、自带依赖体检、升级时整包替换。

---

## 二、缺什么会怎样

| 缺 | 现象 | 处理 |
|---|---|---|
| Python + openpyxl | `read_excel.py` 报 `No module named 'openpyxl'` | `<python> -m pip install openpyxl`，或安装器会自动挑一个带 openpyxl 的解释器写进配置 |
| playwright-core | 连店时 Node 侧报找不到模块 | 插件目录 `npm i playwright-core`，或在插件配置里写 `playwrightCore` 绝对路径 |
| Chrome 未开调试端口 | `cdp_unreachable` | 用技能自带 `skill/scripts/open_browser.ps1` 启动，或自己加 `--remote-debugging-port=<端口>` |
| 店铺未登录 | 页面停在登录页 | 本技能**不代登录**，请自己登录 |
| `.credentials.yaml` 格式不对 | dsh 启动报 `the value for "version" ... must be a string` | 该文件必须是**扁平映射**（`引用名: "字符串"`），不要 `version:`/`refs:`/`records:` 嵌套 |

---

## 三、配置（可选）

在 profile 的 `cordis.patch.yml` 里给插件加 `config`：

```yaml
- id: pdd-product-listing
  config:
    pythonPath: 'C:\Users\you\AppData\Local\Programs\Python\Python311\python.exe'
    playwrightCore: 'C:\Users\you\AppData\Roaming\npm\node_modules\playwright-core'
    chromePath: 'C:\Program Files\Google\Chrome\Application\chrome.exe'
    scriptsDirectory: ''        # 留空 = 用插件自带 skill/scripts
    shops:
      店铺A: { port: 9226, page_kind: old }
      店铺B: { port: 9227, page_kind: unknown }
      店铺C: { port: 9228, page_kind: new }
    configOverrides:
      default_port: 9226
    registerForAgents: false
    verbose: false
```

插件首次加载会把探测到的 `python` / `playwright_core` 写回 `skill/config.json`
（解析优先级：`config.json` → 环境变量 → 自动探测）。

---

## 四、它做什么

技能流程（`skill/scripts/run_listing.js` 等）：

1. `read_excel.py` 预检素材包（价格/库存/编码/标题长度/单图 ≤3MB）；
2. 复制素材到 ASCII 工作目录，生成 `product.json`；
3. 经 CDP 连接你已登录的店铺 Chrome，**逐步填 → 读回 → 通过才下一步**：
   类目 → 主图 → 标题 → 品牌 → 类目属性 → 规格表 → 逐行 SKU（库存/拼单价/单买价/编码）→
   SKU 预览图 → 商品参考价 → 详情图；
4. `validateForm` 全量校验（错误计数、逐行编码归属、矩阵行数、预览/详情图数、品牌、属性…）；
5. 打印结果并把草稿留在后台，**由你自己点提交**。

技能正文里还有很厚的实战手册：`skill/references/playbook.md`（逐步选择器与踩坑）、
`skill/references/handoff.md`（交接与最近改动）、`skill/references/env.md`（环境依赖）。

---

## 五、排错

| 现象 | 处理 |
|---|---|
| 会话里看不到 `/pdd-product-listing` | 确认已重启 dsh；确认插件在 `bundles` 里；新开一个对话再试 |
| 插件市场（dshmarket）里搜不到 | 正常：市场只列已发布 npm 的插件；本地插件不参与索引 |
| `cdp_handshake_failed` | 技能会**自动探活并关掉卡死页/重复监控页**再重连；仍失败就重启该店 Chrome（保留原 `--user-data-dir`） |
| 控制台提示找不到 Python/playwright-core | 按提示在插件配置里指定路径，或按上一节安装依赖 |
| 想换端口/店铺 | 改插件 `config.shops`，或运行前设环境变量 `PDD_PORT` |

---

## 六、开发

- 改技能逻辑：编辑 `skill/scripts/*.js|py`、`skill/references/*.md`、`skill/SKILL.md`；
- 改插件行为：编辑 `lib/index.mjs`（`apply(ctx, config)` 里注册技能 + 依赖体检）；
- 自检：`node --check lib/index.mjs`，以及 `node skill/scripts/test_pdd_flow.js`（13 条纯函数回归）；
- 装到某个 profile 验证：`install.ps1 -ProfileDir <profile 目录>`，重启 dsh 后新开会话。

## 许可

MIT。技能内容源自 `pdd-product-listing` 技能包；仓库内的店铺名与端口只是示例。
