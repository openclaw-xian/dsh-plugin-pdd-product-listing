# PDD 上架完整操作手册（整合版）

本文件是可执行的逐步操作记录。SKILL.md 是门禁与总览；这里是逐步点击/选择器/代码。

**调用本 skill 时先读本文件「标准填法」和 §5，不要只读 SKILL.md 就开填。**（2026-09-27：多次只读 SKILL 导致虚拟滚动行数误判、绕过 ensureSpecTable 手拧规格。）

来源整合：
- **基线（mimocode）**：`resolve_env` / `pdd_flow` 三段流水线、状态字典、校验清单
- **补强（.claude）**：完整逐步 UI 代码与手工兜底片段（§A）

**路径不写死**：一律 `scripts/resolve_env.ps1` → `config.json` → 环境变量 → 探测。业务状态机优先调用 `scripts/pdd_flow.js`，不要复制粘贴带机器绝对路径的片段。

## 0. 环境与会话脚本

```powershell
# 本 skill 根目录（换机器改此处；与 SKILL.md 保持一致）
$skillRoot = "<技能根目录>"

# 读 config + 探测
. "$skillRoot\scripts\resolve_env.ps1"
$e = $script:PddEnv   # node / python / playwright_core / workdir / read_excel / flow_js / default_port

New-Item -ItemType Directory -Path $e.workdir -Force | Out-Null

# 导出给 stepN.js
$env:PDD_PLAYWRIGHT = $e.playwright_core
$env:PDD_FLOW_JS    = $e.flow_js
```

每个步骤写 `stepN.js`，执行：`& $e.node "$($e.workdir)\stepN.js"`

脚本骨架（**禁止杀用户 Chrome 进程**；用 `flow.disconnectPage` 只断开 CDP 客户端）：

```js
// 经 resolve_env.ps1 注入：$env:PDD_FLOW_JS / $env:PDD_PLAYWRIGHT / $env:PDD_PORT
const flow = require(process.env.PDD_FLOW_JS);
const { browser, page } = await flow.connectShop(process.env.PDD_PORT || 9222);
try {
  // ...操作...
  await page.screenshot({ path: '...' });
} finally {
  // 断开 Playwright 客户端连接，不 taskkill、不换 profile 重启
  await flow.disconnectPage(browser);
}
```

> Playwright `connectOverCDP` 下 `browser.close()` 是断开客户端连接；**不要** `taskkill` 用户 Chrome，也不要 `page.context().close()` 后另开未登录 profile。

CDP 探活：`Invoke-WebRequest http://127.0.0.1:9222/json/version`

**多店铺**：端口从用户/配置获取，先逐个探活再操作，不要并发。

## 1. 打开浏览器（首次）

```powershell
. "$skillRoot\scripts\resolve_env.ps1"
& $script:PddEnv.open_browser -Port $script:PddEnv.default_port -Profile $script:PddEnv.chrome_profile
```

- 已有 CDP 端口 → 不新开
- `reuse_profile` / `chrome_profile` → 复用**已登录**目录，避免全新未登录环境
- 等用户说「已登录」。列表页：`https://mms.pinduoduo.com/goods/goods_list`

## 2. 读 Excel + 预检

```powershell
. "$skillRoot\scripts\resolve_env.ps1"
$e = $script:PddEnv
& $e.python $e.read_excel "<xlsx路径>"
# exit 0=ok；exit 1=路径/解析硬错误；exit 2=预检未过，禁止连店
```

输出 JSON 含 `dimensions`、`skus[]`、`warnings[]`、`blocking_warnings[]`、`ok`。

**预检**：`ok !== true` → 先修数据再连店铺。

核对：类目、标题 ≤60 字符、SKU 数 >0、每行 stock/group/single/code/preview、参考价 > max(单买价)、图片存在（含 `素材包设置.根目录`）、编码不重复。

若解析错位，手读：

```python
from openpyxl import load_workbook
wb = load_workbook(path, data_only=True)
ws = wb['拼多多']
# 第1行类目，第2行表头，第3行SKU子表头，第5行起数据
# 维度列：优先第3行，第2行已知维度名也会并入 — 见 read_excel.py
```

## 3. 发布第一步：类目页

**URL**: `https://mms.pinduoduo.com/goods/category`

0. **多店铺查重**（每店填表前）— 用 `pdd_flow.checkDuplicate`

```js
const flow = require(process.env.PDD_FLOW_JS);
const dup = await flow.checkDuplicate(page, title, skus);
// exact_duplicate            → skipped_duplicate
// same_title_different_sku   → skipped_same_title_diff_sku（默认不覆盖）
// not_found                  → 可继续
// search_failed              → 不得当作「无重复」自动提交
```

指纹 = 规范化标题 + SKU 编码集合（+ 类目若列表页可见）。

**先判断新旧形态**：

```js
const isNew = await page.evaluate(() =>
  document.body.innerText.includes('商品主图') && document.body.innerText.includes('下一步'));
```

### 新版流程


#### 同一个 URL 有两种页面，必须先判别（2026-09-28 9228 实测）

`https://mms.pinduoduo.com/goods/category` **在不同店铺会渲染成完全不同的两套页面**，
所以**不能按 URL 判分支**，必须现场探测：

| 探测项 | 旧版页 | 新版页 |
|--------|--------|--------|
| `input[placeholder*="关键词搜索分类"]` 数量 | 1 | **0** |
| `.choose-category` 数量 | ≥1 | **0** |
| 是否有「下一步, 完善商品信息」 | 否 | **是** |
| 是否有 `*商品主图` + `上传图片 (N/10)` | 否（主图在 goods_add 里） | **是** |
| 选类目方式 | `searchCategory()`（见「旧版流程」） | `pickCategoryExact()` 选推荐类目卡 |

实测：**9226 店铺A = 旧版页；9228 店铺C = 新版页**（同一时段、同一 URL）。
`fillProductForm` 里的 `isNew` 判据是「正文含『商品主图』且含『下一步』」—— 与上表一致。

#### 新版页第一步的实测结构（9228）

```
发布新商品
*商品主图   图片要求：宽高比例 1:1 或 3:4，宽高均 >480px，3M 内（拖拽可调整顺序）
            上传图片  (0/10)
*商品标题
下一步, 完善商品信息
```

**推荐类目卡初始不存在**，必须**先把主图+标题填完，再点击页面空白处让标题失焦**才会出现 →
之后轮询（最多 ~20s，同时点「查看更多推荐」），再 `pickCategoryExact(page, categoryText, category_id)`。

> ### ★ 2026-10-05 复测补充（GPVC-001@9228 · 16 SKU 全流程 100.7s 通过）
>
> 1. **`run_listing.js` 已把这一整段固化**：传主图 → `ti.click()` 真实聚焦 → `Ctrl+A`/`Backspace` →
>    `type(标题, delay:10)` → 点「商品标题」标签（`position:{x:2,y:2}`）制造 blur → `openManualCategoryPicker`
>    → `searchCategory(路径, {confirm:true})` → 点「下一步, 完善商品信息」。实测 ② 段 12.3s→25.1s 走完，
>    读回 `chosen:"家居饰品 > 贴饰 > 墙贴"`、`confirmed:"确认"`。
> 2. **不要手写这一段**：`④ 详情图` 首次报 `detail_unstable_after_upload`、`⑨b` 补传都是脚本内置行为。
> 3. **第三步「下一步」之后**，表单页没有「商品轮播图」input（主图留在第一步的内存态），
>    表单里只有 辅助图/包装标签图（/10）+ 商品详情（/50）。`forceMain` 只读计数器确认，别改传到别的区。

> ### ★ 失焦这一步是最容易漏的坑（2026-09-28 9228 实测，绕了很久）
>
> 卡片是靠标题输入框的 **blur 事件**触发的，而 **blur 只在真正 focus 过之后才会发生**。
>
> - ❌ 用 `evaluate` + 原生 setter 直接写 `input.value` 并派发 `input/change` —— **DOM 里标题有值、
>   `inputValue()` 也读得回来，但从未聚焦过，点空白处不产生 blur → 卡片永远不出现**。
>   我据此一度误判成「9228 新版第一步根本没有推荐类目卡」，是错的。
> - ✅ 正确顺序：`locator.click()` 真实聚焦 → 键盘输入（`type` 或逐字）→ `page.mouse.click(空白坐标)`
>   → 断言 `document.activeElement` 已不是标题框（blur 确实发生）→ 卡片出现。
> - 排查时**先断言 `document.activeElement`**：聚焦失败、blur 未发生，比盯着「卡片没出来」有用得多。
>
> 9228 实测该卡 10 条候选，**目标「家居饰品 > 贴饰 > 墙贴」在第 1 条，第 2 条紧挨着就是「背景墙贴」**，
> 另有 `PVC墙纸`/`铝箔墙纸`/`纯纸墙纸`/`沙面墙纸（喷砂壁纸）`/`其他墙纸`/`墙布/壁布/布面墙纸`/
> `家居饰品 > 贴饰 > 地贴`/`节庆用品/礼品 > 婚庆用品 > 喜字/剪纸/贴纸`。
> `pickCategoryExact` 实测：目标 → `how: 'exact_full'` + `verified: true`；反向指向 `背景墙贴` →
> 高亮变为「背景墙贴」而非「墙贴」（PASS，未退化成子串匹配）。

#### ★ 首选路径：点「手动选择商品分类」用搜索选（2026-09-28 9228 实测通过）

**不要直接点推荐卡上的候选。** 推荐卡只给约 10 条预测，目标不在其中就没有出路，
而且候选里常混着高度近似的项（9228 实测：目标 `家居饰品 > 贴饰 > 墙贴` 在第 1 条，
**第 2 条紧挨着就是 `家居饰品 > 贴饰 > 背景墙贴`**）。

推荐卡下方有「**没有满意的推荐结果？手动选择商品分类**」（`button` 文案 `手动选择商品分类`），
点开后是**全量搜索弹窗**，结构与旧版分类页一致：

| 项 | 实测（9228） |
|----|-------------|
| 搜索框 | `input[placeholder*="关键词搜索分类"]` |
| 候选 | `li[class*=searchItem]`（实测 10 条） |
| 已选读回 | `已选分类` 行 |
| 确认按钮 | **`确认`**（旧版页是 `确认发布该类商品`） |

> ### ★ 「手动选择商品分类」入口常被折叠，找不到就先点「查看更多推荐」
>
> 推荐卡**初始只显示两三条**，这时页面上**根本没有**「手动选择商品分类」这个按钮。
> **必须先点「查看更多推荐」把列表展开，入口才会出现。**
> 另外，**确认过一次类目之后按钮也会消失**（卡片进入已确认态），同样要靠「查看更多推荐」把它找回来。
> 2026-09-28 实测：类目确认成「地毯」后入口消失，直接找按钮 → `button_not_found`；
> 先点「查看更多推荐」再找 → `{ok:true, how:'clicked'}`。
>
> `openManualCategoryPicker(page)` 已内置这个重试循环：
> 找按钮 → 没有就点「查看更多推荐」→ 轮询重试（默认 25s）。**不要自己写「找不到就报错」**。

> ### ⚠️ 弹窗里做匹配必须限定在 `li[class*=searchItem]`
>
> 弹窗里同时存在两类元素：
> - **搜索结果**（本次要选的）：`LI.SPP_searchItem_5-188-0`
> - **推荐卡残留候选**（上一次搜索/推荐留下的）：`DIV.cateItemCard_chooseCategory__*`
>
> 实测搜「地毯」时页面可见的「含 > 的条目」有 **28 条**，但真正的搜索结果只有 **10 条**。
> 所以**不能用全局文本全等**（`pickCategoryExact` 的全局匹配在这里不安全，会命中残留项）；
> 必须像 `searchCategory` 那样把范围锁在 `li[class*=searchItem]` 内。

```js
await flow.openManualCategoryPicker(page);                       // 打开弹窗（已在则返回 already_open）
const r = await flow.searchCategory(page, '家居饰品 > 贴饰 > 墙贴', { confirm: true });
if (!r.ok) throw new Error('category_failed: ' + r.reason + ' seen=' + JSON.stringify(r.seen));
// r.confirmed === '确认'
```

实测结果：`{ ok:true, chosen:'家居饰品 > 贴饰 > 墙贴', confirmed:'确认', seen:10 }`，
确认后弹窗关闭、页面第一步的 `*商品分类` 变为目标；
反向验证指向 `家居饰品 > 贴饰 > 背景墙贴` → `chosen` 为**背景墙贴**（PASS）。

确认后页面第一步会显示 `*商品分类 | 推荐使用以下分类，更符合平台规则，降低违规风险 | <路径>` ——
**读这一行核验**，与旧版页读 `商品分类` 等价。

**点「下一步」之后**：URL 带 `version=predictCate`，`商品分类` 会被**自动预测带入**（9228 实测预测正确）。
**即便如此也必须读回 `商品分类` 核验末段全等** —— 预测会错（历史上出现过「背景墙贴」）；
预测错了就从「修改分类」重选。卡片**一旦点了「下一步」就消失**，只剩预测值。

#### `pickCategoryExact` 已加固（2026-09-28）

原来的兜底链在全等失败后，会**无条件点第一个**命中的元素（`ends[0]` / `leafOnly[0]`）且不读回校验 ——
这与旧版页「只比叶子名 → 背景墙贴也能过」是同一类错。现在：

- 多命中（`ambiguous_ends_with_leaf` / `ambiguous_leaf_only`）**一律返回失败**并把候选放进 `candidates`，不再猜
- 放宽命中（`how` = `ends_with_leaf` / `leaf_only`）会返回 **`verified: false` + `warn`** ——
  **调用方必须读回「商品分类」核验末段全等**，不能只看 `ok`
- `how: 'cateId'` 与 `how: 'exact_full'` 才是 `verified: true`（按 `choosen_cate=<id>` 或整条路径全等命中）

**优先给 `category_id`（`choosen_cate`）**，那是最硬的判据；文本匹配只是退路。

1. **上传轮播图**
   ```js
   const files = fs.readdirSync(imgDir).filter(f=>/\.(jpe?g|png)$/i.test(f)).sort().map(f=>path.join(imgDir,f));
   // 新版第一步只有主图一个 file input，才可用 .first()；编辑页/完整表单必须按区块文本锁定
   await page.locator('input[type=file]').first().setInputFiles(files, { timeout: 20000 });
   await page.waitForTimeout(5000);
   ```
   成功标志：`已上传5/10张` 或 `已上传10/10张`。**同一组文件只传一次**；包装标签图无素材则留空。

2. **填标题**
   ```js
   await page.locator('input[placeholder*="商品标题"]').first().fill(title);
   ```
   长度 ≤30 汉字（60字符）

3. **选类目（在第一步就选，别等下一步）** ⚠️ 2026-09-28 修正
   推荐类目卡出现在**第一步**（主图+标题下方），**一旦点了「下一步」卡片就消失**，只剩预测类目（曾因此拿到「背景墙贴」）。
   - 卡片常在**主图+标题填完后**才出现 → **轮询等待**（最多 ~20s，同时点「查看更多推荐」）
   - 文本来自 Excel `类目` / `category_id`，禁止写死
   - 匹配优先级：`choosen_cate=<category_id>` → **完整路径全等** → 以 `> 叶子` 结尾 → 叶子全等。**禁止 includes（墙贴 ⊂ 背景墙贴）**
   ```js
   // 轮询到卡片出现
   for (let i = 0; i < 10; i++) {
     const more = page.getByText('查看更多推荐', { exact: false }).first();
     if (await more.count().catch(() => 0)) { try { await more.click({ timeout: 2000 }); } catch (_) {} }
     const hit = await page.evaluate((cat) => {
       const leaf = String(cat).split('>').pop().trim();
       return Array.from(document.querySelectorAll('*')).some((e) =>
         e.offsetParent && (e.textContent || '').replace(/\s+/g, ' ').trim().endsWith('> ' + leaf));
     }, categoryText);
     if (hit) break;
     await page.waitForTimeout(2000);
   }
   const picked = await flow.pickCategoryExact(page, categoryText, productData.category_id || '');
   ```

4. **点下一步**
   ```js
   await page.getByText('下一步, 完善商品信息', { exact: false }).first().click({ timeout: 10000 });
   ```
   进入 `goods_add/index?...&goods_id=...` 后**严格读回**：`商品分类` 按 `>` 分段，**末段必须全等叶子**（`墙贴` ≠ `背景墙贴`）。

