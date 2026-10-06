# 交接说明（pdd-product-listing）

> 给接手的使用者 / agent。**SKILL.md 是规则本体，这份文档是「本轮改了什么、哪些还没验、你那批怎么跑」。**
> 最后更新 2026-09-30。
> **注意**：用户验收轮（72 行 / 两维 / 猫抓板）又落了 6 处改动并做了端到端复验，见 **§七**。
> §二 是验收轮之前的修复清单；§七 之后的结论更新了 §六 的遗留状态与 §三 的验证结论。

---

## 一、装好三步

1. **放对目录**：把整个 `pdd-product-listing/` 放进 agent 会扫描的技能根。
   - **DeepSeek Harness（DSH）→ `~/.agents/skills/`**（2026-10-05 实测：本机 DSH 扫这里；
     `~/.config/mimocode/skills/` 与 `~/.claude/skills/` 都不扫）。
   - MiMo Desktop → `~/.config/mimocode/skills/`（本目录）。
   - **现状**：本 skill 只在 `~/.config/mimocode/skills/`，所以 **DSH 会话里发现不到它** ——
     要在 DSH 用就 `Copy-Item` 一份到 `~/.agents/skills/pdd-product-listing` 并新开会话。
2. **装运行时**：Node.js + `playwright-core`、Python 3、Chrome 开远程调试端口、**已登录的拼多多商家后台**
   （本流程不代登录）。缺件时报错会指向 `references/env.md`。
3. **每次给两样输入**：素材目录 + 一份 `listing.json`（照 `scripts/listing.example.json` 写）。

```bash
python scripts/build_product.py --listing listing.json --assets "<素材目录>" --out ./work
PDD_PRODUCT=./work/product.json PDD_PORT=9228 PDD_CATEGORY="家居饰品 > 贴饰 > 墙贴" node scripts/run_listing.js
```

**全程不提交**——跑完自己检查，再在后台点提交。

---

## 二、本轮修复清单（按审计项）

| 审计项 | 修法 | 验证方式 |
|---|---|---|
| ① `searchCategory` 整条全等、平台下拉不带顶级前缀 | 改为**按 `>` 分段的「后缀匹配」**，轮询/点击/读回三处同判据；新增 `pathSuffixMatch` | 单元测试 5 例（含 `家居生活 > 宠物… > 猫抓板` 去前缀、`背景墙贴` 陷阱不误命中） |
| ② 扫描结果 24/72 | **真根因是 `dimToken` 折叠**（12 个尺寸值共享 `30cm` 前缀 → 塌成 4 个 token → 6×4=24），不是滚动。唯一性保护：全值匹配优先，短标识**仅在本维度内唯一**时才兜底 | **真实 72 行表实测 `scanSkuKeys` = 72/72（5.9s）** ✅ |
| ③ `build_product.py` 对真实素材包不可用 | 目录名可配 + **关键字自适应**（`01_主图` 与 `商品轮播图` 两套命名都认）、扩展名补 `.webp`、SKU 映射不再写死 `.png`、**新增 `rows` 直通模式**（绕开维度结构假设） | 用 PE6 素材实跑通过（向后兼容） |
| ④ `read_excel` 图片预检是 blocking，与 playbook 冲突 | `no_main_images` / `no_detail_images` 移出阻塞清单，`preview_missing:` / `main_image_missing:` 降为非阻塞 | 语法 + 逻辑核对（图片路径不该参与 `ok` 判定） |
| ⑤⑥⑦ 静默判过（检测不到就 `pass`） | `validateForm` 的 `preview_images` / `packaging_label` 兜底改 **`unknown`**；`waitForUploads` 返回 `how` 标明判据来源，**缩略图兜底单标 `thumbnail_fallback`**（它不分区，判据偏弱） | 语法 + 回归 |
| ⑩ 是否代提交自相矛盾 | SKILL.md 写明：**本流程只填空与校验，绝不点提交**；`submitProduct` / `listProductSafe` 仅供人工显式调用 | 校验器 PASS |
| ⑪–⑰ 八条文档矛盾 | 加**权威更正块**（SKILL.md 内「文档现状与已知矛盾 · 以本节为准」）：代提交 / 素材目录两套命名 / 店铺端口 / 步数 / `fillProductForm` 定位 / 新旧版判定 / `mapRow` / 标题长度 | 校验器 PASS |
| ⑱⑲⑳ 硬编码路径与坏引用 | 清掉 SKILL 与 playbook 里的机器绝对路径、移除对不存在脚本的引用；`config.json` 加 **`shops`**（端口与页形态） | 残留检查 0 处 |
| ㉑ 门禁编号跳号 | 重排为 **0–13**，无跳号、无悬空交叉引用 | 正则核对 |
| ㉒ `pickAttr` 不返回可选项（指令不可执行） | 新增 `readDropdownOptions`；`pickAttr` 失败返回 `{reason:'value_not_in_options', options:[…]}`；**`run_listing.js` 会把这些可选项打印出来** | 语法 + 回归 |
| ㉓ 缺规模上限说明 | SKILL.md 加**规模与耗时表**：36 行 ≈ 4.8–6.1 分钟；**72 行 ≈ 8–10 分钟**，提示放宽超时或拆段 | 实测数据 |
| ㉖ `code_tpl` / `code_template` 字段名不统一 | builder 两个名字都认 | 语法 |
| ㉗ `listing.example.json` 缺 `category` | 已补 | JSON 解析通过 |

