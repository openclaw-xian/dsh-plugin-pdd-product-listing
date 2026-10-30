---
name: pdd-product-listing
description: 拼多多商家后台「新品上架」全流程自动化：读本地素材目录（主图/详情图/SKU图/店透视数据包），经 CDP 填标题、类目、品牌、类目属性、规格与 36 行 SKU、SKU 预览图、商品参考价，并跑 validateForm 校验（绝不代替用户点提交）。Use when 用户说「拼多多上架」「上架到店铺C」「上架到店铺A」「上架到XX店」「上架这个」「上架到拼多多」「pdd发布商品」「多店铺上架」「用素材包上架」，或给出 D:/图片/... 这类素材目录并要求上架。能自动识别同一个类目 URL 的新旧两套页面（旧版用搜索选类目、新版用手动选择商品分类）。Negative：不要用于改价、下架、订单、客服、投流；改规格类型/值请用 pdd-fix-listing-specs，竞品图处理请用 competitor-image-fission，只做定价表请用 pdd-five-stack-listing。
---

# 拼多多多店铺商品上架

把素材包（Excel + 分类图片）自动填进拼多多商家后台，支持单店铺或批量多店铺发布。

### 交接上手（给新 agent / 新机器）

**第 0 步 · 装到正确的目录**（决定 agent 能不能发现它）：
把整个 `pdd-product-listing/` 文件夹放进 agent 会扫描的技能根目录：

| 宿主 | 技能根目录 | 本机实测 |
|---|---|---|
| **DeepSeek Harness（DSH）** | **`~/.agents/skills/`** | ✅ 本机 DSH 实际扫的就是这里（目录里已有 90+ 个技能）；`~/.config/mimocode/skills/` 与 `~/.claude/skills/` **都不扫** |
| MiMo Desktop | `~/.config/mimocode/skills/` | 本目录（2026-10-05 时点：DSH 里**发现不到**本路径下的这个 skill） |

**2026-10-05 实测结论**：本 skill 目前只存在于 `~/.config/mimocode/skills/`，所以在 DSH 会话里
**不会被加载**（catalog 里没有它）。要在 DSH 用，把整个目录复制到 `~/.agents/skills/pdd-product-listing`
（含 `scripts/`、`references/`、`config.json`；`tools/` 13MB 与 `output/` 素材可不同步），然后**新开一个会话**。


**运行时依赖**（缺哪样就装哪样，详见 `references/env.md`）：Node.js + `playwright-core`、
Python 3、Chrome 开远程调试端口、以及**已登录的拼多多商家后台**
（技能明确规定 agent 不代登录、不碰账号密码）。

三步就能跑，全程不提交，跑完自己去后台检查并点提交：

1. **准备**：Chrome 开调试端口（`open_browser.ps1`），用户登录拼多多商家后台；素材目录按 `01_主图` / `02_详情图` / `03_SKU图/12张汇总` 放好。**单图不得超过 3MB**（平台文案「上传图片大小不能超过 3MB」）；预览图/主图建议先缩到 ≤800×800 PNG（目标 <2.5MB）。
2. **建数据**：**写 listing.json 之前，按上面的「开工前确认清单」把各项一次问清**（规格结构、标题、属性、价格、编码、类目、素材取舍）：规格类型名与维度结构是照数据包、你另有想法、还是要我给建议（见门禁 23）。然后照 `scripts/listing.example.json` 写一份 `listing.json`（标题/属性候选/档位色名/长度与价格/编码模板），
   然后 `<带 openpyxl 的 python> scripts/build_product.py --listing listing.json --assets "<素材目录>" --out ./work`
   （⚠️ 裸 `python` 可能指向没有 openpyxl 的解释器 → 先把绝对路径写进 `config.json.python`，见下「2026-10-05 实测 B/A」）。
   它会做**规格值预检**（≤40 字、无非法字符）+ **单图 ≤3MB 预检**，并生成 ASCII 素材副本 + `work/product.json`。
3. **跑上架**：`PDD_PRODUCT=work/product.json PDD_PORT=9226 PDD_CATEGORY="家居饰品 > 贴饰 > 墙贴" node scripts/run_listing.js`。
   它自动识别新旧类目页、走完 15 步、打印 `validateForm` 结果，**不提交**。

_backup/ 里的 `*.bak` 是历史回滚副本，**给使用者可以直接忽略**（改代码前若想留退路，就按同样方式再复制一份）。
改代码后先跑 `node scripts/test_pdd_flow.js` 做最小回归。

**本轮改了什么、哪些还没验、你那批怎么跑** → 见 `references/handoff.md`（接手前先看这份）。详细规则见本文件的门禁与 `references/playbook.md`。

### ★★ 开工前确认清单（2026-09-29 用户明确 · 所有要「定下来」的值都要问）

**原则：任何会写进商品、且不是你我此刻能唯一确定的值，开工前一次问清，不要自己拍板。**
每项给三个选项：**A 照数据包 / B 用户另有想法 / C 我给建议**。问完再写 `listing.json`。

| 要确认的 | 说明 | 我给建议时的默认倾向 |
|---|---|---|
| **规格类型名** | `型号/尺寸`、`款式/属性`、`颜色/尺寸`… 不固定 | `型号`=颜色档位、`尺寸`=长度 |
| **维度结构** | 哪个维度装颜色档位、哪个装长度；长度取哪几档 | 颜色档位×长度 = 12×3=36 行 |
| **标题** | 直接用数据包、还是差异化改写（避开同店/竞品重复） | 改写，保留核心词 |
| **规格值措辞** | 值的文字骨架（`微浮雕系列【色】档位` / `微浮雕色--【档位#】`…） | 照数据包骨架 |
| **属性** | 材质/特点/风格/图案元素/工艺/适用空间/产地/厚度 | 照数据包；**下拉没有该值时的回落项也要你定** |
| **价格/库存/参考价** | 拼单价、单买价、库存、商品参考价 | 沿用上一批（须 > 最大单买价） |
| **编码模板** | 如 `50cm连续木纹-{色}-{长度}`，是否带档位段 | 两段式（色+长度），共 12 个 |
| **类目** | 完整叶子路径，如 `家居饰品 > 贴饰 > 墙贴` | 照上一批/数据包的叶子 |
| **素材取舍** | 超过平台上限（轮播 10 / 详情 50）时取哪些 | 全用；超限才取舍并告知 |

> **不要把「沿用上一批」当成默认**——每条链接都要问一遍。
> 也不要因为「照数据包」就不问：数据包的值未必可填（下拉里没有），结构也未必是我们要的形态。

> **自动化边界（消除文档矛盾 · 2026-09-29）**：本 skill 的自动化流程**只负责填空与校验，绝不点提交**。
> 代码里确实存在 `submitProduct` / `listProductSafe`，它们是**仅供人工显式调用**的工具，
> 不属于本流程；门禁里凡出现「提交」字样，均指**由用户在后台自行完成**。

### ★ 文档现状与已知矛盾（以本节为准 · 2026-09-30）

旧文档里散着几处互相打架的表述，**全部以本节为准**，遇到别处说法不一致时按这里执行：

| 项 | 以本节为准 |
|---|---|
| **是否代提交** | **本流程只填空与校验，绝不点提交**。代码里的 `submitProduct` / `listProductSafe` 仅供人工显式调用，不属于本流程 |
| **素材目录命名** | **两套都支持**：`01_主图 / 02_详情图 / 03_SKU图`（老批）与 `商品轮播图 / 商品详情 / 预览图`（如 MZB-006）。`build_product.py` 已按关键字自适应；要精确指定就用 `listing.json` 的 `dirs` |
| **店铺与端口** | 以 `config.json` 的 **`shops`** 字段为准（店铺A 9226 / 店铺B 9227 / 店铺C 9228）。`run_listing.js` 的默认端口只是兜底，实际用 `PDD_PORT` 传入 |
| **步数** | `run_listing.js` 现为 **10 步**（① 判形态 ② 选类目 ③ 旧版补主图标题 ④ 详情图 ⑤ 品牌+属性 ⑥ 规格表 ⑦ 填值 ⑧ 预览图+正向核验 ⑨ 参考价 ⑩ validateForm）。playbook「一次生成」里的 15 步是**较早期的手工清单**，以代码为准 |
| **`fillProductForm`** | **遗留入口，别用**。它遇属性缺失会直接中止、规格段也没接新校验；正式入口是 `run_listing.js` |
| **新旧版判定** | 用 **`detectCategoryPage(page)`**（返回 `kind: old/new/unknown` + `evidence`）。旧文档说「正文含商品主图且含下一步」是**过期描述**，它漏判了「搜索框与 `.choose-category` 均为 0」这个关键条件 |
| **`mapRow` / 续行去重** | 逐行读取**必须** sticky 继承（`makeStickyMapRow`）或自己拼维度 key。`makeMapRow` 在续行文本相同的情况下会合并行（PE2 把 36 读成 17 就是它） |
| **标题长度** | 以**平台上限 30 汉字（60 字符）**为准。`read_excel.py` 里那套「>60 字符」是字符计数，两者不等价——**取更严的 30 汉字** |

### ★ 2026-10-05 GPVC-001@店铺C9228 实测新增（必读）

> 这一轮 16 SKU（8 色 × 2 款式）端到端跑通：**100.7s，validateForm allPass（15/15），错误（0）**，
> 草稿 `goods_id=10xxxxxxxxxx`。下面 4 条是本轮踩出来、且旧文档没写清或写错的。