5. 后续：品牌 → 属性 → 详情图 → 规格 → SKU → 参考价 → 预览（见 §4–§6）

> 完整编排可直接 `flow.fillProductForm(page, productData, opts)`（**不提交**）。

### 旧版流程（2026-09-28 PE5 修正 · 必读）

> **原本这里写的是「`document.querySelector('.choose-category')` 点一下」——那是错的做法，别再用。**
> `.choose-category` 是**「最近使用的分类」栏**里的项，不是搜索结果：
> 该栏不一定有目标类目；而且它的文本与下拉项**完全相同**（都是 `家居饰品 > 贴饰 > 墙贴`），
> 用「文本全等」会命中 **2 个**元素，`querySelector` 取第一个纯属撞运气。
> PE5 当初就是走了这个捷径，等于**整套类目匹配逻辑一次都没执行过**，白页面上看着「对了」而已。

**唯一正确做法：搜索关键词 → 在下拉里按「完整路径全等」选 → 读回「已选分类」→ 再确认。**
已封装为 `flow.searchCategory(page, categoryText, { keyword })`：

```js
const r = await flow.searchCategory(page, '家居饰品 > 贴饰 > 墙贴');
if (!r.ok) throw new Error('category_failed: ' + r.reason + ' seen=' + JSON.stringify(r.seen));
// r.chosen 已验过 === '家居饰品 > 贴饰 > 墙贴'
await page.getByText('确认发布该类商品', { exact: false }).first().click();
```

内部门禁（都要满足才返回 `ok:true`）：

- 下拉项选择器 `li[class*=searchItem]`（实测 `LI.SPP_searchItem_5-188-0`）
- 下拉里**整条路径全等**的项必须**恰好 1 条**；0 条 → `no_exact_match`，>1 条 → `ambiguous_exact_match`
- 点击后读回 `已选分类`，**必须整条路径全等**目标（比「末段全等」更严），否则 `selected_mismatch`
- 失败时返回 `seen`（下拉里所有可见路径），便于当场看清有没有更接近的类目

**为什么必须全等、禁止 `includes`**：搜「墙贴」时同一屏会出现
`家居饰品 > 贴饰 > 背景墙贴`、`家装主材 > 背景墙/工艺软包 > 软包墙贴`、
`玩具/…> 儿童玩具墙贴`，以及 `家装主材 > 墙纸 > PVC墙纸`、`铝箔墙纸`、`其他墙纸`。
PE5 实测下拉 10 条里**只有 1 条**是目标，其余全是近似项。

**反向验证（建议每次换类目都跑一次）**：故意用 `家居饰品 > 贴饰 > 背景墙贴` 调一次，
必须选中 `背景墙贴` 而不是 `墙贴`；若选成了 `墙贴`，说明判据退化成了子串匹配。PE5 实测 PASS。

**关键词怎么取（2026-09-28 地毯实测补充）**

默认取目标路径的**末段叶子**当关键词。若目标是**二级类目**（如 `居家布艺 > 地毯`），
叶子本身就是个大类、下拉里不存在「末段 == 关键词」的项，此时返回 `no_exact_match` 并带上 `seen` ——
**这是正确行为，不要改成「猜第一个」**。地毯实测：搜「地毯」下拉 10 条里含「地毯」的只有 4 条
（`客厅地毯/茶几毯`、`酒店地毯/商用地毯/户外地毯/办公地毯`、`婚礼地毯/庆典地毯`、`草坪地毯`），
**末段恰好等于「地毯」的 0 条**，因为「地毯」是二级类目而非叶子。
→ **目标必须传完整叶子路径（三级）**。

**失败模式（每次都看 `reason` + `seen`，不要静默继续）**

| reason | 含义与处置 |
|--------|-----------|
| `no_exact_match` | 下拉里没有整条全等的项。多半路径不是叶子 / 写错 / 该关键词下确实没有。看 `seen` 里最接近的那条 |
| `ambiguous_exact_match(n)` | 整条全等命中 n>1 条 → 判据不够严，**必须人工介入**，不要随便取一条 |
| `selected_mismatch` | 点了但读回「已选分类」≠ 目标 |
| `search_box_not_found` | 不在旧版分类页（可能是新版推荐卡流程）→ 改用 `pickCategoryExact` |
| `click_failed` | 找到项但点击未生效，重试一次 |

**三个关键词的实测样本（便于比对判据是否退化）**

- `墙贴` → 10 条，含「墙贴」但不全等 3 条（`背景墙贴`、`软包墙贴`、`儿童玩具墙贴`），目标 1 条
- `地毯` → 10 条，含「地毯」4 条，**末段全等 0 条**（关键词是二级类目）
- `地毯`（在 9228 手动选择弹窗里复测，结果与旧版页一致）→ 搜索结果 10 条：
  `居家布艺 > 地毯 > 客厅地毯/茶几毯`、`居家布艺 > 地垫 > 入户地垫`、`居家布艺 > 地垫 > 浴室地垫`、
  `居家布艺 > 地毯 > 酒店地毯/商用地毯/户外地毯/办公地毯`、`居家布艺 > 地垫 > 客厅地垫`、
  `居家布艺 > 地垫 > 卧室地垫`、`居家布艺 > 地毯 > 婚礼地毯/庆典地毯`、
  `居家布艺 > 地垫 > 商用/办公/户外地垫`、`家庭/个人清洁工具 > 卫浴/置物用具 > 地垫`、
  `鲜花园艺/绿植仿真/园林设备 > 园艺用品/园林五金 > 草坪地毯`。
  传二级路径 `居家布艺 > 地毯` → `no_exact_match`（正确拒绝）；传叶子
  `居家布艺 > 地毯 > 客厅地毯/茶几毯` → `ok`，确认后第一步 `*商品分类` 变为该路径。
- 反向验证 PASS 两次：指向 `背景墙贴` 选中 `背景墙贴`、指向 `酒店地毯/商用地毯/户外地毯/办公地毯`
  选中该条（而不是同屏的 `客厅地毯/茶几毯`）


3. 确认后 URL 含 `goods_id=`，进入 `goods_add/index?type=add&from=category&id=...&goods_id=...` 完整表单。

## 4. 完整表单：基本信息

### 4.1 品牌
品牌名来自 Excel；无品牌填「无品牌」→ 点「无品牌/无注册商标」。下拉同名选项用叶子文本点击。

```js
const brand = page.locator('input[placeholder*="品牌名称"]').first();
await brand.click();
await brand.fill(brandName);
await page.waitForTimeout(2000);
await page.evaluate((name) => {
  const els = Array.from(document.querySelectorAll('*')).filter(el =>
    el.offsetParent && el.children.length===0 && (el.textContent||'').trim() === name);
  if (els.length) els[els.length-1].click();
}, brandName);
```

### 4.2 类目属性（下拉）
通用 `pick(page, lab, opt)`：找到 label → 行内 `input` → mousedown/mouseup/click → 点 option。完整实现见 §A.1。

**注意**：先点「不使用」关掉「一键复用」横幅，否则会填成相似品属性。

属性名/值必须来自 Excel 或类目表单实际字段，不要写死「祺讯/墙贴」示例值。

### 4.3 厚度等数字
```js
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
setter.call(inp, '4.2');
inp.dispatchEvent(new Event('input', { bubbles: true }));
inp.dispatchEvent(new Event('change', { bubbles: true }));
```

### 4.4 详情图
按 file input 邻近文本 `/快捷编辑|0\/50/` 定位，再 `setInputFiles(detailFiles)`。完整代码见 §A.2。
成功：`已上传N/50张`

### 4.5 图区正确姿势（2026-09-27 PE4 固化 · 优先用）
**禁止 input index**；轮播/包装标签/辅助/详情同页，index 会串。
```js
const flow = require(process.env.PDD_FLOW_JS);
await flow.zoneByCounter(page, '商品轮播图', 10);  // {uploaded,total,idx}
await flow.zoneByCounter(page, '商品详情', 50);
await flow.zoneByCounter(page, '包装标签图', 10);   // 无素材须为 0

await flow.uploadZone(page, '商品轮播图', 10, mainFiles);   // 先传 → 稳定 → 多则裁剪
await flow.uploadZone(page, '商品详情', 50, detailFiles);
await flow.clearZone(page, '包装标签图', 10);              // 真实 hover + DeleteIcon
await flow.packagingLabelState(page);                      // {uploaded,total} | null
```
- **先传后删**：残留缩略图在上传新图前常常删不动
- 删除必须 `img.hover()` 后点 `i[class*="DeleteIcon"]` / `svg[data-testid=beast-core-icon-close]`
- **绝不点「保存草稿」**（重载页面，内存上传丢失）；也**不要 goto 重开**做验证

## 5. 规格与 SKU

### 5.0 行数 = 虚拟滚动（2026-09-27 实战）SKU 表 **虚拟渲染**：`document.querySelectorAll('tbody tr').length` 只是可视窗口（13/24/26 ≠ 真实 36）。
- **禁止**用 DOM tr 数做「缺行/矩阵没生成」的门禁
- **必须** `flow.getScrollMeta` + `flow.readAllSkuRows({ rowFilter, mapRow: sticky })` 数唯一 key
- sticky rowspan：续行无型号/颜色名时靠 `makeStickyMapRow` 继承
- 若 readAll 的 count == Excel 笛卡尔积 → 规格矩阵是好的，别清空重填（手拧会制造 undefined/重复规格值）

**⚠️ `readAllSkuRows` 的 `mapRow` 必须返回维度级 `key`**（2026-09-28 PE2 实测）：
去重键是 `mapped.key || text.slice(0,80)`。续行只显示末维值（`长5米*宽50厘米…`），同一组的续行**文本完全相同** → 不传 `key` 时会被 Map 合并，**行数严重偏少**（PE2 36 行读成 **17 行**，误判成「矩阵缺行」）。所以：
- 一律传 `makeStickyMapRow(dimNames, skuByKey)`（它返回 `key`），或自己 sticky 继承后拼 `型号|尺寸` 作 key
- 别用裸 `readAllSkuRows(page, { mapRow: (t,i)=>({text:t,vals:i}) })` 数行；那样只能得到「可见窗口内的唯一文本数」

### 5.1 改规格类型名

规格类型是 **`ST_selectValueSingle` 下拉**（不是裸 input 点击）：

1. 点 `input[placeholder="规格类型1"]` 外层 `ST_selectValueSingle_*` 打开 portal  
2. 在 portal 里点 **`[role="option"]`**，文案可能带徽标（如「尺寸常用」）→ `startsWith`/`includes` 匹配「尺寸」「款式」  
3. **读回 `input.value` 必须等于目标名**，否则重试  

不要用「全页叶子文本 exact === 名称」——会误点表头 `sku-thead-th`。

类型下拉没有「尺寸」→ 用「款式」代替。

### 5.2 添加规格值
「请输入规格名称」按 groupIndex 分组写入 + Enter；写完 **读回 `input.value`**。完整代码见 §A.3。

双维度：先 t1=颜色+全部值 → 再「添加规格类型」→ t2=尺寸/款式+全部值 → 系统交叉生成。
**关键**：t2 值必须填齐（如 `60x300cm`）；添加 t2 后 t1 可能被清空，需重填并读回。

### 5.3 自定义规格 UI
- 每个已有值一个 `input[placeholder*="自定义"]`
- 末尾空 input 才是新增；`Enter`/`Tab` 会**改当前值**而不是新增
- 改名：fill + Tab；新增：末尾 fill + Enter；删除：行内「删除」span
- 可删掉多余规格类型只留一维

### 5.4 虚拟表格滚动填价（与校验共用）

**不要写死 3200/5200**；用 `flow.getScrollMeta` / `flow.readAllSkuRows`：

```js
const flow = require(process.env.PDD_FLOW_JS);
const dimNames = productData.dimensions;
const skuByKey = flow.buildSkuByKey(productData.skus, dimNames);
const rowFilter = flow.makeRowFilter(productData.skus.flatMap(s => dimNames.map(d => s[d])));
const mapRow = flow.makeMapRow(dimNames, skuByKey);

// 填充：fillProductForm 内部已做；手工时同样走 readAllSkuRows 模式滚动
// 校验：validateForm 会再次全量读回
```

商品特定占位（`颜色正则`、`宽\d+cm` 等）**必须由 Excel `dimensions` + SKU 值动态生成**，禁止把示例正则当通用逻辑。

**填完后**以 `validateForm` 读回为准，不要只信 `fillSeen.size`。手工滚动骨架见 §A.4。

DOM setter 备选（Playwright fill 超时）：见 §A.5。

### 5.5 参考价
placeholder 含「最大单买价」；值 = Excel `ref_price`，且预检已保证 **> max(单买价)**。

```js
const inp = Array.from(document.querySelectorAll('input')).find(i =>
  i.offsetParent && (i.placeholder||'').includes('最大单买价'));
setter.call(inp, String(refPrice));
inp.dispatchEvent(new Event('input', {bubbles:true}));
inp.dispatchEvent(new Event('change', {bubbles:true}));
```

### 5.6 长规格值的行定位（2026-09-28 店铺C9228 固化 · 必读）
长型号名（`木纹米黄升级强胶款/增厚暴粘`）在 SKU 行里会被**截断**成 `菌纳米款/旗舰品质`：
- **禁止**用 `text.includes(型号全名)` 匹配行 → 不同颜色/档位会被判成同一行（曾把整表写成一个码）
- **正确**：`块标题 + 长度` 定位
  - 块标题 = 该块**首行**（`tr.querySelectorAll('td').length >= 8` 的那行）文字中 ` 长` 之前的部分，且与 payload 型号名**全等**
  - 长度 = 行文字里的 `长\d+米`
  - 组合唯一确定 SKU → 覆盖写 库存/拼单价/单买价/编码
- 写完**逐行读回**比对（`validateForm` 的 `code_per_row`）

### 5.7 规格 chip 提交（2026-09-28）
- 批量 `evaluate` 写值 + `Enter` 常丢**末位值**（12 个只落 10 个 → 矩阵 30/36 行）
- 必须读回 chip 数并跟维度值集合比对；补值用**真实 click + type + `Tab`**（`ensureSpecValuesRobust`），Tab 比 Enter 可靠
- 补齐后再用 `readAllSkuRows().count == 笛卡尔积` 确认矩阵行数
- 新生成的行库存被预填 **`0`** → 视作「未填」（否则 `total_stock` 永远差 6×500）

### 5.8 滚动只滚表（2026-09-28）
- `scrollTopTo` 只设置 **tbody 祖先中 `overflow-y:auto/scroll`** 那个元素的 `scrollTop`，**不再 `window.scrollTo`**（否则页面猛跳、表却没动）
- 自查：滚前后 `window.scrollY` 应不变，表格容器 `scrollTop` 应变

### 5.9 编辑页 SKU 行的 input 列序（2026-09-28 PE3/PE4 实测 · 必读）

编辑页每行有 **5 个**可见 `input[placeholder="请输入"]`，顺序**不是**「库存/拼单价/单买价/编码」：

| 序 | 所在格 | 语义 |
|----|--------|------|
| 0 | 「库存增减」格（cls 含 `quantity`） | **库存** |
| 1 | 下一格（表头叫「改后库存」） | **库存**（与 #0 **同一状态、镜像同步**，写哪个都行） |
| 2 | `sku-input` | **拼单价** |
| 3 | `sku-input` | **单买价** |
| 4 | `sku-input` | **规格编码** |

- 旧的 `[库存, 拼单价, 单买价, 编码]` 四列假设**会把拼单价写进库存** —— 这正是当年 PE2 跑完 p2 还得叠一堆修正脚本的根因
- 表头 10 列、行 `td` 数 10（组首行）/9（续行）——**不要按 td 下标映射**，按上面的 input 序
- `td.sku-preview-cell` 里是 **file input**，不算在文本 input 内
- **换页面/换版本先实测列语义**：给 5 个 input 各写**不同**值再逐格读回；往数字列写非数字（如 `TESTCODE`）会被自动清空 → 借此识别数字列；写 `1500` 后看「总库存」是否变 1500 → 确认库存列

### 5.10 改线上已有链接：规格类型/值对调（2026-09-28 PE2/PE3/PE4 固化 · 必读）

**症状**：「型号」装的是长度（3 值）、「尺寸」装的是颜色+档位（12 值），语义颠倒。
**根因**：店透视数据包原始就是 `型号=长度、尺寸=颜色+档位`，上架时照抄。
**正确形态**：`型号 = 颜色+档位（12 值）`、`尺寸 = 长度（3 值）`。**类型名不动，只对调两个类型下的值位置，值文字一个都不改**。