---

## 三、待你复验的三件事（我做不了，缺你的 fixture）

1. **端到端跑一遍你那批（最重要）**：`build_product.py` → `run_listing.js`，看 10 步是否全通、
   `validateForm` 是否 `allPass`。我这边的验证仍是 36 行的商品形态，**你的 72 行 / 两维 / 不同目录命名是真正的验收场景**。
   > 我这一轮反复踩过「拿一种形态当通用证据」的坑，所以这条不敢替你下结论。
2. **`pickAttr` 的可选项回报**：跑一次看日志里是否出现 `可选项 材质 = [...]`。若下拉里确实没有数据包的值，
   你应该能从这行直接看到「能填什么」，而不是只知道失败。
3. **`countPreviewCells` 正向核验**：`run_listing.js` 第 ⑧b 步会打印 `{total, withImg, missing}`。
   确认它数与你的行数一致（36 或 72）。

---

## 四、跑你那批（两维 / 72 行）怎么写 listing.json

用 **`rows` 直通模式**，完全绕开「档位×色×长度」的维度假设：

```json
{
  "category": "宠物/宠物食品及用品 > 猫/狗玩具 > 猫抓板",
  "title": "…（≤30 汉字）",
  "brand": "祺讯",
  "ref_price": 199,
  "dirs": { "main": "商品轮播图", "detail": "商品详情", "sku": "预览图" },
  "dimensions": ["款式", "尺寸"],
  "v0": ["米白", "卡其色", "浅灰", "…"],
  "v1": ["30cm*1米", "30cm*3米", "30cm*5米", "…"],
  "rows": [
    { "i0": 0, "i1": 0, "stock": 500, "group_price": 19.9, "single_price": 27.9,
      "code": "MZB-006-米白-30cm1米", "preview": "D:/图片/…/预览图/xxx.jpg" }
  ]
}
```

要点：

- **`category` 可以只写后半段**（如 `宠物/宠物食品及用品 > 猫/狗玩具 > 猫抓板`）——
  平台下拉不带顶级前缀，后缀匹配已支持；带顶级前缀写全也能匹配。
- `rows` 里 `preview` 可给绝对路径（ASCII 路径更稳）；不给则回落到按 `tier`/`color` 从 SKU 图目录映射。
- **参考价必须 > 最大单买价**（数据包作者常写成相等，会被平台拦；`read_excel` 与 `validateListingPayload` 都会报）。
- 规格值有硬限制：**≤40 字**、只允许 中英文/数字/空格 + `# : % ( ) ' + - * / .` + `（）【】`。
  **排版符号 `×` 非法**，会导致「数据错误，请刷新页面」且矩阵建成 **0 行**。`build_product.py` 会预检。

---

## 五、改代码前必读

1. **先备份**：`cp scripts/pdd_flow.js _backup/pdd_flow.js.<时间戳>.bak`。
2. **字符串切片/`replace` 打补丁前断言 `start < end`**——顺序反了会连带删掉中间所有代码（我曾因此删掉 35KB、20 个函数）。
3. **抠函数体先跳过参数表的括号**——JS 参数里可有对象解构（`{ max = 60 }`），从那儿配对会截断。
4. 改完跑：`node --check` → `node scripts/test_pdd_flow.js` → 导出逐个 `typeof === 'function'` 点名。
   ⚠️ 顶层 `const` 也可能被删（我漏过 `ZONE_KEYS`），审计要**同时扫顶层常量**。

---

## 六、已知遗留

> **状态已由 §七 更新**。下列为「仍未修」的项。