**A. 运行时（最容易一开工就挂）**
- **`python` 必须用带 openpyxl 的解释器**。本机 PATH 上的 `python` 是 hermes venv（3.11.9，**没有 openpyxl**），
  照文档写 `python scripts/read_excel.py ...` 直接 `ModuleNotFoundError`。
  实测可用：`<你的 python.exe 路径>`（openpyxl 3.1.5）。
  最省事的办法是把绝对路径写进 `config.json` 的 `python` 字段（`resolve_env.ps1` 会优先用它）。
- **Node 侧不必依赖 skill 内的 `tools/`**：本机 `playwright-core` 可解析、且 Node 24 + Chrome 154 实测可用。
- 端口 ↔ 店：**9226 店铺A（旧版页）/ 9227 店铺B / 9228 店铺C（新版页）**；连店前 `probeShop` 探活。

**B. 详情图（本轮唯一的真坑，必须按这个顺序读回）**
- 新版页**详情区缩略图是 `<img src>`**（不是 background-image），但容器 class 是
  `ImageWithRemark_v2_imageContainer__*`：**必须用 `img[src]` 数**，用 background 数会得 0 或错值。
- **计数器会虚高**：本轮实测计数器读 `已上传9/50`，而页面真实只有 **8** 个容器 → `detail_images` 判 fail。
  门禁：**计数器数字必须 == 容器数量 == `product.detailCount`**，三者不齐就修详情区，别信单边数字。
- **`④` 首次详情上传常报 `detail_unstable_after_upload`（uploaded=0）**，`⑨b` 再按容器定位补传一次。
  实测这会让服务端计数多算（9/50），所以**⑨b 跑完必须复读一次计数器**。
- **平台禁止把详情区清到 0 张**：会弹「**删除失败！商详装修图片不能为空**」。
  所以 playbook 的「先传后删」是**硬要求**：清残留前先确保区内还有图。
- 删单张残留：进 `[class*=ImageWithRemark_v2]` 容器 → 悬停 → 点 `[class*=actionBox]` 里的删除项。
  本 skill 的 `clearZone(frame,'商品详情')` **不要用来清空**，只能用来删指定残留。
- 已建坏且救不动（清不掉 / 计数错乱）→ **直接重跑 `run_listing.js` 生成新草稿**，废稿留给用户删。
  实测重跑一次 100s，比在坏稿上修便宜得多（我本轮就在坏稿上耗了太久）。

**C. 只读侦察脚本会把已填表单冲掉（我本轮的真实事故）**
- `connectShop(port)` 会**优先选中 `goods_add` 那一页**。所以「用 connectShop 拿到 page 再 goto 别的 URL」
  = 把已填的草稿页导航走，实测导致详情区/预览图的计数错乱、后续校验 fail。
- 铁律：**任何读回/侦察都在当前页原地 `page.evaluate`**；要开别的页面就用
  `browser.contexts()[0].newPage()` 开新标签，**并且不要用 `connectShop` 去拿那个 page**。
- 与门禁 0d 同源，但 0d 只说「禁止 goto 已填表单」，这里补上**触发路径**。

**D. 查重与裂变（本轮实战）**
- 命中**同店同标题**（本例 `10xxxxxxxxxx`）→ 按门禁问用户，用户选裂变后：
  标题加一个后缀词（本例「新款」，28 汉字）+ **反转 `main_images` 顺序**即可；改完先单跑一次
  `checkDuplicate` 确认 `not_found`，再跑正式流程（**不要用 `PDD_SKIP_DUP=1` 蒙过去**）。
- 反转载入的做法：直接改 `work/product.json` 的 `main_images` 数组顺序即可，不必重命名文件。
- 提交前用只读方式核对：`main_images`、`detail_images` 与页面对应区计数一致（见 B）。

### ★ 2026-10-05 MZB-001@店铺B9227 实测新增（72 行 / 旧版页 / 必读）

72 SKU（6 色 × 12 款式）跑通：**289.8s**、`allPass`（17 项，含新增 `main_images`）、错误（0），未提交。

**E. 旧版页（9227 店铺B）主图上传是「假失败」——已修，别再手补**
- 症状：`③ 主图 = {"ok":false,"uploaded":0,"confirmedBy":"zone_timeout"}` 且白等 45–60s；
  但页面计数器其实是 `已上传10/10张`，**图已经传上去了**。
- 根因：`readZoneCounter(page,'商品轮播图',10)` 在**旧版页恒返回 `[]`**（分区文本定位不到），
  `waitForZoneCounter` 于是等满超时后报 0。
- 已修（`uploadZoneFast`）：主图/轮播区先**轮询 6×700ms** 的「快速判据」
  （① 邻近文本 `已上传N/10张` / `上传图片 (N/10)` ② 分区缩略图数），命中即返回
  `confirmedBy: main_counter_quick / zone_thumb_quick`；等满后仍失败则再用同样判据兜底
  （`main_counter_fallback`）。**再也不许手写补主图脚本**（我手补时重开 URL，把草稿搞坏过）。
- 判据函数可直接复用：`flow.mainImagesState(page)`、`flow.quickZoneCount(page, '商品轮播图', 10)`。

**F. `validateForm` 新增 `main_images` 项（本次补的漏检）**
- 旧版：主图 0/10 也 `allPass`（因为**根本没有这一项**）。现在 `expect = main_images.length`，
  读到就 pass/fail，读不到判 `unknown`（不允许静默 pass）。
- ⚠️ **2026-10-05 二次修正**：主图/详情图数组在 `product.json` 的**顶层**（`main_images` / `detail_images`），
  **不在 `product` 对象里**。`run_listing.js` 只传 `D.product` 时 → `expectMain = 0` → **整项被跳过**，
  校验表里看不到这一行（`allPass` 照样是 true）。已在 `run_listing.js` 显式补传两项，
  并让 `pdd_flow.js` 的 expect 兼容「数组 / 数字 / `mainImageCount`」。
  **教训：新增校验项后必须确认调用方真的把数据传进来了。**

**G. 属性不是漏填：先看数据包有没有这一列**
- MZB-001 的拼多多段**只有「品牌」「包装方式」两个属性列，且都为空** → `attributes={}` 是**忠于数据包**，
  不是脚本漏填。该类目表单上**没有**「商品属性」行（也没有 材质/特点/风格 可选）。
- 判断口径：`错误（N）== 0` + `required_attributes_missing` 为空 = 没有必填属性被漏；
  可选属性（品牌/包装方式）**要填就单独问用户**——数据包空着时不要自己拍板，也别假装已填。
- 品牌沿用本店惯例（`祺讯`）是前几轮的**用户确认做法**，不是默认值；本批用户未指定 → 留空。
- **2026-10-05 用户明确默认**：**品牌=祺讯、包装方式=袋装**。做法：
  `product.brand='祺讯'` + `product.attributes={'包装方式':['袋装']}`；
  现在 `validateForm` 会各出一项 **`brand` / `attr_包装方式`** 逐项读回（实测 `[pass] brand: 祺讯`、`[pass] attr_包装方式: 袋装`）。
  ⚠️ **不要再把「品牌」塞进 `attributes`**：`run_listing.js` 有专门的品牌分支先填，走属性分支会重复填且可能报 `open_failed`。

**H. 旧版页规格区旁边的 AI 按钮会毁掉整轮（2026-10-05 店铺A9226 实测，已修）**
- 症状：`⑥ 规格表 ok:false / count:0`，两个维度一个值都没进去；页面上多出一个
  **「智能生成工具」模态框**（beast-core），**Esc / 「知道了」/ testid 关闭全无效**，
  之后规格区的 `input[placeholder="规格类型1"]` 与「请输入规格名称」**都不再渲染**。
- 根因：`添加规格类型(0/2)` 这一排里还有 **「AI添加规格」（旁边还有「AI素材工具」）**，
  用 `hasText:'添加规格类型'`（子串匹配）或 `span` 兜底会把 **AI 按钮**算成候选并点中 → 弹 AI 弹窗遮住规格区。
- 已修（`clickAddSpecType`）：文本**必须**以 `添加规格类型` **开头**（`^添加规格类型`），
  且**排除任何含 `AI` / `智能生成` 的候选**；两条路径（locator 与 evaluate）都加。
- 救法：那个弹窗关不掉 → **重开该页/重跑流程**即可（重跑一次 230s，比在坏稿上救便宜）。
- 顺带：同类「按文本点按钮」的地方都要防这种**子串误命中**（AI 按钮与正常按钮相邻是常态）。

### ★ 2026-10-07 PE3@店铺C9228 实测新增（36 SKU / 属性口径必读）

36 SKU（3长度×3档位×4色）跑通：**221.6s**、`allPass`（22 项）、错误（0），未提交。

**I. 属性字段名与取值：一律以「页面实际字段」为准，别照抄数据包的字面**
本轮数据包写 `样式：立体`、`工艺：浮雕,覆膜,素面`、`风格：中式`、`材质：pvc`，
而页面实际是：

| 数据包/字面 | 页面真实情况 | 处理 |
|---|---|---|
| 样式 | 字段叫 **`墙贴样式`**（值 `立体`） | 用页面字段名，否则 `validateForm` 的 `attr_样式` 读不到（`readDropdownFieldValue` 用全等匹配） |
| 材质 pvc | 下拉里显示为 **`聚乙烯(PE)`** | `attributes` 照数据包写 `pvc`，`pickAttr` 能精确命中（展示名≠存储值） |
| 风格 中式 | 该类目只有 **`北欧风`** 等 | **下拉没有的值不要硬填**，改用页面可选项（本轮用户确认用 `北欧风`） |
| 厚度 2.4mm | 是**数字直填**输入框，档位是 `2`、`2.00mm（含）-2.50mm（不含）` 等 | 直填数字 `2`；写 `2.4mm` 会读回不一致 |
| 工艺 `浮雕,覆膜,素面` | `ST_selectValueMultiple` **多选**字段 | `pickAttr` **只支持单选**（多点一次是替换），会只落第一个值；要么留空走类目默认，要么先扩展多选支持 |
| 适用空间 卧室 | 同样是**多选** | 同上 |