**为什么必须重建、不能原地改名**：3 行一组要变成 12 行一组，且值要跨类型搬 → 只能**清空两个类型的全部值，再按新顺序重加**。

步骤（`（原引用的 swap_live_specs_p1.js 已不在包内；规格对调见 pdd-fix-listing-specs 技能）` 已实现，实测可用）：
1. 商品列表搜 goods_id → 点「编辑」进编辑页（记完整 URL `id=<commitId>&goods_id=<id>`）
2. 读 chips 分组（DOM 顺序：`规格类型1` → `规格类型2`，期间出现的 `请输入规格名称` 归到当前组）
3. **先清组1、再清组0**：逐值 `click` → `Ctrl+A` → `Backspace`，直到该组剩余 0
4. 按新顺序加：组0 ← 12 个颜色档位；组1 ← 3 个长度。**真实 click + type + `Tab`**（别用批量 setter + Enter，会丢末位，§5.7）
5. **读回门禁**：`g0===12 && g1===3` **且** `readAllSkuRows().count === 笛卡尔积`（36）

**⚠️ 动手前必须告知用户的后果**：对调会**重建 SKU 表**，行级数据全丢（库存/拼单价/单买价/规格编码/预览图）→ 之后必须**整表回填 36 行**（列序见 §5.9）+ **重传 36 张预览图**（§6）+ 参考价，才能保存。工作量 ≈ 重新上架一次。

**用 `dimensions` 取向避免再次搞反**：`fillProductForm` 把 `dimensions[0]` 写进规格类型1、`dimensions[1]` 写进规格类型2 → payload 就写 `dimensions:['型号','尺寸']` 且 sku 里 `型号=tier`、`尺寸=length`。**不要再依赖「页面语义与 payload 反着」的隐式约定**（那正是老脚本越叠越多的原因）。

**交付纪律（用户明确要求 · 硬规则）**：
- **一条一条来**：一条做完（对调+回填+补图+双向校验）**立刻停下报告**，**由用户自己检查、自己点「提交」**，agent 不碰提交按钮
- **改动只在内存里**：编辑页标签一关/刷新/被复用，全部改动消失 → **做完立刻交付，不要挂着这条去做别的链接**（PE3 首次就是这样丢的：全部校验通过，但标签没了，线上还是旧的）
- 编辑页按钮：`提交`（蓝色主动 = 保存）、`保存草稿`（灰色 = **禁止点**，会重载页面丢内存）
- 保存前**双向校验**：图片按 §6.2 像素比对 + 行值按 §5.11 数值比对

> 这条流程已独立成 skill：**`pdd-fix-listing-specs`**（含完整步骤、踩坑表、代码骨架与交付纪律）。本节只保留共用机制要点，执行时以那个 skill 为准。

### 5.11 逐行值比对要按「数值」比（2026-09-28）
页面显示 `41`、素材包写 `41.0` → 直接字符串比会误报一片不一致（本次 28 处假失败，实际 0 处真错）。
比对前 `float()` 归一（`f'{float(s):.4f}'`），非数字（规格编码）再退回字符串比。


## 6. 预览图上传

**★ 单图体积硬限制（2026-09-30 ZDT-003 实测 · 必读）**：拼多多拒绝任何 **>3MB** 的图片，平台文案是「**上传图片大小不能超过 3MB**」。
- 实测：自粘地毯预览图 24 张 `1024×1024` PNG 恰为 **3164952 字节（3.02MB）** → 全部被拒，流程停在 ⑧ 预览图。
- **上传前必检**：`build_product.py` 的 `copy_ascii` 会对超限图 **exit 6**；>2.5MB 给警告。
- **压图配方**：`Image.resize((800,800), LANCZOS)` → `PNG optimize`（约 400–750KB）；仍超限再 JPEG `quality=88`。预览格是缩略图，800×800 足够。
- **只压 work 目录副本**即可，素材包原图可以不动。

**判「有没有图」**（2026-09-28 修正）：看目标行 `td.sku-preview-cell` 内是否存在 `[class*=imageWrapper]`。取该行现有图的 URL：
`cell.innerHTML.match(/url\(&quot;([^&]+)&quot;\)/)[1]`（URL 在 `imgContainer` 的 inline `background-image`，`getComputedStyle` 取不到，必须读 innerHTML）。
脚本只能判「有没有图」，图**对不对**要靠 §6.2 像素比对。

- **只补缺图**：没有 `imageWrapper` 的行才传图
- **禁止盲删重传**（2026-09-28 曾删出缺图、误替换）；需替换先问用户，替换后必须复核无「请上传第N行」横幅
- **用户只说「补上」时不要顺手替换已有图**（2026-09-28 PE2：36 行里 15 行有旧图、21 行空，用户选择只补 21 行、保留旧图）
- 用户指认某块图错 → 按 §5.6 的「块标题+长度」定位该行再替换，最小改动

行内两态：
- **待上传态**：`upload-logic` + 「本地上传」按钮 + 隐藏 `input[type=file]`
- **已有图态**：`[class*=imageWrapper]`（无 file input）

- 用 `flow.getScrollMeta` 动态 `scrollHeight` + **depth** 滚动（勿写死 3200）
- **维度 rowspan 继承**：续行只显示末维值 → 必须 sticky 继承（PE2 是 型号 rowspan + 尺寸，`makeStickyMapRow` 同理）
- 路径含中文/空格 → 先复制到 ASCII 路径再传
- 映射：`opts.colorToFile[维度值]` 或 `opts.previewByCode[code]`

### 6.1 传图方式优先级（2026-09-28 PE2 固化 · 必读）

1. **首选**：该行 `td.sku-preview-cell` 内的 `input[type=file]` → `setInputFiles`（input 是隐藏的也能传，Playwright 不要求可见）
2. **兜底**：没有 file input 才点「本地上传」+ `page.waitForEvent('filechooser')`

**禁止点「本地上传」按钮**：该按钮在 sticky 定位 + 虚拟滚动下 Playwright 判定 `element is outside of the viewport`，`click` 必超时（2026-09-28 PE2 实测，重试 13 次全失败；改传同格隐藏 input 一次成功）。§A.6 里的 filechooser 分支仅用于「无 input」的素材库态。

**虚拟表格单行定位**：`td.sku-preview-cell` 会随滚动回收，`nth(i)` 下标在传图后会失效 → **每传一行就重新扫码一次**（传完 break 出内层循环、重新 scroll+scan），不要缓存下标批量传。

传完必须**逐行读回** `imageWrapper` 是否出现（默认轮询 ~20s），再跑 §6.2。

### 6.2 上传后内容校验（像素比对）

「有图」≠「图对」。把页面返回的图下载回来和源文件比对：

```python
from PIL import Image, ImageChops
import io, urllib.request
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
up  = Image.open(io.BytesIO(urllib.request.urlopen(req, timeout=40).read())).convert('RGB')
ref = Image.open(src_path).convert('RGB')          # 本地源文件
m = sum(sum(p) for p in ImageChops.difference(up.resize((128,128)), ref.resize((128,128))).getdata()) / (128*128*3)
# MATCH 判据 m < 8；PDD 返回 JPEG，重编码噪声实测 0.24~0.30，阈值 8 足以区分「传错图」
```

实测 21/21 全 MATCH（meanAbsDiff 0.24~0.30）。这套校验同时能发现「图片被别的行覆盖」「传成相邻 SKU」这类肉眼难查的错配。

探测与上传循环见 §A.6。

### 6.3 9228 新版类目第一步：**没有 file input**，主图别在这儿硬传（2026-09-28 实测）

> **更正（2026-09-28 9228 复测）**：原记载「新版类目第一步**没有** file input」**不成立**。
> 9228 实测该步**有 1 个 file input**，页面显示 `上传图片 (0/10)`。
> 是否出现 file input 取决于**该页当时有没有服务端草稿**，所以要**现场探测**（`input[type=file]` 计数），
> 不要按店铺或按版本写死；探测不到才走 `mainFiles: []` 跳过主图续填。

- 区块标签是 **`*商品主图`**（不是「商品轮播图」）、容器 `id="carouselList"`；文案要求 **比例 1:1 或 3:4、≥480px、大小 3M 内**（⚠️ 是 **3M**，别按别处写的 1M 去压）
- 页面加载后 **`input[type=file]` 数量为 0**（上传控件是 `MaterialModalButton`；**悬停也不会**冒出来）
- 于是 `uploadZone`（按计数器文本找区）和 `waitForImageInput`（纯轮询 input）**双双失配** → `fillProductForm` 在 `main_images` 步返回 `main_block_not_found`，**直接提前结束，后面的步骤一个都不执行**
- **但这份 `goods/category` 页可能是服务端草稿**：`fillProductForm` 一开始就 `goto` 了类目页，之后页面上仍能看到 10 张主图 → 说明主图已随草稿持久化，**能扛过一次页面加载**
- **续填办法**：`fillProductForm(page, productData, { mainFiles: [], ... })` —— 内部 `if (mainFiles.length)` 正好是**跳过主图步骤的开关**，于是它继续走 标题→类目→下一步→品牌→属性→详情→规格→SKU→参考价→预览
- **先确认草稿里的图对不对**：把 `#carouselList` 每个槽位的 `background-image` URL 下载回来，与候选源做 §6.2 像素比对（本次 10/10 **逐位对上** PE4 新木纹套）
- ⚠️ 槽位类名带**构建哈希后缀**（`MaterialModalButton_v2_imageWrapper__ukMzO`），换一次加载可能变 → 选择器一律用 `[class*=imageWrapper]` 这类前缀匹配，**别写死完整类名**（否则会误判成「槽位空了」）
- 跳过主图后紧接着会撞 `category_pick_failed`：见 §11 对应行（标题刚填上时推荐类目卡还没渲染，要轮询）

## 7. 结构化校验与提交（严格三段）

```text
fillProductForm(page, data)     // 绝不提交
  → validateForm(page, data)    // 虚拟滚动全量 + unknown 阻断
  → allPass === true
      ? submitProduct(page, validation)
          // 内部：承诺发货时间不可选 → 重选 24/48
          // success 仅当 goods_add/success
      : 禁止提交，修复后重跑
```

```js
const flow = require(process.env.PDD_FLOW_JS);

const fill = await flow.fillProductForm(page, productData, opts);
if (!fill.ok) return { status: 'fill_failed', fill };

const validation = await flow.validateForm(page, productData);
// checks[].status ∈ pass | fail | unknown —— unknown 与 fail 同样禁止提交

if (!validation.allPass) {
  console.table(validation.checks);
  return { status: validation.anyUnknown ? 'validation_unknown' : 'validation_failed', checks: validation.checks };
}

const sub = await flow.submitProduct(page, validation); // 内部再次断言 allPass
// sub.goodsId / sub.success
```

**遮罩**：`submitProduct` → `dismissOverlays` 先点关闭/取消/知道了/Escape；**不要**一上来对 `[data-testid*=modal], MDL_mask` 做 `remove()`（会与 React 状态脱节、掩盖真实错误）。

编辑页按钮文案可能是「提交」而非「提交并上架」。

**列表验证**：`flow.verifyListed(page, goodsId)`。

## 8. 多店铺批量执行（幂等）

```js
const flow = require(process.env.PDD_FLOW_JS);
const results = [];

for (const shop of shops) {
  const row = { shop: shop.name, port: shop.port, goodsId: null, status: 'pending', checks: null, error: null };
  let browser;
  try {
    ({ browser } = await flow.connectShop(shop.port));
    const page = browser.contexts()[0].pages().find(p => p.url().includes('mms.pinduoduo.com'));
    if (!page) { row.status = 'no_page'; results.push(row); continue; }

    const r = await flow.listProductSafe(page, productData, opts);
    Object.assign(row, r);
  } catch (e) {
    row.status = 'error';
    row.error = e.message;
  } finally {
    await flow.disconnectPage(browser); // 只断开连接
  }
  results.push(row);
}

// 任何失败都要在最终回复展示 — 禁止静默
console.table(results.map(r => ({
  shop: r.shop, port: r.port, goodsId: r.goodsId, status: r.status,
  failed: r.checks ? r.checks.filter(c => c.status !== 'pass').map(c => c.name).join(',') : (r.error || '')
})));
```

**状态字典**：

| status | 含义 |
|--------|------|
| `skipped_duplicate` | 精确重复（标题+编码） |
| `skipped_same_title_diff_sku` | 同标题不同 SKU，默认不覆盖 |
| `search_failed` | 查重搜索失败 ≠ 无重复 |
| `fill_failed` | 填表未完成（类目读回/标题/上传/必填属性等，见 reason） |
| `validation_failed` / `validation_unknown` | 禁止提交 |
| `submitted` | 已提交 |
| `submit_error` / `error` | 失败，记录原因 |

**多店铺注意**：
- 单店铺失败不阻断其它店铺
- 类目/运费模板以各店实际为准
- 价格/库存/编码同一份 Excel
- 标题可完全一致，也可让用户指定微调

## 9. 编辑已有商品

- 列表点「编辑」→ 可能开新 tab
- URL: `goods_add/index?id=...&goods_id=...&type=edit`
- 按钮是「提交」
- 编码取最后一个「请输入」
- **已审核商品可能提示不能更新规格** → 只能重新上架

## 10. 历史实战数据（参考）

| 商品 / 店铺 | goods_id / 端口 | SKU | 类目 | 结果 |
|------|----------|-----|------|------|
| 猫抓自粘毛毡 | 1002028998359 | 72 | 猫抓板 | 销售中 |
| 白色木纹墙纸 | 1002089918834 | 4 | PVC墙纸 | 销售中 |
| 猫抓布墙贴 | 1002096801266 | 36 | 墙贴 | 曾因图含顺丰驳回 |
| JH格栅 | 1002128349521 | 16 | 墙贴 | 销售中 |
| 洞石墙纸 店铺B | 1006607763043 / 9227 | 颜色+尺寸 | 墙纸 | 销售中 |
| 洞石墙纸 鱼益 | 1006580347019 / 9226 | 颜色+款式 | 墙纸 | 见会话记录 |
| 洞石墙纸 店铺C | 1006589909296 / 9228 | 颜色+款式+60x300cm | 墙纸 | 见会话记录 |
| 00016洞石 店铺B | 1009192540975 / 9227 | 5色×60x300cm | 墙贴 | 销售中 · 2026-09-24 |

## 10.5 2026-09-22 实战备忘（900016 猫抓布 / 三店）

| 项 | 结论 |
|----|------|
| `.claude` 副本 | 已归档，细节可参考；业务只走 mimocode `pdd_flow.js` |
| 添加规格类型 | 按钮文案是 `添加规格类型(0/2)`，`exact:true` 点不中；用 `button hasText` 或 includes |
| 加第二维 | 先填 t1 类型名，否则「添加规格类型」`disabled` |
| 72 SKU 填价 | Playwright `fill()` 会超时；在 `page.evaluate` 里用 native setter 批量填更快 |
| 颜色 rowspan | 行文本常只有尺寸；必须 sticky 继承上一出现的款式/颜色 |
| 错误计数 | 页面是 `错误（0）`（中文括号），不是 `0个错误`；正则两者都认 |
| 主图 | 900016 是纳米胶竞品图，**不能当猫抓布主图**；猫抓布用 `000002_cat\拼多多\猫抓布墙贴` 的 `白色猫抓布-01…08` |
| 标题 | 竞品标题「纳米胶…」不对；猫抓布用「猫抓布墙贴…」 |
| 类目 | Excel 写「猫抓板」易被系统落到「墙贴」；用户要求按猫抓布产品线，属性/流量按墙贴类也可，**上架前先跟用户确认** |
| 编辑已上架 | `type=edit` 按钮是「提交」；删图要点缩略图 close，可能弹「确定」 |
| 本批状态 | 9226 `1008328998578` 曾销售中但改图时标题回退/主图 6–8 张，**用户自行手改**；9227/9228 未上 |

**用户说「我来改」时：停后台操作，只沉淀经验。**

## 10.6 2026-09-22 实战备忘（900017 自粘猫抓板 · 店铺C9228）