- **品牌这一步不可靠**：`enforceCriticalOnForm.forceBrand` 的判据是搜索框 `value`，且只写文字不点候选项，
  两个方向都不成立；实测 4 条草稿里 **2 条**自动流程没选上。`validateForm` 的 `brand` 检查能抓到（判 `fail`）。
- **`main_images` 仍靠 `thumbnail_fallback`**（全页缩略图计数、不分区）：等轮播 10 张时，
  详情区已有缩略图就能让它通过。事后计数器正确，但当时那一步没证明任何事。
- **`read_excel` 的 `ref_price` 仍阻塞**：数据包常把参考价写成等于最大单买价（平台要求必须大于），
  会让 `ok=false`。**这是数据问题，不是脚本问题** —— 开工前先抬参考价。
- **`scanSkuKeys` 无「窗口真的推进了」断言**：`document.querySelectorAll('tbody tr').length;`
  那行是丢弃返回值的空操作。目前靠消费方把 `count` 与期望值比对来兜底。
- `pickAttrByCandidates` 的 `open_failed` 早退分支没带 `options` 字段（它的 fuzzy 路径已有）——不影响使用。
  注意：该分支也会在**标签本身不存在于该类目表单**时触发，此时报的是「找不到该属性的下拉控件」。
- 文档历史遗留：`playbook.md` 里仍有较早期的手工流程描述（15 步 vs 现在 `run_listing.js` 的 10 步），
  **以 SKILL.md 的「文档现状与已知矛盾」一节为准**。
- `_backup/` 里是历史回滚副本，**可直接忽略**。

---

## 七、2026-09-30 用户验收轮：改动与复验（72 行 / 两维 / 猫抓板）

**fixture**：MZB-006，款式 6 × 尺寸 12 = **72 SKU**，类目 猫抓板（cateId 16435），
素材目录 商品轮播图 / 商品详情 / 预览图（与 §四 示例一致），店铺「店铺C」9228。**全程未提交。**

这一轮用真实数据把 §三 的三项验证跑完，并额外修了 6 处。

### 7.1 本轮改动（均已备份在 _backup/）

| # | 文件 | 改动 | 为什么 |
|---|---|---|---|
| 1 | pdd_flow.js scanSkuKeys | 第二维改「全值精确匹配优先；短标识兜底仅在其**在本维度内唯一**时才用」 | 原 \|\| text.includes(T1[i]) 把共享前缀的值折叠：12 个尺寸共享 30cm 前缀 → 塌成 4 个 → 数得 **24/72** → 触发 repairSpecMatrix **删掉本来正确的尺寸值** |
| 2 | pdd_flow.js fillSkuRowsAndVerify | 同上 | **写入路径**上的同一 bug：会把 30cm*3米 行的价格/编码写成 30cm*1米 的 |
| 3 | run_listing.js run() | 同上 | 同上（读回与 fill） |
| 4 | pdd_flow.js uploadMissingPreviews | **倒序**：先用同格隐藏 input[type=file]，仅当该格无 input 才退回「本地上传」按钮 | 该按钮在 sticky + 虚拟滚动下**位于视口外**，Playwright 每行等满 2500ms 才抛错（trial:true 实测 2515ms/行）→ 72 行白等约 180s |
| 5 | pdd_flow.js uploadMissingPreviews | pass 循环加 touchedThisPass === attempted 早退；每行固定 waitForTimeout(300) 改「轮询本行缩略图出现」 | 原固定 3 遍，传完后空扫两遍；固定睡眠 72×300ms = 21.6s 死等 |
| 6 | pdd_flow.js readAllSkuRows + validateForm | 同一次 evaluate 里**顺带**取「本行有无预览图」(hasImg)，preview_images 直接复用；删掉 countPreviewCells 那一遍独立扫描 | 省一整遍全表扫描（实测 4.3s/遍） |
| 7 | pdd_flow.js validateForm | preview_images 改正向逐行判据（数得全给 pass/fail，数不全才 unknown）；**新增 brand 检查**；ADVISORY_UNKNOWN 让 preview_images/packaging_label 的 unknown 保留状态但**不进 allPass 否决项** | 原兜底改 unknown 后 allPass **恒为 false**（实测：72/72 行预览图齐全的链接也永远通不过）；品牌此前**没有检查**，缺失会静默溜过 |
| 8 | build_product.py | 新增 _resolve()：dirs 的值按**相对 --assets** 解析、支持绝对路径、目录不存在则告警回落；copy_ascii 加缺失目录守卫 | §四 文档示例的 dirs 写法（"main": "商品轮播图"）会让 builder 直接 FileNotFoundError |
| 9 | pdd_flow.js | module.exports 补 countPreviewCells、readDropdownOptions | 两者都有定义但没导出 → run_listing 的 ⑧b 打印「技能内无 countPreviewCells，跳过」，空转 |
| 10 | run_listing.js | **新增 ⓪ 查重**（门禁第 3 步）；命中不静默跳过，PDD_SKIP_DUP=1 才跳过 | 正式入口此前**完全没有查重** |
| 11 | read_excel.py | 标题判据由 len() > 60 改为「**汉字数 > 30**」（保持非阻塞） | 原判据下 30 汉字的标题（len=30）永远报不出；与门禁「≤30 汉字」口径不一致 |