**J. 多选属性当前无解，必须显式告知用户**
`pickAttr`/`pickAttrByCandidates` 走的是「点开→点选项」，对 `ST_selectValueMultiple` 只能选一个。
所以含多值的数据包字段（`工艺`/`适用空间`）**不要抱期望全部填上**：跑完在报告里**明确列出哪些值没填**，
让用户在后台补勾（一个字段两下点击），别当成"已按数据包填完"。

**K. 属性值是「候选数组」不是字符串（我本轮因此崩过一次）**
`run_listing.js:201` 直接 `for (const [k, arr] of Object.entries(ATTRS))` 把值交给
`applyAttributesByCandidates(page, {标签: [候选…]})` → 写成字符串会 `(candidates||[]).map is not a function` 崩在 ⑤。
**建 product.json 时 `attributes` 必须是 `{标签: [首选, 备选…]}`**（候选数组用于"下拉没有就回落"的分层告警）。

**L. 崩溃后不要试图续跑**
`run_listing.js` 没有断点续跑入口，每次从类目页重开新草稿；已填一半的稿子只能废弃（用户自己在后台删）。
本轮因此留下 2 张废稿（一次属性格式崩、一次属性口径错），修复数据后第 3 次才全绿。
**先确保数据对，再开跑**，比"跑一半再补"便宜。

### 规模与耗时（2026-09-30 实测）

| SKU 数 | 结构 | 实测耗时 | 说明 |
|---|---|---|---|
| **16** | **8色×2款式** | **100.7s（≈1.7 分钟）** | **2026-10-05 GPVC-001@9228 实测，allPass 15/15** |
| **72** | **6色×12款式（旧版页 9227）** | **289.8s（≈4.8 分钟）** | **2026-10-05 MZB-001 实测，allPass 17/17（含 main_images）** |
| 36 | 4色×3档×3长度 | **4.8–6.1 分钟** | 常规 |
| 72 | 6色×12尺寸 | 约 **8–10 分钟** | `scanSkuKeys` 实测 **72/72 全覆盖**（5.9s）。⚠️ 一次性跑完可能顶穿命令行超时，建议把超时放宽到 20 分钟，或拆成「建表 → 填值 → 传图」多段执行 |

**预览图是最大头**（36 行时约 140s，占约一半），其次是填值与规格表。

## Important（硬门禁，不可跳过）

### PE5 实测新增硬门禁（2026-09-28 · 必读）

0. ★ **规格分组必须核对「每维值数」**：`ensureSpecTable` 返回的 `groups` / `groupMismatch` 必须为空才继续。
   只验「值有没有出现过」会漏掉「第二维的值被写进第一维」——那时 `t1/t2` 全对、所有值都出现过，
   但矩阵少一维（PE5 实测：型号 13 值 / 尺寸 2 值，`长10米` 成了型号）。
   判据用 `readSpecGroups(page)`（按 **DOM 顺序相对「规格类型2」** 分组，**不要用 y 坐标中点**）。
1. ★ **规格值做行匹配禁止尾部/子串兜底**：同一档位下不同颜色的值**尾缀完全相同**，
   兜底会让 sticky 永远粘在第一个颜色上 → 每行都匹配到同一个 sku → 目标值与现值相同 →
   **静默写入 0 次**（返回 `changed: 0`，看起来像「滚动不推进虚拟窗口」）。
   填值后**先看 `changed`**：为 0 不代表没有待填行，先怀疑匹配，不要先怀疑滚动。
3. **参考价字段真名是「商品参考价」**（不是「参考价」）：必填、label 带 `*`、占位「应大于商品最大单买价」。
   定位用 `[class*=beast-input-goods-sku-row]` + 文本含「商品参考价」；它的 label `span` **有子元素**，
   用「`children.length === 0`」当叶子条件会整条漏掉。
4. **新链接页每行 4 个 `input[placeholder="请输入"]`** = 库存 / 拼单价 / 单买价 / 规格编码，
   **没有「库存镜像」列**（编辑页才是 5 个，见 playbook §B）。别照搬编辑页列序。
5. `mms.pinduoduo.com/goods/category` 是**旧版分类页、没有 file input**，主图不在这儿传。
   选类目**必须用 `flow.searchCategory(page, 目标完整路径)`**：搜索关键词 → 下拉
   `li[class*=searchItem]` 里**整条路径全等**且**恰好 1 条** → 读回「已选分类」整条全等
   → 再点「确认发布该类商品」。
   **禁止点「最近使用的分类」里的 `.choose-category`**：那是捷径，它的文本与下拉项**完全相同**
   （文本全等会命中 2 个元素），且该栏不一定有目标类目 —— PE5 当初走这条捷径，
   等于**整套类目匹配逻辑一次都没执行过**。
   禁止 `includes`：搜「墙贴」时同屏还有「背景墙贴」「软包墙贴」「儿童玩具墙贴」「PVC墙纸」。
   （反向验证：用 `家居饰品 > 贴饰 > 背景墙贴` 调一次，必须选中「背景墙贴」而非「墙贴」。）
6. 任一时刻只能读到十几个 SKU 行（虚拟窗口）→ 读全量**必须跨滚动位置取并集**，单次快照永远不全。
7. 排错顺序：**先怀疑自己的匹配/判据，再怀疑页面**。PE5 这轮把匹配 bug 误判成滚动问题，白试了三种滚动机制。
2. ★ **`goods/category` 同一个 URL 有两种页面，不能按 URL 判分支，必须现场探测**：
   有 `input[placeholder*="关键词搜索分类"]` / `.choose-category` → **旧版页** → 用
   `flow.searchCategory(page, 完整叶子路径)`；
   有「下一步, 完善商品信息」+ `*商品主图` + `上传图片 (N/10)`、而搜索框与 `.choose-category` 均为 **0** → **新版页** →
   先上传主图+填标题，**推荐类目卡才会轮询出现**，再用 `flow.pickCategoryExact(page, 路径, category_id)`。
   实测：**9226 店铺A = 旧版；9228 店铺C = 新版**（同 URL）。
9. `pickCategoryExact` 的 `how` 要看清：只有 `cateId` / `exact_full` 是 `verified:true`；
   `ends_with_leaf` / `leaf_only` 会带 `verified:false` + `warn`，**必须读回「商品分类」核验末段全等**；
   出现 `ambiguous_*` 一律是失败，不许挑一个。
   优先传 `category_id`（`choosen_cate`），那是最硬判据。
10. 「新版第一步没有 file input」**不成立**（9228 复测有 1 个）——**现场探测 `input[type=file]` 计数**，
    不要按店铺/版本写死。
3. ★ **新版页：填完标题必须「真实聚焦 → 输入 → 点空白处失焦」，推荐类目卡才会出现**。
    卡片靠 blur 触发，而 **blur 只在真正 focus 过之后才发生** —— 用 `evaluate` + 原生 setter 直接写值
    （未聚焦）时标题「看起来填上了」（`inputValue()` 读得回来），但点空白不会产生 blur，
    **卡片永远不出现**。排查时先断言 `document.activeElement`：它不是标题框，才说明 blur 真的发生了。
    （2026-09-28 我因漏这步，一度误判成「新版没有推荐类目卡」。）
12. 点「下一步」后 URL 带 `version=predictCate`，`商品分类` 是**系统按标题+图片预测**带入的 ——
    **即使第一步手动选过，也必须读回 `商品分类` 核验末段全等**，预测会错（历史出现过「背景墙贴」）。
4. ★ **新版页选类目：优先点「手动选择商品分类」走全量搜索，不要直接点推荐卡候选**。
    推荐卡只有约 10 条预测（9228 实测目标第 1 条、**第 2 条就是「背景墙贴」**），目标不在其中就没有出路。
    正确姿势：
    ```js
    await flow.openManualCategoryPicker(page);                        // 或已在弹窗里
    const r = await flow.searchCategory(page, 完整路径, { confirm: true });
    // r.confirmed === '确认'（旧版页才叫「确认发布该类商品」）
    ```
    弹窗结构与旧版分类页一致：`input[placeholder*="关键词搜索分类"]` + `li[class*=searchItem]` + `已选分类` 读回 + `确认`。
    确认后读回第一步的 `*商品分类` 那一行核验。
5. ★★ **规格值有「字符集 + 40 字」硬限制，违反会让整张矩阵建成 0 行**（比少行更严重）：
    只允许 中英文 / 数字 / 空格 / `# : % ( ) ' + - * / .` / `（）【】`，最长 40 字。
    **排版符号 `×` 非法** —— PE4 把长度值写成 `长3米×宽50厘米【…】` 直接触发
    「数据错误，请刷新页面」+ 矩阵 0 行；换 ASCII `*` 立刻正常。
    开工前先 `flow.validateSpecValues(dimNames, [V0, V1])`；`ensureSpecTable` 已内置该预检
    （`precheck` 默认开），过不了会直接返回 `spec_value_precheck_failed` 而不碰页面。
    **已建坏可原地救**：`removeSpecValue` 删非法值 → `robustCommitSpecValue` 写入合法值 → 矩阵自动重建（实测 0→36），
    不必重开草稿。