| 项 | 结论 |
|----|------|
| goods_id | **1008345583767** · **销售中** · 库存 720000 · 拼单价 27.9～90 · 参考价 98 |
| 类目 | 预测成沙发 → 「查看更多推荐」→ `choosen_cate=16435` → 猫抓板 |
| 标题 | AI/误点可能改成短词 → 每步读回 Excel 标题 |
| 颜色 rowspan | 6 色 × 12 尺寸；续行无颜色名 → sticky 继承才填满 72 SKU/预览图 |
| 真滚动层 | tbody 上第 3 层，`clientHeight≈820` `scrollHeight≈5000`；`.sku-list` 常不够 |
| 预览图 | 有 file 直接传；无 file 点「本地上传」+ filechooser |
| 提交卡死 | 「已选中的承诺发货时间现不可选」→ 重选 24 小时后到 `goods_add/success` |
| 规格命名 | 按店透视：类型颜色+尺寸；`30cm*1米`→`100厘米*30厘米【不伤爪】` |

## 11. 常见错误文案 → 动作

| 文案 | 动作 |
|------|------|
| 请上传第N行规格的预览图 | 滚动找缺图行：`td.sku-preview-cell` 内无 `[class*=imageWrapper]` → 传该行 `input[type=file]`（**首选**）；无 input 才点「本地上传」+ filechooser；维度 rowspan 继承 |
| 点「本地上传」报 `element is outside of the viewport` | 该按钮在 sticky + 虚拟滚动下不可点 → 改成同格隐藏 `input[type=file]` 的 `setInputFiles`（§6.1） |
| `readAllSkuRows` 行数远少于笛卡尔积 | `mapRow` 没返回维度 `key`，续行同文本被去重（PE2: 36→17）→ 传 `makeStickyMapRow`（§5.0） |
| 参考价应大于商品最大单买价 | 参考价改 max(单买价)+余量（预检应拦住） |
| 请输入第N行规格的库存 | `validateForm` 滚动读回补填 |
| 请确保该商品中含有所选材质 | 属性与实际不符，改属性 |
| 顺丰发货描述 | 图/标题含顺丰，换图或改运费模板 |
| 已选中的承诺发货时间现不可选 | 重选 24/48/当日发货 radio，再点提交（`submitProduct` 已处理） |
| category_pick_failed / category_readback_failed | 确认 Excel category_id 与类目叶子；禁止继续 |
| title_readback_failed | 标题被 AI/误点改写，重新 fill Excel 标题 |
| detail_upload_timeout | 仅在 `expectTotal:50` 的 `已上传N/50` 仍为 0 时算失败；勿把全页 `0/10` 当详情进度 |
| 主图上传等待 | `expectTotal:10`；辅助图「0/10」不算失败 |
| required_attributes_missing | 仅真字段缺选；填写率/点击反馈等 chrome 不计入 |
| 旧版类目误选套装玩具 | 搜叶子后点完整路径 exact，校验**已选分类**行后再确认 |
| 类目拿到「背景墙贴」而非「墙贴」 | 子串匹配 bug；读回按 `>` 分段**末段全等**；选择器用 §3 新版流程的严格匹配 |
| 编码集合对了但颜色/型号错配 | 看 `code_per_row`（新增）；行定位用 §5.6「块标题+长度」，禁用 includes |
| 行内型号被截断（`菌纳米款/旗舰品质`） | 长型号名必然截断 → §5.6 定位法 |
| 总库存差 6×500 | 新行库存被预填 `0`；`0` 当「未填」处理（`fillEmptySkuRows` 已修） |
| 点击脚本时页面猛跳、表没动 | `scrollTopTo` 旧版会 `window.scrollTo`；已改为只滚表的滚动容器（§5.8） |
| 预览图是否「对」 | 「有图」≠「图对」：下载页面图与源文件 resize 128 求 meanAbsDiff，<8 判 MATCH（§6.2）；**禁止盲删重传**，只补缺图 |
| 点「本地上传」按钮报 `element is outside of the viewport` | sticky + 虚拟滚动下该按钮不可点 → 改传同格隐藏 `input[type=file]`（§6.1） |
| `readAllSkuRows` 行数远少于笛卡尔积（如 36→17） | 去重键是 `mapped.key \|\| text.slice(0,80)`：续行文本相同会被合并 → `mapRow` 必须返回维度级 `key`（传 `makeStickyMapRow`，§5.0） |
| 编辑页写入后「拼单价」跑到库存列 | 列序是 `[库存, 库存镜像, 拼单价, 单买价, 规格编码]`，不是四列（§5.9） |
| 逐行值比对报一大片不一致，但肉眼看都对 | 页面 `41` vs 素材包 `41.0` → 按 `float()` 归一后再比（§5.11） |
| `connectShop` 报 `cdp_too_many_tabs`；或 `connectOverCDP` 握手超时 | 标签 ≥7 就会这样。读操作改走**页级 WS 直连**（§12.1）；要写操作先试 `{maxTabs:12}` 放宽，仍握手超时再请用户关掉多余标签 |
| 页级直连读表只拿到十几行 | 滚动容器选错 + 未触发 re-render：取 scrollHeight 最大的可滚动祖先，且每次滚动后先查一次 `tbody tr`（§12.1） |
| 9228 类目第一步 `main_block_not_found`，后续步骤全没跑 | 该页**没有 file input**（`MaterialModalButton` 控件）→ 主图通常已在服务端草稿里；用 `mainFiles: []` 跳过主图步骤续填（§6.3） |
| 跳过主图后 `category_pick_failed` | 标题刚填上时推荐类目卡**还没渲染** → 轮询等待 + 点「查看更多推荐」，再 `pickCategoryExact`（§11 同条） |
| 判断 9228 主图槽位「空了」 | 槽位类名带构建哈希后缀，换了加载就变 → 用 `[class*=imageWrapper]` 前缀匹配再下结论（§6.3） |

## 12. 校验清单（`validateForm` 全量）

| 检查项 | 通过 | 失败/未知 |
|--------|------|-----------|
| errors | 明确 `0个错误` | fail 或 **unknown 禁止提交** |
| price_displayed | 有具体拼单价 | 空→unknown；自动计算→fail |
| total_stock | 页面总库存 == Excel Σstock | 不等 fail；读不到 unknown |
| sku_count | 全量读回 == sku_count | 不等 fail |
| no_empty_stock | empty=0（含首行） | fail |
| code_per_row | 每行编码 == 该行 SKU 的编码 | 任一错配 fail（抓颜色/型号错配） |
| stock_match / price_match | 逐行 == Excel | fail |
| codes_nonempty / codes_exact | 双向集合 + 行数==SKU数；Excel 同码共享或 allow_duplicate_codes 时允许页面重复 | fail |
| scroll_coverage | 每个 Excel key 都被读到 | 漏行 fail |
| preview_images | 无缺图文案 | fail |

**全部 `pass` 才允许 `submitProduct`。**

---

## 12.1 CDP 连接：标签数保护 + 「页级直连」逃生（2026-09-28 PE2/PE3 实测）

`connectShop(port)` 先 `probeShop(port)`，**标签 >6 直接抛 `cdp_too_many_tabs`**。

> **⚠️ 更正（2026-09-29 9228 实测）**：遇到 `cdp_too_many_tabs` **不要第一反应就让用户关标签**。
> 多余标签常常是**用户自己的营销 / 生意参谋页**（9228 那次 7 个标签里有 5 个是，
> `yingxiao.pinduoduo.com/goods/promotion/list`、`mms.pinduoduo.com/sycm/goods_effect`），
> 关掉会打断他正在做的事。**先试放宽门槛**：
>
> ```js
> await flow.connectShop('9228', { maxTabs: 12 });   // 实测 7 标签下 0.5s 连上，握手并未超时
> ```
>
> 真的握手超时（`cdp_handshake_failed`）再请用户关。下表的「现象」是在**不放宽**的前提下观测到的。

更要命的是实测发现：

| 标签数 | 现象 |
|--------|------|
| ≤6 | 正常 |
| 7 | `connectShop` 被拦；**浏览器级 `connectOverCDP` 握手开始超时**（WS 已连上，但握手 30s / 90s 都不完成） |
| 9+ | 同上（9228 常态，9 个标签） |

**逃生：页级 WS 直连** —— 读操作最稳，不需要浏览器级握手：

```js
// Node 22+ 自带全局 WebSocket，不需要额外依赖
const list = await (await fetch('http://127.0.0.1:9226/json/list')).json();
const t = list.find(x => x.type === 'page' && x.url.includes('goods_add') && x.url.includes(GOODS));
const ws = new WebSocket(t.webSocketDebuggerUrl);   // ← 用「该页面自己的」ws，不是 /json/version 里 browser 的
// 然后发 Runtime.evaluate { expression, awaitPromise: true, returnByValue: true }
```

- **适合**：读回 DOM/表格、取数校验 —— 凡是一个 `Runtime.evaluate` 能表达的读操作
- **不适合**：`setInputFiles` / 真实点击（需要 Playwright）→ 那些必须 `connectOverCDP`；标签多时**先试 `connectShop(port, { maxTabs: 12 })` 放宽**；确实握手超时才请用户关掉多余标签，别硬重试
- 探活不等于能连：`Invoke-WebRequest http://127.0.0.1:PORT/json/version` 有响应 ≠ 握手能成功
- 工程上把连接收敛进一个小模块（`openEdit(port,goodsId)` / `openPort(port)`），业务脚本只拿 `page`；`pdd_flow` 里所有接 page 的函数（`getScrollMeta`/`scrollTopTo`/`validateForm`/`readAllSkuRows`…）照常可用

**页级直连读虚拟表**：只滚「第一个可滚动祖先」可能滚到假的 → 收集**所有**可滚动祖先、取 `scrollHeight` 最大者，且每个都设一遍 `scrollTop`；并且**每次滚动后先查一次 `tbody tr`**（触发 re-render）再收集，否则只拿到初始渲染的那十几行（本次先读成 7 行 / 15 行，补上这两点才拿到完整 36 行）。

## A. 手工兜底代码（来自 .claude 版逐步沉淀）

优先走 `flow.*`；仅当 flow 某步在新 UI 上失效、需要单独 step 调试时使用下列片段。示例中的维度/正则必须按当前 Excel 替换。

### A.1 类目属性 pick

```js
async function pick(page, lab, opt) {
  const opened = await page.evaluate((lab) => {
    const label = Array.from(document.querySelectorAll('*')).find(el =>
      el.offsetParent && el.children.length===0 && (el.textContent||'').trim() === lab);
    if (!label) return false;
    let row = label;
    for (let i=0;i<6 && row;i++) {
      row = row.parentElement;
      if (!row) break;
      const inp = row.querySelector('input[placeholder="请选择"], input:not([readonly])');
      if (inp && inp.offsetParent && inp.type !== 'file') {
        const r = inp.getBoundingClientRect();
        for (const type of ['mousedown','mouseup','click']) {
          inp.dispatchEvent(new MouseEvent(type, {bubbles:true, cancelable:true, clientX:r.x+10, clientY:r.y+10}));
        }
        return true;
      }
    }
    return false;
  }, lab);
  if (!opened) return { lab, ok:false };
  await page.waitForTimeout(700);
  const picked = await page.evaluate((opt) => {
    const cands = Array.from(document.querySelectorAll('*')).filter(el =>
      el.offsetParent && el.children.length===0 && (el.textContent||'').trim() === opt);
    if (!cands.length) return false;
    cands[cands.length-1].click();
    return true;
  }, opt);
  await page.waitForTimeout(400);
  return { lab, opt, ok: picked };
}
```

### A.2 详情图定位

```js
const fmap = await page.evaluate(() => Array.from(document.querySelectorAll('input[type=file]')).map((el, idx) => {
  let node = el, ctx = '';
  for (let i=0;i<8 && node;i++) {
    node = node.parentElement;
    if (!node) break;
    const t = (node.innerText||'').replace(/\s+/g,' ').trim();
    if (t.length > 10) { ctx = t.slice(0,90); break; }
  }
  return { idx, ctx };
}));
const detailIdx = fmap.findIndex(f => /快捷编辑|0\/50/.test(f.ctx));
// 常见 index=6
await page.locator('input[type=file]').nth(detailIdx).setInputFiles(detailFiles, { timeout: 25000 });
```

### A.3 添加规格值（groupIndex 分组）

```js
async function addValues(page, groupIndex, values) {
  for (const v of values) {
    await page.evaluate((args) => {
      const { value, groupIndex } = args;
      const inputs = Array.from(document.querySelectorAll('input[placeholder="请输入规格名称"]')).filter(el => el.offsetParent);
      const type1 = document.querySelector('input[placeholder="规格类型1"]');
      const type2 = document.querySelector('input[placeholder="规格类型2"]');
      const y1 = type1 ? type1.getBoundingClientRect().top : 0;
      const y2 = type2 ? type2.getBoundingClientRect().top : 1e9;
      const mid = (y1 + y2) / 2;
      const candidates = inputs.filter(inp => {
        const y = inp.getBoundingClientRect().top;
        return groupIndex === 0 ? y < mid : y >= mid;
      });
      let target = candidates.find(inp => !inp.value) || candidates[candidates.length-1];
      if (!target) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(target, value);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      target.focus();
    }, { value: v, groupIndex });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(350);
  }
}
```

**读回验证 t1/t2/规格名**：

```js
const verify = await page.evaluate(() => ({
  t1: document.querySelector('input[placeholder="规格类型1"]')?.value,
  t2: document.querySelector('input[placeholder="规格类型2"]')?.value,
  names: Array.from(document.querySelectorAll('input[placeholder="请输入规格名称"]'))
    .filter(i=>i.offsetParent).map(i=>i.value).filter(v=>v),
  rowCount: document.querySelectorAll('tbody tr').length,
  stock: (document.body.innerText.match(/总库存\n\d+/)||[])[0],
  errors: (document.body.innerText.match(/\d+个错误/g)||[])[0] || '0'
}));
console.log('VERIFY:', JSON.stringify(verify));
```

### A.4 虚拟滚动填价骨架（动态 scroll meta + depth）

```js
const flow = require(process.env.PDD_FLOW_JS);
const meta = await flow.getScrollMeta(page); // { depth, scrollHeight, clientHeight }
// 实战：depth≈3，scrollHeight≈5000，clientHeight>200；禁止依赖 .sku-list 小高度

const sticky = flow.makeStickyMapRow(dimNames, skuByKey); // rowspan 颜色继承
const mapRow = (text, inputs) => sticky.map(text, inputs);
const seen = new Set();

for (let st = 0; st <= (meta.scrollHeight || 4000) + 400; st += 150) {
  await flow.scrollTopTo(page, st, meta.depth);
  await page.waitForTimeout(150);
  // 读可见 tr → mapRow(sticky) → setter 填 库存/拼单价/单买价/编码
}
```

填完后对比 `seen.size` vs Excel `sku_count`，不等则继续滚动；最终以 `validateForm` 为准。

### A.5 DOM setter 备选

```js
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
setter.call(inp, v);
inp.dispatchEvent(new Event('input',{bubbles:true}));
inp.dispatchEvent(new Event('change',{bubbles:true}));
```

### A.6 预览图上传循环（2026-09-28 修正：input 优先）

```js
// 复制到 ASCII 路径后再传
// Copy-Item "源\SKU_01.png" "$workdir\prev\sku01.png"

const flow = require(process.env.PDD_FLOW_JS);
const meta = await flow.getScrollMeta(page);
const sticky = flow.makeStickyMapRow(dimNames, skuByKey);

// 每行一个 td.sku-preview-cell；下标会随滚动回收 → 一次扫描只处理一行，处理完重新扫
for (let st = 0; st <= meta.scrollHeight + 400; st += 150) {
  await flow.scrollTopTo(page, st, meta.depth);
  await page.waitForTimeout(150);
  const rows = await readViewportRows(page, sticky);   // 见下：一屏一次 evaluate + sticky 继承
  const hit = rows.find((r) => want(r));               // 待补的行
  if (!hit) continue;

  const cell = page.locator('tbody tr').nth(hit.i).locator('td.sku-preview-cell');
  if (await cell.locator('[class*=imageWrapper]').count()) continue;  // 已有图，跳过

  const fi = cell.locator('input[type=file]').first();
  if (await fi.count()) {
    // 首选：同格隐藏 input。不要点「本地上传」——sticky 下必报 outside viewport
    await fi.setInputFiles(hit.filePath, { timeout: 20000 });
  } else {
    // 兜底：素材库态，本地上传 + filechooser
    const [fc] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 2500 }),
      cell.getByText('本地上传', { exact: true }).first().click({ timeout: 3000 }),
    ]);
    if (fc) await fc.setFiles(hit.filePath);
  }

  // 轮询读回 imageWrapper，最多 ~20s；不出现算该行失败
  for (let w = 0; w < 30; w++) {
    await page.waitForTimeout(700);
    if (await cell.locator('[class*=imageWrapper]').count()) break;
  }
  break;   // 传完退出，重新 scroll+scan（下标已失效）
}
```