### 7.2 §三 三项验证结论（全部通过）

1. **端到端** ✅ build_product.py → run_listing.js 十步全通，**allPass: true（15/15）**。
   关键两行：⑥ 规格表 matrix = {ok:true, expected:72, count:72, rounds:1, bad:[], log:[]}（**无删值**）、
   ⑦ 填值 = {covered:72, ok:72, bad:[], stockSum:720000 = expected}（**无错值**）。
2. **pickAttr 可选项回报** ✅ 但**必须用该类目表单上真实存在的标签**测。
   这个类目只有 品牌 / 包装方式 / 商品资质，**没有 材质 / 特点 / 风格**，用后者测会落到
   open_failed 分支（报「找不到该属性的下拉控件」，且该分支不带 options）。
   用真实标签实测：pickAttr('包装方式','<不存在>') → {reason:'value_not_in_options', options:[10 个]}。
3. **countPreviewCells 正向核验** ✅ 实跑 ⑧b 打印 {"total":72,"withImg":72,"missing":0}。

### 7.3 性能（实测，非估算）

| 阶段 | 优化前 | 优化后 |
|---|---|---|
| ⑧ 预览图 72 张 | 271.1s | **78.8s** |
| 全部 10 步 | 约 9 分钟 | **274.8s（约 4.6 分钟）** |

全表扫描次数 **8 遍 → 6 遍**（约 36s → 约 28s）。

**慢在哪（逐项归因，实测）**：

| 阶段 | 耗时 | 根因 |
|---|---|---|
| ⑦ 填值 | ~102s | **288 次独立写值**（4 字段 × 72 行）× 约 100~220ms。单次写值本身不慢（DOM 只 1 次 mutation），慢在乘法 |
| ⑧ 预览图 | ~79s | 1.09s/行：逐行 setInputFiles + 等本行缩略图。对照：详情图 34 张**一次批量**只要 12.3s（0.36s/张） |
| 其余 | ~93s | ⑥ 25s / ② 22s / ⑩ 17s / ④ 12s / ⑧b 7s |

**结论：进一步提速只能减少「变值写入次数」或「预览图逐行往返次数」，都是换实现方式，不是调参。**
平台自带一条更快的路 —— SKU 工具条的「**Excel批量编辑规格**」（弹窗：导出当前 72 行 → 改 → 导入，
支持 xls/xlsx、最多 500 行）。**这一轮没有采用**（评估中），记录下来供后续决策。

### 7.4 两个踩过的机制坑（下次直接用）

1. **beast-core 模态框只能靠这个 testid 关**：svg[data-testid="beast-core-modal-icon-close"]。
   **Esc 与点遮罩都无效**，在 class 里找 close 也找不到（图标 class 是 MDL_headerClose，不含 close 关键字）。
2. **SKU 行的 file input 一直是可用的**：空预览格内 input[type=file] 的
   accept="image/jpeg,image/png"、offsetParent=true。**别去点「本地上传」按钮**（视口外，白等 2.5s/行）。

---

## 八、2026-09-30 ZDT-003 补丁（自粘地毯 · 店铺A9226）

> 草稿 goods_id=**1011453989574**（id=202481266215），validateForm allPass，**未提交**。
> 裂变：同标题已有 1006083375131 → 标题加「款」+ 首图反转。