6. ★ **取值来源规则：标题 / 规格类型名 / 规格值 / 商品属性 一律以该批次的「店透视商品数据包」为准**
    （2026-09-29 用户明确）。**唯一例外是「品牌」**：数据包里是竞品品牌（瓦时/易树家/贝悦…），
    我们必须填自己的 **`祺讯`**。数据包没写的属性才回退到类目表单默认或沿用上一批。
    ⚠️ **不要因为「跟上一批保持一致」就沿用上一批的属性** —— 我曾连续三批把 PE4/PE6 的属性
    填成 PE5 的 `材质 pvc` / `风格 中式`，这是错的。
    ⚠️ 数据包字段名 ≠ 表单字段名（PE6 数据包写「功能/使用对象」，表单上是「特点/适用空间」），
    **按语义就近映射**；写值前先枚举该下拉的可用选项（`pickAttr` 精确匹配，值不存在会 `ok:false`）。
7. ★ **优先「一次生成」：一个脚本跑完「类目第一步 + 表单」全流程**，别拆多段。
    实测 PE6→9228（36 SKU）**6.1 分钟**走完 15 步且 `validateForm` 全过。
    **可靠性靠机制不靠等待**：可靠路径（真实 click + 逐字 type + Tab）必须保留，但
    打字延迟用 **10ms**、单击/清空/Tab 后的等待收在 **200/120/700ms**、点击超时 **8s**；
    `scanSkuKeys` 步长/间隔 **120px / 70ms**（窗口约 15 行 ≈ 525px，仍有 4 倍重叠不会漏行）。
    保守设置会让 15 个规格值白等 40 多秒、叠加多次扫描后**一次跑 46 分钟跑不完**。
    ⚠️ PowerShell 里**别用 `| Select-Object -First N` 包住 node 调用** —— 读满即关管道、
    会**杀掉 node 进程**导致脚本半途静默中断；改用重定向到文件 + `Get-Content -Tail`，或 `-Last`。
8. ★ **两条「别自己把页面搞坏」的铁律**（2026-09-29 实测踩坑）：
    **(1) 禁止坐标盲点 `page.mouse.click(x,y)`** —— 落点控件不可控，曾点到规格区控件，
    页面直接「数据错误，请刷新页面」、型号 chip 读回 0 个。
    要失焦用 `blur()`，要点击就点确定的文本元素（`position:{x:2,y:2}` 避开其内部控件）。
    **(2) `ensureSpecTable` 不要在建好的表上重跑** —— 已改为幂等（类型名按需设、值只补缺失），
    但仍应「**读用读函数**」（`readSpecGroups` / `scanSkuKeys`），别为了看一眼就重跑它。
    教训：**读用读函数、写要幂等、禁止坐标点击。**
9. ★ **规格表建完必须「数行数」= 型号数 × 长度数** —— **`ensureSpecTable` 现在默认帮你做了**
    （`{ verifyRows: true }`，可关）。PDD chip 是受控组件：`evaluate` + 原生 setter 写值会
    **留下值但不提交进矩阵** → 分组读回是对的（12/3），矩阵却按 11 个型号建行 = **33/36**，
    而平台 **`错误（0）` 完全不报**，会静默少上架几个 SKU。
    **返回值里的 `matrix` 字段必须看**：`{ ok, expected, count, rounds, bad, log }`。
    单个函数：`scanSkuKeys`（跨窗口取并集数行）、`repairSpecMatrix`（数行+修）、
    `robustCommitSpecValue`（真实 click + 逐字 type + Tab 提交单个值）。
    ⚠️ **真凶判据**：只有「缺得不是全部值」的维度才是原因；某维度**全部值都缺**时它是受害者，
    修它没用还会白删好值（实测：缺 1 个型号 → 只修 `型号 x1`，不要连 `尺寸 x3` 一起修）。
    **`ensureSpecValuesRobust` 修不了这个**（它看到 chip 已存在就跳过）。
    ★ **「手动选择商品分类」入口常被折叠**：推荐卡初始只显示两三条，**此时页面上没有这个按钮**；
    确认过一次类目后按钮也会消失。**找不到就先点「查看更多推荐」展开**。
    `flow.openManualCategoryPicker(page)` 已内置这个重试（找按钮 → 没有就点「查看更多推荐」→ 轮询），
    **不要自己写「找不到就报错」**。
    ⚠️ 弹窗里同时有「搜索结果」`LI.SPP_searchItem_*` 和「推荐卡残留」`DIV.cateItemCard_chooseCategory__*`
    （实测搜「地毯」可见 28 条含「>」的条目，真结果只有 10 条）——
    **匹配必须锁在 `li[class*=searchItem]` 内**，不要用全局文本全等（`pickCategoryExact` 在弹窗里不安全）。

### 原有门禁（按序执行）

0. **开工前必读 `references/playbook.md`**：不要只读本 SKILL 就开工。至少通读 **「标准填法（实战固化）」+ §5 规格与 SKU（含 §5.0 虚拟滚动、§5.6 行定位）+ §6 预览图上传（含 §6.1 传图优先级、§6.2 像素比对）+ §A 兜底选择器**；旧坑在文末各「本次踩坑」表。playbook 是逐步点击/选择器唯一来源，本文件只做门禁与总览。**只在卡住时才翻 playbook = 迟**。（不写行号，按小节名找）
0b. **驳回改规格/文案 → 新建链接，禁止在 rejected 草稿上清 chips 重填**（清不干净会矩阵脏：stock/预览/行数全乱）。废稿只读 `rejectReason`，改好数据后从类目页 `fillProductForm` 重开。
0c. **payload 预检**：连店前跑 `flow.validateListingPayload(productData)` — 标题≤30汉字、ref>max(单买)、preview/主图路径必须存在（PE3 曾因 `sku_2.0`≠磁盘 `sku_1.0` ENOENT）。`fillProductForm` 默认也会跑，失败返回 `payload_precheck_failed`。
0c2. **单图 ≤3MB**（2026-09-30 ZDT-003 实测）：拼多多拒绝任何 >3MB 的图片（文案「上传图片大小不能超过 3MB」）。`build_product.py` 已内置预检，超限 exit 6，禁止连店。预览图常见坑：1024×1024 PNG 恰 3164952 字节（3.02MB）。处理：缩到 ≤800×800 + PNG optimize，目标 <2.5MB；JPEG q88 兜底。**只压 work 目录副本即可**，不必改素材包原图。
0d. **流程中禁止「保存草稿」、禁止 `goto` 重开已填表单**（PE4 血坑 + GPVC-001 复发）：点保存/刷新/goto 会**冲掉内存里的上传与未服务端落库的字段**。GPVC-001 实测：填完后再 `goto` 草稿 URL 读回 → 详情 8/8 变 0/50、预览 16/16 变 0、品牌/参考价被清空，规格表也被重置。**读回一律当前页原地 `evaluate`/`inputValue`，禁止导航**。只有脚本中途彻底失败、且已确认服务端草稿字段时，才允许开完整 `id=&goods_id=` URL 续填；续填后也要当表单可能被重置来补。
0c3. **数字类属性是直填输入框，不是下拉**（GPVC-001）：如「厚度」在表单上是 `input`（placeholder=请输入，label 常带 ` mm`），**直接 set 值**；不要走 `pickAttr`/`ST_selectValueSingle`。「中层厚度」等若是 `请选择` 下拉，数据包没有就留空，不要硬塞。
0e. **图区只按计数器文本定位（分区锁死，禁止全文假成功）**：详情区必须锁定「快捷编辑/商品详情 + 已上传N/50」对应的 input[type=file]（
eadZoneCounter / zoneByCounter 返回的 idx）；上传后用 waitForZoneCounter **只读该区计数器**，达到 N 才算成功。禁止 document.body.innerText 全文匹配「已上传N/M」（GPVC-001：全文假成功报 8/8、实际 0/50）。原文门禁：：`zoneByCounter(page, '商品轮播图'|'商品详情'|'包装标签图', 10|50)`；**禁止用 input index**（轮播/包装标签/辅助/详情同页易混）。分类以 **input 为中心**：取「最近的、只含单一区关键词的祖先」；**无法定区的输入一律不传**。上传用 `uploadZone()`（先传后删）；清区用 `clearZone()`（真实 hover 再点 `DeleteIcon`）。包装标签无素材必须 **0/10**（`validateForm.packaging_label`）。
0e2. **类目读回必须严格**：按 `>` 分段后，最后一段要**等于**目标叶子（`墙贴` ≠ `背景墙贴`）。新版预测类目页（9228）用推荐卡：精确全路径 → `以 > 叶子结尾` → 叶子精确，禁止 `includes` 模糊命中。表单页若没有「商品轮播图」input（主图在类目第一步已传），`forceMain` 只读计数器确认，**绝不改传别的区**。
0f. **连接前置探活**：`connectShop` 会先 `probeShop(port)`。可能抛：`cdp_unreachable`（Chrome 没开/没开调试端口）、`cdp_too_many_tabs`（标签 >6 —— **先试 `connectShop(port, { maxTabs: 12 })` 放宽**：多余标签常是用户自己的营销/生意参谋页，关掉会打断他；实测 7 标签下放宽后 0.5s 连上。真的 `cdp_handshake_failed` 再报用户关标签）、`cdp_handshake_failed`（浏览器卡死）。**这三种都不要硬重试** —— 报用户处理。新版类目**第一步只有主图**时也不退任意图片 input：找不到「商品主图/商品轮播图」区块 → `main_block_not_found` 立即停。
0f2. **★ 连店自动清理卡死/重复标签（2026-10-05 新增 · 已实测）**：`cdp_handshake_failed` 的头号原因是
    **某个标签卡死**（实测 `sycm/goods_effect`；Playwright 会等**所有**页面初始化 → 干等 120s）。
    现在 `connectShop` 自带：
    - `probePagesAlive(port, pages)`：用 Node 内置 `WebSocket` 逐页发 `Runtime.evaluate('1+1')`，
      8s 不回即判卡死（**纯只读**，Node ≥22 可用；更老版本返回 `supported:false` 自动跳过）。
    - `cleanupShopTabs(port)`：关掉 ① 卡死页 ② 同类监控页（`sycm/goods_effect` / `yingxiao.*`，每类留 1 个）
      ③ 仍超标时的多余非业务页。**业务页（`goods_add`/`goods_list`/`goods_detail`/`home`/`orders`）永不关**，
      不动 Chrome 进程。握手失败时会自动清一次再重试。
    - `run_listing.js` 会把清理结果打进日志（`① 连店前自动清理标签 = N [...]`），**不静默动用户标签**。
    - 端到端实测：故意阻塞一个标签主线程 15s → `探活 alive=3 hung=1(hung:about:blank)` → 清理只关它，
      `goods_add` 表单页保留。**若清理后仍 `cdp_handshake_failed`**，才重启该店实例（保留 `--user-data-dir`）。