一屏扫描 + sticky 继承（避免续行同文本被去重）：

```js
async function readViewportRows(page, sticky) {
  const raw = await page.evaluate(() =>
    Array.from(document.querySelectorAll('tbody tr')).map((el, i) => {
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const cell = el.querySelector('td.sku-preview-cell');
      const url = cell ? (cell.innerHTML.match(/url\(&quot;([^&]+)&quot;\)/) || [])[1] || null : null;
      return { i, text, url, hasImg: cell ? !!cell.querySelector('[class*=imageWrapper]') : false };
    })
  );
  const out = [];
  for (const r of raw) {
    const m = r.text.match(MODEL_RE);          // 按当前商品的维度正则替换
    if (m) sticky.model = m[0];                // 组首行才出现 → sticky 继承
    const s = r.text.match(SIZE_RE);
    if (!s || !sticky.model) continue;
    out.push({ ...r, key: `${sticky.model}|长${s[1]}米` });
  }
  return out;
}
```

### A.7 手工读回（提交前快照）

```js
const rows = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('tbody tr'))
    .filter(tr => /商品特征|规格特征|颜色/.test(tr.innerText||''))
    .map(tr => ({
      text: (tr.innerText||'').replace(/\s+/g,' ').slice(0,40),
      vals: Array.from(tr.querySelectorAll('input[placeholder="请输入"]')).map(i=>i.value)
    }));
});
// 检查每行 vals[0] 库存非空且 >0；首行最易漏
```


## 裂变确认（查重命中）

命中 exact_duplicate / same_title_different_sku → 问用户：裂变新标题+首图？覆盖编辑？放弃？无答复默认不裂变不覆盖。裂变可选：标题 / 首图 / **规格显示名**（店透视或用户命名；编码价库存仍 Excel）。规格裂变=维度值重命名，SKU 集合与编码集合不变。

## 标准填法（实战固化 · 快而准）

> **SKILL 入口：开工先读到这里再写脚本。** 以下方法已在 900017/900027 跑通。下次上架只按本节做，禁止重新试选择器。

### 总序（逐步门禁，非一把梭跳检查）
resolve_env -> read_excel(ok|用户覆盖ref) -> 复制图片到 ASCII workdir
-> connectShop(port) -> checkDuplicate（命中问裂变）-> 逐步 fill（每步读回）
-> validateForm -> submitProduct -> verifyListed -> 对照表

### 每步固定方法（填 → 读回 → 通过才下一步）
1 环境: resolve_env.ps1 + Show-PddEnv; `flow.probeShop(port)`（端口/标签数）→ **读回 reachable + tabs**；>6 标签先试 `{maxTabs:12}` 放宽（多余标签可能是用户自己的业务页），握手真超时再请用户关
2 预检: read_excel.py; ref_price>max(single) 不过则问用户覆盖 → **读回 ok===true / sku_count**
2b 标题长度: 汉字数≤30（1 汉字=2 字符）；超了去冗余并告知 → **读回 .value**
3 图片: Copy 到 workdir main/detail/sku ASCII 路径 → **核对文件数=Excel 图数**；**逐张核对单图 ≤3MB**（超限先压图，`build_product.py` 会拦）
3b 记 URL: on_form 后记下 `id=commitId&goods_id=`；续填只开完整 URL
4 查重: flow.checkDuplicate 填前跑; not_found 才 fill; 命中问裂变 → **读回 status**
5 主图: 轮播区块 file input setInputFiles（仅新版第一步可用 first）; waitForUploadProgress expectTotal=10; 一组只传一次 → **读回 已上传N/10 + 缩略图不重复**
6 标题: input[placeholder*=商品标题] native setter → **读回 .value == 目标标题（≤30 汉字）**
7 类目新版: 查看更多推荐 -> choosen_cate=<category_id> 卡片 → **读回商品分类含叶子**
7 类目旧版: 搜叶子 -> 点满路径 exact -> 确认发布该类商品 → **读回表头商品分类含叶子、无猫抓板/沙发**（已选分类行不够）
8 品牌: input[placeholder*=品牌名称] 无品牌/无注册商标 → **读回 .value**
9 详情: file 邻文本 快捷编辑|0/50 setInputFiles; expectTotal=50 → **读回 已上传N/50 == 详情张数**
9b 包装标签: 无素材留空 → **读回 0/10**；有素材才传 → **读回 N/10**
9c 辅助图: 目视缩略图 → **无无关图（白底人像等），不对就删**
10 属性: pickAttr（下拉类）；**数字类（厚度/平方克重等）是 `input` 直填，不走下拉**（GPVC-001：厚度=请输入文本框，填 `4`）；probeRequiredAttributes 只认重要+字段名 → **读回无空必填「请选择」**
11 规格: ensureSpecTable t1/t2 下拉 ST_selectValueSingle + 值 Enter → **读回 t1/t2 .value + 规格名集合 == Excel + `readAllSkuRows.count == 笛卡尔积`（禁 tbody tr.length）**
12 SKU: getScrollMeta+depth; sticky 继承颜色; 一屏 evaluate 批量 setter 填库存/拼单价/单买价/编码 → **readAllSkuRows 逐行 == Excel；含首行**；编码模板 `applyCodeTemplate`（同码多档走 evalCodesExact 放行）
13 参考价: input 最大单买价/参考价 setter → **读回 > max(单买)**
14 预览: **该行 `td.sku-preview-cell` 内 `input[type=file]` 的 setInputFiles 优先**（禁点「本地上传」，sticky 下必 outside viewport）；无 input 才 filechooser 兜底；sticky 继承维度→路径；路径先 `validateListingPayload` → **读回每行 imageWrapper + 无「请上传第N行」**；**只补缺图，替换已有图先问用户**
15 表单错误: 「错误（N）」→ **N==0**（N 是必填计数，不是脚本错）
16 校验: validateForm 全量滚动读回 → **allPass===true 才继续**（fail/unknown 禁止提交）
17 提交: 清遮罩 -> 提交并上架; 发货时间现不可选则点 24h → **读回 URL 含 goods_add/success**
18 验证: verifyListed **内置 3 次×4s 重试**（列表比 success 慢）→ on_sale / auditing

每步必须输出：动作 + 读回值 + 通过/未过。未过立即停，禁止带着 fail 进下一步。

### 禁止
- 禁止跳步：任何一步没读回/未过就进下一步
- 禁止只信 fill `ok` 不读回
- 禁止逐格 Playwright fill 填 72 SKU（用 evaluate setter）
- 禁止点最后一个匹配选类目
- 禁止把辅助图 已上传0/10 当详情进度
- 禁止 fill ok 就不跑 validateForm
- 禁止 goods_add 表单 URL 仍带 goods_id 就当成功
- 禁止查重命中后静默裂变/覆盖 — 先问用户

### 裂变（可组合）
标题 / 首图顺序 / 规格显示名（店透视或用户命名）任选；编码价库存仍 Excel。

## 2026-09-23 GPVC-001 格栅木纹pvc 实战固化（店铺A9226 成功）

goods_id=1008831388562，`wait_audit=false`，满2件9.5折自动带上。

### 快路径（下次只走这条）
1. `read_excel` 预检（图不在 asset_roots 可忽略 blocking，只要 Excel 字段齐）
2. 图片复制到 ASCII workdir 子目录：`商品轮播图/`、`商品详情/`、`预览图/`（中文路径 setInputFiles 不稳）
3. `listProductSafe` 或分步：`fillProductForm` **必须带 attributes**
4. 主图+标题由 **fill 收尾 `enforceCriticalOnForm` 自动读回修复**（写→读→重试×3）；失败看 `fill.reason=title_readback_failed|ref_price_readback_failed`；包装标签无素材留空
5. `validateForm` allPass
6. 选 48h 发货 → 提交并上架 → 确认低价
7. success 仅当 URL 含 `goods_add/success`

### 本次踩坑（禁止再犯）
| 坑 | 正确做法 |
|----|----------|
| 为了 read_excel 预检把图拷进 发品excel | 不拷；上传时传绝对路径即可 |
| attributes 没传 → required_attrs 中断，规格 0/2 | 从 **Excel 产品行**读材质/特点/风格/厚度/产地等（GPVC-001 例：pvc/防水/简约现代/立体/4/中国大陆/客厅/热熔胶），禁止写死示例值 |
| 手工点 ST_selectValueSingle 选「颜色」没落到规格类型 | 用 fillProductForm；别手拧 |
| `input[placeholder=规格类型1]` 不存在（旧版 UI） | 按钮是 `添加规格类型(0/2)`，类型是 ST_selectValueSingle |
| 详情图 setInputFiles 到 first file input | 选邻文本 `0/50|快捷编辑` 的（idx≈5） |
| 主图传到包装标签图（编辑页 10/10 占满） | 多 file input 禁用全页 `.first()`；锁定「商品主图\|商品轮播图」区块；包装标签无素材留空 |
| 同一组主图 setInputFiles 多次 → 轮播 10 张重复 | 一组图只传一次；并发更会重复灌/落错槽位 |
| read_excel 报 preview_missing/no_main_images | 真图在 `拼多多/GPVC-001/`，settings_root 是死路径；可忽略，靠 opts 传路径 |
| 同页并发跑脚本 | 表单被踩空、类目变猫抓板、多出草稿。**一次只跑一个** |
| 提交不跳 success | 先点「48小时发货及揽收」再提交；再点 `确认提交` |
| fillProductForm 的 ok:true+no_dimensions 会骗人 | 检查 reason；`no_dimensions` 表示没填规格 |
| 辅助图混入无关图（白底人像） | 上架/改图后逐区读回；不像本品删掉 |
| 「错误（N）」当脚本错误 | 是表单必填项计数；N=0 才齐 |
| 素材路径手拼失败 | WPS「共享文件夹 」Unicode 空格；`Get-ChildItem -Recurse -Filter` 定位 |
| **平台弹「上传图片大小不能超过 3MB」** | 单图 >3MB。预览图常见 1024² PNG=3.02MB；缩到 800×800 PNG optimize 再传。`build_product.py` 预检 exit 6 应在连店前拦住 |
| Playwright `connectOverCDP` 挂在 ws connected | 多半是商家后台有 **CDP 无响应标签页**（如 `sycm/goods_effect`），Playwright 等 `_waitForAllPagesToBeInitialized` 直到超时。用 `Target.getTargets` + 逐页 `Runtime.evaluate` 探活，**关掉 hung 页**再连。`/json/list` 的 `id` ≠ `Target.getTargets` 的 `targetId` |
| 用户要求逐步检查却一把梭跑完 | 每步读回告知，等确认；默认逐步，用户点名要快才固定序一把梭 |
| 一次发太多工具调用被限流 | 串行小步；同页脚本更是一次只跑一个 |

### 类目页（旧版）
- 最近使用里 `.choose-category` 直接点「家居饰品 > 贴饰 > 墙贴」短路径
- 读回「已选分类」必须含目标叶子
- 确认按钮：`确认发布该类商品` → URL 进 `goods_add/index?...&goods_id=`

### 遗留草稿清理
调试会留下多个 goods_id 草稿，上架成功后提醒用户删：本次 1008806940196 / 1008810321484 / 1008818903346 / 1008828437306

### 逐步确认（默认，硬要求）
每步「填 → 读回 → 判定」，向用户报动作+读回值+通过/未过。未过禁止下一步。用户要确认时等回复；未点名「要快」禁止一把梭跳检查。用户明确「要快/一把梭」= 跳过中间等待，**读回门禁仍不可跳**。

## 2026-09-24 00016 洞石双平台 · 店铺B9227 成功

goods_id=**1009192540975** · **销售中** · 库存 5000 · 拼单价 59.8 · 单买价 60.8 · 参考价 62.8 · 5 色×60x300cm · 满2件9.5折自动带上（`batch_discount=9.5`）。

类目：**家居饰品 > 贴饰 > 墙贴**（用户确认；Excel/历史写「墙纸」勿盲从）。标题因 30 汉字上限去掉「一贴」→ `洞石纹自粘墙纸免胶铺贴焕新客厅卧室背景墙贴自粘背胶自由裁剪`。

### 快路径（洞石/墙贴类）
1. `read_excel` ok → 图拷 ASCII workdir `main/ detail/ preview/`
2. 旧版类目：搜「墙贴」→ **exact 全路径**「家居饰品 > 贴饰 > 墙贴」→ 确认 → **读回表头 `商品分类`**
3. 记下 success 前完整 URL 的 `id=<commitId>&goods_id=<id>`；断点续填只开这个 URL
4. 主图 10 + 标题（≤30 汉字）+ 详情（`0/50` input）+ attributes + 规格 颜色+尺寸
5. 读回 SKU 行数==规格笛卡尔积；缺行先修规格值再填价
6. `tr.evaluate((el,args)=>…)` 填 库存/拼单价/单买价/编码；`validateForm` allPass → 提交 → `verifyListed`

### 本次踩坑（禁止再犯）
| 坑 | 正确做法 |
|----|----------|
| 续填 URL 只带 `goods_id` → 「地址不对」、类目「加载中…」 | 必须 `id=commitId&goods_id=`；或从列表点编辑 |
| picker「已选分类」是墙贴，确认后表头变猫抓板 | 硬门禁读**表头** `商品分类`；最近使用猫抓板会抢点 |
| Excel/历史类目写「墙纸」 | 洞石自粘墙纸按用户/流量走**墙贴**；上架前确认 |
| 规格 5 色只生成 4 行（雪白色在输入框但无 tr） | 清空重填末位色 + Enter/Tab 逼出第 5 行，再填该行 |
| `tr.evaluate` 里写 `tr.querySelector` → not defined | 回调第一参是 `el` |
| 标题 31 汉字被「最多30个汉字」挡 | 去冗余到 ≤30；read_excel 的 ≤60 字符拦不住汉字计数 |
| 特点「防撞」下拉无此项 | 选最近项（防水），读回即可 |
| `getScrollMeta` → kind:none | 5 行表用 window.scrollTo 扫即可 |
| 用 `tbody tr.length` 判 36 行失败 | 只是可视窗口；用 `readAllSkuRows`（§5.0） |
| 提交成功后 verify `not_found` | 列表延迟；`verifyListed` 已重试 3×4s，仍无则等 10s 手动再查 |
| 非 read_excel 素材（口播/自备 JSON） | 自备 title≤30汉字、ref>max(single)、sku_count>0 再连店；编码走 applyCodeTemplate；**先 `validateListingPayload` 查 preview 路径** |
| 要求编码不区分档位 | Excel 同码多行；evalCodesExact 自动 shared_excel 放行 |
| 点「保存草稿」后上传全没了 | 保存会**重载页面**；流程中禁止点保存/禁止 goto；读回用当前页 `zoneByCounter` |
| 重开草稿 URL 看到旧状态（图数回退） | 那是**服务端存档**，不是内存态；别用重开当验证 |
| 主图传进包装标签 / 详情混入主图 | 图区**只按计数器文本**定位：`zoneByCounter(page,'商品轮播图'|'商品详情'|'包装标签图',10|50)`；禁 input index |
| 残留图删不掉 | 先 `uploadZone` 传满正确图，再删残留（PE4：上传后才能删）；删除必须**先真实 hover** 再点 `DeleteIcon_v2_delete` |
| 包装标签图 10/10 | 无素材必须 0/10；`validateForm.packaging_label` 会报 fail |
| CDP 端口活但连不上（标签多/浏览器卡） | `connectShop` 先 `probeShop`：>6 标签→`cdp_too_many_tabs`；握手超时→`cdp_handshake_failed`；**先试 `{maxTabs:12}` 放宽**（多余标签可能是用户自己的业务页），握手真超时再报用户关标签（PE2→9228 实例） |
| 新版类目第一步 fill 报 main_upload_timeout | 该步没有「轮播图 …/10」计数；已改为锁「商品主图」区块，找不到即 `main_block_not_found` 停止（禁退回任意图片 input） |
| fill 跑完仍缺 SKU 行/预览图 | 收尾 `enforce_sku_rows`（空行库存/拼单价/编码）+ `enforce_previews`（缺图行）已内置；看这两项状态 |
| 主图老是被灌进「包装标签图」 | 根因：从计数器节点往上爬会命中**共用祖先**（轮播/辅助/包装同容器），拿到别的区的 input。已改为**以 input 为中心**分类：最近的「只含单一区关键词」祖先 → 定区；无法定区的输入一律不传 |
| 9228 表单页找不到「商品轮播图」input | 该版 UI 主图在**类目第一步**就传好了，表单里只有 辅助图/包装标签图（都是 /10）+ 商品详情（/50）。`forceMain` 找不到轮播区时**只读计数器确认，不再往任何区上传** |
| 类目读回 `背景墙贴` 也算通过 | 子串匹配 bug（墙贴 ⊂ 背景墙贴）。已改为**按 `>` 分段，最后一段必须严格等于目标叶子**；选择器也改为「精确全路径 → 以 `> 叶子` 结尾 → 叶子精确」三级，不再用 includes |
| 预览 setInputFiles ENOENT（tier 文件名不一致） | 构建 payload 时校验 `fs.existsSync(preview)`；`fill` 前 `validateListingPayload` |
| rejected 后在原稿清规格 chips | **禁止**；旧值清不净 → 矩阵脏/库存 4 万。读 `rejectReason` 后**类目页新建**再 fill |
| 预览 file input 传不上（第 1 行缺图） | ~~先点行内「本地上传」+ filechooser，再备用 `input[type=file]`~~ **2026-09-28 修正**：顺序反了 → 先 `td.sku-preview-cell` 内 `input[type=file]` 的 setInputFiles（§6.1），filechooser 只作无 input 时兜底 |
| 废草稿 1009190588605（误类目） | 提醒用户删；成功稿 1009192540975 |