| 项 | 改动 | 位置 |
|---|---|---|
| **单图 ≤3MB 硬限制** | 拼多多文案「上传图片大小不能超过 3MB」。实测 24 张 1024² PNG=3164952 字节全被拒。`build_product.py` 的 `copy_ascii` 新增 `_check_img_size`：超限 **exit 6**，>2.5MB 警告。压图配方：800×800 PNG optimize（约 400–750KB） | SKILL.md 门禁 0c2 / 预检表 / Troubleshooting；playbook §6、标准填法 step 3、踩坑表；`build_product.py` |
| **预览图取图优先级** | `uploadMissingPreviews` / `enforceCritical` 原先 byDim first-wins，对「同色不同尺码配图不同」会静默传错图。改为本行 `sku.preview` / `previewByCode` 优先，维度值映射只兜底 | `pdd_flow.js`（备份 `pdd_flow.20260930-155730.bak`） |
| **CDP 握手挂起** | Chrome 154 上 `connectOverCDP` 停在 ws connected → 根因是商家后台有 **CDP 无响应标签页**（`sycm/goods_effect`），Playwright 等所有页初始化。用 `Target.getTargets` + 逐页 `Runtime.evaluate` 探活后关掉 hung 页即可。注意 `/json/list` 的 `id` ≠ `Target.getTargets` 的 `targetId` | playbook 踩坑表；notes 已记 |

**接手注意**：素材包原图仍是 3.02MB，只压了 work 目录副本；下次上架前先跑 `build_product.py`（会自动拦超限图）。

---

## 九、2026-09-30 GPVC-001 复发坑（店铺C9228）

> 草稿 goods_id=**1011460754327**（id=202483324966），validateForm allPass，**未提交**。
> 裂变：已有 1002128349521 同标题 → 标题加「新款」+ 去空格 + 首图反转。

| 项 | 教训 |
|---|---|
| **禁止对已填表单 `goto` 读回** | 填完后用草稿 URL 刷新读回 → 详情 8→0、预览 16→0、品牌/参考价被清、规格表被重置。**读回只许当前页原地 evaluate**。已写进 SKILL 0d |
| **厚度是直填输入，不是下拉** | 表单「重要 > 厚度」= `input[placeholder=请输入]`，label 带 ` mm`。`applyAttributesByCandidates` 按下拉匹配会 `unmatched`。`run_listing.js` 已改为：数字类属性从 ATTRS 拆出后 **direct_input 写值**；「中层厚度」若是请选择下拉且数据包没有就留空 |
| 图片体积 | 本批全部 <0.5MB，无 3MB 问题 |

**接手注意**：若表单又被误刷新，按「原地补填」顺序：品牌 → 详情图（只补缺）→ 厚度直填 → 属性下拉 → ensureSpecTable → fillSku → 预览 → 参考价 → validateForm；**不要 goto**。
### 9.1 GPVC-001 整条重跑后补丁（同日）

- 新草稿 goods_id=**1011464190438**（id=202484199972），查重 not_found，validateForm **allPass**，**未提交**。
- 厚度直填生效：thickness=4 via direct_input。
- **详情图陷阱**：uploadZoneFast 曾报 counter_uploaded=8，稍后读回 0/50。已原地重传到 8/50。
- **validateForm 新增 detail_images**：读「快捷编辑 已上传N/50」与 payload detailCount 比对；unknown 不进 allPass 否决项。build_product.py 会写 product.detailCount。
- 排错：上传后必须再读一次详情区计数，不能只信 upload 的确认字段。

### 9.2 详情图容器定位 + 校验前补传（同日·最终）

- 新草稿 goods_id=**1011472364575**（id=202487018655），validateForm **allPass**（detail_images 8=8），**未提交**。
- **根因**：新页刚加载时详情 input 未稳定，全局 nth(idx) 会锁错；规格/SKU 阶段可能重渲染冲掉未落库的图。
- **修法**：
  1. `locateZoneFileHandle`：在「快捷编辑 + 已上传N/50」**容器内**找 file input（不靠全局下标）；
  2. 详情上传后 **2.5s 再读一次**分区计数器，不稳则 `detail_unstable_after_upload`；
  3. `run_listing` **⑨b**：校验前复核详情区，不足则容器定位补传；
  4. 详情区**禁止** zone_thumbnails 全页缩略图兜底。
- 整条实测：④ 首次锁错并如实失败 → ⑨b 补传 idx=6 → ⑩ allPass。


---

## 十一、2026-10-05 MZB-003 两店上架（店铺C9228 + 店铺A9226 · 各 72 SKU）

> 店铺C草稿 `1012864855034`（224.4s）、店铺A草稿 `1013044536839`（230.9s），**两店 allPass、错误（0）**，未提交。
> 两店原有同标题链接（店铺A `1006030110896`、店铺C `1008345583767`，均为 MZB-001 那批）→ 各自裂变。

### 11.1 本轮修掉的真 bug：旧版页点到 AI 按钮（店铺A首跑整条报废）

