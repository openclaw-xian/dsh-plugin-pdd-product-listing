# PDD Skill 配置与环境

## 配置文件

`config.json` 位于 skill 根目录。**所有脚本必须经 `scripts/resolve_env.ps1` 解析路径**，禁止在 SKILL/playbook/业务代码里写死绝对路径。

```json
{
  "chrome": "",
  "chrome_profile": "",
  "node": "",
  "npm": "",
  "python": "",
  "playwright_core": "",
  "workdir": "",
  "default_port": 9222,
  "reuse_profile": true
}
```

空字符串 = 自动探测。`default_port` 是单店铺默认 CDP 端口。`chrome_profile` 指向**已登录**的 Chrome 用户目录（强烈建议按店铺固定）。`reuse_profile: true` 时优先复用已有 profile，避免开出未登录新环境。

## 路径解析优先级

1. **config.json 明确指定**
2. **环境变量**：`PDD_CHROME`、`PDD_CHROME_PROFILE`、`PDD_NODE`、`PDD_PYTHON`、`PDD_PLAYWRIGHT`、`PDD_WORKDIR`、`PDD_FLOW_JS`
3. **自动探测**（见下表）

统一入口（PowerShell）：

```powershell
. "<skill根目录>\scripts\resolve_env.ps1"
Show-PddEnv   # 打印解析结果；$script:PddEnv 供后续使用
```

Node 侧解析 playwright：

```js
// 优先 process.env.PDD_PLAYWRIGHT，再 require('playwright-core')
// 完整逻辑：scripts/pdd_flow.js → resolvePlaywrightCore()
const flow = require(process.env.PDD_FLOW_JS || require('path').join(SKILL_ROOT, 'scripts', 'pdd_flow.js'));
const { chromium } = flow.resolvePlaywrightCore();
```

**禁止**再写死类似 `C:\Users\...\skills\...` 或把某台机器的 `D:/mimo/...` 当作唯一路径来源（探测列表仅作 fallback，且必须先读 config/env）。

## 自动探测

| 工具 | 优先级 | 探测 |
|------|--------|------|
| Chrome | config → `PDD_CHROME` → 标准安装路径 | `Test-Path` |
| Node | config → `PDD_NODE` → `Get-Command node` | 可执行即用 |
| Python | config → `PDD_PYTHON` → `$env:MIMO_PYTHON` → `python` | 见下「Python 必须带 openpyxl」 |
| playwright-core | config → `PDD_PLAYWRIGHT` → `require` → 探测列表 | `pdd_flow.js` |
| workdir | config → `PDD_WORKDIR` → `./output/playwright/pdd` | 自动创建 |
| Chrome profile | config `chrome_profile` → workdir 下已有 `chrome-profile` | 优先复用 |

## Python 必须带 openpyxl（2026-10-05 实测补充）

`read_excel.py` 依赖 `openpyxl`。**PATH 上的 `python` 常常不是你要的那个**：本机就是 hermes venv
（3.11.9，无 openpyxl），照文档写 `python scripts/read_excel.py ...` 会直接 `ModuleNotFoundError`。

- 本机实测可用：`<your-python.exe>`（openpyxl 3.1.5）。
- **已写进 `config.json` 的 `python` 字段**（`resolve_env.ps1` 会优先用它），换机器改这一处即可。
- `read_excel.py` 现在会在缺 openpyxl 时打印「换哪个解释器 / 怎么写 config」并 `exit 1`，不再是裸栈。
- ⚠️ 注意：`resolve_env.ps1` 的自动探测**只做 `Get-Command python`，并不校验 openpyxl**
  （早期文档写「有 openpyxl」是过期描述）——所以 config 里固定路径是最稳的做法。

## 读 Excel / 启浏览器（一律经 resolve）

```powershell
. "<skill根目录>\scripts\resolve_env.ps1"
$e = $script:PddEnv

# 预检（exit 0=ok；exit 1=路径/解析硬错误；exit 2=预检未过）
& $e.python $e.read_excel "<xlsx路径>"

# 浏览器：若 CDP 已在跑则不新开；优先复用已登录 profile
& $e.open_browser -Port $e.default_port -Profile $e.chrome_profile
```

## 连接店铺

```js
const flow = require(process.env.PDD_FLOW_JS);
const { browser, page } = await flow.connectShop(port);
// 结束时只断开，不要对用户 Chrome 做破坏性关闭：
await flow.disconnectPage(browser);
```

**多店铺**：用户会提供店铺名 + 端口列表。探活后**逐个**连接，不要并发。探活：`Invoke-WebRequest "http://127.0.0.1:{port}/json/version"`。

## PDD 关键 URL

| 页面 | URL |
|------|-----|
| 类目/首步 | `https://mms.pinduoduo.com/goods/category` |
| 完整表单 | `https://mms.pinduoduo.com/goods/goods_add/index?type=add&...` |
| 编辑 | `.../goods_add/index?id=...&goods_id=...&type=edit` |
| 成功 | `.../goods_add/success?goods_id=...` |
| 列表 | `https://mms.pinduoduo.com/goods/goods_list` |

## 规格表 DOM

- 行：`tbody tr`（虚拟滚动，只渲染可见行）
- 输入：`input[placeholder="请输入"]`，按 left 排序：库存 → 拼单价 → 单买价 → 规格编码
- **编辑页可能多一列空，编码取最后一个「请输入」**
- 滚动容器：`.sku-list` / tr 各级 parent — **必须动态读 `scrollHeight`**
- 预览图 file input：每行一个，仅「待上传」行有
- 遮罩：优先点「关闭/取消/知道了」；仅确认残留后再考虑清 DOM（勿一上来 `remove()`）
- 旧版类目选中：`.choose-category`；确认按钮文本「确认发布该类商品」
- 新版类目选中：`.cateItemCard_checked`

## 三段流水线（禁止合并）

```
fillProductForm → validateForm → allPass ? submitProduct : 禁止提交
```

- `validateForm` 用 `readAllSkuRows` 虚拟滚动全量读
- 错误文案正则**未匹配 → `unknown` → 不得提交**
- 查重：`checkDuplicate` → `exact_duplicate` / `same_title_different_sku` / `not_found` / `search_failed`
- `search_failed` 不等于「无重复」，默认禁止自动提交

实现见 `scripts/pdd_flow.js`。