## 2026-09-28 PE2 木纹墙贴 SKU 预览图补齐（店铺A9226 成功 · 编辑已有商品）

goods_id=**1010224568885** · 编辑页 `type=edit` · 用户提交后保存。本批只做「补预览图」，不动价格/库存/编码。

结构：**型号（12 值）× 尺寸（3 值：长3/5/10米*宽50厘米）= 36 行**。
型号 = 4 色（白色/米黄/浅粉/晴蓝）× 3 系列（`2.0版/标准遮丑`、`3.0版/强胶暴粘不透底`、`4.0版/纳米抗菌真无味`）。

初始状态：**前 15 行有图（旧图）、后 21 行空**；页面 `错误（1）` + 横幅「请上传第16行规格的预览图后重新操作」——**错误计数只报第一个缺图行，别当成只有一行缺图**。

素材：`D:\图片\PE2_木纹替换完成\03_SKU图`（3 个系列子目录 + `全套12款核心SKU上架图` 合并目录，12 张 1024×1024 PNG）。
图内标签是「标准款 / 强胶款 / 纳米款」+ 色名 → 映射页面型号时**按系列名匹配**，别按文件夹里的版本号（文件夹叫 `1.0标准款`，页面型号写 `2.0版/标准遮丑`，号对不上但系列唯一）。

### 快路径（补预览图专用）
1. 取全部行状态：`getScrollMeta` + 自建一屏 `evaluate` + **型号 sticky 继承** → 得到 36 个 `型号|尺寸` 的 `hasImg`
2. 过滤出 `hasImg === false` 的行 = 待补清单
3. 逐行：该行 `td.sku-preview-cell` 内 `input[type=file]` → `setInputFiles`（ASCII 路径）
4. 每行传完轮询读回 `imageWrapper`
5. 全量读回复核：`错误（0）` + 无「请上传第N行」文案
6. **内容校验**（§6.2）：下载每行图与源文件 resize 128 求 meanAbsDiff
7. 用户确认后再提交（本次用户明确「先不提交」，我未点提交；用户自点）

### 本次踩坑（禁止再犯）
| 坑 | 正确做法 |
|----|----------|
| 用裸 `readAllSkuRows` 数行 → 36 行报 **17 行**，差点当成「矩阵缺行」去清规格重填 | 去重键是 `mapped.key`；续行只显尺寸、文本相同会被合并 → 传 `makeStickyMapRow` 或自己 sticky 拼 key（§5.0） |
| 点行内「本地上传」→ `element is outside of the viewport`，重试 13 次全失败 | 改传同格**隐藏 `input[type=file]`**，一次成功（§6.1） |
| 判「有没有图」用 `getComputedStyle` 取 background-image → 拿到 `none` | URL 在 `imgContainer` 的 **inline style** 里，读 `cell.innerHTML` 正则提（§6） |
| 错误计数 `错误（1）` 以为只缺 1 张 | 只报第一个缺图行；缺几张要自己全量读回（15 有 / 21 缺） |
| 差点顺手把已有 15 行旧图一起换成新木纹图 | 「补上」≠「替换」；**先问用户**（本次用户选只补 21 行、保留旧图）——旧图与新图肉眼差异小（仅墙面木纹），对比要靠 §6.2 像素比对才能确认是两版图 |
| 传完只确认「有图」就报完成 | 「有图」≠「图对」→ 必跑 §6.2 像素比对（本次 21/21 MATCH，meanAbsDiff 0.24~0.30） |
| 素材中文本名直接 setInputFiles | 先复制到 ASCII 目录改名 `sku01..12.png`；源目录含中文和空格 |

### 可复用脚本骨架（本次实跑）
`dump-urls.js`（导 `key→url` JSON）＋ Python 比对：
下载 `url` → `Image.open(...).convert('RGB')` → 与源 PNG 各 `resize((128,128))` → `ImageChops.difference` 求和均值。
`< 8` 判 MATCH。这套校验适合所有「传完图后要证明确实传对了」的场景。

---

## ★ 属性取值要「分层告警」：数据包的值可能在该类目下拉里根本不存在（2026-09-29 PE6@9226 实测）

### 踩的坑

按「一律以数据包为准」去填属性时，**数据包的写法未必是下拉选项原文**。PE6@9226 实测：

| 属性 | 数据包 | 该类目下拉里 | 朴素实现的结果 |
|------|--------|------------|---------------|
| 材质 | 聚乙烯(PE) | 有 | 精确命中 ✓ |
| 图案元素 / 产地 / 工艺 | 纯色 / 中国大陆 / 光面,覆膜,浮雕 | 有 | 精确命中 ✓ |
| **风格** | **欧式** | **没有「欧式」** | **静默退到「中式」** |
| **适用空间** | **使用对象：衣柜,橱柜** | **没有衣柜/橱柜** | **静默退到「卧室」** |

危险之处：**日志里它们和精确命中一样显示 OK** —— 用户拿到一个「看起来按数据包填了、其实值被换掉」的属性，
而且无从察觉。所以「填上了」不等于「填对了」。

### 正确做法：用分层命中的封装，只看 `datapack` 才免复核

```js
const r = await flow.applyAttributesByCandidates(page, {
  材质:    ['聚乙烯(PE)', 'PE', '聚氯乙烯'],
  特点:    ['防潮', '防水'],
  风格:    ['欧式', '现代简约'],          // 首元素 = 数据包原值，其后是备选
  图案元素: ['纯色'],
  工艺:    ['覆膜', '光面', '浮雕'],
  适用空间: ['衣柜', '橱柜', '卧室'],
  产地:    ['中国大陆'],
});
console.log(r.allFromDatapack, r.needReview);   // needReview 里的每一项都要列给用户确认
```

`how` 分四档，**只有 `datapack`（候选序列第 1 个 = 数据包原值精确命中）不需人工复核**：

| how | 含义 | 处置 |
|-----|------|------|
| `datapack` | 数据包原值精确命中 | 免复核 |
| `fallback` | 原值不在选项里，退到了后续候选 | **必须列给用户**（含 `failed` 说明哪些值没中） |
| `fuzzy` | 候选全不中，枚举选项后按包含关系近似命中 | **必须列给用户**（附 `options`） |
| `unmatched` | 完全没命中 | **人工指定**（附 `options` 供排查） |

> 交付时把 `needReview` 原样写给用户，例如：「风格：数据包是欧式，但该类目没有欧式，现在是中式，请确认」。
> **不要只报「属性 8 项已填」** —— 那正是这次差点漏掉的。

## ★ 素材图片：**用户给的图全部用，不要自己剔**（2026-09-29 用户明确）

主图 / 详情图 / SKU 图 —— **用户给的素材一律全部上传**。
**不要因为「体量明显偏小」「看着不像同一批」「文件后缀不一致」就自行剔除**，
也不要因此反复去问（我曾连续几批拿体量异常的主图去问，用户的答复是「用我给你的没问题」）。

唯一需要取舍的情况：**超过平台数量上限**（轮播 **10** 张、详情 **50** 张）。
这时才做取舍，且必须**明确告知用户取了哪些、舍弃了哪几张、为什么**。

> 已封装的调用本来就不会剔图：`uploadZone(page,'商品详情',50,detailFiles)`（超 50 才裁剪）、
> `uploadMissingPreviews(...,{colorToFile})`、主图直接 `setInputFiles(mainFiles.slice(0,10))`。
> 也就是说**只要不额外写筛选逻辑，默认行为就是全用**。

## ★ 取值来源规则：**一律以该批次的「店透视商品数据包」为准**（2026-09-29 用户明确）

一个新产品上架时，标题 / 规格类型名 / 规格值 / **商品属性** 都**从它的店透视数据包里取**。
**唯一例外是「品牌」** —— 数据包里是竞品品牌（`瓦时` / `易树家` / `贝悦` 等），
必须换成我们自己的 **`祺讯`**。数据包里没写的属性，才回退到类目表单默认或沿用上一批。

### 我犯过的错（别重复）

PE4、PE6 两批我连续三次把属性填成了 PE5 数据包里的 `材质 pvc` / `风格 中式`，
理由是「跟 PE5 保持一致」—— **这是错的**，PE5 的属性能用只是因为 PE5 恰好对了那一批。
正确做法是**每批都回它自己的数据包**。差异实例：

| | PE4 数据包 | PE6 数据包 | 我当时填的（错） |
|---|---|---|---|
| 材质 | 铝箔 | 聚乙烯(PE) | pvc |
| 风格 | （无） | 欧式 | 中式 |
| 工艺 | （无） | 光面,覆膜,浮雕 | 覆膜 |
| 特点 | 防水,耐磨,环保 | （表为「功能」：保暖,装饰,防潮） | 防水 |
| 产地 | 中国大陆 | 中国大陆 | 中国大陆 ✓ |
| 品牌 | 易树家 | 贝悦 | 祺讯 ✓（品牌永远是我们的） |

### 注意：数据包字段名 ≠ 类目表单字段名

两者的字段集合不一定一一对应，要**按语义就近映射**，不能只认字面同名：

- PE6 数据包里是「**功能**」「**使用对象**」，而类目表单上是「**特点**」「**适用空间**」→ 按语义对应过去
- 数据包有、表单没有的字段（如「计价单位」「安装方式」「发货地」）→ 跳过
- 表单必填而数据包没有的（如「厚度」）→ 先看类目表单有什么可选项，再决定填什么或留空
- 写值前**先枚举该下拉的可用选项**（`pickAttr` 是精确匹配，值不存在会返回 `ok:false`），
  数据包里的写法（如 `聚乙烯(PE)`）未必是选项原文

## ★ 推荐做法：一次生成（单脚本跑完全流程）· 2026-09-29 实测 6.1 分钟

把「类目第一步 + goods_add 表单」合成**一个脚本**一次跑完，比拆成多段省掉反复连店与状态确认。
实测（PE6 上店铺C 9228，36 SKU）：**6.1 分钟**走完 15 个步骤且 `validateForm` **allPass 13 项全过**。

### 速度参数：可靠性靠机制，不靠等待

`robustCommitSpecValue` / `removeSpecValue` 这类可靠路径**必须保留**（`evaluate` 写值会漏提交，
就是「矩阵少 3 行」的元凶），但**不要挂长固定等待**。踩过的坑：保守设置下 15 个规格值白等 40 多秒，
再叠加多次全表扫描，**一次跑 46 分钟还没结束**；同一份数据收紧后 **6.1 分钟**。

| 参数 | 保守（别用） | 收紧后（实测够用） |
|------|------------|------------------|
| 打字延迟 `type(..., {delay})` | 25ms | **10ms** |
| 单击后等待 | 400ms | **200ms** |
| 清空后等待 | 300ms | **120ms** |
| 按 Tab 后等待 | 1800ms | **700ms** |
| 点击超时 | 15000ms | **8000ms** |
| `scanSkuKeys` 步长 / 间隔 | 70px / 110ms | **120px / 70ms** |

步长敢放到 120px，是因为**表格虚拟窗口约 15 行 ≈ 525px** —— 120px 步长仍有约 4 倍重叠，
并集扫描不会漏行。**若某页窗口更小，要相应调小步长。**

### 实操提示（Windows PowerShell）

**不要用 `... | Select-Object -First N` 包住 node 调用。**
PowerShell 读满 N 条后会关闭管道，**把 node 进程提前杀掉**，脚本半途静默中断 ——
我因此拿到过「图传了但预览图没传、参考价没设」的半成品页面。
要看输出就**重定向到文件**再 `Get-Content -Tail`，或用 `-Last`（会读完全部，不提前关管道）。

### 15 步清单（顺序即依赖关系）

1 主图 10 张 → 2 **真实聚焦标题框 → 逐字 type → 点确定无害的文本元素失焦** →
3 `openManualCategoryPicker`（入口被折叠时会自动先点「查看更多推荐」）→
4 `searchCategory(完整叶子路径, { confirm:true })` → 5 点「下一步, 完善商品信息」→
6 详情图（`uploadZone(...,'商品详情',50,...)`）→ 7 包装标签图无素材必须 0/10 →
8 品牌 → 9 属性 8 项 + 厚度 → 10 **`ensureSpecTable`（看返回的 `matrix`）** →
11 填 36 行 → 12 `uploadMissingPreviews` → 13 参考价（字段真名「商品参考价」）→
14 跨窗口并集全表校验 → 15 `validateForm`。**全程不提交。**

### ★★ 改 `pdd_flow.js` 的三条铁律（2026-09-29 我亲手把文件删掉 35KB 的教训）

### 事故还原

给 `waitForUploads` 打补丁时用了字符串切片：

```js
const old = f.slice(f.indexOf(A), f.indexOf(B));
f = f.replace(old, new);
```

**A、B 的先后顺序被我搞反了**（B 在 A 之前），`slice` 返回空/反向内容，`replace` 于是把
**中间约 35KB、20 个函数**一并替换掉 —— `uploadZone` / `uploadMissingPreviews` /
`readAllSkuRows` / `getScrollMeta` / `pickAttr` / `applyAttributes` / `zoneByCounter` /
`validateListingPayload` / `checkDuplicate` … 全部消失。后果：`require` 解析不了，脚本跑了 0 秒。

### 铁律

1. **动 `pdd_flow.js` 之前先备份。** 这次是 `_backup/pdd_flow.js.<时间戳>.bak` 救回了 20 个函数。
   没有备份就是不可逆损失。**每次改之前都复制一份**，哪怕只是改一行。
2. **字符串切片/`replace` 打补丁前，必须先断言 `start < end`**，否则会连带删掉中间所有代码。
   更稳的做法：用「锚点之间的完整片段」做 replace（锚点自己也要断言唯一），或直接用编辑工具做精确替换。
3. **抠函数体时要先跳过参数表的括号**，再找函数体的 `{`。JS 参数里可以有对象解构，
   如 `async function clearZone(page, keyword, total, { max = 60 } = {})` —— 第一个 `{` 是解构，
   从那儿开始配对花括号会**把函数截断在参数表**。正确顺序：
   匹配函数名后的 `(` → 按括号配对找到 `)` → 再找 `{` 配对到 `}`。
   （同样要跳过字符串/模板/注释，否则 `${...}`、`/{}/` 会把配对带偏。）

### 恢复后必须做的审计（缺一不可）

```bash
node --check pdd_flow.js                       # 语法
node -e "const f=require('./pdd_flow.js')"     # 能 require
# 导出审计：module.exports 里每个名字都要是 function（常量如 LIST_URL 除外）
# 关键函数点名核对：uploadZone / readAllSkuRows / pickAttr / … 逐个 typeof 检查
```

⚠️ **顶层 `const` 也可能是被删对象**（这次漏了 `ZONE_KEYS`，因为「缺函数」审计只看 function 声明，
它不是函数，跑了才发现 `ZONE_KEYS is not defined`）。审计要**同时扫顶层常量**。

## ★ 新版流程提速三条（2026-09-29 逐项实测 · 总时长 399.8s → 286.0s，−28%）