| 项 | 内容 |
|---|---|
| 症状 | `⑥ 规格表 ok:false / count:0`（两维全 missing），页面浮出「智能生成工具」模态框，`规格类型1`/「请输入规格名称」此后不再渲染 |
| 用户线索 | 抓到被点的元素：`<button data-tracking-viewid="el_entry_button" …><span>AI素材工具</span>…` |
| 根因 | `添加规格类型(0/2)` 旁边有 **`AI添加规格` / `AI素材工具`**；旧实现 `locator('button',{hasText:'添加规格类型'})`（子串）+ `span` 兜底把 AI 按钮算进去 |
| 修法 | `clickAddSpecType`：文本必须 `/^添加规格类型/` 且排除 `/AI|智能生成/`（locator 的 `hasNotText` + evaluate 双保险） |
| 验证 | 修复后店铺A重跑：⑥ **29s、1 轮、72/72**，无弹窗 |
| 附带 | 那个模态框 **Esc / 知道了 / testid 关闭全无效** → 只能重开页面；别在坏稿上救 |

### 11.2 本轮其他环境问题
- 店铺A 9226 出现 **`cdp_handshake_failed`（120s 超时）**：`/json/list` 正常、8 个标签在，
  但有个 `sycm/goods_effect` 页无响应（handoff §8 的老坑）。处理：**只重启该店 Chrome**
  （`User Data` 仍为 `chrome_pdd_account1`），2s 内 CDP 就绪、页面 1 个 → 重跑成功。
- 数据问题：MZB-003 的「★ 商品参考价」列**空**（用户确认用 99.9，> 最大单买价 93）；
  「★ 商品轮播图」列也空，但素材目录里有 7 张 → 直接用目录内容。
  标题 30 汉字顶格，裂变时**先删冗余词再加后缀**（店铺C：「保护」→「升级」；店铺A：「保护/多功能」→「升级加宽」）。

### 11.3 收尾修正：`main_images` 校验「没生效」的真因（2026-10-05 二次定位）
- 现象：`run_listing.js` 的 ⑩ 校验表里**没有 `main_images` 这一行**；手写 probe（把 `main_images` 合并进 product）却能看到 `main_images: pass`。
- 真因：`run_listing.js:24` 是 `const P = D.product`，而**主图/详情图数组在 product.json 的顶层**
  （`D.main_images` / `D.detail_images`），不在 `product` 里 → `validateForm` 的 `productData.main_images`
  恒为空 → `expectMain = 0` → **整项被跳过**（不是「读不到判 unknown」）。
  实测对照（店铺B草稿 `1013047463679`）：旧调用 `有 main_images 项 = false`；补齐两项后
  `main_images = {status:'pass', value:'uploaded=10/10 expect=10'}`。
- 已修：① `run_listing.js` 调用 `validateForm` 时显式补 `main_images` / `detail_images`；
  ② `pdd_flow.js` 的 expect 兼容「数组 / 数字 / `mainImageCount`」三种形态。
- 教训：**新增校验项后要确认调用方真的把数据传进来了** —— `allPass` 不会因为你漏传参数而变红。

### 11.4 2026-10-05 收尾：品牌/包装方式 + 校验表补两项（三家全绿复验）

用户明确默认：**品牌=祺讯、包装方式=袋装**（做法 `product.brand` + `attributes={'包装方式':['袋装']}`）。

`validateForm` 新增两项并实测通过：
- `brand`（原有项，本轮起在三条链接上都参与判定）；
- **`attr_<标签>`**（新）：对 `productData.attributes` 里每个非空属性读回并比对
  （新增 `readDropdownFieldValue(page, label)`：找标签 → 同行 input/selectValue → 返回已选值）。

**三条链接的最终校验表都是 18 项全 pass**（含 `main_images` / `brand` / `attr_包装方式`）：

| 店 | 产品 | 草稿 goods_id | 耗时 | 备注 |
|---|---|---|---|---|
| 店铺B 9227 | MZB-001 | `1013048905237` | 248.3s | 品牌/包装方式首次生效 |
| 店铺C 9228 | MZB-003（裂变） | `1013050921200` | 276.8s | ④ 详情首传失败 → ⑨b 补传 11/11 |
| 店铺A 9226 | MZB-003（裂变） | `1013052548325` | 237.9s | 旧版页，主图 7/7 |

环境：本轮 9226/9227/9228 三个实例都出现过 **CDP 握手超时或直接掉线**（`sycm/goods_effect` 卡死页 / 实例退出），
处置一律是**只重启该店实例**（保留原 `--user-data-dir`），2s 内恢复。