0g. **fill 收尾会深度补全**（`enforceCriticalOnForm` deep）：标题/品牌/参考价/主图 + **SKU 空行（库存/拼单价/编码）+ 预览缺图**。看 `fill.steps` 里的 `enforce_sku_rows` / `enforce_previews`；任一不过即 `fill.ok=false`，不要再手写补丁脚本。
0h. **新流程顺序（9228 v4 / predictCate）**：`主图 → 标题 → 类目(先选) → 下一步`。类目卡在**第一步**，点完「下一步」卡片就消失了（只会留下预测类目）；类目读回必须**按 `>` 分段后末段严格等于叶子**。
0i. **长规格值会被行内截断**：型号名长（如 `木纹米黄升级强胶款/增厚暴粘`）时，行文字会被截成 `菌纳米款/旗舰品质`，`includes(needle)` 匹配必然错配（曾把整表写成同一个码）。**行定位改用「块标题 + 长度」**：块标题 = 该行（`td` 数 ≥8 的那行）文字中 ` 长` 之前的部分；长度取 `长\d+米`。
0j. **`0` 视为未填**：拼多多给新生成的 SKU 行预填 `0`；填价/库存时必须把 `'0'` 当空值处理（`fillEmptySkuRows` 已修）。
0k. **预览图「有图」≠「图对」**：**禁止盲删重传**（曾造成缺图 + 误替换）；只补**缺图**行。判「有没有图」看该行 `td.sku-preview-cell` 内有没有 `[class*=imageWrapper]`；图**对不对**用 playbook §6.2 像素比对（下载页面图与源文件各 resize 128 求 meanAbsDiff，<8 判 MATCH）。**用户只说「补上」时不要顺手替换已有图——先问**（PE2：36 行里 15 行有旧图，用户选择只补 21 行）。传图优先用**同格隐藏 `input[type=file]` 的 setInputFiles**，**禁止点「本地上传」**（sticky 下必报 `element is outside of the viewport`）。
0l. **滚动只滚 SKU 表自己的容器**：`scrollTopTo` 已改为只设 tbody 祖先里 `overflow-y:auto/scroll` 那个元素的 `scrollTop`，**不再 `window.scrollTo`**（页面跳动且表没动）。
0m. **规格 chip 提交要读回**：批量 evaluate 写值 + Enter 常丢末位值（12 个只落 10 个）。必须读回 chip 数并按维度值集合比对；补值时用**真实 click + type + `Tab`**（`ensureSpecValuesRobust`），Tab 比 Enter 可靠；补齐后再用 `readAllSkuRows().count == 笛卡尔积` 确认矩阵行数。
0n. ★★ **检查到此为止：禁止「验收后再自造第二轮核验」**（2026-10-05 用户明确反馈：
    「你一开始检查太多了，第二次检查少了就很好」）。
    **`run_listing.js` 自己的读回 + `⑩ validateForm allPass` 就是验收标准**（它已经覆盖：
    错误计数、逐行库存/价格/编码归属、矩阵行数、预览图逐行、详情计数、品牌、包装标签）。
    规则：
    - 脚本打印 `allPass=true` 就**停**。不要再写「侦察脚本」去核对类目/轮播顺序/编码分布/详情逐张/预览逐张。
    - **禁止**为了看一眼而 `goto` / 重开草稿 URL / 用只读脚本 `connectShop` 再导航（见 §E，会冲掉已填表单）。
    - 只有两种情况才追加核验：① 某步 `fail`/`unknown`（此时按该步的读回函数查，见 §D/§6.2）；
      ② 用户**明确要求**「核对图对不对」这类验收（最多做一轮像素比对）。
    - 数值抽样想报告给用户时，用 `validateForm.checks` 里已有的值（`stock_sum`/`price_match`/`code_per_row`…），
      **不要为此新开扫描**。
    - 判断标准是「能不能交付」，不是「我还能再验什么」。**检查本身也会把好稿搞坏**（本轮真实事故：3 次自造扫描后详情区计数错乱）。
1. **不代登录**：用户已登录店铺；复用已登录 profile，禁止新开未登录环境、禁止 `taskkill` Chrome
2. **Excel 是唯一数据源**：价格/库存/编码/属性以 Excel 原文为准，禁止改写
3. **三段严格分离**：`fillProductForm` 绝不提交 → `validateForm` 全量读回 → 仅 `allPass === true` 才 `submitProduct`；**fail 或 unknown 都禁止提交**
4. **路径不写死**：一律 `scripts/resolve_env.ps1` → `config.json` → 环境变量 → 探测；业务逻辑走 `scripts/pdd_flow.js`
5. **多店铺幂等 + 失败不静默**：先 `checkDuplicate`（标题+编码）；单店失败不阻断，最终必须输出对照表
6. **改完必须读回**：以 `validateForm` 为准，不只信 fill 脚本 `ok`
7. **逐步检查是默认**：每步填完读回、通过才下一步（见「逐步检查门禁」表）；禁止跳步、禁止一把梭省略读回
8. **草稿续填用完整 URL**：`id=<commitId>&goods_id=<id>` 缺一不可；只带 `goods_id` 会「地址不对」且类目加载卡死。续填不进类目页，直接开该 URL

业务入口只走本目录

## 开工前必读（顺序）

1. 本文件 Important + 逐步检查门禁表
2. **`references/playbook.md` → 「标准填法（实战固化 · 快而准）」**（含 step 1–18 固定方法）
3. **playbook §5** 规格/SKU/虚拟滚动/`readAllSkuRows`/sticky
4. **playbook §A** 手工兜底（选择器、file input 区块、属性 pick）
5. **playbook 文末「★ 2026-09-30 复验轮补充 §B1–§B6」**（72 行实测；预览图上传顺序、模态框关闭、
   第二维短标识唯一性、`unknown` 与 `allPass` 的关系、规模耗时表）——**与上文冲突时以这一节为准**
6. `references/handoff.md` §七：本轮改了什么、验到什么程度、还剩哪些没修
7. 需要旧案例/踩坑表 → playbook 文末「实战固化」与「本次踩坑」

未读 playbook 禁止开始 fill。执行时选择器/点击细节**只信 playbook**，不在聊天里重新发明。

## 快而准（硬要求）

**准**：**默认逐步**。每步「填 → 读回 → 对 Excel/目标 → 通过才进下一步」。读回失败或对不上就停，禁止跳步、禁止只信 fill `ok`。价格/库存/编码只取 Excel。

**快**：顺序固定，禁止来回试 UI（在逐步门禁都通过的前提下不回头改选择器）：
`resolve_env → read_excel(ok) → checkDuplicate → 逐步 fill(每步读回) → 补主图+标题(读回) → validateForm 全量 → submitProduct → verifyListed`

**逐步检查门禁（每步必须出读回结果，未过禁止下一步）**：

| 步 | 动作 | 必须读回 | 通过条件 | 未过 |
|----|------|----------|----------|------|
| 1 | 环境 | `Show-PddEnv` + CDP `/json/version` | 端口可达 | 停，报用户 |
| 2 | 预检 | `read_excel` JSON | `ok===true` 且 `sku_count>0` | 停，列 blocking |
| 3 | 查重 | `checkDuplicate` | `not_found` | 问裂变，禁静默 |
| 4 | 标题 | title input `.value` | == 目标标题且 ≤30 汉字 | 超长去冗余后重填再读 |
| 5 | 主图 | 轮播计数 `已上传N/10` + 缩略图不重复 | N==主图张数且无重复 | 删错图/补传 |
| 6 | 包装标签 | 该区计数/缩略图 | 无素材=0；有=目标张数 | 清空误传 |
| 7 | 详情 | `已上传N/50` | N==详情张数 | 删/补 |
| 8 | 辅助图 | 缩略图目视 | 无无关图（白底人像等） | 删 |
| 9 | 类目 | **表头** `商品分类` | 含目标叶子、不含猫抓板/沙发等误选 | 重选 |
| 10 | 品牌 | brand input | == Excel/约定 | 重填 |
| 11 | 属性 | 必填字段「请选择」 | 无空必填（`required_attributes_missing` 空） | 补选 |
| 12 | 规格类型 | t1/t2 input `.value` | == dimensions 名 | 重选下拉 |
| 13 | 规格值 | 各「请输入规格名称」.value | 集合 == Excel 维度值 | 补 Enter |
| 14 | SKU 行 | `readAllSkuRows` 虚拟滚动逐行（**禁 `tbody tr.length`**） | stock/拼单价/单买价/编码 == Excel；首行不空；行数==笛卡尔积 | 补填；缺行先修规格值 |
| 15 | 参考价 | 参考价 input | > max(单买价) | 改 |
| 16 | 预览图 | 每 SKU 有图（`td.sku-preview-cell` 内 `[class*=imageWrapper]`） | 无「请上传第N行」；补/替换后跑 §6.2 像素比对全 MATCH | 补缺图；替换前先问用户 |
| 17 | 表单错误 | 「错误（N）」 | N==0 | 补必填 |
| 18 | 全量校验 | `validateForm.checks` | `allPass===true`（无 fail/unknown） | 禁止提交 |
| 19 | 提交 | URL | 含 `goods_add/success` | 查发货警告 |
| 20 | 终态 | `verifyListed` | on_sale / auditing | 报 goods_id/reason |