| 阶段 | 最初 | 优化后 | 关键动作 |
|------|------|--------|---------|
| 类目第一步 | 46.5s | **26.4s** | ①传图后**不等上传、立刻填标题** |
| 规格表 | 49.3s | **23.5s** | ②空槽位跳过清空 + `insertText` + Tab 后 400ms |
| 填值+校验（合趟） | 80.5s | 43.3s | ③逐行 `innerText` → `textContent` |
| 预览图 | 165.9s | 139.7s | （现占总时 49%，最大头，暂不动） |
| 详情图 | 16.5s | 12.6s | ③ |
| 品牌+属性 | 23.4s | 20.5s | ③ |
| **总计** | **399.8s** | **286.0s** | |

**① 新版第一步：`setInputFiles` 之后不要等上传，立刻去填标题。**
上传是服务端并行处理的，等计数器是纯串行浪费。正确顺序：传图 → **立刻**聚焦标题框、输入、失焦
→ 只有当「手动选择商品分类」入口没出现时才回头 `waitForUploads`。
实测这一条把「类目第一步」从 46.5s 压到 26.4s（−43%），并顺带绕开了下面第 ④ 条那个超时坑。

**② 规格填写：三处白费要去掉。**
- 选中的通常是**空槽位**，本来就无需 `Ctrl+A`/`Backspace` → 先读一次值，只在非空时才清空
- 逐字 `type(..., {delay:10})` 的 delay 是纯等待 → 改用 **`keyboard.insertText`** 一次性插入。
  它**同样触发真实 input 事件**（≠ 当初那个不可靠的 `evaluate` 直接写 value），仍是可靠路径
- Tab 后等待 700 → **400ms**：值真没提交上去的话，末尾的矩阵校验会抓到并修复
实测「规格表」49.3s → 23.5s（−52%），且跑完仍是 `matrix.rounds:1`。

**③ 逐行循环里禁用 `innerText`，用 `textContent`。**
`innerText` 会**强制重排**，一次全表扫描约 900 行次调用，两次就是 1800 次 —— 这才是「填值+校验」80s 的真正来源
（不是 sleep、也不是扫了几趟：30 步 × 190ms 才 5.7s）。换 `textContent` 后直接砍半。
`scanSkuKeys` / `fillSkuRowsAndVerify` / `readAllSkuRows` 里的逐行读取已全部替换。

**④ 上传计数器有两套文案，`waitForUploads` 必须都认。**
表单区是 `已上传N/M张`；**新版第一步是 `上传图片 (N/M)`** —— 没有「已上传」也没有「张」。
我第一版只认前者，在 9228 新版第一步上一直等不到、**白耗满 60 秒超时**（把「类目第一步」从 46.5s 拖到 82.7s）。
现在同时认两种文案，并加「缩略图数量 ≥ N」兜底（新版第一步传完后计数器文本会消失，只剩缩略图）。

## ★ 规格值有「字符集 + 40 字」硬限制，违反会让整张矩阵建成 0 行（2026-09-29 PE4 实测）

### 症状

- 页面弹 toast **「数据错误，请刷新页面」**
- 规格 chip 分组**看着是对的**（如 12/3），但 SKU 表**一行都没有**（`count: 0`）
- `validateForm` 报 `sku_count: 0/36`、`scroll_coverage: missing_keys=36`、`价格显示「系统自动计算」`
- 严重程度高于「静默少行」：**整张表空**，后面所有填值/传图全是白费

### 页面原文的两条限制

```
a. 最多填写40个字
b. 仅允许中英文 数字 空格 部分英文符号如 # : % ( ) ' + - * / .
   部分中文符号如 （）【】
```

### 踩坑实录

把长度值写成 `长3米×宽50厘米【…】` —— 那个**排版乘号 `×`(U+00D7) 不在允许集**，
平台直接「数据错误，请刷新页面」、矩阵 0 行。

**换 ASCII 的 `*` 立刻正常。** 同类要避开的还有：`×` `✕` `⚠` `→` `·` `～`、中文引号 `“”`、emoji、
以及任何允许集之外的全角符号。**注意 `x`(小写字母) 与 `*` 都合法，但 `×` 不合法。**

### 已封装：开工前先预检，别等页面炸了才发现

```js
const sv = flow.validateSpecValues(dimNames, [V0, V1]);
if (!sv.ok) console.log(sv.bad);   // [{ dim, value, problems: ['含非法字符:×'] }]
```

`ensureSpecTable` 已内置该预检（`{ precheck: true }`，默认开）：**过不了就直接返回
`reason: 'spec_value_precheck_failed'`，不会去点任何东西**，避免把页面点成 0 行状态。

### ⚠️ 两条「别自己把页面搞坏」的铁律（2026-09-29 我亲手踩的）

1. **不要用坐标盲点 `page.mouse.click(x, y)`。**
   坐标上落着什么控件完全不可控 —— 我加过一次「点空白处」的兜底，结果点到规格区控件，
   页面直接变「**数据错误，请刷新页面**」、型号 chip 读回 **0 个**、这条草稿基本报废。
   要失焦就 `elementHandle.blur()`，要点击就**点一个确定的文本元素**（如区块标题，
   并用 `position:{x:2,y:2}` 避开其内部控件）。`commitSpecTail` 已按此修正。

2. **`ensureSpecTable` 不要在建好的表上重跑。**
   它原先是「无条件 `setSpecType` + 把整批值再加一遍」，重跑会把同一批值加两遍 → 重复值
   → 平台「数据错误，请刷新页面」。**已改为幂等**：类型名只在不同时才设、值只补缺失的
   （内部通过 `readSpecGroups` 先读现状再决定加什么）。
   但**调用方仍应先判断**：想确认规格表状态就用 `readSpecGroups` / `scanSkuKeys` **读**，
   不要为了「看一眼」就重跑 `ensureSpecTable`。

> 教训一句话：**读操作用读函数，写操作要幂等，坐标点击要禁止。**
> 这三点任意一条破了，都会得到同一个结局 —— 「数据错误，请刷新页面」。

### 已经建坏了怎么救（实测有效，不用重开草稿）

页面处于「数据错误 / 矩阵 0 行」时，**不必重建草稿**：

```js
// 1) 删掉带非法字符的那一组值
for (const v of oldIllegalValues) await flow.removeSpecValue(page, v);
// 2) 用合法值重新提交（真实 click + 逐字 type + Tab）
for (const v of newLegalValues) await flow.robustCommitSpecValue(page, gi, v);
// 3) 复扫矩阵
const keys = await flow.scanSkuKeys(page, dimNames, [V0, V1]);   // 期望 36
```

PE4 实测：`数据错误` 消失、矩阵 **0 → 36**，随后填值/预览图/参考价全部走通、`validateForm` 13 项全过。

## ★ 矩阵「静默少行」：chip 里值全了，但某一行组根本没建（2026-09-28 9228 实测 + 修复配方）

### 症状（最坑的地方：平台完全不报错）

- `readSpecGroups(page)` 读回**分组就是对的**：组0 = 12 个、组1 = 3 个
- 但 SKU 表**行数 ≠ 型号数 × 长度数**：实测 `33 = 11 × 3`，**少了一整个型号组（3 行）**
- `validateForm` 报 `sku_count: 33/36`、`scroll_coverage: missing_keys=3`、`total_stock: 16500 != 18000`
- **`错误（0）`，页面不报任何错** → 不主动数行就发现不了，会静默上架一个少 3 个 SKU 的链接

### 根因

PDD 的规格 chip 是**受控组件**：用 `evaluate` + 原生 setter 写值（有时再加 `Enter`）会**在输入框里留下值、
但没真正提交进矩阵** —— 于是 chip 分组读回「看着全了」，矩阵却按少一个值建行。
（`ensureSpecValuesRobust` 的注释里早记过这个现象，但当时没给修复配方。）

### 修复配方（已实测走通 · 已封装成函数，直接用）

**现在不用手写这套流程 —— `ensureSpecTable` 默认自带矩阵行数校验与修复**（`{ verifyRows: true }`，可关）。
返回值里多一个 `matrix` 字段，开工时**先看它**：

```js
const spec = await flow.ensureSpecTable(page, dimNames, [V0, V1]);
console.log(spec.ok, spec.groupMismatch, spec.matrix);
// matrix = { ok, expected:36, count:36, rounds:2,
//            bad:['型号:微浮雕浅粉--【4.0抗菌纳米款/旗舰品质#】'],
//            log:[{ round:1, count:33, short0:[…], short1:[…], repaired:['型号 x1'] }] }
```

也可单独调用（例如想在填值前自己数一遍）：

| 函数 | 作用 |
|------|------|
| `scanSkuKeys(page, dimNames, dimValues)` | 跨滚动位置取并集，返回实际存在的 `dim0\|dim1` 键数组（单次快照永远读不全） |
| `repairSpecMatrix(page, dimNames, dimValues, {maxRound})` | 数行 → 定位真凶 → 删值重提交 → 重扫，直到达 维度值数之积 |
| `robustCommitSpecValue(page, gi, value)` | 以「真实 click + Ctrl+A + Backspace + 逐字 type + Tab」把值提交进指定维度组 |

**真凶判据（很重要，别修错对象）**：某维度值缺行时，**只有「缺得不是全部值」的那个维度才是原因**；
若某维度**全部值都缺**（如缺 1 个型号 → 3 个长度全都少一行），它只是被连累的受害者，**修它没意义**，
还会白白删改一堆本来正确的值、平白增加把好值弄坏的风险。

实测对比（9228，同一个「缺 1 个型号」场景）：

- 修前判据：`repaired` 会同时包含 `型号 x1` **和** `尺寸 x3` —— 多修了 3 个无辜值
- 修后判据：`repaired: ['型号 x1']` —— 只修真凶，一轮修、二轮齐 36/36



**关键：`ensureSpecValuesRobust` 修不了这个** —— 它有 `if (list.some(c => c.v === v && c.group === gi)) continue;`，
看到 chip 里「已存在」就跳过，正好跳过了坏值。必须**先删再按可靠路径重加**：

```js
// 1) 跨滚动位置取并集，扫出缺失的 `型号|长度` key → 得到缺行的型号值
//    mergeKeys: 见下（不能用单次快照，虚拟窗口永远读不全）
const missV0 = [...new Set(missingKeys.map(k => k.split('|')[0]))];

// 2) 删掉那个 chip（真实 click + Ctrl+A + Backspace + Tab）
for (const v of missV0) await flow.removeSpecValue(page, v);

// 3) 用「真实 click + Ctrl+A + Backspace + type + Tab」重新提交（可靠路径）
//    落点 = 该组里第一个空槽位，没有则最后一个
const idx = /* 找组0 里可见的 chip 下标 */;
await page.locator('input[placeholder="请输入规格名称"]').nth(idx).click();
await page.keyboard.press('Control+a'); await page.keyboard.press('Backspace');
await chip.type(v, { delay: 25 });                       // 必须逐字
await page.keyboard.press('Tab');                        // 必须 Tab 提交

// 4) 重扫，期望达到 型号数 × 长度数；未达标就再来一轮（实测 round 1 修、round 2 齐 36/36）
```

实测：9228 上缺的是 `微浮雕浅粉--【4.0抗菌纳米款/旗舰品质#】` 这**一个型号的全部 3 个长度行**，
删除 + 重新提交后矩阵立刻补齐；新增的 3 行**价格/库存/编码已被 PDD 自动带上**（写值次数 0 也算对，
但**必须读回校验**，不能凭写入次数判断）。补完后：36/36 行、36/36 有图、总库存 18000、`错误（0）`、
`validateForm` 13 项全过。

> **推荐做法**：规格表建完、填值之前**先数一遍行数**（`型号数 × 长度数`），不对就先用上面的配方修，
> 再去填值 —— 比填完发现少行、又要补值补图省事得多。

## 2026-09-28 PE5 木纹墙贴新链接（店铺A 9226 成功 · goods_id=1010936401222 · 36 SKU）

`validateForm` → `allPass:true / anyFail:false / anyUnknown:false`（13 项全过）：值 36/36、图 36/36、
总库存 18000、`错误（0）`、参考价 199。结构 = 型号 12 值（4色 × 3档）× 尺寸 3 值 = 36 行，
编码 `50cm连续木纹-{色}-{长度}` 共 12 个、每档共用（`dup=12, shared_excel=true`）。

### ★ 填值「静默写 0 次」的根因：尾部子串兜底（禁止再用）

`fillEmptySkuRows` 原来对行文本做「整串 includes 失败就退回尾部 8 字 includes」。
**同一档位下不同颜色的规格值尾缀完全相同**（如四色都以 `…基础标准款/标准遮丑#】` 结尾），
于是 `lastD0` 永远粘在第一个颜色（白色）上 → 每行算出的目标 sku 都是同一个
→ 目标值与现值相同 → **一次都没写，返回 changed=0**，表现成「滚动不推进虚拟窗口」的假象。
排查时一度误判成滚动容器问题，白试了三种滚动机制。

> **铁律：规格值做行匹配时禁止用尾部/子串兜底。** 只用整串精确匹配；行内被截断靠 **sticky 继承** 解决。
> 已改 `pdd_flow.js` 的 `hit()`。**判据：`changed` 是不是 0。写入 0 次 ≠ 没有待填的行，先怀疑匹配。**

### ★ 规格分组自愈（新增，务必用）

旧校验只查「值有没有出现在任何 chip 里」，**不查在哪个组**——第二维的最后一个值被写进第一维时，
所有值都「出现过」、`t1/t2` 也对，校验依然全过，但矩阵少一维（PE5 实测：型号 13 值 / 尺寸 2 值，
`长10米` 成了型号）。已加：

- `readSpecGroups(page)` —— 按 **DOM 顺序相对 `规格类型2`** 分组（**不要用 y 坐标中点**：型号值换行后中点判据失效，这就是串组的原因）
- `removeSpecValue(page, value)` —— 按精确值删单个 chip（真实 click + Ctrl+A + Backspace + Tab）
- `ensureSpecTable` 内新增自愈循环：删掉站错队的 stray → 补回本组缺失值；返回值带 `groups` / `groupMismatch`
- `ensureSpecTable` 的 `ok` 现在还要求 `groupMismatch` 为空 —— **开工前先看这个字段**

### 旧版分类页分支（与「新版流程」不同，必读）

`https://mms.pinduoduo.com/goods/category` 是**旧版分类页**：**没有 file input**，主图不能在这儿传。

1. **用 `flow.searchCategory(page, 目标完整路径)`** —— 走「搜索关键词 → 下拉里整条路径全等」，
   **不要点「最近使用的分类」里的 `.choose-category`**（那是捷径，且它的文本与下拉项相同、会命中 2 个元素，见 §3 旧版流程）
2. 读回「已选分类」，确认末段全等目标叶子
3. 点「确认发布该类商品」→ URL 变 `goods_add/index?type=add&from=category&id=...&goods_id=...`
4. **进到 goods_add 才是完整表单**（7 个 file input、三个计数器 `10/10`、`0/10`、`50/50`）

「最近使用的分类」里同时存在 `家居饰品 > 贴饰 > 墙贴` 和 `宠物…> 猫抓板`，
按类名取 `.choose-category` 时**必须同时校验文本**，否则会点到猫抓板。

### 参考价字段真名是「商品参考价」

不是「参考价」。必填（label 带 `*`），占位文案 **「应大于商品最大单买价」**。定位：

```js
document.querySelectorAll('[class*=beast-input-goods-sku-row]')  // 再筛 textContent 含「商品参考价」
```

坑：它的 label `span` **有子元素**，用「`children.length === 0`」当叶子条件会**整条漏掉**。

### 新链接页每行是 4 个 input（与编辑页 5 个不同）

新链接 `type=add` 的 SKU 行只有 4 个可见 `input[placeholder="请输入"]`：

| 序 | 语义 |
|----|------|
| 0 | 库存 |
| 1 | 拼单价 |
| 2 | 单买价 |
| 3 | 规格编码 |

**没有「库存镜像」那一列**（编辑页才有，见 §B）。别照搬编辑页的 5 列假设。

### 若干小坑（PE5 实测）

