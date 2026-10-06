#!/usr/bin/env node
/**
 * 上架全流程编排（旧版/新版类目页自动分流）—— 正式入口，别用 fillProductForm。
 *
 * 用法（先跑 build_product.py 生成 product.json）：
 *   node scripts/run_listing.js
 * 环境变量：
 *   PDD_PRODUCT     必填，product.json 路径（build_product.py 的输出）
 *   PDD_PORT        默认 9226
 *   PDD_MAX_TABS    默认 12（多余标签常是用户自己的业务页，先放宽再让对方关）
 *   PDD_CATEGORY    默认取 product.category；空则必填（完整叶子路径，如「家居饰品 > 贴饰 > 墙贴」）
 *   PDD_ATTRS       可选，JSON 覆盖属性候选 {label: [数据包原值, ...备选]}
 *   PDD_SHOT        可选，截图目录
 *
 * **全程不提交**，跑完打印 validateForm 结果，交给用户自己检查后点提交。
 */
const fs = require('fs');
const path = require('path');
const flow = require(process.env.PDD_FLOW_JS || path.join(__dirname, 'pdd_flow.js'));

const productPath = process.env.PDD_PRODUCT;
if (!productPath) { console.error('[FATAL] 请设置 PDD_PRODUCT=.../product.json'); process.exit(2); }
const D = JSON.parse(fs.readFileSync(productPath, 'utf8'));
const P = D.product;
const DIMS = P.dimensions;
const SKUS = P.skus;
const CAT = process.env.PDD_CATEGORY || P.category;
const PORT = process.env.PDD_PORT || '9226';
const SHOT = process.env.PDD_SHOT || path.dirname(productPath);
const ATTRS = process.env.PDD_ATTRS ? JSON.parse(process.env.PDD_ATTRS) : (P.attributes || {});