每步向用户报：**做了什么 + 读回值 + 通过/未过**。用户要求确认时等回复；未要求确认时连续跑但每步仍读回。

> **★ 到 18 步就结束**（2026-10-05 用户明确）：`validateForm.allPass === true` **就是验收标准**。
> **不要再自造第二轮核验**（类目/轮播顺序/编码分布/详情逐张/预览逐张的额外扫描一律不做）——
> 见硬门禁 **0n**。要做「图对不对」这种深核验，只在用户明确要求时做，且最多一轮。

- fill：类目(cateId/满路径)→品牌→详情(等 expectTotal:50)→**attributes/required_attrs**→规格类型(ST_selectValueSingle)→滚动批量填价→参考价→预览
- **attributes 必传**：从 Excel 产品行读（材质/特点/风格/厚度/产地等），否则 `required_attributes_missing` 会中断，规格永远填不上。**fill 中断后续填**：记草稿 `id=&goods_id=` 完整 URL，属性/标题/主图补齐后再从规格继续；主图 0/10 时锁「商品主图|商品轮播图」区块再传一次（禁全页 first）
- **fill 收尾强制读回修复**：`enforceCriticalOnForm` 在 fill 末尾**写→读→重试最多3次**（标题/品牌/参考价/主图N/10）。标题或参考价仍不齐 → fill 返回 `title_readback_failed` / `ref_price_readback_failed`，**禁止当作 fill 成功再手写 continue**。
- **fillProductForm 不保证填主图/标题（旧说法已过时）**：收尾会强制补；读回仍以 `fill.steps` 的 `enforce_*` 与 `validateForm` 为准
- 图片路径：**直接传绝对路径**（`商品轮播图/`、`商品详情/`、`预览图/`），不要为了预检把图拷进 Excel 目录；`read_excel` 只扫 Excel 父目录+settings_root
- **file input 必须按区块锁定**（页面有轮播/包装标签/辅助/详情多个 input）：
  - 主图/轮播：取「商品主图|商品轮播图」区块内的 file input；**新版第一步（仅主图）才可用 `.first()`**
  - 详情：邻文本含 `0/50|快捷编辑` 的那个（常 idx=5），不是 first
  - **包装标签图没有就别传**；禁止把主图传进去（会 10/10 占满）
  - 同一组图对同一 input 只 `setInputFiles` 一次；重复灌 → 轮播 10 张含重复
  - 删缩略图用 `DeleteIcon_v2_delete` / `svg[data-testid=beast-core-icon-close]`；详情图在 `ImageWithRemark` 的 `actionItem`（hover 显示）
  - **上架/改图后逐区读回**：轮播张数与不重复、包装标签按需（无素材=0）、详情数、辅助图是否混入无关图（如白底人像）
- 规格类型是 **`ST_selectValueSingle` 下拉**，不是 `input[placeholder=规格类型1]`；手工拧必挂，走 `fillProductForm`/`ensureSpecTable`
- 滚动：`getScrollMeta` + sticky；一屏一次 evaluate 批量 setter，禁止逐格 Playwright fill
- 门禁 fail：打印 reason 立即停，不重试无关步骤
- allPass 前禁止提交；仅 `goods_add/success` 算成功
- **禁止对同一 CDP 页面并发跑多个脚本**（会互相踩掉 React 状态，表单清空/类目错乱）
- 提交序：先选「48小时发货及揽收」（或 Excel 承诺发货时间）→ `提交并上架` → 出低价/警告再点 `确认提交|确认低价创建`
- 页面「错误（N）」是表单必填项计数，**不是脚本错误**；N=0 才算表单齐
- 素材路径可能含特殊空白（WPS「共享文件夹 」Unicode 空格）→ 用 `Get-ChildItem -Recurse -Filter` 定位，禁止手拼路径
- 禁止写死 `.claude` 或单机 `D:/...` 路径。**逐步 UI / 选择器 / 手工兜底一律以 `references/playbook.md` 为准**（见「开工前必读」）；禁止凭记忆改选择器。

## 前置条件

| 条件 | 说明 |
|------|------|
| Chrome | 已安装；profile 已登录目标店 |
| Node + playwright-core | 经 `resolve_env.ps1` / `pdd_flow.js` 解析 |
| 素材包 | `商品信息.xlsx` + 图片；`read_excel.py` 输出 `ok === true` |
| 店铺已登录 | CDP 端口可探活 |
| config.json | skill 根目录；空字段=自动探测 |

**统一解析入口**（`$skillRoot` = 本 skill 根目录；换机器改此处，或用 `resolve_env` 的 `skill_root`）：

```powershell
$skillRoot = "<技能根目录>"
. "$skillRoot\scripts\resolve_env.ps1"
Show-PddEnv
```

详细优先级见 `references/env.md`。换机器只改 `config.json` 或设 `PDD_*` 环境变量。

## 店铺配置

**不要写死店铺**。每次执行向用户确认：

1. 有哪些店铺？（名称 + CDP 端口）
2. 素材包路径
3. 发到哪些店铺？（全部 / 指定几个）

```js
// 示例：用户说「鱼益9226、店铺B9227、店铺C9228，全发」
const shops = [
  { name: '鱼益', port: 9226 },
  { name: '店铺B', port: 9227 },
  { name: '店铺C', port: 9228 },
];
```

**探活**：`Invoke-WebRequest "http://127.0.0.1:{port}/json/version"`，不可达跳过并告知用户。逐店连接，不并发。

## Instructions

```
resolve_env → 读 playbook「标准填法」→ 读 Excel 预检(ok) → 逐店查重 → fill → validate → (allPass) submit → verify → 对照表
```

### Step 1. 读取素材包与预检

```powershell
. "$skillRoot\scripts\resolve_env.ps1"
$e = $script:PddEnv
& $e.python $e.read_excel "<xlsx路径>"
# exit 0=ok；exit 1=路径/解析硬错误；exit 2=预检未过，禁止连店
```

`read_excel.py` 动态识别表头与 SKU 维度（第2行表头 + 第3行 SKU 子表头，禁止写死列号），输出：

```json
{
  "sheet": "拼多多",
  "dimensions": ["颜色", "尺寸"],
  "product": { "name": "...", "title": "...", "brand": "...", "ref_price": 62.8, "category": "...", "main_images": [], "detail_images": [] },
  "skus": [ { "颜色": "...", "尺寸": "...", "stock": 1000, "group_price": 59.8, "single_price": 60.8, "code": "...", "preview": "..." } ],
  "sku_count": 5,
  "warnings": [],
  "blocking_warnings": [],
  "ok": true
}
```

**预检（先于连店铺）**：

| 检查项 | 通过条件 |
|--------|----------|
| `ok` | `true`（`blocking_warnings` 空且 `sku_count > 0`） |
| 标题 | 存在且 ≤60 字符 |
| SKU | 每行 stock / group_price / single_price / code / preview 非空 |
| 参考价 | 存在且 `ref_price > max(single_price)` |
| 图片 | 主图/预览图在 `asset_roots` 可找到 |
| **单图体积** | **每张 ≤3MB**（拼多多硬限制）；>2.5MB 建议先压。`build_product.py` 会对超限图 exit 6 |
| 编码 | 无重复、无空 |

`ok !== true` → **停**，不连店铺、不填表、不提交。非 blocking warning 列出请用户确认。

### Step 1.5 连接前查重（每店）

必须用编码集合指纹，禁止只搜标题：

```js
const flow = require(process.env.PDD_FLOW_JS);
const dup = await flow.checkDuplicate(page, title, skus);
// exact_duplicate | same_title_different_sku | not_found | search_failed
```

| 结果 | 动作 |
|------|------|
| `exact_duplicate` | `skipped_duplicate`，跳过 |
| `same_title_different_sku` | `skipped_same_title_diff_sku`，默认不覆盖 |
| `not_found` | 继续 |
| `search_failed` | **不能当无重复**；默认禁止自动提交，报告用户 |

不要先填表再查重。

**查重命中必问裂变**：exact_duplicate / same_title_different_sku 不得静默跳过 — 问用户「是否裂变一条新链接？」（裂变=只改标题+首图；或覆盖编辑；或放弃）。默认无答复则不裂变、不覆盖。

### Step 2. 连接店铺浏览器