| 坑 | 正确做法 |
|----|----------|
| 定位规格值 chip 用「规格类型1+类型2+chip」**合并列表**下标 → `nth(17)` 越界超时 | 必须只用 `input[placeholder="请输入规格名称"]` **这一个 selector** 的下标 |
| `uploadZone` 回读计数误报 `{ok:false, uploaded:0}`，以为没传上 | 以页面 `已上传N/M张` 文案为准；PE5 轮播图报 0 实际 10/10 |
| 数 CDP `/json/list` 的 `.Count` = 20，误判标签超限 | 只数 `type === 'page'`（实际 1 个）；`probeShop` 的 6 标签上限按 page 算 |
| `readAllSkuRows` 报 `mapRow is not a function` | `makeStickyMapRow` 返回的是**对象** `{map}`，要传 `mapRow: (t,i)=>sticky.map(t,i)` |
| 任一时刻只能读到十几个行 | 虚拟窗口，**必须跨滚动位置取并集**才拿到 36 行；单次快照永远不全 |
| 主图 11 张超轮播上限 | 轮播上限 10；体量异常的那张（如 131KB vs 其他 1.3MB）先跟用户确认再决定用不用 |
| 素材在中文目录 | 主图/详情图/SKU 图都要先复制成 ASCII 文件名再 `setInputFiles` |

### PE5 打通用到的脚本序列（可复用）

`.mimo-sessions/2026/09/28/new-chat/pe5_work/`：

`build_pe5.py`（36 行数据）→ `build_product.py`（转 `pdd_flow` 的 productData 结构：`dimensions` 是**维度名数组**、每个 sku 以维度名为键）
→ `step3.js`（选类目进表单）→ `step4.js`（主图/详情图/标题/品牌）→ `step5.js`（属性）
→ `step6.js`（建规格表）→ `fix1.js`/`fix2.js`（规格分组纠错）→ `fill4.js`（填 36 行值）
→ `fix5.js`（36 张预览图）→ `refset.js`（参考价）→ `final.js`（`validateForm` + 跨窗口并集校验）

### 2026-09-28 同款重上店铺C家居 9228（新版页 · goods_id=1010956680705 · 成功）

同素材、同价格、同编码，**只换标题**（避免与 9226 那条重复铺货）：
标题 `掉灰墙面自粘墙纸防水防潮防霉卧室客厅背景墙贴纸翻新遮丑可擦洗`（30 字）。

新版页走通的顺序：主图 10 张 → **真实聚焦标题框 → 逐字输入 → 点空白处失焦** →
`openManualCategoryPicker` → `searchCategory(路径, { confirm:true })` → 点「下一步, 完善商品信息」 →
`goods_add`（URL 带 `version=predictCate`，`商品分类` 读回核验）→ 详情图 39 → 品牌祺讯 → 属性 8 项 →
规格表 → **数行数**（这里发现 33/36，按上节配方修成 36）→ 填值 → 预览图 → 参考价 199 → `validateForm` 全过。

> 主图/详情图/标题/品牌/属性/规格一次性做对的比例很低，**每步都读回校验再进下一步**；
> 尤其**规格分组建完立刻用 `readSpecGroups` 核对每维值数**，错了当场修，别等到填值阶段。


---

## ★ 2026-09-30 复验轮补充（72 行 / 两维 · 实测）

> 这一节的结论都来自真实数据复跑（MZB-006，72 SKU，猫抓板，店铺C 9228）。与上文冲突时**以本节为准**。

### §B1 预览图上传：先走隐藏 input，不要点「本地上传」

空预览图格内**一直存在可用的** input[type=file]（accept="image/jpeg,image/png"、offsetParent=true）。

**「本地上传」按钮不要点**：它在 sticky + 虚拟滚动下位于**视口之外**
（实测按钮 rect.y ≈ 2955 而 viewportH = 945，hitTest: none），
Playwright 会等满 timeout 才抛错。用 btn.click({ trial: true }) 实测 **2515ms/行**。
72 行就是约 180s 的纯白等。

**正确顺序**：tr.locator('input[type=file]').first().setInputFiles(file)，只有该格确实没有 input 时才退回按钮 + filechooser。
uploadMissingPreviews 已按此实现（2026-09-30）。

另外两点：
- 上传后的等待**不要用固定 waitForTimeout(300)**（72 行 = 21.6s 死等），改成轮询「本行出现缩略图」，通常 100~200ms 就返回。
- pass 循环要**早退**：本遍所有待传行都成功就 break（原实现固定 3 遍，传完还空扫两遍）。

### §B2 关 beast-core 模态框只有一个办法

`
svg[data-testid="beast-core-modal-icon-close"]
`

**Esc 无效、点遮罩无效**、在 class 里搜 close 也找不到（图标 class 是 MDL_headerClose，不含 close 关键字）。
外层容器是 MDL_outerWrapper … MDL_showCloseIcon。

### §B3 第二维匹配：短标识兜底必须有「唯一性」前提

`
// ✗ 错：共享前缀会折叠（12 个尺寸共享 30cm 前缀 → 塌成 4 个 → 数出 24 而不是 72）
text.includes(V1[i]) || (T1[i] && text.includes(T1[i]))

// ✓ 对：全值精确匹配优先；短标识兜底仅当它在本维度内唯一
for (let i = 0; i < V1.length; i++) if (text.includes(V1[i])) { d1 = V1[i]; break; }
if (!d1) for (let i = 0; i < V1.length; i++) {
  const tk = T1[i];
  if (!tk || tk === V1[i]) continue;
  if (T1.filter((x) => x === tk).length > 1) continue;   // 有歧义就不猜
  if (text.includes(tk)) { d1 = V1[i]; break; }
}
`

**为什么必须修**：repairSpecMatrix 会拿 scanSkuKeys 的行数当「值是否缺失」的证据。
数出 24/72 时它反推「12 个尺寸里缺 8 个」，而 short1.length < D1.length 那道**本该保护受害者的护栏**
恰好被这个假象绕过 → **删掉 8 个本来正确的尺寸值**。实测触发过两次。

**判据口径**：ensureSpecTable(verifyRows:true) 的返回值里，matrix.count 必须等于笛卡尔积；
missing 为空只说明**值**都在，不代表**行**齐 —— 两者是不同的东西。

### §B4 validateForm 的 unknown 不能一概进否决项

把兜底从 pass 改成 unknown 的方向是对的（不静默判过），但**不能同时让它否决 allPass** ——
实测会导致一条 72/72 行预览图齐全的链接**永远无法通过**（allPass:false，唯一非 pass 项就是
preview_images: unknown）。

现有口径：preview_images / packaging_label 的 unknown **保留状态、但不进 allPass 否决项**；
同时 preview_images 改为**正向逐行判据**（复用 readAllSkuRows 带回的 hasImg，数得全就给 pass/fail）。

### §B5 run_listing.js 的第十步之前有查重

正式入口现在开头有 **⓪ 查重**（门禁第 3 步）。命中 exact_duplicate / same_title_different_sku /
search_failed 都会停下并给出处置建议；确认无碍可用 PDD_SKIP_DUP=1 跳过。

### §B6 规模与耗时（72 行实测）

| 阶段 | 耗时 |
|---|---|
| ⓪① 查重 + 类目页 | 约 13s |
| ② 选类目（含主图 10 + 标题 + 手动分类弹窗 + 搜索确认） | 约 15s |
| ④ 详情图 34 张（一次批量） | 约 12s |
| ⑤ 品牌 | 约 6s |
| ⑥ 规格表（1 遍扫描 + 类型名 + 18 chip） | 约 25s |
| ⑦ 填值（288 次写值 = 4 字段 × 72 行） | **约 100s** |
| ⑧ 预览图 72 张（逐行） | **约 79s** |
| ⑧b 正向核验（1 遍扫描） | 约 7s |
| ⑨ 参考价 | 约 0.4s |
| ⑩ validateForm（1 遍扫描） | 约 17s |
| **合计** | **约 275s（4.6 分钟）** |

ⓖ 与 ⑧ 占 66%，且都是「行数 × 逐次操作」的乘法 —— 36 行时约一半，行数翻倍就翻倍。

### §C 分区上传锁死（2026-09-30 GPVC-001）

- **详情区 input**：`readZoneCounter(page, '商品详情', 50)` → 邻近文本含「快捷编辑」+ `已上传N/50`，idx 即该区 file input。
- **上传确认**：`uploadZoneFast` → `setInputFiles(该 idx)` → `waitForZoneCounter` **只认分区计数器**（`how=zone_counter`）。
- **禁止**：全文 `已上传N/total` 正则、全页缩略图计数当详情区成功判据。
- **validateForm**：`detail_images` 用 `readZoneCounter` 读回与 `detailCount` 比对。

### §D 详情区读回与残留清理（2026-10-05 GPVC-001 实测 · 计数器会骗人）

**症状**：`readZoneCounter` 读 `已上传9/50`，但页面上真实只有 **8** 张 → `validateForm.detail_images` fail
（GPVC-001 重跑那次就是这样；根因是 ④ 首次上传报了 `detail_unstable_after_upload`、⑨b 又补传一次，服务端多算）。

**正确的读回（两个值一起看）**：

```js
// 容器：label 文案为「商品详情」的 mui-form-group；其内文本含「快捷编辑 … 已上传N/50」
let root = /* 含「快捷编辑」且含 /已上传\s*\d+\s*\/\s*50/ 的最小容器 */;
const counter = ((root.textContent||'').match(/已上传\s*(\d+)\s*\/\s*50/)||[])[1];
// 真实张数：缩略图是 <img src>，容器 class 前缀 ImageWithRemark_v2_imageContainer
const imgs = Array.from(root.querySelectorAll('[class*=ImageWithRemark_v2_imageContainer]'))
  .map(n => n.querySelector('img')?.getAttribute('src')).filter(Boolean);
// 判定：Number(counter) === new Set(imgs).size === product.detailCount
```

- **门禁**：`计数器 == 去重后 img 数 == detailCount`，三者不齐就修，别只看计数器。
- 缩略图 URL 两种形态：`img.pddpic.com/mms-goods-image/...`（本次上传）与 `pfs.pinduoduo.com/L90k…`
  （落库后）。**`pfs.*` 用脚本直接 GET 会 401，页面内 `fetch` 也会被 CORS 拦** —— 想核内容只能靠截图或
  浏览器里看，别为这个反复造轮子。

**删单张残留**（`clearZone` 不要用于清空详情区）：

```js
const n = root.querySelectorAll('[class*=ImageWithRemark_v2_imageContainer]')[idx];
for (const t of ['mouseover','mouseenter','mousemove']) n.dispatchEvent(new MouseEvent(t,{bubbles:true}));
const box = n.querySelector('[class*=actionBox]');
const del = Array.from(box.querySelectorAll('*')).find(e => /删除/.test(e.textContent||''));
const clickable = del.closest('[class*=actionItem]') || del;
clickable.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));
clickable.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
clickable.click();
```

- **平台硬限制**：详情区**不能删到 0 张** → 弹「**删除失败！商详装修图片不能为空**」。
  所以顺序必须是「**先传后删**」：先确保区内有图，再删残留。
- `run_listing.js` 的 ⑨b 已内置这套核对/补传/删残留循环；**救不动就直接重跑出新草稿**（100s），
  不要在坏稿上耗（这是我 2026-10-05 的真实教训）。

### §E 只读侦察脚本不要碰已填表单（2026-10-05 事故）

`connectShop(port)` 会**优先返回 `goods_add` 那一页**。所以「拿 connectShop 的 page 再 `goto` 商品列表查重」
= 把已填的草稿页导航走 → 详情区/预览图计数错乱、后续 `validateForm` fail（门禁 0d 的触发路径）。

- 读回：**只在当前页原地 `page.evaluate`**。
- 要开别的页面：`browser.contexts()[0].newPage()`，并且**不要用 `connectShop` 去拿那个 page**。
- 查重/列表这类只读检查，要么走 `checkDuplicate`（它内部会 goto，必须在**还没填表时**做），
  要么等整轮跑完再做。

### §F 主图/轮播区读回（2026-10-05 MZB-001@9227 旧版页实测）

- **旧版页 `readZoneCounter(page,'商品轮播图',10)` 恒返回 `[]`**（分区文本定位不到）；
  于是老代码 `waitForZoneCounter` 必然等满 45–60s，然后报 `uploaded:0` ——
  **图其实已经传上去了**（页面是 `已上传10/10张`）。这是「假失败」，不是真失败。
- 现在的判据（都在 `pdd_flow.js` 里，直接复用）：
  - `flow.mainImagesState(page)` → `{uploaded,total}`：认 `商品轮播图|商品主图` 附近的两套文案
    （`已上传N/10张` 与 `上传图片 (N/10)`）。
  - `flow.quickZoneCount(page, '商品轮播图', 10)` → `{counter,thumbs,how}`：计数器 + **分区缩略图数**。
  - `uploadZoneFast` 会先轮询这两条（6×700ms），命中即返回 `main_counter_quick` / `zone_thumb_quick`；
    超时后再兜底为 `main_counter_fallback`。
- `validateForm` 现在有 **`main_images`** 校验项（`expect = main_images.length`），
  主图缺了会 fail，读不到判 unknown —— **旧版曾整项缺失导致 0/10 也 allPass**。
- ⚠️ 缺口要在**当前页原地补**（`uploadZoneFast` 直接调即可）；**不要为了补图重开草稿 URL**
  （我 2026-10-05 这么干过一次，详情计数变 11/10、末组预览图丢失 → 整条报废）。

### §G 连店自动清理卡死页 / 重复监控页（2026-10-05 新增 · 已端到端实测）

**症状**：`cdp_handshake_failed: connectOverCDP Timeout 120000ms exceeded`（或 `ECONNREFUSED`＝实例已退出）。
`/json/list` 正常、标签一堆（实测 8 个：`sycm/goods_effect` ×4、`yingxiao/goods/promotion/list` ×2 …），
但 Playwright 会等**所有页面**初始化 → 一个卡死页就干等 120s。

**已封装的三个函数**（都在 `pdd_flow.js`，`connectShop` 已内置调用）：

```js
// 1) 只读探活：Node 内置 WebSocket，逐页发 Runtime.evaluate('1+1')，8s 不回即卡死
const r = await flow.probePagesAlive(port, pages, { perPageMs: 8000 });
// -> { supported:true, alive:3, hung:[{url,id}], ok:false }

// 2) 清理：卡死页 + 同类监控页(每类留 1) + 超标多余非业务页；业务页永不关
const c = await flow.cleanupShopTabs(port, { maxTabs: 6 });
// -> { closed:['hung:about:blank', ...], keptDocs:N }

// 3) 直接连（默认 autoCleanup=true：握手失败会先清一次再重试）
const det = await flow.connectShop(port, { maxTabs: 12 });
// det.probe.cleanup.closed 里是本次自动关掉的页；run_listing 会把它打进日志
```

**边界（务必遵守）**：
- 业务页正则 `goods_add|goods_list|goods_detail|home|orders` —— **一律不关**（含用户正在填的草稿页）。
- 只关标签，**不 `taskkill` Chrome**；清理后仍失败才考虑重启该店实例（保留原 `--user-data-dir`）。
- Node < 22 没有全局 `WebSocket` → `supported:false`，探活自动跳过（清理仍会处理重复监控页）。

**实测验证**：故意把自己开的一个标签主线程忙等 15s →
`探活 alive=3 hung=1 (hung:about:blank)` → `cleanupShopTabs closed=1` → 清理后仍剩 3 个页面，
其中 `goods_add` 表单页完好。


- **症状**：`⑥ 规格表 count:0`、两个维度全 missing；页面浮出 **「智能生成工具」** 模态框，
  **Esc / 知道了 / `svg[data-testid*=modal-icon-close]` 都关不掉**（实测全无效），
  规格区此后 `规格类型1` input 与「请输入规格名称」**都不再渲染** → 后面全崩。
- **根因**：`添加规格类型(0/2)` 旁边就是 **`AI添加规格`** 和 **`AI素材工具`**（用户抓到的元素：
  `data-tracking-viewid="el_entry_button"`、`<span>AI素材工具</span>`）。旧实现用
  `page.locator('button', { hasText: '添加规格类型' })`（子串匹配）+ `span` 兜底，
  把 AI 按钮也算进去了 → 点它 → 弹窗。
- **修法**（`ensureSpecTable` 内 `clickAddSpecType`）：
  - locator：`page.locator('button:has-text("添加规格类型")').filter({ hasNotText: /AI|智能生成/ }).first()`，
    点击前再断言 `innerText` **以「添加规格类型」开头**；
  - evaluate 兜底：`/^添加规格类型/.test(t) && !/AI|智能生成/.test(t)`。
- **通用教训**：这个后台里**任何按文本点按钮**的地方都要防子串误命中（AI 入口与正常按钮相邻是常态）。
- **救法**：弹窗关不掉 → **重开页面/重跑流程**（230s）；不要在坏稿上救。