### 11.5 连店自动清理卡死页 / 重复监控页（2026-10-05 新增）

背景：上一条的「重启该店实例」是人工操作，根因是**某个标签卡死**（Playwright 会等所有页面初始化）。
现在把它自动化了，三个新函数 + `connectShop` 内置：

| 函数 | 作用 | 实测 |
|---|---|---|
| `probePagesAlive(port, pages, {perPageMs})` | Node 内置 `WebSocket` 逐页发 `Runtime.evaluate('1+1')`，8s 不回即判卡死；**只读** | 三家：`alive=2/3/1, hung=0` ✅ |
| `cleanupShopTabs(port, {maxTabs})` | 关 ① 卡死页（排除业务页）② 同类监控页每类留 1 ③ 超标多余非业务页 | 故意忙等一个标签 15s → `closed=['hung:about:blank']`，`goods_add` 保留 ✅ |
| `connectShop(..., {autoCleanup:true})` | 标签超标先清；握手失败**自动清一次再重试**；返回 `probe.cleanup` | 语法/回归通过 |
| `closeTarget(port,id)` | 关单个 target | — |

边界：业务页正则 `goods_add|goods_list|goods_detail|home|orders` **永不关**；只关标签不杀 Chrome；
Node < 22 无全局 `WebSocket` → `supported:false` 自动跳过探活。
`run_listing.js` 会把清理结果打进日志（`① 连店前自动清理标签 = N [...]`），不静默动用户标签。

## 十二、2026-10-05 MZB-001@店铺B9227（72 SKU · 旧版页 · 修掉主图假失败与漏检）

> 最终草稿 `goods_id=1012860923330`（commit id `202848159958`），**allPass 17/17、错误（0）**，未提交。
> 规模：颜色 6 × 款式 12 = **72 行**，耗时 **289.8s**（≈4.8 分钟）。

### 12.1 本轮抓到的两个真 bug（都已修）

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | `③ 主图 ok:false / uploaded:0`，白等 45–60s，但页面其实是 `已上传10/10张` | **旧版页 `readZoneCounter(page,'商品轮播图',10)` 恒返回 `[]`** → `waitForZoneCounter` 必然超时 | `uploadZoneFast` 主图/轮播区先轮询 6×700ms 的快速判据（邻近计数器文本 + 分区缩略图数），命中即返回；超时后同判据兜底。新增 `quickZoneCount()`；`confirmedBy` 会写 `main_counter_quick` / `zone_thumb_quick` / `main_counter_fallback` |
| 2 | 主图为 0/10 时 **`validateForm` 仍然 allPass** | 校验项里**根本没有主图这一项**（只有 packaging_label / detail_images / preview_images） | `validateForm` 新增 `main_images`：`expect=main_images.length`，读到判 pass/fail，读不到判 `unknown`；`main_images` 为空则不产生该项 |

### 12.2 属性问题的结论（用户问过「属性是不是没填」）
- MZB-001 的拼多多段**只有「品牌」「包装方式」两列，且都为空** → `attributes={}` 是忠于数据包。
- 该类目（猫抓板 16435）表单上**没有「商品属性」行**，也没有 材质/特点/风格；品牌/包装方式/商品资质都是选填。
- 判断口径：`错误（N）==0` + `required_attributes_missing` 空 = 没有必填属性被漏。
  可选属性要填就**单独问用户**；品牌填 `祺讯` 是前几轮用户确认的做法，不是默认值。

### 12.3 我又犯了一次的错（已写进门禁 0d 的触发路径）
为了补主图，我用**完整草稿 URL 重开**了表单（门禁 8 允许的续填），结果该稿详情计数变成 11/10、
末组「深棕」24 行预览图丢失 → 整条报废。**教训：主图这类缺口应当用「当前页原地补」，
而不是重开 URL；真坏了就重跑出新草稿（4.8 分钟）**，不要在坏稿上救。

---

## 十三、2026-10-05 GPVC-001 重跑（店铺C9228 · 16 SKU · 全绿）

> 草稿 `goods_id=1012851756666`（commit id `202846161572`），**validateForm allPass（15/15）、错误（0）**，未提交。
> 规模：颜色 8 × 款式 2 = **16 行**；耗时 **100.7s**（对比 72 行 274.8s）。