```js
const flow = require(process.env.PDD_FLOW_JS);
const { browser, page } = await flow.connectShop(shop.port);
if (!page) { /* no_page */ }
// playwright 路径：flow.resolvePlaywrightCore() — 先 config/env，不写死单机路径
```

### Step 3–6. 填表（fillProductForm — 不提交）

覆盖：类主页新/旧形态 → 品牌/属性/详情图 → 规格类型与值（来自 `product.dimensions`）→ 虚拟滚动填价库存编码 → 参考价 → 预览图。

```js
const fill = await flow.fillProductForm(page, productData, {
  mainFiles, detailFiles,
  categoryText: productData.category, // Excel 或用户确认，勿写死
  brandName: productData.brand,
  colorToFile, // 或 previewByCode；ASCII 路径
  // attributes: { '材质': 'PVC', ... }  // 可选类目属性，来自 Excel/表单
});
// fill.submitted 恒为 false
```

**动态生成 SKU 匹配**（禁止写死「颜色正则」「宽\d+cm」等示例）：

```js
const dimNames = productData.dimensions;
const skuByKey = flow.buildSkuByKey(productData.skus, dimNames);
const rowFilter = flow.makeRowFilter(productData.skus.flatMap(s => dimNames.map(d => s[d])));
// rowspan 颜色：必须 sticky，禁止只用 makeMapRow
const sticky = flow.makeStickyMapRow(dimNames, skuByKey);
const mapRow = (text, inputs) => sticky.map(text, inputs);
```

**规格类型下拉**：点外层 `ST_selectValueSingle` 打开 → 点 portal `[role=option]`（文案可能含徽标如「尺寸常用」）→ **读回 input.value 必须等于目标名**。禁止用全页 exact 文本点选（会误点表头）。

**属性必填探测**：只认字段级「重要+字段名」+ 空「请选择」；忽略填写率/点击反馈等 chrome → `required_attributes_missing`（`strictRequiredAttributes=false` 可降级）。

**旧版类目树**：搜叶子 → 只点**完整路径 exact**；**已选分类**行含叶子才确认，否则 `category_readback_failed`。禁止点最后一个模糊匹配（会误选套装玩具）。

**类目硬规则**（续）：
- 先点「查看更多推荐」再选；按 Excel `category_id` 匹配 `data-tracking-params` 的 `choosen_cate=<id>`，或完整类目路径叶子
- 选后读回 `商品分类` 必须含目标叶子（如猫抓板）、不含误选叶子（如沙发）
- **读回失败即 `fill_failed`（category_pick_failed / category_readback_failed）**，禁止继续填表提交
- 每步后读回标题，防止 AI 建议条改短 → 不一致则 `title_readback_failed`

**上传确认**：`setInputFiles` 不算完成；只等目标计数器（详情 `expectTotal:50`，轮播 `10`），禁止 `every` 全页「已上传」。

**颜色 rowspan**：fill/validate/预览必须用 `makeStickyMapRow`（续行无颜色名）。

**查重前置**：`listProductSafe` 在 fill 前 `checkDuplicate`；`same_title_different_sku` 默认不覆盖，先改标题/首图再发。

执行时只按 references/playbook.md 的「标准填法（实战固化）」逐步做。

逐步 UI（新旧类目、规格输入、属性 pick、手工兜底 §A）→ `references/playbook.md`。

### Step 7. 校验（validateForm — 仍不提交）

```js
const validation = await flow.validateForm(page, productData);
// 内部：getScrollMeta + readAllSkuRows 全量 + 逐行 stock/price/code 对比 Excel
// checks[].status: 'pass' | 'fail' | 'unknown'
console.table(validation.checks);
if (!validation.allPass) {
  // validation_failed 或 validation_unknown — 禁止提交
}
```

校验项：errors、price_displayed、total_stock、sku_count、no_empty_stock、stock_match、price_match、codes_nonempty、codes_exact、**code_per_row（逐行编码归属）**、scroll_coverage、preview_images、packaging_label。

**code_per_row（必须看）**：`codes_exact` 只比**集合**（12 个码都在、数量平衡），**抓不到颜色/型号错配**——PE3→9228 曾出现「36 个码齐全但多数行写着同一个颜色」。`code_per_row` 逐行比对 `row.code === skuByKey[row.key].code`，任一不符即 fail。

**行数门禁（禁止用 `tbody tr.length`）**：SKU 表是**虚拟滚动**，DOM 里只挂可视行（常见 24≠36）。规格/编码/行数判定必须 `getScrollMeta` + `readAllSkuRows`（sticky rowspan 继承颜色/型号）。

**⚠️ `readAllSkuRows` 的 `mapRow` 必须返回维度级 `key`**：去重键是 `mapped.key || text.slice(0,80)`；续行只显示末维值、文本完全相同 → 不传 `key` 会把续行合并，**行数严重偏少**（PE2 实测 36 行读成 **17 行**，会误判「矩阵缺行」而清规格重填）。一律传 `makeStickyMapRow(dimNames, skuByKey)`，或自己 sticky 继承后拼 `型号|尺寸` 当 key。

**codes_exact**：集合双向覆盖 + 页面行数==SKU 数；**同码多档**（Excel 侧编码本身重复，如 `50cm连续木纹-白色-3米` 三档共用）自动放行页面重复。可用 `productData.allow_duplicate_codes=true` 或 `config.json.allow_duplicate_codes` 强制放行。编码格式用 `flow.applyCodeTemplate(skus, template)`，例：`50cm连续木纹-{color}-{length}`（config `code_template`），禁止在 flow 里写死商品名。

**首行库存陷阱**：fill 可能「成功」但第 1 行库存为空。必须逐行读回，直到 `总库存 = ΣExcel stock`。

### Step 8. 提交（仅 allPass）

```js
const sub = await flow.submitProduct(page, validation);
// 内部：再次断言 allPass；dismissOverlays；若「已选中的承诺发货时间现不可选」则重选 24/48 小时
// → 仅 goods_add/success 才 success=true（表单仍在 goods_add ≠ 成功）
// → { goodsId, success, url }
```

编辑页按钮可能是「提交」而非「提交并上架」。**提交无跳转第一检查：承诺发货时间警告。**

**提交后 `verifyListed`**：列表索引比 `goods_add/success` 慢几秒，内部默认 **重试 3 次 × 4s**（`verifyListed(page, id, { retries, delayMs })`）；仍 `not_found` 才报失败，不要只查一次就当没上架。

### Step 9. 多店铺批量（幂等状态机）

**禁止** `listProduct(含提交)` 之后再 `validateForm`。正确顺序：

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
    // 内部严格：duplicate → fill → validate → submit
    Object.assign(row, { goodsId: r.goodsId ?? null, status: r.status, checks: r.checks, error: r.error });
  } catch (e) {
    row.status = 'error';
    row.error = e.message;
  } finally {
    await flow.disconnectPage(browser);
  }
  results.push(row);
}