const V0 = [...new Set(SKUS.map((s) => String(s[DIMS[0]] ?? '')))];
const V1 = [...new Set(SKUS.map((s) => String(s[DIMS[1]] ?? '')))];
const T1 = V1.map((v) => { const i = String(v).search(/[*（(【\[]/); return i > 0 ? String(v).slice(0, i) : String(v); });
const want = SKUS.map((s) => [`${s[DIMS[0]]}|${s[DIMS[1]]}`, s]);

const T0 = Date.now();
const log = (...a) => console.log('[上架]', `[+${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

// 跨窗口 sticky：写值 / 读回 两用
const run = (page, mode) => page.evaluate(async (a) => {
  const { V0, V1, T1, want, mode } = a;
  const wmap = new Map(want);
  const norm = (x) => { const y = Number(String(x ?? '').trim()); return Number.isFinite(y) ? y.toFixed(4) : String(x ?? '').trim(); };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const setVal = (el, v) => { if (String(el.value) === String(v)) return false;
    setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; };
  const sc = (() => { let c = Array.from(document.querySelectorAll('*')).filter((e) => e.querySelector && e.querySelector('tbody tr') && e.scrollHeight > e.clientHeight + 20 && /^(scroll|auto)$/.test(getComputedStyle(e).overflowY)); if (!c.length) c = Array.from(document.querySelectorAll('*')).filter((e) => e.tagName !== 'HTML' && e.tagName !== 'BODY' && e.scrollHeight > e.clientHeight + 40 && e.querySelector && e.querySelector('tbody tr')); return c; })();
  let n = document.querySelector('tbody tr')?.parentElement;
  while (n && n !== document.body) { if (n.scrollHeight > n.clientHeight + 20) sc.push(n); n = n.parentElement; }
  const all = Array.from(new Set(sc));
  const maxSh = Math.max(3000, ...all.map((e) => e.scrollHeight));
  let sticky = ''; let writes = 0; const seen = new Map();
  const step = () => {
    for (const tr of Array.from(document.querySelectorAll('tbody tr'))) {
      const text = (tr.textContent || '').replace(/\s+/g, ' ').trim();
      for (const v of V0) if (text.includes(v)) { sticky = v; break; }
      // 全值精确匹配优先；token 兜底仅在 token 在本维度唯一时使用（共享前缀会折叠行）
      let d1 = ''; for (let i = 0; i < V1.length; i++) if (text.includes(V1[i])) { d1 = V1[i]; break; }
      if (!d1) for (let i = 0; i < V1.length; i++) {
        const tk = T1[i];
        if (!tk || tk === V1[i]) continue;
        if (T1.filter((x) => x === tk).length > 1) continue;
        if (text.includes(tk)) { d1 = V1[i]; break; }
      }
      if (!sticky || !d1) continue;
      const w = wmap.get(`${sticky}|${d1}`); if (!w) continue;
      const inputs = Array.from(tr.querySelectorAll('input[placeholder="请输入"]')).filter((e) => e.offsetParent);
      if (inputs.length !== 4) continue;
      if (mode === 'fill') {
        const t = [String(w.stock), String(w.group_price), String(w.single_price), String(w.code)];
        for (let k = 0; k < 4; k++) if (setVal(inputs[k], t[k])) writes++;
      } else {
        seen.set(`${sticky}|${d1}`, { vals: inputs.map((e) => e.value), img: !!tr.querySelector('td.sku-preview-cell [class*=imageWrapper]') });
      }
    }
  };
  for (let round = 0; round < (mode === 'fill' ? 3 : 1); round++) {
    sticky = ''; writes = 0;
    all.forEach((e) => { e.scrollTop = 0; }); window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 220)); step();
    for (let st = 0; st <= maxSh + 600; st += 120) {
      all.forEach((e) => { e.scrollTop = st; }); window.scrollTo(0, st);
      await new Promise((r) => setTimeout(r, 70));
      document.querySelectorAll('tbody tr').length;
      await new Promise((r) => setTimeout(r, 35)); step();
    }
    if (mode !== 'fill' || writes === 0) break;
  }
  if (mode !== 'fill') {
    let ok = 0, img = 0; const bad = [];
    for (const [k, g] of seen) {
      const w = wmap.get(k); if (!w) { bad.push(k); continue; }
      const same = norm(g.vals[0]) === norm(w.stock) && norm(g.vals[1]) === norm(w.group_price)
        && norm(g.vals[2]) === norm(w.single_price) && String(g.vals[3]) === String(w.code);
      if (same) ok++; else bad.push(k); if (g.img) img++;
    }
    return { covered: seen.size, ok, img, bad: bad.slice(0, 6), stockSum: Array.from(seen.values()).reduce((x, y) => x + (Number(y.vals[0]) || 0), 0) };
  }
  return { writes };
}, { V0, V1, T1, want, mode });

(async () => {
  if (!CAT) { console.error('[FATAL] 缺少目标类目（PDD_CATEGORY 或 product.category）'); process.exit(2); }
  log('产品 =', P.title, '| 目标类目 =', CAT, '| 端口 =', PORT, '| 期望 SKU =', SKUS.length);
  const det = await flow.connectShop(PORT, { maxTabs: Number(process.env.PDD_MAX_TABS || 12) });
  const { browser, page } = det;
  // 连店时的自动清理（关卡死页 / 重复监控页）要显式报出来，别静默动用户的标签
  if (det.probe && det.probe.cleanup && det.probe.cleanup.closed && det.probe.cleanup.closed.length) {
    log('① 连店前自动清理标签 =', det.probe.cleanup.closed.length, JSON.stringify(det.probe.cleanup.closed.slice(0, 5)));
  }
  try {
    await page.bringToFront();

    // ⓪ 查重（门禁第 3 步：填表前必须查重；2026-09-30 补上，此前正式入口缺这一步）
    //    命中同标题不静默跳过：由 PDD_SKIP_DUP=1 才继续，否则停下交人工决定（裂变 / 覆盖 / 放弃）。
    if (process.env.PDD_SKIP_DUP !== '1') {
      const dup = await flow.checkDuplicate(page, P.title, SKUS).catch((e) => 'search_failed:' + e.message);
      log('⓪ 查重 =', dup);
      if (dup !== 'not_found') {
        console.error('[FATAL] 查重未通过 =', dup,
          '\n  exact_duplicate / same_title_different_sku → 请改标题或首图（裂变），或确认覆盖；',
          '\n  search_failed → 查重失败不等于「无重复」，需人工确认。',
          '\n  确认无碍后可用 PDD_SKIP_DUP=1 跳过本步。');
        process.exitCode = 3;
        return;
      }
    } else {
      log('⓪ 查重 = (PDD_SKIP_DUP=1 已跳过)');
    }

    // ① 类目页：自动识别新旧版
    await page.goto('https://mms.pinduoduo.com/goods/category', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    await flow.dismissOverlays(page).catch(() => {});
    const kind = await flow.detectCategoryPage(page);
    log('① 类目页 =', kind.kind, '|', JSON.stringify(kind.evidence));
    if (kind.kind === 'unknown') throw new Error('类别页形态未知，停止');

    // ② 选类目（旧版用 searchCategory；新版先传图+标题才会出「手动选择商品分类」入口）
    if (kind.kind === 'old') {
      const s = await flow.searchCategory(page, CAT, { confirm: true });
      log('② 类目 =', JSON.stringify({ ok: s.ok, chosen: s.chosen, confirmed: s.confirmed }));
      if (!s.ok) throw new Error('category_failed:' + s.reason);
      await log('   等表单', JSON.stringify(await flow.waitForFormReady(page)));
    } else {
      await page.locator('input[type=file]').first().setInputFiles(D.main_images.slice(0, 10), { timeout: 120000 });
      const ti = page.locator('input[placeholder*="商品标题"]').first();
      await ti.click({ timeout: 15000 });
      await page.keyboard.press('Control+a').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await ti.type(P.title, { delay: 10 });
      await page.waitForTimeout(400);
      await page.getByText('商品标题', { exact: false }).first().click({ timeout: 5000, position: { x: 2, y: 2 } }).catch(() => {});
      await page.waitForTimeout(1000);
      let open = await flow.openManualCategoryPicker(page);
      if (!open.ok) { log('   入口未出现，等上传 =', JSON.stringify(await flow.waitForUploads(page, 10, { capacity: 10 })));
        open = await flow.openManualCategoryPicker(page); }
      const s = await flow.searchCategory(page, CAT, { confirm: true });
      log('② 类目 =', JSON.stringify({ ok: s.ok, chosen: s.chosen, confirmed: s.confirmed }));
      if (!s.ok) throw new Error('category_failed:' + s.reason);
      await page.waitForTimeout(2000);
      await page.getByText('下一步, 完善商品信息', { exact: false }).first().click({ timeout: 20000 });
      log('   等表单 =', JSON.stringify(await flow.waitForFormReady(page)));
    }
    log('   URL =', page.url());
    const gid = (page.url().match(/goods_id=(\d+)/) || [])[1];
    if (!page.url().includes('goods_add')) throw new Error('not_on_form');
    await flow.dismissOverlays(page).catch(() => {});

    // ③ 旧版的主图/标题在表单里补
    if (kind.kind === 'old') {
      log('③ 主图 =', JSON.stringify(await flow.uploadZoneFast(page, '商品轮播图', 10, D.main_images.slice(0, 10), { timeoutMs: 150000 })));
      const ti = page.locator('input[placeholder*="商品标题"]').first();
      await ti.click({ timeout: 15000 });
      await page.keyboard.press('Control+a').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await ti.type(P.title, { delay: 10 });
      await page.waitForTimeout(400);
      await page.getByText('商品标题', { exact: false }).first().click({ timeout: 5000, position: { x: 2, y: 2 } }).catch(() => {});
      await page.waitForTimeout(800);
    }

    // ④ 详情图 / 包装标签图
    log('④ 详情图 =', JSON.stringify(await flow.uploadZoneFast(page, '商品详情', 50, D.detail_images, { timeoutMs: 300000 })));
    await page.waitForTimeout(3000);
    let pl = await flow.packagingLabelState(page).catch(() => null);
    if (pl && pl.uploaded) { await flow.clearZone(page, '包装标签图', 10).catch(() => {}); await page.waitForTimeout(1500); }

    // ⑤ 品牌 + 属性（分层告警）
    const brand = page.locator('input[placeholder*="品牌名称"]').first();
    if (await brand.count()) {
      await brand.click({ timeout: 15000 }); await brand.fill(P.brand); await page.waitForTimeout(2000);
      await page.evaluate((name) => { const els = Array.from(document.querySelectorAll('*')).filter((el) => el.offsetParent && el.children.length === 0 && (el.textContent || '').trim() === name); if (els.length) els[els.length - 1].click(); }, P.brand);
      await page.waitForTimeout(1200);
    }
    // 数字/直填属性（厚度等）不走下拉 pickAttr —— 表单上是 input，直接写值
    const DIRECT_ATTR_LABELS = new Set(['厚度', '中层厚度', '平方克重', '重量', '尺寸']);
    const directAttrs = {};
    const dropAttrs = {};
    for (const [k, arr] of Object.entries(ATTRS || {})) {
      if (DIRECT_ATTR_LABELS.has(k)) directAttrs[k] = arr;
      else dropAttrs[k] = arr;
    }
    const ar = await flow.applyAttributesByCandidates(page, dropAttrs);
    log('⑤ 品牌 =', P.brand, '| needReview =', JSON.stringify(ar.needReview.map((x) => `${x.label}<${x.chosen}|${x.how}>`)));
    // 把「这个下拉到底有哪些选项」打出来 —— 否则使用者只知道失败、不知道能填什么（审计 ㉒）
    ar.results.filter((r) => r.how !== 'datapack' && (r.options || []).length)
      .forEach((r) => log(`   可选项 ${r.label} =`, JSON.stringify(r.options.slice(0, 20))));

    // 直填数字属性（厚度 mm 等）：定位含标签的叶子 → 祖先里的 input，native setter 写值
    const directFilled = await page.evaluate((pairs) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const out = [];
      for (const { label, value } of pairs) {
        const leaves = Array.from(document.querySelectorAll('*')).filter((el) => {
          if (!el.offsetParent || el.children.length) return false;
          const s = (el.textContent || '').trim();
          return s === label || s === label + ' mm' || s.startsWith(label);
        });
        let done = false;
        for (const leaf of leaves) {
          let p = leaf.parentElement;
          for (let k = 0; k < 5 && p; k++) {
            const inputs = Array.from(p.querySelectorAll('input,textarea'))
              .filter((e) => e.offsetParent && !e.readOnly && e.type !== 'file');
            const inp = inputs.find((e) => /请输入|请选择|mm/.test(e.placeholder || '') || e.type === 'text');
            const target = inp;
            if (target) {
              if (String(target.value) !== String(value)) {
                setter.call(target, String(value));
                target.dispatchEvent(new Event('input', { bubbles: true }));
                target.dispatchEvent(new Event('change', { bubbles: true }));
                target.dispatchEvent(new Event('blur', { bubbles: true }));
              }
              out.push({ label, value: target.value, how: 'direct_input' });
              done = true;
              break;
            }
            p = p.parentElement;
          }
          if (done) break;
        }
        if (!done) out.push({ label, value: null, how: 'not_found' });
      }
      return out;
    }, Object.entries(directAttrs).map(([label, arr]) => ({ label, value: String((arr && arr[0]) || '') })));
    log('⑤ 直填数字属性 =', JSON.stringify(directFilled));

    // ⑥ 规格表（预检 + 分组 + 矩阵行数自愈）
    const spec = await flow.ensureSpecTable(page, DIMS, [V0, V1]);
    log('⑥ 规格表 ok =', spec.ok, '| matrix =', JSON.stringify(spec.matrix));
    if (!spec.ok) log('   groupMismatch =', JSON.stringify(spec.groupMismatch), '| 预检 =', JSON.stringify(spec.specValueProblems || null));

    // ⑦ 填 36 行 + 读回
    log('⑦ 填值 =', JSON.stringify(await flow.fillSkuRowsAndVerify(page, P)));

    // ⑧ 预览图
    const colorToFile = {};
    for (const sk of SKUS) if (!colorToFile[sk[DIMS[0]]]) colorToFile[sk[DIMS[0]]] = sk.preview;
    log('⑧ 预览图 =', JSON.stringify(await flow.uploadMissingPreviews(page, P, { colorToFile })));
    await page.waitForTimeout(3000);
    // ⑧b 正向核验：逐行数预览图（不能只看「无缺图横幅」，那是弱判据）
    if (typeof flow.countPreviewCells === 'function') {
      const cp = await flow.countPreviewCells(page, DIMS, [V0, V1]).catch((e) => ({ error: e.message }));
      log('⑧b 预览图正向核验 =', JSON.stringify({ total: cp.total, withImg: cp.withImg, missing: (cp.missing || []).length, error: cp.error || null }));
      if (cp.missing && cp.missing.length) log('   ⚠️ 缺图行 =', JSON.stringify(cp.missing.slice(0, 8)));
    } else {
      log('⑧b 预览图正向核验 = (技能内无 countPreviewCells，跳过)');
    }

    // ⑨ 参考价
    log('⑨ 参考价 =', JSON.stringify(await page.evaluate((val) => {
      const rows = Array.from(document.querySelectorAll('[class*=beast-input-goods-sku-row]')).filter((e) => e.offsetParent && /商品参考价/.test(e.textContent || ''));
      if (!rows.length) return { ok: false, reason: 'row_not_found' };
      const inp = Array.from(rows[0].querySelectorAll('input')).find((e) => e.offsetParent && e.type !== 'file');
      if (!inp) return { ok: false, reason: 'input_not_found' };
      const st = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      st.call(inp, String(val)); inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true })); inp.dispatchEvent(new Event('blur', { bubbles: true }));
      return { ok: true, now: inp.value }; }, P.ref_price)));
    await page.waitForTimeout(1500);

    // ⑨b 详情图落库复核（规格/SKU 可能触发重渲染冲掉未落库的图）
    // 2026-10-05 加固：④ 首次常报 detail_unstable_after_upload，⑨b 补传会让服务端计数偏大
    // （实测计数器 9/50 而页面只有 8 张 → validateForm.detail_images fail）。
    // 所以这里读回「计数器」与「真实缩略图张数」两个值：只补缺，多则删残留。
    const readDetailZone = () => page.evaluate(() => {
      let root = null;
      for (const e of Array.from(document.querySelectorAll('div,section'))) {
        const t = e.textContent || '';
        if (/快捷编辑/.test(t) && /已上传\s*\d+\s*\/\s*50/.test(t) && t.length < 8000) { root = e; break; }
      }
      if (!root) return { counter: null, imgs: [] };
      const m = (root.textContent || '').match(/已上传\s*(\d+)\s*\/\s*50/);
      const imgs = Array.from(root.querySelectorAll('[class*=ImageWithRemark_v2_imageContainer]'))
        .map((n) => { const i = n.querySelector('img'); return i ? (i.getAttribute('src') || '') : ''; })
        .filter(Boolean);
      return { counter: m ? Number(m[1]) : null, imgs: Array.from(new Set(imgs)) };
    });

    if ((D.detail_images || []).length) {
      let z = await readDetailZone().catch(() => ({ counter: null, imgs: [] }));
      log('⑨b 详情区 =', `计数器 ${z.counter} / 实际 ${z.imgs.length} / 期望 ${D.detail_images.length}`);
      if ((z.counter || 0) < D.detail_images.length) {
        log('⑨b 详情图不足，容器定位补传...');
        const re = await flow.uploadZoneFast(page, '商品详情', 50, D.detail_images, { timeoutMs: 120000, waitMs: 60000 });
        log('⑨b 详情补传 =', JSON.stringify(re));
        z = await readDetailZone().catch(() => z);
      }
      // 多出来的：先补一张（平台禁止详情区为空）再删残留，最后必须 计数 == 实际 == 期望
      let guard = 0;
      while (z.imgs.length > D.detail_images.length && guard++ < D.detail_images.length + 2) {
        log(`⑨b 详情区多出 ${z.imgs.length - D.detail_images.length} 张，先补 1 张再删残留...`);
        await flow.uploadZoneFast(page, '商品详情', 50, D.detail_images.slice(0, 1), { timeoutMs: 120000, waitMs: 30000 }).catch(() => {});
        await page.waitForTimeout(2500);
        for (let i = 0; i < z.imgs.length; i++) {
          await page.evaluate((idx) => {
            let root = null;
            for (const e of Array.from(document.querySelectorAll('div,section'))) {
              const t = e.textContent || '';
              if (/快捷编辑/.test(t) && /已上传\s*\d+\s*\/\s*50/.test(t) && t.length < 8000) { root = e; break; }
            }
            if (!root) return false;
            const nodes = Array.from(root.querySelectorAll('[class*=ImageWithRemark_v2_imageContainer]'));
            const n = nodes[idx];
            if (!n) return false;
            for (const t of ['mouseover', 'mouseenter', 'mousemove']) n.dispatchEvent(new MouseEvent(t, { bubbles: true }));
            const box = n.querySelector('[class*=actionBox]');
            const cands = box ? Array.from(box.querySelectorAll('*')) : Array.from(n.querySelectorAll('*'));
            const del = cands.find((e) => /删除/.test(e.textContent || '') || /delete/i.test(String(e.className)));
            if (!del) return false;
            const clickable = del.closest('[class*=actionItem]') || del;
            clickable.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            clickable.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            clickable.click();
            return true;
          }, i).catch(() => false);
          await page.waitForTimeout(1200);
        }
        await page.waitForTimeout(2500);
        z = await readDetailZone().catch(() => z);
        if (z.imgs.length <= D.detail_images.length) break;
      }
      log('⑨b 详情区最终 =', `计数器 ${z.counter} / 实际 ${z.imgs.length} / 期望 ${D.detail_images.length}`);
    }

    // ⑩ 终校验
    const vf = await flow.validateForm(page, {
  ...P,
  // 2026-10-05 修复：主图/详情图数组在 product.json 的**顶层**（D.main_images / D.detail_images），
  // 不在 product 对象里。旧代码只传 P → validateForm 的 main_images 校验因 expect=0 被整项跳过，
  // 于是「主图 0/10」也能 allPass。这里显式补齐两项。
  main_images: D.main_images || [],
  detail_images: D.detail_images || [],
}).catch((e) => ({ err: e.message }));
    log('⑩ validateForm allPass =', vf.allPass, '| anyFail =', vf.anyFail, '| anyUnknown =', vf.anyUnknown);
    if (vf.checks) vf.checks.forEach((c) => log(`    [${c.status}] ${c.name}: ${String(c.value).slice(0, 64)}`));

    if (process.env.PDD_SHOT) await page.screenshot({ path: path.join(SHOT, 'final.png'), fullPage: true }).catch(() => {});
    log('★ 未提交 · 草稿 goods_id =', gid, '· 请自行检查后在后台点提交');
  } finally {
    await flow.disconnectPage(browser);
  }
})().catch((e) => { console.error('[上架] FAIL:', e.message); process.exit(1); });