### 13.1 结论（跑通的那条路）
`build_product.py（本项目改成手工生成 product.json 也行）→ run_listing.js`，中间只需盯两处：
- ④ 详情图首次报 `detail_unstable_after_upload`（uploaded=0）→ ⑨b 自动补传，**这是常态，不是失败**；
- 其余每步都打印读回值（类目/品牌/属性/矩阵 16/16/填值 16/16/预览 16/16/参考价），`⑩` 一次过。

### 13.2 本轮改动（都已备份在 `_backup/*.20261005-171135.bak`）

| # | 文件 | 改动 | 为什么 |
|---|---|---|---|
| 1 | `config.json` | `python` 固定为装了 openpyxl 的解释器 + 两条 `_note_*` | PATH 上的 `python` 是 hermes venv（无 openpyxl），照文档跑 `read_excel.py` 直接 ModuleNotFoundError |
| 2 | `read_excel.py` | `openpyxl` 导入失败时打印「换哪个解释器/怎么写 config」并 exit 1 | 同上；裸栈会让人误判素材包坏了 |
| 3 | `build_product.py` | 维度模式加断言 `len(v0)*len(v1)==行数`，不匹配给可读报错 | 旧实现 `v0[i // len(v1)]` 在 v0 给少时 IndexError 裸崩 |
| 4 | `build_product.py` | `allow_duplicate_codes` 默认改为 **listing > config.json > False** | 旧实现硬编码 True，与 config.json 的 false 相反 = 静默放行重复编码 |
| 5 | `build_product.py` | `precheck()` 增加「维度数与取值组数不一致」的结构告警；SKU 图映射在 rows 模式跳过并说明 | 旧实现 3 维只给 2 组值也报 ok |
| 6 | `run_listing.js` | ⑨b 改为**核对「计数器 vs 真实缩略图数」**：缺则补、多则「先补 1 张再删残留」，循环到 `计数==实际==期望` | 本轮服务端计数虚高（9/50 而页面 8 张）导致 `detail_images` fail；根因是 ④+⑨b 重复入库 |
| 7 | `SKILL.md` | 新增「★ 2026-10-05 实测新增（必读）」A–D 四条 + Troubleshooting 三行 + 16 行耗时行 | 运行时/详情图/侦察脚本冲表单/查重裂变四类坑，旧文档没写清 |
| 8 | `SKILL.md` | 「维护」节标注 10–13 是遗留交叉引用编号，非执行顺序 | 门禁编号乱、容易看漏 |

### 13.3 本轮我犯的错（别再犯）
1. **只读侦察脚本把已填表单冲掉了**：`connectShop()` 会优先选中 `goods_add` 页，我却拿它去 `goto` 商品列表查重
   → 草稿页被导航走、详情区计数错乱。**要开别的页就用 `contexts()[0].newPage()`，别用 connectShop 拿 page 再导航。**
2. **检查过度（已升级为硬门禁 0n）**：用户原话「**你一开始检查太多了，第二次检查少了就很好**」。
   端到端绿了之后，**读回以 `validateForm` 为准**，不要再为「图对不对 / 类目对不对 / 编码分布」自造第二轮扫描；
   要验就一次做完（像素比对脚本已有），或者干脆不做。判断标准是「能不能交付」，不是「我还能再验什么」。
   我的代价：3 次自造扫描后，好稿的详情区计数被搞成 9/50 → `detail_images` fail。
3. **在坏稿上抢救太久**：详情区计数错乱后我尝试 clearZone→重传→删残留，平台还拦「商详装修图片不能为空」。
   正确做法是**直接重跑 run_listing.js 出新草稿（100s）**，废稿留给用户删。


> 草稿 goods_id=**1011475841012**（id=202488065013），validateForm **allPass**，**未提交**。
> 裂变：已有 1004662681298 同标题 → 标题去掉「家用」+「新款」，首图反转。

| 项 | 值 |
|---|---|
| SKU | 270 = 颜色18 × 款式15 |
| 价格 | 拼单价 11.31 / 单买价 12.44 / 参考价 14.93（用户确认的建议规则） |
| 编码 | 自粘-{色}-{长X米*宽Y厘米}-{档位}，270 唯一 |
| 品牌 | 祺讯（数据包沃锦已覆盖） |
| 素材 | 主图 10/10（原 11 张去掉 1 张）、详情 22、预览 18 |
| 详情图 | ④ 首次失败 → ⑨b 容器定位补传 22/22（idx=5） |
| needReview | **特点「自粘」表单无此项**；可选近义：防水/防潮等，**未自动替换**，提交前请人工确认 |
| 耗时 | 约 15 分钟（预览图 270 行是大头） |