console.table(results.map(r => ({
  shop: r.shop, port: r.port, goodsId: r.goodsId, status: r.status,
  failed: r.checks ? r.checks.filter(c => c.status !== 'pass').map(c => c.name).join(',') : (r.error || ''),
})));
```

单店失败不阻断其它店；最终回复必须展示对照表。

### Step 10. 提交后状态验证

```js
const st = await flow.verifyListed(page, goodsId);
// on_sale | auditing | rejected | off_shelf | draft | not_found | unknown
```

| status | 下一步 |
|--------|--------|
| `on_sale` | 成功，报告 goods_id |
| `auditing` | 成功待过审 |
| `rejected` | 展示 rejectReason，改素材/运费后重提 |
| `not_found` | 查 goods_id / 店铺 |

常见驳回：图含「顺丰」但运费模板未勾选顺丰包邮 → 换图或改模板后重提。

## 状态字典

| status | 含义 |
|--------|------|
| `skipped_duplicate` | 标题+编码精确重复 |
| `skipped_same_title_diff_sku` | 同标题不同 SKU |
| `search_failed` | 查重失败，非「无重复」 |
| `fill_failed` | 填表未完成（category_pick / category_readback / title / detail_upload / required_attrs 等） |
| `validation_failed` | 校验 fail，禁止提交 |
| `validation_unknown` | 校验 unknown，禁止提交 |
| `submitted` | 已提交 |
| `submit_error` / `error` | 失败 |

## 脚本与手册

| 文件 | 用途 |
|------|------|
| `config.json` | 路径/端口/profile（覆盖优先） |
| `scripts/resolve_env.ps1` | **唯一**路径解析入口 |
| `scripts/read_excel.py` | 解析 + 严格预检（`ok` 含 sku_count>0） |
| `scripts/open_browser.ps1` | CDP Chrome；复用 profile；已有 CDP 不新开 |
| `scripts/pdd_flow.js` | fill / validate / submit / duplicate / verify 状态机 |
| `scripts/test_pdd_flow.js` | 纯函数单测：`node scripts/test_pdd_flow.js` |
| `references/playbook.md` | 逐步点击、选择器、手工兜底 §A |
| `references/env.md` | 路径优先级与状态机约定 |

## Troubleshooting

| 现象 | 处理 |
|------|------|
| CDP 不可达 | 查 Chrome 进程；确认该店已登录 |
| 路径找不到 | 只改 `config.json` 或 `PDD_*`；跑 `Show-PddEnv` |
| 规格表只有部分行 | `readAllSkuRows` 动态 scrollHeight（禁止写死 3200/5200）；**行数远少于笛卡尔积先查 `mapRow` 有没有返回维度 `key`**（无 key 会把续行去重，PE2: 36→17） |
| fill 后值丢失 | Playwright `fill`；批量用 setter+input/change |
| 校验报 unknown | 修选择器/等待 UI，**禁止提交** |
| 查重 search_failed | 人工确认列表页；勿当无重复 |
| 编码对不上 | `codes_exact` fail → 按 Excel 重填 last「请输入」 |
| 参考价失败 | 预检应拦；`ref_price > max(single_price)` |
| 详情图传到主图 | 按 file input 邻近文本「快捷编辑/0/50」定位 |
| 主图传到包装标签图 / 轮播重复 10 张 | 多 file input 禁用全页 `.first()`；按「商品主图\|商品轮播图」区块锁定；一组图只传一次；包装标签无素材则留空 |
| 辅助图混入无关图（白底人像等） | 上架后逐区读回；不像本品就删（`DeleteIcon_v2_delete`） |
| 「错误（N）」以为是脚本挂了 | 是 PDD 表单必填项计数；补必填直到 N=0 |
| 素材路径手拼找不到 | WPS 路径含 Unicode 空格；`Get-ChildItem -Recurse -Filter` 定位 |
| 预览图 setInputFiles 超时 | 素材库态无 file input；跳过 |
| 预览图路径含中文/空格 | 复制到 ASCII 路径再传 |
| **上传图片大小不能超过 3MB**（平台弹窗） | 单图 >3MB 被拒。先压图：Pillow `resize((800,800))` + `PNG optimize`（目标 <2.5MB），JPEG q88 兜底。`build_product.py` 预检会拦；若已连店，只补缺图时用压缩后的 work 副本路径重传 |
| **详情图计数器 > 实际张数**（如 9/50 但只 8 张）→ `detail_images` fail | 计数器虚高（本轮实测）。用 `img[src]` 数 `[class*=ImageWithRemark_v2_imageContainer]` 的真实数量；删残留**必须在区内仍有图时做**，清到 0 会被平台拦「删除失败！商详装修图片不能为空」。救不动就重跑 `run_listing.js` 出新草稿 |
| `python scripts/read_excel.py` 报 `No module named 'openpyxl'` | PATH 上的 python 不对；用装了 openpyxl 的解释器（本机 `…\Programs\Python\Python311\python.exe`），或写进 `config.json.python` |
| 侦察/读回后表单字段错乱、计数虚高 | 你的只读脚本用了 `connectShop` 拿页再 `goto`，把已填的 `goods_add` 页导航走了。读回一律当前页原地 evaluate；要开新页用 `contexts()[0].newPage()` |
| 类目点选无效 / 预测成沙发 | 「查看更多推荐」→ `choosen_cate=<Excel category_id>`；读回类目叶子 |
| 类目后标题被 AI 改短 | 读回标题 input，重新 fill Excel 标题 |
| SKU/预览图只填每色 1 行 | 颜色 rowspan → 用 `makeStickyMapRow` 继承 |
| 规格表 scrollHeight 只有 ~800 | `getScrollMeta` 找 tbody 上 clientHeight>200 的真滚动层（常 depth≈3） |
| 预览图无 file input | 行内「本地上传」+ `filechooser`（仅**无** input 的素材库态）；有 input 一律直接 setInputFiles |
| 点「本地上传」报 `element is outside of the viewport` | 该按钮在 sticky + 虚拟滚动下不可点 → 改传**同格隐藏 `input[type=file]`**（playbook §6.1）；传完逐行读回 `imageWrapper`，替换/补图后跑 §6.2 像素比对 |
| 提交无跳转 | 查「已选中的承诺发货时间现不可选」→ 重选 24/48；`submitProduct` 已处理 |
| success 误判 | 仅 `goods_add/success` 算成功；表单仍有 `goods_id=` 不算 |
| 提交后驳回 | `verifyListed` 读 rejectReason |
| 同标题商品 | 查重状态机，不盲目覆盖 |
| 某店失败 | 其它店继续；results 全量报告 |
| 已审核不能改规格 | 「商品编辑通过状态，不能更新商品」→ 只能重新上架 |
| 规格 t2 漏填 / t1 被清空 | t2 必须填齐（如 `60x300cm`）；添加 t2 后重填 t1 并读回 |
| 「地址不对，请重新输入」+ 类目一直「加载中…」 | 草稿 URL 缺 `id=`；用完整 `goods_add/index?type=add&from=category&id=<commitId>&goods_id=<id>` |
| 确认后表头类目变猫抓板/沙发 | 读回**表头** `商品分类`（不是选中页「已选分类」）；最近使用里的猫抓板会抢点，exact 全路径后再确认 |
| 规格值有、SKU 少一行（如 5 色只出 4 行） | 末位规格值未提交：清空重填 + Enter/Tab 逼出新行，再填价库存编码 |
| `tr.evaluate` 报 `tr is not defined` | 回调写 `(el, args) => el.querySelector…`，外层变量名不进浏览器 |
| 标题报「最多填写30个汉字」 | 汉字=2 字符；Excel 标题 31 字会挡提交。去冗余词到 ≤30 汉字再提交，并告知用户 |
| 属性下拉无目标项（如「防撞」） | 选最近可选项（防水等），读回值；不必卡死 |

## 边界

- 不处理：改价、库存调整、下架、活动报名、客服、订单
- **改【已在售】链接的规格类型/值映射（「型号」「尺寸」装反）→ 用 `pdd-fix-listing-specs` skill**（对调 + 整表回填 + 双向校验的完整流程；本 skill 只提供 §5.9/§5.10/§6 这些共用机制）
- 不代登录；不绕过验证码
- 非拼多多平台不要用本 skill
- 用户明确说「我来改」时，只整理经验/更新 skill，不操作后台

## Examples

- 用户：「帮我把这个素材包发到店铺B和店铺C」  
  → 确认端口与路径 → `read_excel` 预检 `ok` → 逐店 `listProductSafe` → 输出对照表。

- 用户：「素材包预检过了，但有一店校验 unknown」  
  → **禁止提交**；打印 `checks`；修 UI/选择器后重跑 `validateForm`，不绕过。

- 用户：「某店已有同标题商品」  
  → `checkDuplicate` → `skipped_duplicate` 或 `skipped_same_title_diff_sku`，默认不覆盖。

## 维护

> 本节编号（10–13）是旧文档遗留的交叉引用编号，**不是执行顺序**；
> 真正的硬门禁在本文「Important」与「★ 2026-10-05 实测新增」两节，逐步 UI 在 `references/playbook.md`。
> 历史实战数据与逐步 UI 沉淀见 `references/playbook.md`（§10 历史表、§A 手工兜底）。本 skill 由 `.claude` 与 mimocode 两版整合；`.claude` 目录仅归档，新任务只走本路径。

10. ★★ **属性取值必须「分层告警」**：数据包的值**可能不在该类目下拉里**（PE6@9226 实测：
    数据包「欧式」「衣柜/橱柜」选项里都没有，朴素实现会**静默退成「中式」「卧室」**，
    而日志里和精确命中一样显示 OK → 用户拿到「看起来按数据包填、其实被换掉」的属性）。
    用 `flow.applyAttributesByCandidates(page, { 属性: [数据包原值, ...备选] })`，
    它返回 `needReview`（`how` = `fallback`/`fuzzy`/`unmatched` 的项）——
    **只有 `how === 'datapack'` 才免复核，其余必须在交付时原样列给用户确认**。
    ⚠️ 不要只报「属性 N 项已填」，那是假完成。
11. ★★ **改 `pdd_flow.js` 的三条铁律**（2026-09-29 我曾误删 35KB 代码）：
    **动手前先备份**、**切片/`replace` 前断言 `start < end`**、**抠函数体先跳过参数表括号**（参数里可有对象解构）。
    恢复后必须 `node --check` + `require` + 导出逐个 `typeof` 点名，并**同时扫顶层 `const`**（我漏过 `ZONE_KEYS`）。
    事故还原与完整审计清单见 `references/ops-notes.md`。

12. ★★ **上架前必问：规格类型名与维度结构怎么定**（2026-09-29 用户明确）。
    **规格类型名（如 `型号/尺寸`、`款式/属性`、`颜色/尺寸`）和「哪个维度装颜色档位、哪个装长度」
    都不是固定的，每条链接要单独定** —— 不要默认沿用上一批，也不要默认照抄数据包。
    开工前用一句话问用户，给三个选项：
    - **A 照数据包**（如 `款式/属性`）
    - **B 用户另有想法**（他会给类型名和维度分配）
    - **C 我给建议**（通常推荐 `型号`=颜色档位、`尺寸`=长度，理由是 PE2/PE3/PE4/PE5/PE6 实测的稳定形态）
    拿到答复再写进 `listing.json` 的 `dimensions` 与 `v0/v1`。
    ⚠️ 这跟第 15 条「取值按数据包」不冲突：**15 条管的是值的内容**（标题/属性/规格值措辞），
    **本条管的是结构**（类型名 + 维度分配）。两者都要在开工前确认。
13. ★ **新版流程提速**（实测 399.8s → 286.0s）：
    传图后**不等上传立刻填标题**；规格填写**空槽位跳过清空 + `insertText` + Tab 后 400ms**；
    逐行循环**禁用 `innerText` 用 `textContent`**（强制重排，一次全表扫描约 900 行次调用）；
    上传计数器**有两套文案**（`已上传N/M张` 与 `上传图片 (N/M)`），`waitForUploads` 必须都认 + 缩略图兜底。
    逐阶段实测表见 `references/ops-notes.md`。预览图现占总时约 50%，暂不动。

