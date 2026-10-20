/**
 * PDD listing flow helpers — fill → validate → submit are strictly separated.
 *
 * Load from Node (path from config/env, never hardcode a machine path):
 *   const flow = require(process.env.PDD_FLOW_JS || '<skill>/scripts/pdd_flow.js');
 *
 * Contract:
 *   fillProductForm  — never submits
 *   validateForm     — full virtual-scroll read; unknown ≠ pass
 *   submitProduct    — only after validateForm().allPass === true
 *   checkDuplicate   — title + SKU code set fingerprint
 *   disconnectPage   — disconnect CDP; never browser.close() on user Chrome
 */

'use strict';

const LIST_URL = 'https://mms.pinduoduo.com/goods/goods_list';

// ---------- path / playwright resolution ----------
function resolvePlaywrightCore() {
  // 1) explicit env (set by resolve_env.ps1 from config.json / auto-detect)
  const p = process.env.PDD_PLAYWRIGHT;
  if (p && p !== 'playwright-core') {
    try { return require(p); } catch (_) {}
  }
  // 2) bare module name — Node resolution (NODE_PATH / local node_modules)
  try {
    return require('playwright-core');
  } catch (_) {}
  throw new Error(
    'playwright-core not found. Set config.json "playwright_core" or env PDD_PLAYWRIGHT, ' +
    'then dot-source scripts/resolve_env.ps1 (writes those into the process env). ' +
    'See references/env.md.'
  );
}

/** CDP HTTP 小工具（probeShop / 卡死页清理共用） */
function cdpGet(port, path, timeoutMs = 4000) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('timeout', () => { req.destroy(new Error('probe_timeout')); });
    req.on('error', reject);
  });
}

/**
 * 逐页探活（2026-10-05 新增）：Playwright 连 CDP 会等**所有页面**初始化，
 * 只要有一个卡死页（实测 `sycm/goods_effect`）就会 `cdp_handshake_failed`（120s 超时），
 * 而 `connectShop` 之前无法区分「浏览器卡死」与「某个标签卡死」。
 * 这里用 Node 内置 WebSocket（Node ≥22 有）对每个页面发一条 `Runtime.evaluate('1+1')`，
 * 8s 内不回就当卡死。返回 { ok, hungUrls }，**只读，不关任何东西**。
 */
async function probePagesAlive(port, pages, { perPageMs = 8000 } = {}) {
  const WS = globalThis.WebSocket;
  if (typeof WS !== 'function') return { supported: false, ok: true, hung: [] };
  const probeOne = (p) => new Promise((resolve) => {
    let done = false;
    let ws;
    const finish = (alive) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch (_) {}
      resolve({ alive, url: String(p.url || '').slice(0, 90), id: p.id });
    };
    const timer = setTimeout(() => finish(false), perPageMs);
    try { ws = new WS(p.webSocketDebuggerUrl); } catch (_) { return finish(false); }
    ws.addEventListener('open', () => {
      try { ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1+1', returnByValue: true } })); }
      catch (_) { finish(false); }
    });
    ws.addEventListener('message', (ev) => {
      try { const j = JSON.parse(String(ev.data)); if (j.id === 1) finish(true); } catch (_) {}
    });
    ws.addEventListener('error', () => finish(false));
    ws.addEventListener('close', () => finish(false));
  });
  const out = [];
  for (const p of pages) {
    if (!p.webSocketDebuggerUrl) continue;
    out.push(await probeOne(p));
  }
  const hung = out.filter((x) => !x.alive);
  return { supported: true, ok: hung.length === 0, hung, alive: out.filter((x) => x.alive).length };
}

/** 关掉一个 CDP target（成功返回 true） */
async function closeTarget(port, targetId, timeoutMs = 5000) {
  try {
    const r = await cdpGet(port, '/json/close/' + encodeURIComponent(targetId), timeoutMs);
    return String(r.body || '').trim() === 'Target is closing' || r.status === 200;
  } catch (_) {
    return false;
  }
}

/** 反复自我累积的监控类页面（实测就是它们把标签数堆到 8-29 个并卡死 CDP） */
const NOISY_PAGE_RE = /sycm\/goods_effect|yingxiao\.pinduoduo\.com|\/goods_effect/i;

/**
 * 连店前清理（2026-10-05 新增）：把**卡死页**与**重复的监控页**关掉，再把多余标签收掉。
 * 原则：① 用户自己的页面只在「确诊卡死」或「同类重复」时才关，每类最多留 1 个；
 *      ② `goods_add` / `goods_list` 等业务页一律保留；③ 全程只读 + 关标签，不动 Chrome 进程。
 * @returns {Promise<{closed:string[], keptDocs:number}>}
 */
async function cleanupShopTabs(port, { closeHung = true, keepNoisy = 1, maxTabs = 6 } = {}) {
  const closed = [];
  let pages = [];
  try {
    const list = await cdpGet(port, '/json/list');
    pages = (JSON.parse(list.body) || []).filter((t) => t.type === 'page');
  } catch (_) {
    return { closed, keptDocs: 0, error: 'list_failed' };
  }
  // 业务页永不关
  const isBusiness = (u) => /goods_add|goods_list|goods_detail|mms\.pinduoduo\.com\/(home|orders)/i.test(u);

  // 1) 卡死页（排除业务页：业务页卡死也先留着，避免打断用户已填的表单）
  if (closeHung) {
    const cand = pages.filter((p) => !isBusiness(String(p.url || '')));
    const alive = await probePagesAlive(port, cand);
    if (alive.supported) {
      for (const h of alive.hung) {
        if (await closeTarget(port, h.id)) closed.push('hung:' + h.url);
      }
      if (closed.length) {
        const list2 = await cdpGet(port, '/json/list');
        pages = (JSON.parse(list2.body) || []).filter((t) => t.type === 'page');
      }
    }
  }

  // 2) 重复的监控页：同类只留 keepNoisy 个
  const noisy = pages.filter((p) => NOISY_PAGE_RE.test(String(p.url || '')));
  const byKind = {};
  for (const p of noisy) {
    const key = /yingxiao/i.test(p.url) ? 'yingxiao' : 'sycm';
    byKind[key] = byKind[key] || [];
    byKind[key].push(p);
  }
  for (const [, group] of Object.entries(byKind)) {
    for (const p of group.slice(keepNoisy)) {
      if (await closeTarget(port, p.id)) closed.push('dup:' + String(p.url).slice(0, 70));
    }
  }

  // 3) 仍然超标就把「非业务、非首个」的多余标签收掉，保证握手有余量
  if (maxTabs > 0) {
    let list3 = [];
    try { list3 = (JSON.parse((await cdpGet(port, '/json/list')).body) || []).filter((t) => t.type === 'page'); } catch (_) {}
    const extra = list3.filter((p) => !isBusiness(String(p.url || '')));
    const budget = Math.max(0, maxTabs - list3.filter((p) => isBusiness(String(p.url || ''))).length);
    for (const p of extra.slice(budget)) {
      if (await closeTarget(port, p.id)) closed.push('over:' + String(p.url).slice(0, 70));
    }
  }

  let keptDocs = 0;
  try {
    const fin = (JSON.parse((await cdpGet(port, '/json/list')).body) || []).filter((t) => t.type === 'page');
    keptDocs = fin.filter((p) => isBusiness(String(p.url || ''))).length;
  } catch (_) {}
  return { closed, keptDocs };
}

/**
 * Pre-probe CDP: port alive + page/tab count, before the expensive WS handshake.
 * A shop Chrome with many tabs (or a blocked dialog) accepts WS but never
 * completes CDP init — report that loudly instead of hanging (PE2→9228 lesson).
 */
async function probeShop(port, { timeoutMs = 4000, maxTabs = 6 } = {}) {
  try {
    const ver = await cdpGet(port, '/json/version', timeoutMs);
    let pages = [];
    try {
      const list = await cdpGet(port, '/json/list', timeoutMs);
      pages = (JSON.parse(list.body) || []).filter((t) => t.type === 'page');
    } catch (_) {}
    return {
      reachable: ver.status === 200,
      tabs: pages.length,
      tooManyTabs: pages.length > maxTabs,
      urls: pages.map((p) => String(p.url || '').slice(0, 60)),
      hint: pages.length > maxTabs
        ? `Chrome 开着 ${pages.length} 个标签页，CDP 可能握手超时；可先跑 cleanupShopTabs(port) 自动收掉卡死/重复页`
        : null,
    };
  } catch (e) {
    return { reachable: false, tabs: 0, tooManyTabs: false, urls: [], error: e.message };
  }
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.autoCleanup=true] 握手失败时自动清理卡死/重复标签并重试一次
 *   （2026-10-05 新增：实测 `sycm/goods_effect` 卡死页会让 `connectOverCDP` 干等 120s，
 *    以前只能人工重启整个 Chrome 实例；现在先探活+关卡死页/重复监控页，再重试）
 */
async function connectShop(port, { timeout = 120000, probe = true, maxTabs = 6, autoCleanup = true } = {}) {
  const { chromium } = resolvePlaywrightCore();

  const pre = probe ? await probeShop(port, { maxTabs }) : { reachable: true, tabs: 0, tooManyTabs: false };
  if (probe) {
    if (!pre.reachable) {
      throw new Error(`cdp_unreachable: 端口 ${port} 不可达（Chrome 未启动或未开 remote-debugging）`);
    }
    // 标签超标不再直接抛错：先自动清理（关卡死页 + 同类监控页只留 1 个），再继续
    if (pre.tooManyTabs && autoCleanup) {
      const c = await cleanupShopTabs(port, { maxTabs }).catch(() => null);
      if (c && c.closed && c.closed.length) {
        const after = await probeShop(port, { maxTabs });
        pre.tabs = after.tabs;
        pre.tooManyTabs = after.tooManyTabs;
        pre.cleanup = c;
      }
    }
    if (pre.tooManyTabs) {
      throw new Error(`cdp_too_many_tabs: ${pre.hint}`);
    }
  }

  let lastErr;
  let cleanedOnce = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout });
      const pages = browser.contexts()[0]?.pages() || [];
      const page =
        pages.find((p) => p.url().includes('goods_add')) ||
        pages.find((p) => p.url().includes('mms.pinduoduo.com'));
      if (page) await page.bringToFront();
      return { browser, page, probe: pre };
    } catch (e) {
      lastErr = e;
      // 握手失败的头号原因是「某个页面卡死」——先探活并关掉，再重试一次
      if (autoCleanup && !cleanedOnce) {
        cleanedOnce = true;
        const c = await cleanupShopTabs(port, { maxTabs }).catch(() => null);
        if (c && c.closed && c.closed.length) lastErr.cleaned = c;
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  const detail = lastErr && lastErr.message ? lastErr.message.split('\n')[0] : String(lastErr);
  const cleaned = lastErr && lastErr.cleaned ? ` | 已清理标签: ${lastErr.cleaned.closed.join(' , ')}` : '';
  throw new Error(`cdp_handshake_failed: ${detail}${cleaned}（若仍失败，请重启该店 Chrome 实例，保留原 --user-data-dir）`);
}

/** Disconnect only — do not close the user's Chrome. */
async function disconnectPage(browser) {
  try {
    if (browser && typeof browser.close === 'function') {
      // playwright-core CDP: close() disconnects; still avoid if clearly process-bound
      await browser.close();
    }
  } catch (_) { /* ignore */ }
}

// ---------- fingerprints / duplicate check ----------
function normalizeTitle(t) {
  return String(t || '').replace(/\s+/g, '').toLowerCase();
}

function codeSet(skus) {
  return [...new Set((skus || []).map((s) => String(s.code || '').trim()).filter(Boolean))].sort();
}

/**
 * Fill SKU codes from a template (no hard-coded product names).
 * Placeholders: {color} {length} {size} {tier} {d0} {d1} + every dimension name.
 * Example: '50cm连续木纹-{color}-{length}' → 50cm连续木纹-白色-3米
 * Mutates skus[i].code; returns skus.
 */
function applyCodeTemplate(skus, template, { dims = [] } = {}) {
  if (!template) return skus || [];
  for (const s of skus || []) {
    let code = String(template);
    code = code.replace(/\{(\w+)\}/g, (_, k) => {
      if (k in s && s[k] != null) return String(s[k]);
      if (k === 'length' && s['长度']) return String(s['长度']);
      if (k === 'color' && s['颜色']) return String(s['颜色']);
      if (k === 'size' && s['尺寸']) return String(s['尺寸']);
      if (k === 'tier' && s['等级']) return String(s['等级']);
      if (k === 'd0' && dims[0]) return String(s[dims[0]] ?? '');
      if (k === 'd1' && dims[1]) return String(s[dims[1]] ?? '');
      return '';
    });
    s.code = code;
  }
  return skus;
}

/**
 * After bulk fill: read back critical fields and repair in-place
 * (fold of PE2/PE3 manual continue.js steps — do not rely on caller).
 */
async function enforceCriticalOnForm(page, productData, { mainFiles = [], colorToFile = {}, previewByCode = {}, deep = true } = {}) {
  const out = { title: false, main: false, ref: false, brand: false, errors: null, counters: [] };

  const forceTitle = async () => {
    const t = String(productData.title || '');
    if (!t) return true;
    for (let i = 0; i < 3; i++) {
      const now = await page.evaluate((expected) => {
        const inp = Array.from(document.querySelectorAll('input')).find(
          (el) => el.offsetParent && /商品标题|30个汉字/.test(el.placeholder || '')
        );
        if (!inp) return null;
        if (inp.value === expected) return inp.value;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, expected);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.blur();
        return inp.value;
      }, t);
      if (now === t) return true;
      await page.waitForTimeout(400);
    }
    return false;
  };

  const forceRef = async () => {
    const ref = productData.ref_price;
    if (ref == null) return true;
    for (let i = 0; i < 3; i++) {
      const now = await page.evaluate((v) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        const inp = Array.from(document.querySelectorAll('input')).find(
          (el) => el.offsetParent && ((el.placeholder || '').includes('最大单买价') || (el.placeholder || '').includes('参考价'))
        );
        if (!inp) return null;
        setter.call(inp, String(v));
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.blur();
        return inp.value;
      }, ref);
      if (Number(now) === Number(ref)) return true;
      await page.waitForTimeout(400);
    }
    return false;
  };

  const forceBrand = async () => {
    const b = productData.brand || '';
    if (!b) return true;
    const now = await page.evaluate((v) => {
      const inp = Array.from(document.querySelectorAll('input')).find(
        (el) => el.offsetParent && /品牌名称/.test(el.placeholder || '')
      );
      if (!inp) return '';
      if (inp.value === v) return inp.value;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, v);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return inp.value;
    }, b);
    return now === b;
  };

  const forceMain = async () => {
    if (!mainFiles || !mainFiles.length) return true;
    // Identify the carousel zone positively; if we cannot, NEVER upload blindly.
    const z = await zoneByCounter(page, '商品轮播图', 10);
    if (z) {
      if (z.uploaded >= mainFiles.length || z.uploaded >= 10) return true;
      try {
        const viaZone = await uploadZone(page, '商品轮播图', 10, mainFiles, { timeoutMs: 30000 });
        if (viaZone.ok) return true;
      } catch (_) {}
    }
    // No identifiable carousel input on this page (e.g. 9228 form: main is set in
    // the category step, 辅助图/包装标签图 own the other /10 inputs). Trust the
    // carousel counter if it already shows the full set — do not touch other zones.
    const counters = await page.evaluate(() => (document.body.innerText.match(/已上传\s*(\d+)\s*\/\s*10/g) || []));
    const nums = counters.map((s) => Number((s.match(/(\d+)\s*\/\s*10/) || [])[1] || 0));
    const anyFull = nums.some((n) => n >= mainFiles.length || n >= 10);
    if (anyFull) return true;
    // last resort: only the input whose own block mentions 商品主图/轮播图 AND no other zone
    try {
      const mainIdx = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input[type=file]'));
        const mainRe = /商品主图|商品轮播图/;
        const otherRe = /包装标签|辅助图|商品详情|详情介绍|快捷编辑/;
        for (let i = 0; i < inputs.length; i++) {
          if (!/image/i.test(inputs[i].accept || '')) continue;
          let node = inputs[i].parentElement;
          let depth = 0;
          let inMain = false;
          let inOther = false;
          while (node && depth < 12) {
            const t = (node.innerText || '').slice(0, 600);
            if (mainRe.test(t)) inMain = true;
            if (otherRe.test(t)) inOther = true;
            node = node.parentElement;
            depth++;
          }
          if (inMain && !inOther) return i;
        }
        return -1;
      });
      if (mainIdx >= 0) {
        await page.locator('input[type=file]').nth(mainIdx).setInputFiles(mainFiles, { timeout: 30000 });
        const up = await waitForUploadProgress(page, {
          timeoutMs: 60000,
          expectMin: Math.min(mainFiles.length, 1),
          expectTotal: 10,
          pattern: /已上传\s*(\d+)\s*\/\s*(\d+)/g,
        });
        if (up.ok) return true;
      }
    } catch (_) {}
    const after = await page.evaluate(() => /已上传\s*[1-9]\d*\s*\/\s*10/.test(document.body.innerText));
    return after;
  };

  out.title = await forceTitle();
  out.ref = await forceRef();
  out.brand = await forceBrand();
  out.main = await forceMain();

  // Deep repair: empty SKU rows (stock/price/code) + missing preview images
  if (deep && Array.isArray(productData.skus) && productData.skus.length) {
    try {
      out.skuRows = await fillEmptySkuRows(page, productData);
    } catch (e) {
      out.skuRows = { ok: false, error: e.message };
    }
    try {
      out.previews = await uploadMissingPreviews(page, productData, { colorToFile, previewByCode });
    } catch (e) {
      out.previews = { ok: false, error: e.message };
    }
  }

  const snap = await page.evaluate(() => {
    const t = document.body.innerText || '';
    return {
      counters: t.match(/已上传\d+\/\d+/g) || [],
      errors: (t.match(/错误（\d+）/) || [])[0] || null,
      title: (Array.from(document.querySelectorAll('input')).find(
        (el) => el.offsetParent && /商品标题|30个汉字/.test(el.placeholder || '')
      ) || {}).value || '',
    };
  });
  out.counters = snap.counters;
  out.errors = snap.errors;
  out.titleValue = snap.title;
  out.pass = out.title && out.ref && out.brand && out.main
    && (!out.skuRows || out.skuRows.ok === true)
    && (!out.previews || out.previews.ok === true);
  return out;
}

/** Split spec-value inputs into [group0, group1] by the two type inputs' Y positions. */
async function specGroups(page) {
  return page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[placeholder="请输入规格名称"]')).filter((i) => i.offsetParent);
    const t1 = document.querySelector('input[placeholder="规格类型1"]');
    const t2 = document.querySelector('input[placeholder="规格类型2"]');
    const mid = ((t1 ? t1.getBoundingClientRect().top : 0) + (t2 ? t2.getBoundingClientRect().top : 1e9)) / 2;
    const g0 = [];
    const g1 = [];
    inputs.forEach((i) => {
      const v = i.value;
      if (!v || v === 'undefined') return;
      (i.getBoundingClientRect().top < mid ? g0 : g1).push(v);
    });
    return { t1: t1 ? t1.value : null, t2: t2 ? t2.value : null, g0, g1 };
  });
}

/**
 * Clear one spec-value group reliably: chipped inputs are controlled components —
 * clearing all at once gets rolled back, and one Backspace deletes only the
 * FOCUSED chip. So: focus the first chip of the group, Ctrl+A + Backspace,
 * re-query the group each iteration, and stop when the count stops dropping.
 */
async function clearSpecValues(page, groupIndex, { max = 40 } = {}) {
  const groupOf = (g) => (groupIndex === 0 ? g.g0 : g.g1);
  let removed = 0;
  for (let i = 0; i < max; i++) {
    const before = await specGroups(page);
    const list = groupOf(before);
    if (!list.length) break;
    const target = list[0];
    const focused = await page.evaluate((args) => {
      const { val, gi } = args;
      const inputs = Array.from(document.querySelectorAll('input[placeholder="请输入规格名称"]')).filter((x) => x.offsetParent);
      const t1 = document.querySelector('input[placeholder="规格类型1"]');
      const t2 = document.querySelector('input[placeholder="规格类型2"]');
      const mid = ((t1 ? t1.getBoundingClientRect().top : 0) + (t2 ? t2.getBoundingClientRect().top : 1e9)) / 2;
      const pool = inputs.filter((x) => {
        const v = x.value;
        if (!v || v === 'undefined') return false;
        return gi === 0 ? x.getBoundingClientRect().top < mid : x.getBoundingClientRect().top >= mid;
      });
      const el = pool.find((x) => x.value === val) || pool[0];
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.focus();
      el.click();
      return true;
    }, { val: target, gi: groupIndex });
    if (!focused) break;
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(320);
    const after = await specGroups(page);
    const afterList = groupOf(after);
    if (afterList.length >= list.length) {
      // no progress — try Delete + Enter once, then bail
      await page.keyboard.press('Delete').catch(() => {});
      await page.waitForTimeout(200);
      const retry = groupOf(await specGroups(page));
      if (retry.length >= list.length) break;
    }
    removed++;
  }
  const end = await specGroups(page);
  return { removed, remaining: groupOf(end).length, state: end };
}

/** Wait until the page exposes at least one image file input (slow new-flow pages). */
async function waitForImageInput(page, { timeoutMs = 30000, pollMs = 800 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type=file]'));
      return inputs.map((el, i) => ({ i, accept: (el.accept || '').slice(0, 30), image: /image/i.test(el.accept || '') }));
    });
    if (last.some((s) => s.image)) return last;
    await page.waitForTimeout(pollMs);
  }
  return last;
}

/**
 * Pick a category card by exact full path → ends-with-leaf → exact leaf.
 * Never substring: 墙贴 ⊂ 背景墙贴 (PE3→9228).
 */
async function pickCategoryExact(page, categoryText, cateId = '') {
  return page.evaluate((args) => {
    const { catText, cateId: cid } = args;
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const full = norm(catText);
    const leaf = full.split('>').pop().trim();

    if (cid) {
      const byId = Array.from(document.querySelectorAll('[data-tracking-params]')).find((el) =>
        new RegExp('choosen_cate=' + cid + '\\b').test(el.getAttribute('data-tracking-params') || '')
      );
      if (byId) { byId.click(); return { ok: true, how: 'cateId', text: norm(byId.innerText), verified: true }; }
    }

    // 兜底链逐级放宽，但**放宽时必须唯一命中且标注未核验**（2026-09-28 加固）：
    // 原来 `ends[0]` / `leafOnly[0]` 在多命中时也直接点第一个 → 与旧版页踩的
    // 「只比叶子名 → 背景墙贴也能通过」是同一类错。多命中现在一律失败，交调用方处理。
    const all = Array.from(document.querySelectorAll('div,span,li,a,p,label')).filter((el) => el.offsetParent);
    const exact = all.filter((el) => norm(el.innerText) === full);
    if (exact.length) {
      exact.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
      exact[0].click();
      return { ok: true, how: 'exact_full', text: full, verified: true };
    }
    if (leaf) {
      const ends = all.filter((el) => {
        const t = norm(el.innerText);
        return t.length <= full.length + 8 && (t.endsWith('> ' + leaf) || t.endsWith('>' + leaf));
      });
      if (ends.length === 1) {
        ends[0].click();
        return {
          ok: true, how: 'ends_with_leaf', text: norm(ends[0].innerText), verified: false,
          warn: '整条路径未全等，仅按「> 叶子」结尾唯一命中；调用方必须读回「商品分类」核验末段全等',
        };
      }
      if (ends.length > 1) {
        return { ok: false, how: 'ambiguous_ends_with_leaf', candidates: ends.map((e) => norm(e.innerText)).slice(0, 10) };
      }
      const leafOnly = all.filter((el) => norm(el.innerText) === leaf && el.children.length <= 3);
      if (leafOnly.length === 1) {
        leafOnly[0].click();
        return {
          ok: true, how: 'leaf_only', text: leaf, verified: false,
          warn: '只按叶子名唯一命中，风险最高；调用方必须读回「商品分类」核验',
        };
      }
      if (leafOnly.length > 1) {
        return { ok: false, how: 'ambiguous_leaf_only', candidates: leafOnly.map((e) => norm(e.innerText)).slice(0, 10) };
      }
    }
    return { ok: false, how: 'not_found' };
  }, { catText: categoryText || '', cateId: String(cateId || '') });
}

/**
 * Ensure each dimension holds exactly dimValues[i], committing chips ROBUSTLY.
 * PDD chip inputs are controlled: evaluate-set + Enter often leaves the value in the
 * trailing input without committing a chip/row (PE3→9228: 11/12 values → 33/36 rows).
 * Real click + type + Tab commits reliably; verify after each value.
 * @returns {Promise<{ok:boolean, added:string[], chips:object, retries:number}>}
 */
async function ensureSpecValuesRobust(page, dimNames, dimValues, { maxRetry = 3 } = {}) {
  const readChips = () => page.evaluate(() => {
    // 分组判据 = DOM 顺序相对「规格类型2」（2026-09-28 与 addSpecValues 统一）。
    // ⚠️ 原来用 y 坐标中点：型号值多到换行时中点判据失效，第二维的值会被判进第一维。
    const all = Array.from(document.querySelectorAll(
      'input[placeholder="规格类型1"], input[placeholder="规格类型2"], input[placeholder="请输入规格名称"]'));
    const t2i = all.findIndex((el) => el.placeholder === '规格类型2');
    const inputs = Array.from(document.querySelectorAll('input[placeholder="请输入规格名称"]')).filter((i) => i.offsetParent);
    return inputs.map((i, k) => ({
      k,
      v: i.value,
      y: Math.round(i.getBoundingClientRect().top),
      group: (t2i >= 0 && all.indexOf(i) > t2i) ? 1 : 0,
    }));
  });

  const added = [];
  let retries = 0;
  for (let gi = 0; gi < Math.min(dimNames.length, 2); gi++) {
    const want = dimValues[gi] || [];
    for (const v of want) {
      let list = await readChips();
      if (list.some((c) => c.v === v && c.group === gi)) continue;
      let committed = false;
      for (let attempt = 0; attempt < maxRetry && !committed; attempt++) {
        list = await readChips();
        const pool = list.filter((c) => c.group === gi);
        const target = pool.find((c) => !c.v);
        const idx = target ? target.k : (pool.length ? pool[pool.length - 1].k : -1);
        if (idx < 0) break;
        const inp = page.locator('input[placeholder="请输入规格名称"]').nth(idx);
        try {
          await inp.scrollIntoViewIfNeeded().catch(() => {});
          await inp.click({ timeout: 3000 });
          await page.keyboard.press('Control+A').catch(() => {});
          await page.keyboard.press('Backspace').catch(() => {});
          await page.waitForTimeout(250);
          await inp.type(v, { delay: 25 });
          await page.waitForTimeout(250);
          if (attempt === 0) await page.keyboard.press('Tab');
          else if (attempt === 1) { await page.keyboard.press('Enter'); await page.waitForTimeout(250); await page.keyboard.press('Tab'); }
          else { await page.keyboard.press('Enter'); await page.waitForTimeout(200); await page.keyboard.press('Enter'); await page.keyboard.press('Tab'); }
          await page.waitForTimeout(900);
        } catch (_) {}
        const after = await readChips();
        committed = after.some((c) => c.v === v && c.group === gi);
        if (!committed) retries++;
      }
      if (committed) added.push(`${dimNames[gi]}:${v}`);
    }
  }

  const chips = await readChips();
  const ok = dimNames.slice(0, 2).every((d, gi) => {
    const got = chips.filter((c) => c.group === gi).map((c) => c.v).filter(Boolean);
    return (dimValues[gi] || []).every((v) => got.includes(v));
  });
  return { ok, added, chips, retries };
}

async function fillEmptySkuRows(page, productData) {
  const dimNames = productData.dimensions || [];
  const skus = productData.skus || [];
  const flat = skus.map((s) => ({
    d0: String(s[dimNames[0]] ?? ''),
    d1: String(s[dimNames[1]] ?? ''),
    stock: String(s.stock),
    g: String(s.group_price),
    s: String(s.single_price),
    code: String(s.code || ''),
  }));
  let changed = 0;
  const meta = await getScrollMeta(page);
  for (let pass = 0; pass < 3; pass++) {
    for (let st = 0; st <= (meta.scrollHeight || 4000) + 600; st += 100) {
      await scrollTopTo(page, st, meta.depth);
      await page.waitForTimeout(45);
      changed += await page.evaluate((rows) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        const set = (el, v) => {
          setter.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        let lastD0 = '';
        let n = 0;
        for (const tr of Array.from(document.querySelectorAll('tbody tr'))) {
          const text = (tr.textContent || '').replace(/\s+/g, ' ');
          // ⚠️ 禁止「尾部子串」兜底（2026-09-28 PE5 实测踩坑）：
          // 同一档位下不同颜色的规格值**尾缀完全相同**（都以「…基础标准款/标准遮丑#】」结尾），
          // 尾部兜底会让 lastD0 永远粘在第一个颜色上 → 每行算出的 sku 都相同
          // → 目标值与现值相同 → **静默写入 0 次**，表现成「滚动不推进」的假象。
          // 行内文本被截断的情况交给最后那个 `lastD0 && sku.d0 !== lastD0` 分支 + sticky 继承处理。
          const hit = (hay, needle) => (needle ? hay.includes(needle) : false);
          for (const sku of rows) {
            if (sku.d0 && hit(text, sku.d0)) { lastD0 = sku.d0; break; }
          }
          const inputs = Array.from(tr.querySelectorAll('input[placeholder="请输入"]'));
          if (inputs.length < 3) continue;
          let best = null, score = 0;
          for (const sku of rows) {
            let sc = 0;
            if (lastD0 && sku.d0 === lastD0) sc += 3;
            if (sku.d1 && hit(text, sku.d1)) sc += 4;
            if (lastD0 && sku.d0 !== lastD0 && hit(text, sku.d0)) sc += 3; // row carried its own full name
            if (sc > score) { best = sku; score = sc; }
          }
          if (!best || score < 4) continue;
          // PDD pre-fills new SKU rows with "0" — treat 0 as unfilled, not as a value
          const unfilled = (v) => v === undefined || v === null || String(v).trim() === '' || String(v).trim() === '0';
          if (unfilled(inputs[0].value)) { set(inputs[0], best.stock); n++; }
          if (unfilled(inputs[1].value)) { set(inputs[1], best.g); n++; }
          if (inputs[2] && unfilled(inputs[2].value)) { set(inputs[2], best.s); n++; }
          const codeEl = inputs[inputs.length - 1];
          if (codeEl && unfilled(codeEl.value)) { set(codeEl, best.code); n++; }
        }
        return n;
      }, flat);
    }
    if (changed === 0) break;
  }

  const skuByKey = buildSkuByKey(skus, dimNames);
  const sticky = makeStickyMapRow(dimNames, skuByKey);
  const rowFilter = makeRowFilter(skus.flatMap((s) => dimNames.map((d) => s[d])));
  const read = await readAllSkuRows(page, { rowFilter, mapRow: (t, i) => sticky.map(t, i), step: 140, pauseMs: 80 });
  let okRows = 0;
  let stockSum = 0;
  const expectedSum = skus.reduce((a, s) => a + (Number(s.stock) || 0), 0);
  for (const [key, sku] of Object.entries(skuByKey)) {
    const row = read.rows.find((r) => (r.key || '') === key);
    if (!row) continue;
    const inputs = row.inputs || [];
    const code = inputs.length >= 4 ? inputs[inputs.length - 1] : inputs[3];
    if (String(inputs[0]) === String(sku.stock) && Number(inputs[1]) === Number(sku.group_price) && String(code) === String(sku.code)) {
      okRows++;
      stockSum += Number(inputs[0]) || 0;
    }
  }
  return {
    ok: okRows === skus.length && stockSum === expectedSum,
    rowsOk: okRows,
    rowsExpected: skus.length,
    stockSum,
    stockExpected: expectedSum,
    virtualRows: read.count,
    changed,
  };
}

/**
 * ★ 一趟完成「写值 + 读回校验」（2026-09-29 提速优化 #4）。
 *
 * 原做法是「先跑 3 轮滚动写值、再单独做一次全表并集扫描校验」——同一状态被扫两遍，
 * 而每次全表并集扫描都要滚完整表（约 30 步 × 每步重扫全部 `tbody tr`），是纯浪费。
 * 这里把**写**和**读**合进同一次滚动：每步既写缺失的值、又记录当前行的值/有无图，
 * 滚完即得校验结果。**扫描趟数从 3+1 降到 1~2。**
 *
 * @returns {Promise<{writes:number, covered:number, ok:number, img:number,
 *                    stockSum:number, expected:number, bad:Array, rounds:number}>}
 */
async function fillSkuRowsAndVerify(page, productData, { rounds = 2, step = 120, pauseMs = 70 } = {}) {
  const dimNames = productData.dimensions || [];
  const skus = productData.skus || [];
  const want = skus.map((s) => [`${s[dimNames[0]]}|${s[dimNames[1]]}`, s]);
  const D0 = [...new Set(skus.map((s) => String(s[dimNames[0]] ?? '')))];
  const D1 = [...new Set(skus.map((s) => String(s[dimNames[1]] ?? '')))];
  const tok = (v) => { const s = String(v ?? ''); const i = s.search(/[*（(【\[]/); return i > 0 ? s.slice(0, i) : s; };
  const T1 = D1.map(tok);
  const expected = skus.reduce((a, s) => a + (Number(s.stock) || 0), 0);

  let last = { writes: 0, covered: 0, ok: 0, img: 0, stockSum: 0, bad: [] };
  for (let round = 1; round <= rounds; round++) {
    const r = await page.evaluate(async (a) => {
      const { D0, D1, T1, want } = a;
      const wmap = new Map(want);
      const norm = (x) => { const y = Number(String(x ?? '').trim()); return Number.isFinite(y) ? y.toFixed(4) : String(x ?? '').trim(); };
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const setVal = (el, v) => {
        if (String(el.value) === String(v)) return false;
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      const sc = (() => { let c = Array.from(document.querySelectorAll('*')).filter((e) => e.querySelector && e.querySelector('tbody tr') && e.scrollHeight > e.clientHeight + 20 && /^(scroll|auto)$/.test(getComputedStyle(e).overflowY)); if (!c.length) c = Array.from(document.querySelectorAll('*')).filter((e) => e.tagName !== 'HTML' && e.tagName !== 'BODY' && e.scrollHeight > e.clientHeight + 40 && e.querySelector && e.querySelector('tbody tr')); return c; })();
      let n = document.querySelector('tbody tr')?.parentElement;
      while (n && n !== document.body) { if (n.scrollHeight > n.clientHeight + 20) sc.push(n); n = n.parentElement; }
      const all = Array.from(new Set(sc));
      const maxSh = Math.max(3000, ...all.map((e) => e.scrollHeight));
      const maxShArg = maxSh;
      const seen = new Map();
      let writes = 0; let sticky = '';
      // 一趟：写 + 读同时做
      const stepFn = () => {
        for (const tr of Array.from(document.querySelectorAll('tbody tr'))) {
          const text = (tr.textContent || '').replace(/\s+/g, ' ').trim();
          for (const v of D0) if (text.includes(v)) { sticky = v; break; }
          let d1 = '';
          // 全值精确匹配优先；token 兜底仅在「该 token 在本维度唯一」时使用。
          // 旧写法 `|| text.includes(T1[i])` 会在值共享前缀时静默错配：
          // D1 里 '30cm*1米/30cm*3米/30cm*5米' 的 tok 都是 '30cm'，
          // 首命中即 break → 所有 30cm*N米 行都被写成 30cm*1米 的价格/编码。
          for (let i = 0; i < D1.length; i++) if (text.includes(D1[i])) { d1 = D1[i]; break; }
          if (!d1) for (let i = 0; i < D1.length; i++) {
            const tk = T1[i];
            if (!tk || tk === D1[i]) continue;
            if (T1.filter((x) => x === tk).length > 1) continue;
            if (text.includes(tk)) { d1 = D1[i]; break; }
          }
          if (!sticky || !d1) continue;
          const key = `${sticky}|${d1}`;
          const w = wmap.get(key); if (!w) continue;
          const inputs = Array.from(tr.querySelectorAll('input[placeholder="请输入"]')).filter((e) => e.offsetParent);
          if (inputs.length !== 4) continue;
          const t = [String(w.stock), String(w.group_price), String(w.single_price), String(w.code)];
          for (let k = 0; k < 4; k++) if (setVal(inputs[k], t[k])) writes++;
          seen.set(key, { vals: inputs.map((e) => e.value), img: !!tr.querySelector('td.sku-preview-cell [class*=imageWrapper]') });
        }
      };
      all.forEach((e) => { e.scrollTop = 0; }); window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 200)); stepFn();
      for (let st = 0; st <= maxShArg + 600; st += a.step) {
        all.forEach((e) => { e.scrollTop = st; }); window.scrollTo(0, st);
        await new Promise((r) => setTimeout(r, a.pauseMs));
        document.querySelectorAll('tbody tr').length;   // 触发 re-render
        await new Promise((r) => setTimeout(r, 30));
        stepFn();
      }
      let ok = 0, img = 0; const bad = [];
      for (const [k, g] of seen) {
        const w = wmap.get(k); if (!w) { bad.push(k); continue; }
        const same = norm(g.vals[0]) === norm(w.stock) && norm(g.vals[1]) === norm(w.group_price)
          && norm(g.vals[2]) === norm(w.single_price) && String(g.vals[3]) === String(w.code);
        if (same) ok++; else bad.push(k);
        if (g.img) img++;
      }
      return { writes, covered: seen.size, ok, img, bad: bad.slice(0, 6),
        stockSum: Array.from(seen.values()).reduce((x, y) => x + (Number(y.vals[0]) || 0), 0) };
    }, { D0, D1, T1, want, step, pauseMs });
    last = { ...r, rounds: round };
    if (r.writes === 0) break;     // 没写入说明已就绪，不必再滚
  }
  return { ...last, expected };
}

/**
 * ★ 判定当前 `goods/category` 是**新版**还是**旧版**（2026-09-29 固化）。
 *
 * **同一个 URL 会渲染成两套完全不同的页面，所以绝不能按 URL 判分支** —— 必须现场探测。
 * 实测：9226 店铺A = 旧版；9228 店铺C = 新版（同一时段、同一 URL）。
 *
 * | 探测项 | 旧版 | 新版 |
 * |--------|------|------|
 * | `input[placeholder*="关键词搜索分类"]` | 1 | **0** |
 * | 真 `.choose-category` | ≥1 | **0** |
 * | 「确认发布该类商品」按钮 | 有 | 无 |
 * | 「下一步, 完善商品信息」+ `*商品主图` / `上传图片 (N/M)` | 无 | **有** |
 * | 主图在哪传 | 进表单后（`商品轮播图`） | **第一步就传** |
 * | 选类目方式 | `searchCategory(page, 路径, { confirm:true })` | `openManualCategoryPicker` + `searchCategory` |
 *
 * @returns {Promise<{kind:'old'|'new'|'unknown', evidence:object}>}
 */
async function detectCategoryPage(page) {
  const evidence = await page.evaluate(() => {
    const vis = Array.from(document.querySelectorAll('*')).filter((e) => e.offsetParent);
    const t = document.body.innerText || '';
    return {
      searchBox: vis.filter((e) => e.tagName === 'INPUT' && /关键词搜索分类/.test(e.placeholder || '')).length,
      chooseCategory: vis.filter((e) => /(^|\s)choose-category(\s|$)/.test(String(e.className))).length,
      publishBtn: /确认发布该类商品/.test(t),
      hasNext: /下一步/.test(t),
      hasMainLabel: /\*商品主图/.test(t) || /上传图片\s*\(\s*\d+\s*\/\s*\d+\s*\)/.test(t),
      fileInputs: document.querySelectorAll('input[type=file]').length,
    };
  });
  let kind = 'unknown';
  if (evidence.searchBox > 0 || evidence.chooseCategory > 0 || evidence.publishBtn) kind = 'old';
  else if (evidence.hasNext && evidence.hasMainLabel) kind = 'new';
  return { kind, evidence };
}

/**
 * 条件等待：轮询到「表单就绪」立刻继续，替代拍脑袋的固定等待（2026-09-29 优化 #3）。
 * 判据 = 商品标题输入框已存在 且 出现「提交并上架 / 保存草稿」。
 */
async function waitForFormReady(page, { timeoutMs = 45000, pollMs = 400 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await page.evaluate(() => {
      const t = document.body.innerText || '';
      return !!document.querySelector('input[placeholder*="商品标题"]') && /提交并上架|保存草稿/.test(t);
    }).catch(() => false);
    if (ok) return { ok: true, ms: Date.now() - t0 };
    await page.waitForTimeout(pollMs);
  }
  return { ok: false, reason: 'form_not_ready_timeout', ms: Date.now() - t0 };
}

/**
 * 条件等待：轮询某个图区的计数器达到目标（如 已上传10/10张），替代固定 9 秒等待（优化 #3）。
 * @param {number} total 期望张数
 */
async function waitForUploads(page, uploaded, { capacity = null, timeoutMs = 60000, pollMs = 400 } = {}) {
  // ⚠️ 分母是「分区容量」，不是文件数（2026-09-29 二次修正）：
  //   传 35 张到 50 容量的详情区 → 页面写的是「已上传35/50张」，
  //   我第一版按 uploaded/uploaded 去找「已上传35/35张」，永远等不到、白耗 45s 超时。
  //   轮播区 10/10 碰巧两个数一样，所以那次没暴露。
  // ⚠️ 2026-09-30：全文正则会假成功（GPVC-001 详情区 0/50 却报 uploaded=8）。
  //   调用方若传 zoneKey，必须走分区读回；这里保留全文仅作无分区时的弱兜底。
  const cap = capacity == null ? uploaded : capacity;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    // 两套文案 + 缩略图兜底（新版第一步传完后计数器文本会消失）
    const hit = await page.evaluate((a) => {
      const t = document.body.innerText || '';
      const { up, cap } = a;
      if (new RegExp('已上传\\s*' + up + '\\s*/\\s*' + cap + '\\s*张').test(t)) return 'counter_uploaded';
      if (new RegExp('上传图片\\s*\\(\\s*' + up + '\\s*/\\s*' + cap + '\\s*\\)').test(t)) return 'counter_upload_pic';
      // ⚠️ 缩略图兜底是**全页计数**，不区分图区：等轮播 10 张时，详情区已有的缩略图也能让它通过。
      // 所以把它单独标出来（how: 'thumbnail_fallback'），调用方/复核者要知道这条判据偏弱。
      const thumbs = document.querySelectorAll('[class*=uploadItem], [class*=imageWrapper], [class*=UploadItem]').length;
      return thumbs >= up ? 'thumbnail_fallback' : false;
    }, { up: uploaded, cap }).catch(() => false);
    if (hit) return { ok: true, ms: Date.now() - t0, how: hit };
    await page.waitForTimeout(pollMs);
  }
  return { ok: false, reason: 'upload_timeout', ms: Date.now() - t0, how: 'none' };
}

/**
 * 分区计数器读回（GPVC-001 2026-09-30 · 二次收紧）。
 * 只认「图区邻近文本里的 已上传N/total」，禁止全文匹配。
 * detail：必须 total===50 且邻近出现「快捷编辑」；优先可见 input（offsetParent）。
 */
async function readZoneCounter(page, keyword, total) {
  return page.evaluate((a) => {
    const { keyword, total } = a;
    const inputs = Array.from(document.querySelectorAll('input[type=file]'));
    const out = [];
    for (let i = 0; i < inputs.length; i++) {
      const el = inputs[i];
      if (!/image/i.test(el.accept || '')) continue;
      let node = el;
      let best = null;
      for (let k = 1; k <= 8 && node; k++) {
        node = node.parentElement;
        if (!node) break;
        const t = (node.innerText || '').replace(/\s+/g, ' ');
        const hasQuick = /快捷编辑/.test(t);
        const hasDetKw = t.includes('商品详情');
        const hasCarKw = t.includes('商品轮播图') || t.includes('商品主图');
        const hasPkgKw = t.includes('包装标签图');
        // 关键字必须出现在**本层或本层内计数器附近**，禁止爬到整页 root
        let hasKw = false;
        if (keyword === '商品详情') hasKw = hasQuick || hasDetKw;
        else if (keyword === '商品轮播图' || keyword === '商品主图') hasKw = hasCarKw && !hasQuick;
        else if (keyword === '包装标签图') hasKw = hasPkgKw && !hasCarKw;
        else hasKw = t.includes(keyword);
        if (!hasKw) continue;
        const m = t.match(/已上传\s*(\d+)\s*\/\s*(\d+)\s*张?/) || t.match(/已上传\s*\((\d+)\s*\/\s*(\d+)\)/) || t.match(/上传图片\s*[\(（]\s*(\d+)\s*[\/／]\s*(\d+)/);
        if (!m) continue;
        const uploaded = Number(m[1]);
        const cap = Number(m[2]);
        if (total != null && cap !== total) continue;
        // 关键字与计数器邻近
        const kwPos = Math.max(t.indexOf('快捷编辑'), t.indexOf(keyword));
        const cntPos = t.indexOf('已上传') >= 0 ? t.indexOf('已上传') : t.indexOf('上传图片');
        if (kwPos >= 0 && cntPos >= 0 && Math.abs(kwPos - cntPos) > 160) continue;
        const score = (el.offsetParent ? 0 : 100) + k;
        if (!best || score < best.score) {
          best = { idx: i, uploaded, total: cap, k, score, offset: !!el.offsetParent, near: t.slice(0, 90) };
        }
      }
      if (best) out.push(best);
    }
    out.sort((a, b) => a.score - b.score || a.k - b.k);
    return out;
  }, { keyword, total });
}

/**
 * 分区上传确认：轮询该区计数器，达到 expectN 才算成功。
 * detail 一律禁止 zone_thumbnails（GPVC-001：全页缩略图把 0/50 误判成成功）。
 */
async function waitForZoneCounter(page, keyword, total, expectN, { timeoutMs = 60000, pollMs = 400 } = {}) {
  const t0 = Date.now();
  let last = null;
  const allowThumb = keyword !== '商品详情';
  while (Date.now() - t0 < timeoutMs) {
    const list = await readZoneCounter(page, keyword, total).catch(() => []);
    last = list && list.length ? list[0] : null;
    if (last && last.uploaded >= expectN) {
      return { ok: true, uploaded: last.uploaded, total: last.total, ms: Date.now() - t0, how: 'zone_counter', idx: last.idx };
    }
    // 非详情区：仅在**同一 narrow 祖先**（含该区关键字+计数器）里数缩略图，且该祖先 total 匹配
    if (allowThumb && expectN > 0 && last && last.uploaded === 0) {
      const zoneThumbs = await page.evaluate((a) => {
        const { keyword, total, expectN } = a;
        const inputs = Array.from(document.querySelectorAll('input[type=file]'));
        let bestN = 0;
        for (const el of inputs) {
          if (!/image/i.test(el.accept || '')) continue;
          let node = el.parentElement;
          for (let k = 1; k <= 8 && node; k++) {
            const t = (node.innerText || '').replace(/\s+/g, ' ');
            const okKw = keyword === '商品详情'
              ? (t.includes('快捷编辑') || t.includes('商品详情'))
              : (t.includes(keyword) || (keyword === '商品轮播图' && (t.includes('商品轮播图') || t.includes('商品主图'))));
            const m = t.match(/已上传\s*\d+\s*\/\s*(\d+)\s*张?/);
            if (okKw && m && Number(m[1]) === total) {
              const n = node.querySelectorAll('[class*=imageWrapper], [class*=uploadItem], [class*=UploadItem]').length;
              if (n > bestN) bestN = n;
            }
            node = node.parentElement;
          }
        }
        return bestN;
      }, { keyword, total, expectN }).catch(() => 0);
      if (zoneThumbs >= expectN) {
        return { ok: true, uploaded: zoneThumbs, total, ms: Date.now() - t0, how: 'zone_thumbnails', idx: last.idx };
      }
    }
    await page.waitForTimeout(pollMs);
  }
  return { ok: false, uploaded: last ? last.uploaded : null, total: last ? last.total : total,
           ms: Date.now() - t0, how: 'zone_timeout', idx: last ? last.idx : null };
}

/**
 * 在「快捷编辑 + 已上传N/total」容器内定位 file input。
 * 返回 elementHandle；找不到返回 null。
 * 详情区专用：禁止全局 nth(idx)（GPVC-001 新页刚加载时 idx 会错）。
 */
async function locateZoneFileHandle(page, keyword, total) {
  // 轮询最多 8s 等详情区渲染
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const h = await page.evaluateHandle((a) => {
      const { keyword, total } = a;
      // 先找「快捷编辑」叶子，再向上找带计数器的容器
      const leaves = Array.from(document.querySelectorAll('*')).filter((el) => {
        if (el.children.length) return false;
        const s = (el.textContent || '').trim();
        return s === '快捷编辑' || s.startsWith('快捷编辑');
      });
      const roots = leaves.length ? leaves : Array.from(document.querySelectorAll('*')).filter((el) => {
        if (el.children.length) return false;
        return (el.textContent || '').trim() === keyword;
      });
      for (const leaf of roots) {
        let p = leaf.parentElement;
        for (let k = 1; k <= 10 && p; k++) {
          const t = (p.innerText || '').replace(/\s+/g, ' ');
          const hasQuick = keyword !== '商品详情' || /快捷编辑/.test(t);
          const hasKw = keyword === '商品详情' ? (hasQuick || t.includes('商品详情')) : t.includes(keyword);
          const m = t.match(/已上传\s*(\d+)\s*\/\s*(\d+)\s*张?/) || t.match(/已上传\s*\((\d+)\s*\/\s*(\d+)\)/);
          if (hasKw && m && Number(m[2]) === total) {
            // 在本容器内找 image file input（不爬到整页）
            const inp = p.querySelector('input[type=file]');
            if (inp && /image/i.test(inp.accept || '') && /image/.test(inp.accept || 'image')) {
              return inp;
            }
            // 容器内可能有多个，取第一个 image
            const imgs = Array.from(p.querySelectorAll('input[type=file]')).filter((e) => /image/i.test(e.accept || ''));
            if (imgs.length) return imgs[0];
          }
          p = p.parentElement;
        }
      }
      return null;
    }, { keyword, total });
    const el = h.asElement();
    if (el) {
      // 确认仍挂在文档里
      const ok = await el.evaluate((n) => !!(n && n.isConnected && n.offsetParent !== null)).catch(() => false);
      if (ok) return el;
    }
    await page.waitForTimeout(400);
  }
  return null;
}

async function uploadZoneFast(page, keyword, total, files, { timeoutMs = 90000, waitMs = 45000 } = {}) {
  // 详情区：先等「可见的快捷编辑 + N/50」容器真正渲染出来（新页刚加载时 DOM 不稳）
  if (keyword === '商品详情') {
    await page.waitForFunction((tot) => {
      const inputs = Array.from(document.querySelectorAll('input[type=file]'));
      return inputs.some((el) => {
        if (!el || el.offsetParent === null) return false;
        if (!/image/i.test(el.accept || '')) return false;
        let p = el.parentElement;
        for (let k = 0; k < 8 && p; k++) {
          const t = (p.innerText || '').replace(/\s+/g, ' ');
          if (/快捷编辑/.test(t) && new RegExp('已上传\\s*\\d+\\s*/\\s*' + tot + '\\s*张?').test(t)) return true;
          p = p.parentElement;
        }
        return false;
      });
    }, total, { timeout: 15000 }).catch(() => {});
  }

  // 1) 优先：容器内定位（详情区必须走这条）
  let handle = null;
  let idx = null;
  let lockedBy = 'zone_container';
  if (keyword === '商品详情' || keyword === '包装标签图' || keyword === '商品轮播图' || keyword === '商品主图') {
    const el = await locateZoneFileHandle(page, keyword, total);
    if (el) {
      try {
        const n = await el.evaluate((node) => Array.from(document.querySelectorAll('input[type=file]')).indexOf(node));
        if (n >= 0) { idx = n; handle = { kind: 'nth', idx }; }
      } catch (_) { idx = null; }
      // 详情区额外要求 input 可见
      if (handle && keyword === '商品详情') {
        const vis = await el.evaluate((node) => node.offsetParent !== null).catch(() => false);
        if (!vis) { handle = null; idx = null; }
      }
    }
  }
  if (!handle) {
    // 2) 退回 readZoneCounter idx，但详情仍要求 offset+k 紧邻快捷编辑
    const zoneList = await readZoneCounter(page, keyword, total).catch(() => []);
    let zone = zoneList && zoneList.length ? zoneList[0] : null;
    if (keyword === '商品详情' && zone && !(zone.offset && zone.k <= 6 && /快捷编辑/.test(zone.near || ''))) {
      zone = null; // 不接受非快捷编辑容器
    }
    if (!zone) zone = await zoneByCounter(page, keyword, total);
    if (!zone || zone.idx < 0) return { ok: false, reason: 'zone_not_found', keyword, total };
    idx = zone.idx;
    handle = { kind: 'nth', idx };
    lockedBy = 'zone_idx';
  }
  if (!handle) return { ok: false, reason: 'zone_not_found', keyword, total };

  try {
    // 2026-10-05 修复：locateZoneFileHandle 返回的可能是 Locator（旧版页轮播区实测），
    // 而 Locator 没有 setInputFiles → 旧实现直接抛 "handle.setInputFiles is not a function"，
    // 主图静默 0/10 且 validateForm 当时不查主图 → 漏检。两种句柄都支持。
    if (handle.kind === 'nth') {
      await page.locator('input[type=file]').nth(handle.idx).setInputFiles(files, { timeout: timeoutMs });
    } else if (typeof handle.setInputFiles === 'function') {
      await handle.setInputFiles(files, { timeout: timeoutMs });
    } else {
      // Locator → 转成元素下标再 setInputFiles
      const n = await handle.evaluate((node) => Array.from(document.querySelectorAll('input[type=file]')).indexOf(node));
      if (n < 0) throw new Error('locator_not_in_file_inputs');
      await page.locator('input[type=file]').nth(n).setInputFiles(files, { timeout: timeoutMs });
    }
  } catch (e) {
    return { ok: false, reason: 'setInputFiles_failed', error: e.message, idx, keyword };
  }

  // 3) 确认（详情：分区计数器；主图/轮播：先快速判据，避免旧版页假失败白等）
  const isMainZone = keyword === '商品轮播图' || keyword === '商品主图';
  if (isMainZone) {
    // 刚 setInputFiles 时页面计数器还没翻，所以轮询 6×700ms 再用兜底
    for (let i = 0; i < 6; i++) {
      const quick = await quickZoneCount(page, keyword, total);
      if (quick.counter === files.length || quick.thumbs >= files.length) {
        return {
          ok: true, expect: files.length, uploaded: files.length, waitMs: i * 700,
          how: 'bare_setInputFiles',
          confirmedBy: quick.counter === files.length ? 'main_counter_quick' : quick.how,
          idx, lockedBy,
        };
      }
      await page.waitForTimeout(700);
    }
  }
  let w = await waitForZoneCounter(page, keyword, total, files.length, { timeoutMs: waitMs, pollMs: 400 });
  if (!w.ok && isMainZone) {
    // 兜底：旧版页分区计数器读不到，用「邻近文本 + 分区缩略图」再判一次
    const quick = await quickZoneCount(page, keyword, total);
    if (quick.counter === files.length || quick.thumbs >= files.length) {
      w = { ok: true, ms: w.ms, how: quick.counter === files.length ? 'main_counter_fallback' : quick.how, uploaded: files.length };
    } else {
      const ms = await mainImagesState(page).catch(() => null);
      if (ms && ms.uploaded === files.length) {
        w = { ok: true, ms: w.ms, how: 'main_counter_fallback', uploaded: ms.uploaded };
      } else if (ms) {
        w = { ok: false, reason: `main_counter_mismatch:${ms.uploaded}/${ms.total}`, ms: w.ms, how: 'main_counter_fallback', uploaded: ms.uploaded };
      }
    }
  }

  // 4) 详情：落稳后再读一次（防规格/SKU 重渲染冲掉，或计数器瞬时假 8）
  if (keyword === '商品详情') {
    await page.waitForTimeout(2500);
    const stable = await readZoneCounter(page, keyword, total).catch(() => []);
    const st = stable && stable.length ? stable[0] : null;
    if (!st || st.uploaded < files.length) {
      return {
        ok: false,
        expect: files.length,
        uploaded: st ? st.uploaded : null,
        waitMs: w.ms,
        how: 'bare_setInputFiles',
        confirmedBy: 'detail_unstable_after_upload',
        idx,
        lockedBy,
      };
    }
  }

  return {
    ok: !!w.ok,
    expect: files.length,
    uploaded: w.uploaded == null ? 0 : w.uploaded,
    waitMs: w.ms,
    how: 'bare_setInputFiles',
    confirmedBy: w.how,
    idx,
    lockedBy,
  };
}

/** Packaging label must stay empty unless material provided. */
async function readDropdownFieldValue(page, label) {
  return page.evaluate((lab) => {
    const vis = (el) => !!(el && el.offsetParent);
    const nodes = Array.from(document.querySelectorAll('*')).filter((el) => {
      if (!vis(el) || el.children.length > 0) return false;
      const t = (el.textContent || '').trim();
      return t === lab || t === '*' + lab || t === '重要 ' + lab || t.endsWith(lab);
    });
    for (const node of nodes) {
      let row = node;
      for (let i = 0; i < 6 && row; i++) {
        row = row.parentElement;
        if (!row) break;
        const inp = Array.from(row.querySelectorAll('input')).find((e) => vis(e) && e.type !== 'file'
          && /请选择|请输入/.test(e.placeholder || ''));
        if (inp) return { found: true, value: inp.value || '', placeholder: inp.placeholder || '' };
        // ST_select 的已选值有时不在 input.value，而在同行的文本里
        const sel = Array.from(row.querySelectorAll('[class*=selectValue],[class*=SelectValue],[class*=selection]')).find(vis);
        if (sel && (sel.textContent || '').trim()) return { found: true, value: (sel.textContent || '').trim(), placeholder: '' };
      }
    }
    return { found: false, value: null, placeholder: null };
  }, label).catch(() => ({ found: false, value: null, placeholder: null }));
}

async function packagingLabelState(page) {
  return page.evaluate(() => {
    // ⚠️ 2026-10-20 实测：左侧「发布助手」引导面板里也有「包装标签图 暂无相关内容」，
    // 旧正则从它往后 200 字内扫，会抢先匹配到**商品轮播图**的「已上传10/10」→
    // packaging_label 假失败（这条链上 17 条正常、1 条报错）。
    // 修法：先把引导面板（guide-* / fix-nav）从副本里删掉，再匹配真实表单里的计数。
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('[class*=guide], [class*=fix-nav]').forEach((e) => e.remove());
    const t = (clone.innerText || '').replace(/\s+/g, ' ');
    const m = t.match(/包装标签图[\s\S]{0,200}?已上传\s*(\d+)\s*\/\s*(\d+)\s*张?/);
    return m ? { uploaded: Number(m[1]), total: Number(m[2]) } : null;
  });
}

/**
 * 主图/轮播区状态（2026-10-05 补：validateForm 原先**完全不查主图**，
 * 旧版页 setInputFiles 抛错后主图 0/10 仍然 allPass → 漏检）。
 * 认两套文案：旧版「已上传N/10张」、新版第一步「上传图片 (N/10)」。
 * @returns {Promise<{uploaded:number,total:number}|null>}
 */
async function mainImagesState(page) {
  return page.evaluate(() => {
    const t = document.body.innerText || '';
    const m = t.match(/(?:商品轮播图|商品主图)[\s\S]{0,240}?(?:已上传\s*(\d+)\s*\/\s*(\d+)\s*张?|上传图片\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\))/);
    if (!m) return null;
    return m[1] != null
      ? { uploaded: Number(m[1]), total: Number(m[2]) }
      : { uploaded: Number(m[3]), total: Number(m[4]) };
  });
}

/**
 * 主图/轮播区「快速判定」（2026-10-05）：
 * 旧版页 `readZoneCounter('商品轮播图')` 恒返回空 → `waitForZoneCounter` 必然等满 45–60s，
 * 而图其实已经上传成功（假失败）。这里用两条独立判据先判，命中即跳过等待：
 *   ① 邻近文本里的 `已上传N/10张` / `上传图片 (N/10)`  ② 分区内的缩略图数
 * @returns {Promise<{counter:number|null,thumbs:number,how:string}>}
 */
async function quickZoneCount(page, keyword, capacity = 10) {
  return page.evaluate((a) => {
    const { kw, cap } = a;
    const b = document.body.innerText || '';
    const re = new RegExp(kw + '[\\s\\S]{0,240}?(?:已上传\\s*(\\d+)\\s*/\\s*' + cap + '|上传图片\\s*\\(\\s*(\\d+)\\s*/\\s*' + cap + ')');
    const m = b.match(re);
    const counter = m ? Number(m[1] != null ? m[1] : m[2]) : null;
    let thumbs = 0;
    for (const el of Array.from(document.querySelectorAll('input[type=file]'))) {
      let p = el.parentElement;
      for (let k = 0; k < 8 && p; k++) {
        const t = (p.innerText || '').replace(/\s+/g, ' ');
        if (new RegExp(kw).test(t) && /(?:已上传\s*\d+\s*\/\s*\d+|上传图片\s*\()/.test(t)) {
          thumbs = p.querySelectorAll('[class*=uploadItem], [class*=imageWrapper], [class*=UploadItem]').length;
          return { counter, thumbs, how: thumbs >= cap ? 'zone_thumb_quick' : 'zone_counter_quick' };
        }
        p = p.parentElement;
      }
    }
    return { counter, thumbs, how: 'page_thumb_quick' };
  }, { kw: keyword, cap: capacity }).catch(() => ({ counter: null, thumbs: 0, how: 'quick_failed' }));
}

/**
 * 逐行数预览图（正向判据，供 validateForm 用）。
 * 只滚真正带 overflow:scroll|auto 的 SKU 容器；第二维用全值精确匹配。
 * @returns {Promise<{total:number, withImg:number, missing:string[]}|{error:string}>}
 */
async function countPreviewCells(page, dimNames, dimValues) {
  const V0 = (dimValues[0] || []).map(String);
  const V1 = (dimValues[1] || []).map(String);
  return page.evaluate(async (a) => {
    const { V0, V1 } = a;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const cands = Array.from(document.querySelectorAll('*')).filter((e) => {
      const oy = getComputedStyle(e).overflowY;
      return (oy === 'scroll' || oy === 'auto') && e.scrollHeight > e.clientHeight + 20 && e.querySelector && e.querySelector('tbody tr');
    });
    const sc = cands.sort((x, y) => y.scrollHeight - x.scrollHeight)[0];
    if (!sc) return { error: 'no_container' };
    const seen = new Map();
    const collect = () => {
      let sticky = '';
      for (const tr of Array.from(document.querySelectorAll('tbody tr'))) {
        const text = (tr.textContent || '').replace(/\s+/g, ' ').trim();
        for (const v of V0) if (text.includes(v)) { sticky = v; break; }
        let d1 = '';
        for (const v of V1) if (text.includes(v)) { d1 = v; break; }
        if (!sticky || !d1) continue;
        seen.set(sticky + '|' + d1, !!tr.querySelector('td.sku-preview-cell [class*=imageWrapper]'));
      }
    };
    sc.scrollTop = 0; await wait(220); collect();
    const stepPx = Math.max(60, Math.floor(sc.clientHeight / 8));
    for (let st = 0; st <= sc.scrollHeight + 200; st += stepPx) {
      sc.scrollTop = st; await wait(70); collect();
    }
    sc.scrollTop = 0;
    const missing = Array.from(seen.entries()).filter(([, has]) => !has).map(([k]) => k);
    return { total: seen.size, withImg: seen.size - missing.length, missing };
  }, { V0, V1 });
}

// ---------- spec table (from Excel dimensions) ----------
async function setSpecType(page, typeIndex, name) {
  const ph = typeIndex === 0 ? '规格类型1' : '规格类型2';
  const el = page.locator(`input[placeholder="${ph}"]`).first();
  if (!(await el.count().catch(() => 0))) return false;

  // Open the ST_select wrapper (not the bare input — bare click hits table headers)
  await page.evaluate((ph2) => {
    const inp = document.querySelector(`input[placeholder="${ph2}"]`);
    if (!inp) return;
    let n = inp;
    for (let i = 0; i < 8 && n; i++) {
      const cls = (n.className || '').toString();
      if (/ST_selectValueSingle|selectValue|ST_select/i.test(cls)) {
        n.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        n.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        n.click();
        return;
      }
      n = n.parentElement;
    }
    inp.click();
  }, ph);
  await page.waitForTimeout(500);

  // Portal options: role=option; label may include badge text e.g. "尺寸常用"
  const picked = await page.evaluate((n) => {
    const opts = Array.from(document.querySelectorAll('[role="option"]'))
      .filter((el) => el.offsetParent);
    if (!opts.length) return 'no_options';
    let target = opts.find((el) => (el.textContent || '').trim() === n);
    if (!target) {
      target = opts.find((el) => {
        const t = (el.textContent || '').trim();
        return t === n || t.startsWith(n) || t.includes(n);
      });
    }
    if (!target) return 'no_match:' + opts.map((el) => (el.textContent || '').trim()).slice(0, 8).join(',');
    target.click();
    return 'ok:' + (target.textContent || '').trim();
  }, name);
  await page.waitForTimeout(500);

  const val = await el.inputValue().catch(() => '');
  return val === name || String(picked).startsWith('ok:');
}

async function addSpecValues(page, typeIndex, values) {
  for (const v of values) {
    await page.evaluate((args) => {
      const { value, typeIndex } = args;
      const inputs = Array.from(document.querySelectorAll('input[placeholder="请输入规格名称"]')).filter(
        (el) => el.offsetParent
      );
      // 分组判据必须用「DOM 顺序相对 规格类型2」——不要用 y 坐标中点切（2026-09-28 PE5 实测：
      // 型号值多到换行时中点判据失效，第二维的最后一个值会被写进第一维）。
      const all = Array.from(document.querySelectorAll(
        'input[placeholder="规格类型1"], input[placeholder="规格类型2"], input[placeholder="请输入规格名称"]'));
      const t2i = all.findIndex((el) => el.placeholder === '规格类型2');
      const candidates = inputs.filter((inp) => {
        const di = all.indexOf(inp);
        if (di < 0) return false;
        return typeIndex === 0 ? (t2i < 0 || di < t2i) : di > t2i;
      });
      const target = candidates.find((inp) => !inp.value) || candidates[candidates.length - 1];
      if (!target) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(target, value);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      target.focus();
    }, { value: v, typeIndex });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(350);
  }
}

/**
 * 旧版分类页的**唯一正确**选择方式：搜索关键词 → 在下拉里按「完整路径全等」选 → 读回已选。
 * （2026-09-28 PE5 固化）
 *
 * ⚠️ 禁止的两个捷径：
 *  1. 直接点「最近使用的分类」里的 `.choose-category` —— 该栏不一定有目标类目，且
 *     它的文本与下拉项**完全相同**，用「文本全等」会命中 2 个元素，取错就静默选错类目。
 *  2. 用 `includes` 匹配 —— 搜「墙贴」时同一屏会出现 `家居饰品 > 贴饰 > 背景墙贴`、
 *     `家装主材 > 背景墙/工艺软包 > 软包墙贴`、`…> 儿童玩具墙贴`，以及 `PVC墙纸`/`铝箔墙纸`，
 *     子串匹配必错。必须**整条路径全等**。
 *
 * 下拉项选择器：`li[class*=searchItem]`（实测 `LI.SPP_searchItem_5-188-0`）。
 * 门禁：下拉里全等命中必须**恰好 1 条**；0 条或多条都返回 ok:false（多条说明判据不够严）。
 *
 * @returns {Promise<{ok:boolean, chosen?:string, leaf?:string, reason?:string, seen?:string[]}>}
 */
async function searchCategory(page, categoryText, { keyword = '', timeoutMs = 25000, confirm = false } = {}) {
  const target = String(categoryText || '').replace(/\s*>\s*/g, ' > ').trim();
  if (!target) return { ok: false, reason: 'empty_category' };
  const leaf = target.split('>').pop().trim();
  const kw = keyword || leaf;

  const box = page.locator('input[placeholder*="关键词搜索分类"]').first();
  if (!(await box.count().catch(() => 0))) return { ok: false, reason: 'search_box_not_found' };
  await box.click({ timeout: 15000 });
  await box.fill(kw);

  const deadline = Date.now() + timeoutMs;
  let strict = [];
  let seen = [];
  while (Date.now() < deadline) {
    await page.waitForTimeout(700);
    const r = await page.evaluate((t) => {
      const items = Array.from(document.querySelectorAll('li[class*=searchItem], li[class*=SearchItem]'))
        .filter((e) => e.offsetParent);
      const seg = (s) => String(s || '').split('>').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
      const ts = seg(t);
      const texts = items.map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim());
      // 后缀匹配：候选分段 == 目标分段的尾部（平台下拉可能不带顶级前缀）
      const isHit = (x) => {
        const a = seg(x);
        if (!a.length || a.length > ts.length) return false;
        for (let i = 0; i < a.length; i++) if (a[a.length - 1 - i] !== ts[ts.length - 1 - i]) return false;
        return true;
      };
      return { exact: texts.filter(isHit), all: Array.from(new Set(texts)) };
    }, target);
    strict = r.exact;
    seen = r.all;
    if (strict.length) break;
  }

  if (strict.length === 0) return { ok: false, reason: 'no_exact_match', seen };
  if (strict.length > 1) return { ok: false, reason: `ambiguous_exact_match(${strict.length})`, seen };

  const clicked = await page.evaluate((t) => {
    const el = Array.from(document.querySelectorAll('li[class*=searchItem], li[class*=SearchItem]'))
      .filter((e) => e.offsetParent)
      .find((e) => {
        const seg = (s) => String(s || '').split('>').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
        const a = seg((e.textContent || '').replace(/\s+/g, ' ').trim());
        const b = seg(t);
        if (!a.length || a.length > b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[a.length - 1 - i] !== b[b.length - 1 - i]) return false;
        return true;
      });
    if (!el) return false;
    el.click();
    return true;
  }, target);
  if (!clicked) return { ok: false, reason: 'click_failed', seen };
  await page.waitForTimeout(1800);

  const readback = await page.evaluate(() => {
    const t = document.body.innerText || '';
    const m = t.match(/已选分类\s*([^\n]{0,80})/);
    return m ? m[1].replace(/\s+/g, ' ').trim() : null;
  });
  const chosenNorm = readback ? readback.replace(/\s*>\s*/g, ' > ').trim() : null;
  // 读回也用「分段后缀匹配」：下拉不带顶级前缀时，「已选分类」同样可能只给后半段
  if (!pathSuffixMatch(chosenNorm, target)) {
    return { ok: false, reason: 'selected_mismatch', chosen: chosenNorm, seen };
  }
  // confirm=true 时顺手点掉确认按钮。两套页面的确认文案不同，按优先级探测：
  //   新版「手动选择商品分类」弹窗 → `确认`（弹窗内，精确文本）
  //   旧版分类页                  → `确认发布该类商品`
  let confirmed = null;
  if (confirm) {
    const exact = page.locator('button', { hasText: /^\s*确认\s*$/ }).first();
    if (await exact.count().catch(() => 0)) {
      await exact.click({ timeout: 8000 }).catch(() => {});
      confirmed = '确认';
    } else {
      const pub = page.locator('button', { hasText: '确认发布该类商品' }).first();
      if (await pub.count().catch(() => 0)) {
        await pub.click({ timeout: 8000 }).catch(() => {});
        confirmed = '确认发布该类商品';
      }
    }
    await page.waitForTimeout(2000);
  }
  return { ok: true, chosen: chosenNorm, leaf, seen, confirmed };
}

/**
 * 打开「推荐类目卡 → 没有满意的推荐结果？→ 手动选择商品分类」弹窗（2026-09-28 9228 固化）。
 *
 * **为什么优先走这个而不是直接点推荐卡**：推荐卡只给约 10 条预测候选，
 * 目标不在其中就没有出路，而且候选里常混着高度近似的项（9228 实测目标第 1 条，
 * 第 2 条紧挨着就是「背景墙贴」）。弹窗里是**全量搜索**，结构与旧版分类页一致
 * （`input[placeholder*="关键词搜索分类"]` + `li[class*=searchItem]` + `已选分类` 读回 + `确认` 按钮），
 * 因此进去后直接 `searchCategory(page, 路径, { confirm: true })` 即可。
 *
 * 前置条件：必须先完成「主图 + 标题 + 真实聚焦后点空白处失焦」，推荐卡（连同这个入口）才会出现。
 * @returns {Promise<{ok:boolean, how:string}>}
 */
async function openManualCategoryPicker(page, { timeoutMs = 25000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = { ok: false, how: 'button_not_found' };
  while (Date.now() < deadline) {
    const r = await page.evaluate(() => {
      const vis = Array.from(document.querySelectorAll('*')).filter((e) => e.offsetParent);
      if (vis.some((e) => e.tagName === 'INPUT' && /关键词搜索分类/.test(e.placeholder || ''))) {
        return { ok: true, how: 'already_open' };
      }
      const btns = vis.filter((e) => e.tagName === 'BUTTON' && /手动选择商品分类/.test(e.innerText || ''));
      if (btns.length) { btns[0].click(); return { ok: true, how: 'clicked' }; }
      // ⚠️ 入口常被折叠：推荐卡只先显示很少几条，此时**没有**「手动选择商品分类」按钮。
      // 必须先点「查看更多推荐」把列表展开，入口才出现（2026-09-28 用户指出 + 实测：
      // 确认过一次类目后按钮消失，只有点「查看更多推荐」才回来）。
      const more = vis.filter((e) => {
        const t = (e.innerText || '').replace(/\s+/g, ' ').trim();
        return /查看更多推荐/.test(t) && t.length < 30;
      });
      if (more.length) { more[more.length - 1].click(); return { ok: false, how: 'expanded_more' }; }
      return { ok: false, how: 'nothing_to_click' };
    });
    if (r.ok) {
      if (r.how === 'clicked') await page.waitForTimeout(3500);
      return r;
    }
    last = r;
    await page.waitForTimeout(2000);
  }
  return last;
}

/**
 * 读规格 chip 并按「DOM 顺序相对 规格类型2」分组（2026-09-28 PE5 固化）。
 * 不用 y 坐标：型号值换行后中点判据会失效。
 * 返回 { t1, t2, g0, g1 }，只含**有值**的 chip。
 */
async function readSpecGroups(page) {
  return page.evaluate(() => {
    const all = Array.from(document.querySelectorAll(
      'input[placeholder="规格类型1"], input[placeholder="规格类型2"], input[placeholder="请输入规格名称"]'));
    const t2i = all.findIndex((e) => e.placeholder === '规格类型2');
    const g0 = [];
    const g1 = [];
    all.forEach((e, i) => {
      if (e.placeholder !== '请输入规格名称') return;
      const v = (e.value || '').trim();
      if (!v) return;
      (t2i >= 0 && i > t2i ? g1 : g0).push(v);
    });
    return {
      t1: document.querySelector('input[placeholder="规格类型1"]')?.value || '',
      t2: document.querySelector('input[placeholder="规格类型2"]')?.value || '',
      g0, g1,
    };
  });
}

/**
 * 按**精确值**删掉某一个规格 chip（真实 click + Ctrl+A + Backspace + Tab）。
 * 修「第二维的值被写进第一维」时必须用它，不能整组清空。
 */
async function removeSpecValue(page, value) {
  const idx = await page.evaluate((val) => {
    const els = Array.from(document.querySelectorAll('input[placeholder="请输入规格名称"]'));
    return els.findIndex((e) => e.offsetParent && (e.value || '').trim() === String(val).trim());
  }, value);
  if (idx < 0) return { ok: false, reason: 'chip_not_found', value };
  const chip = page.locator('input[placeholder="请输入规格名称"]').nth(idx);
  await chip.click({ timeout: 8000 });
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(150);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(700);
  return { ok: true, value };
}

/**
 * ★ 规格值预检：PDD 对规格值有两条硬限制，违反会直接「**数据错误，请刷新页面**」
 * 并且规格矩阵**建出 0 行**（不是少几行，是整张表空）——2026-09-29 PE4 实测。
 *
 * 页面原文：`a. 最多填写40个字` /
 *          `b. 仅允许中英文 数字 空格 部分英文符号如 # : % ( ) ' + - * / . 部分中文符号如 （）【】`
 *
 * **踩过的坑**：把长度值写成 `长3米×宽50厘米【…】` —— 排版乘号 `×`(U+00D7) **不在允许集**，
 * 平台报「数据错误，请刷新页面」、矩阵 0 行、`错误（1）`。换成 ASCII 的 `*` 立刻正常。
 * 同理要避开的还有：`×` `✕` `⚠` `→` `·` `～` `%` 以外的全角符号、emoji、引号 `“”` 等。
 *
 * @returns {{ok:boolean, bad:Array<{dim:string,value:string,problems:string[]}>}}
 */
function validateSpecValues(dimNames, dimValues) {
  // 允许：CJK / 英文 / 数字 / 空格 / # : % ( ) ' + - * / . / （）【】
  const OK = /[\u4e00-\u9fa5A-Za-z0-9 #:%()'+*/.\-（）【】]/;
  const bad = [];
  (dimValues || []).forEach((vals, di) => {
    (vals || []).forEach((v) => {
      const s = String(v == null ? '' : v);
      const problems = [];
      if (s.length > 40) problems.push(`超过40字(${s.length})`);
      const illegal = [...new Set(Array.from(s).filter((ch) => !OK.test(ch)))];
      if (illegal.length) problems.push('含非法字符:' + illegal.join(' '));
      if (problems.length) bad.push({ dim: (dimNames && dimNames[di]) || `dim${di}`, value: s, problems });
    });
  });
  return { ok: bad.length === 0, bad };
}

/**
 * 路径后缀匹配（2026-09-29 修复 P0-①）。
 * 平台下拉文本**常不带顶级前缀**：Excel 给 `家居生活 > 宠物/宠物食品及用品 > 猫/狗玩具 > 猫抓板`，
 * 下拉里实际是 `宠物/宠物食品及用品 > 猫/狗玩具 > 猫抓板`。
 * 原来的「整条全等」在这种树上永远匹配不上（no_exact_match），读回判据同理会误报 selected_mismatch。
 * 规则：候选的分段序列 == 目标分段序列的**尾部**（即候选是目标的「去前缀」形态）。
 * 仍是分段比对（不是 includes），所以 `家居饰品 > 贴饰 > 背景墙贴` 不会误命中 `… > 贴饰 > 墙贴`。
 */
function pathSuffixMatch(cand, target) {
  const seg = (s) => String(s || '').split('>').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const a = seg(cand);
  const b = seg(target);
  if (!a.length || !b.length || a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[a.length - 1 - i] !== b[b.length - 1 - i]) return false;
  }
  return true;
}

/**
 * 取值的「短标识」：'长3米*宽50厘米【…】' → '长3米'（无分隔符则原样返回）。**仅用于行归属判断。**
 *
 * ⚠️⚠️ **危险：本函数会折叠共享前缀的值，用它做兜底匹配前必须检查唯一性。**
 * 实测（2026-09-30 MZB-006）：尺寸值为 `30cm*1米` / `30cm*3米` / `30cm*5米` … —— 12 个值共享 `30cm` 前缀，
 * dimToken 把它们**全部截成 `30cm`**，于是 12 个值塌成 4 个 token（30/40/50/60cm），
 * 扫描结果 6色×4 = **24 而非 72**；更糟的是 `repairSpecMatrix` 会据此误判「值缺失」
 * 并 `removeSpecValue` **删掉本来正确的规格值**。
 *
 * **正确用法**（所有调用点都已按此写）：全值 `includes` 优先，
 * 短标识兜底**仅当 `T1.filter(x => x === tk).length === 1`（本维度内唯一）**时才用；
 * 不唯一就直接跳过该 token。
 */
function dimToken(v) {
  const s = String(v == null ? '' : v);
  const i = s.search(/[*（(【\[]/);
  return i > 0 ? s.slice(0, i) : s;
}

/**
 * 跨滚动位置取并集，扫出 SKU 表里**实际存在**的 `dim0|dim1` 组合键（2026-09-28 9228 固化）。
 * 单次快照永远读不全（虚拟窗口）——必须跨滚动位置累积。
 * @returns {Promise<string[]>} 例 ['微浮雕白色--【…】|长3米*宽50厘米【…】', ...]
 */
async function scanSkuKeys(page, dimNames, dimValues, { step = 120, pauseMs = 70 } = {}) {
  const V0 = (dimValues[0] || []).map(String);
  const V1 = (dimValues[1] || []).map(String);
  const T1 = V1.map(dimToken);
  return page.evaluate(async (a) => {
    const { V0, V1, T1, step, pauseMs } = a;
    const sc = (() => { let c = Array.from(document.querySelectorAll('*')).filter((e) => e.querySelector && e.querySelector('tbody tr') && e.scrollHeight > e.clientHeight + 20 && /^(scroll|auto)$/.test(getComputedStyle(e).overflowY)); if (!c.length) c = Array.from(document.querySelectorAll('*')).filter((e) => e.tagName !== 'HTML' && e.tagName !== 'BODY' && e.scrollHeight > e.clientHeight + 40 && e.querySelector && e.querySelector('tbody tr')); return c; })();
    let n = document.querySelector('tbody tr')?.parentElement;
    while (n && n !== document.body) { if (n.scrollHeight > n.clientHeight + 20) sc.push(n); n = n.parentElement; }
    const all = Array.from(new Set(sc));
    const maxSh = Math.max(3000, ...all.map((e) => e.scrollHeight));
    const seen = new Set();
    const collect = () => {
      let sticky = '';
      for (const tr of Array.from(document.querySelectorAll('tbody tr'))) {
        const text = (tr.textContent || '').replace(/\s+/g, ' ').trim();
        // 维度0 常在组首行出现 → sticky 继承；**只用整串精确匹配**，禁尾部兜底（同档位不同颜色尾缀相同）
        for (const v of V0) if (text.includes(v)) { sticky = v; break; }
        let d1 = '';
        // 全值精确匹配优先；token 兜底仅在「该 token 在本维度唯一」时使用。
        // 旧写法会把共享前缀的值折叠（6色×(30/40/50/60cm) = 24 而非 72），
        // 导致 repairSpecMatrix 误判「值缺失」并删掉本来正确的规格值。
        for (let i = 0; i < V1.length; i++) if (text.includes(V1[i])) { d1 = V1[i]; break; }
        if (!d1) for (let i = 0; i < V1.length; i++) {
          const tk = T1[i];
          if (!tk || tk === V1[i]) continue;
          if (T1.filter((x) => x === tk).length > 1) continue;
          if (text.includes(tk)) { d1 = V1[i]; break; }
        }
        if (!sticky || !d1) continue;
        seen.add(sticky + '|' + d1);
      }
    };
    all.forEach((e) => { e.scrollTop = 0; }); window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 240)); collect();
    for (let st = 0; st <= maxSh + 600; st += step) {
      all.forEach((e) => { e.scrollTop = st; }); window.scrollTo(0, st);
      await new Promise((r) => setTimeout(r, pauseMs));
      document.querySelectorAll('tbody tr').length;
      await new Promise((r) => setTimeout(r, 35));
      collect();
    }
    return Array.from(seen);
  }, { V0, V1, T1, step, pauseMs });
}

/** 以「真实 click + Ctrl+A + Backspace + 逐字 type + Tab」把值提交进指定维度组（可靠路径）。 */
async function robustCommitSpecValue(page, typeIndex, value) {
  const idx = await page.evaluate((gi) => {
    const all = Array.from(document.querySelectorAll(
      'input[placeholder="规格类型1"], input[placeholder="规格类型2"], input[placeholder="请输入规格名称"]'));
    const t2i = all.findIndex((e) => e.placeholder === '规格类型2');
    const chips = Array.from(document.querySelectorAll('input[placeholder="请输入规格名称"]'));
    const pool = chips.map((c) => ({ ci: chips.indexOf(c), c }))
      .filter(({ c }) => c.offsetParent && (gi === 1 ? all.indexOf(c) > t2i : (t2i < 0 || all.indexOf(c) < t2i)));
    if (!pool.length) return -1;
    const empty = pool.find(({ c }) => !c.value);
    return (empty || pool[pool.length - 1]).ci;
  }, typeIndex);
  if (idx < 0) return { ok: false, reason: 'no_slot' };
  const chip = page.locator('input[placeholder="请输入规格名称"]').nth(idx);
  // 可靠路径（真实 click + 真实输入事件 + Tab），但把两处白费去掉（2026-09-29 二次提速）：
  //  1) 选中的通常是**空槽位**，本来就无需 Ctrl+A/Backspace —— 先读一次值，只在非空时才清空
  //  2) 逐字 type 的 delay 是纯等待（20 字的值白等 200ms）→ 改用 insertText 一次性插入，
  //     它同样触发真实 input 事件（与 evaluate 直接写 value 不同），仍是可靠路径
  // Tab 后的等待也收紧到 400ms：值真没提交上去的话，末尾的矩阵校验会抓到并修复。
  await chip.click({ timeout: 8000 });
  await page.waitForTimeout(150);
  const cur = await chip.inputValue().catch(() => '');
  if (cur) {
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);
  }
  await page.keyboard.insertText(String(value));
  await page.waitForTimeout(120);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);
  return { ok: true };
}

/**
 * 逐值以「真实 click + Ctrl+A + Backspace + 逐字 type + Tab」提交（**可靠路径**）。
 *
 * 为什么不能继续用 `addSpecValues`：它走 `evaluate` 原生 setter 写值 + `Enter`，
 * PDD 的受控 chip 常常**留下值但不提交**；而它是循环里的最后一步，
 * **最后一个值**后面再没有别的操作触发 commit，最容易漏 → 矩阵少一整组行
 * （PE5、PE6 两次缺的都恰好是最后那个型号值，`33 = 11 × 3`）。
 *
 * 实测对照（2026-09-29，删掉最后一个型号值再分别加回）：
 * `robustCommitSpecValue` 只靠 Tab 就提交成功、直接回到 36 行；
 * 而 `addSpecValues` 路径两次都在最后那个值上翻车。**所以 add 一律走这里。**
 */
async function addSpecValuesRobust(page, typeIndex, values) {
  const out = [];
  for (const v of values || []) {
    const r = await robustCommitSpecValue(page, typeIndex, v).catch((e) => ({ ok: false, reason: e.message }));
    out.push({ v, ...r });
    await page.waitForTimeout(200);
  }
  return out;
}

/**
 * 提交收尾：规格值全部写完后，让末尾输入框失焦（blur + 点页面空白处）。
 * 与标题框同理 —— 最后一个值最容易被「留在输入框里没提交」，一次失焦是最便宜的兜底。
 */
async function commitSpecTail(page) {
  await page.evaluate(() => {
    const a = document.activeElement;
    if (a && typeof a.blur === 'function') a.blur();
  }).catch(() => {});
  // ⚠️ 绝对不要用坐标盲点 `page.mouse.click(x, y)`：那个坐标上是什么控件完全不可控，
  // 实测点到过规格区控件，直接把规格表搞成「数据错误，请刷新页面」（2026-09-29）。
  // 改为点击一个确定无害的文本元素（区块标题），点不到就只靠上面的 blur()。
  const neutral = page.getByText('商品标题', { exact: false }).first();
  if (await neutral.count().catch(() => 0)) {
    await neutral.click({ timeout: 3000, position: { x: 2, y: 2 } }).catch(() => {});
  }
  await page.waitForTimeout(800);
  return { ok: true };
}

/**
 * ★ 规格矩阵「静默少行」检测与修复（2026-09-28 9228 实测固化 · 强烈建议开工即用）
 *
 * **症状**：`readSpecGroups` 读回分组完全正确（如 12/3），但 SKU 表实际行数 ≠ 维度值数之积
 * （实测 33 = 11×3，少一整个型号组），而且**平台 `错误（0）` 完全不报** →
 * 不主动数行就会静默上架一条少几个 SKU 的链接。
 *
 * **根因**：PDD 规格 chip 是受控组件，`evaluate` + 原生 setter 写值会「在输入框留下值、
 * 但没真正提交进矩阵」。注意 `ensureSpecValuesRobust` **修不了**——它的
 * `if (list.some(c => c.v === v && c.group === gi)) continue;` 看到 chip「已存在」就跳过，正好跳过坏值。
 *
 * **修法**：定位缺行的维度值 → `removeSpecValue` 删掉其 chip → `robustCommitSpecValue` 真实输入重提交 → 重扫。
 *
 * @returns {Promise<{ok:boolean, expected:number, count:number, rounds:number, bad:string[], log:object[]}>}
 */
async function repairSpecMatrix(page, dimNames, dimValues, { maxRound = 3 } = {}) {
  const D0 = (dimValues[0] || []).map(String);
  const D1 = (dimValues[1] || []).map(String);
  const expect = D0.length * D1.length;
  const logArr = [];
  const badAll = [];
  for (let round = 1; round <= maxRound; round++) {
    const keys = new Set(await scanSkuKeys(page, dimNames, dimValues));
    if (keys.size === expect) {
      return { ok: true, expected: expect, count: keys.size, rounds: round, bad: [...new Set(badAll)], log: logArr };
    }
    // 找出「哪个维度的值缺行」：某维度值参与的组合数 < 另一维度的值数
    const short0 = D0.filter((v) => D1.filter((w) => keys.has(v + '|' + w)).length < D1.length);
    const short1 = D1.filter((v) => D0.filter((w) => keys.has(w + '|' + v)).length < D0.length);
    // 判定「真凶维度」：只有一个维度值缺行（short 非空且**不是全部值**）时它才是原因；
    // 若某维度**全部值都缺**（例如 3 个长度全都少一行），它只是被另一维度连累的受害者 ——
    // 修它毫无意义，还会白白删改一堆本来正确的值、平白增加把好值弄坏的风险。
    // 实测：缺 1 个型号时 short0=[1个]、short1=[全部3个长度] → 真凶是维度0，只修它。
    const culprits = [];
    if (short0.length && short0.length < D0.length) culprits.push([0, short0]);
    if (short1.length && short1.length < D1.length) culprits.push([1, short1]);
    logArr.push({
      round, count: keys.size, short0, short1,
      repaired: culprits.map(([g, l]) => `${dimNames[g]} x${l.length}`),
    });
    if (!culprits.length) break;   // 缺的组合不成「整值」形状，交给人工
    for (const [gi, list] of culprits) {
      for (const v of list) {
        badAll.push(`${dimNames[gi]}:${v}`);
        await removeSpecValue(page, v);
        await page.waitForTimeout(900);
        await robustCommitSpecValue(page, gi, v);
        await page.waitForTimeout(1000);
      }
    }
  }
  const keys = new Set(await scanSkuKeys(page, dimNames, dimValues));
  return { ok: keys.size === expect, expected: expect, count: keys.size, rounds: maxRound, bad: [...new Set(badAll)], log: logArr };
}

/** Ensure spec dimensions exist and all unique values are present. Never submits. */
async function ensureSpecTable(page, dimNames, dimValues, { verifyRows = true, maxRound = 3, precheck = true } = {}) {
  // 先做规格值预检：值里带非法字符（如 × ）会让平台直接「数据错误，请刷新页面」并把矩阵建成 0 行，
  // 那样后面所有 SKU 操作全是白费。所以**在点任何东西之前**就拦下来。
  if (precheck) {
    const sv = validateSpecValues(dimNames, dimValues);
    if (!sv.ok) {
      return { ok: false, reason: 'spec_value_precheck_failed', specValueProblems: sv.bad,
               verify: null, missing: [], groups: null, groupMismatch: [], matrix: null };
    }
  }
  if (!dimNames.length) return { ok: true, reason: 'no_dimensions' };
  // Button label is dynamic: "添加规格类型(0/2)" — exact match misses it.
  // ⚠️ 2026-10-05 旧版页实测踩坑：这一排按钮里还有 **「AI添加规格」/「AI素材工具」**，
  //   用 `hasText:'添加规格类型'`（子串匹配）会点中旁边的 AI 按钮 → 弹出「智能生成工具」模态框
  //   → 规格区被遮住、建表 0 行（而且 Esc / 知道了 / testid 都关不掉那个弹窗，只能重开页面）。
  //   现在两条路径都强制：**文本必须以「添加规格类型」开头**，且**排除任何含「AI」的候选**。
  const clickAddSpecType = async () => {
    const hit = page.locator('button:has-text("添加规格类型")').filter({ hasNotText: /AI|智能生成/ }).first();
    const n = await hit.count().catch(() => 0);
    if (n) {
      const label = (await hit.innerText().catch(() => '') || '').trim();
      if (/^添加规格类型/.test(label)) {
        await hit.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(800);
        return true;
      }
    }
    const ok = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('button, [role="button"], span')).filter((el) => {
        if (!el.offsetParent) return false;
        const t = (el.innerText || '').trim();
        if (!/^添加规格类型/.test(t)) return false;      // 必须以此开头
        if (/AI|智能生成/.test(t)) return false;          // 明确排除 AI 入口
        return t.length < 30;
      });
      if (!els.length) return false;
      els[els.length - 1].click();
      return true;
    });
    await page.waitForTimeout(800);
    return ok;
  };
  const hasT1 = await page.locator('input[placeholder="规格类型1"]').count().catch(() => 0);
  if (!hasT1) {
    await clickAddSpecType();
  }
  for (let i = 0; i < Math.min(dimNames.length, 2); i++) {
    if (i > 0) {
      const hasT = await page.locator(`input[placeholder="规格类型${i + 1}"]`).count().catch(() => 0);
      if (!hasT) {
        await clickAddSpecType();
      }
    }
    // ⚠️ 幂等保护（2026-09-29 实测踩坑）：**不要在已建好的规格表上重跑本函数** ——
    // 原来这里是无条件 setSpecType + 把整批值再加一遍，重跑会把同一批值加两遍 → 重复值
    // → 平台「数据错误，请刷新页面」。所以：类型名只在不同时才设，值只补缺失的。
    const cur = await readSpecGroups(page);
    const curType = i === 0 ? cur.t1 : cur.t2;
    if (curType !== dimNames[i]) await setSpecType(page, i, dimNames[i]);
    // Re-set t1 if adding t2 cleared it
    if (i === 1) {
      const c2 = await readSpecGroups(page);
      if (c2.t1 !== dimNames[0]) await setSpecType(page, 0, dimNames[0]);
    }
    const have = i === 0 ? cur.g0 : cur.g1;
    const wantVals = (dimValues[i] || []).map(String);
    const missNow = wantVals.filter((v) => !have.includes(v));
    if (missNow.length) await addSpecValuesRobust(page, i, missNow);
    await page.waitForTimeout(400);
  }
  // Read back and retry missing values (up to 3 passes)
  for (let pass = 0; pass < 3; pass++) {
    const verify = await page.evaluate(() => ({
      t1: document.querySelector('input[placeholder="规格类型1"]')?.value || '',
      t2: document.querySelector('input[placeholder="规格类型2"]')?.value || '',
      names: Array.from(document.querySelectorAll('input[placeholder="请输入规格名称"]'))
        .filter((x) => x.offsetParent)
        .map((x) => x.value)
        .filter(Boolean),
    }));
    let missingAny = false;
    for (let i = 0; i < Math.min(dimNames.length, 2); i++) {
      // ensure type name
      const typeVal = i === 0 ? verify.t1 : verify.t2;
      if (typeVal !== dimNames[i]) {
        await setSpecType(page, i, dimNames[i]);
        if (i === 1) await setSpecType(page, 0, dimNames[0]);
        missingAny = true;
        await page.waitForTimeout(500);
      }
      const missing = (dimValues[i] || []).filter((v) => !verify.names.includes(v));
      if (missing.length) {
        missingAny = true;
        await addSpecValuesRobust(page, i, missing);
        await page.waitForTimeout(500);
      }
    }
    // ⚠️ 这里**不能**提前 `return { ok:true, verify }`（2026-09-28 自查发现）：
    // 那会跳过下面的「分组正确性校验与自愈」，导致 `groupMismatch` 在**常见路径上永远是 undefined**、
    // 分组自愈等于没生效 —— 而「值都存在但站错组」恰恰是最需要它兜住的场景。
    // 改成 break，让它继续走到分组校验。
    if (!missingAny) break;
  }
  // ---- 分组正确性校验与自愈（2026-09-28 PE5 固化 · 必读）----
  // 只验「值出现过」是不够的：第二维（如长度）的最后一个值可能被写进第一维（如型号），
  // 此时所有值都「出现过」、t1/t2 也对，但矩阵少一维 —— 全部校验通过却仍然错。
  for (let attempt = 0; attempt < 2; attempt++) {
    const g = await readSpecGroups(page);
    const want = [dimValues[0] || [], dimValues[1] || []];
    let fixed = false;
    for (let i = 0; i < Math.min(dimNames.length, 2); i++) {
      const mine = i === 0 ? g.g0 : g.g1;
      const stray = mine.filter((v) => !want[i].includes(v));
      for (const v of stray) {
        await removeSpecValue(page, v);
        fixed = true;
      }
      if (stray.length) await page.waitForTimeout(500);
      const g2 = await readSpecGroups(page);
      const nowMine = i === 0 ? g2.g0 : g2.g1;
      const miss = want[i].filter((v) => !nowMine.includes(v));
      if (miss.length) {
        await addSpecValuesRobust(page, i, miss);
        fixed = true;
        await page.waitForTimeout(700);
      }
    }
    if (!fixed) break;
  }

  const finalVerify = await page.evaluate(() => ({
    t1: document.querySelector('input[placeholder="规格类型1"]')?.value || '',
    t2: document.querySelector('input[placeholder="规格类型2"]')?.value || '',
    names: Array.from(document.querySelectorAll('input[placeholder="请输入规格名称"]'))
      .filter((x) => x.offsetParent)
      .map((x) => x.value)
      .filter(Boolean),
  }));
  const allMissing = [];
  for (let i = 0; i < Math.min(dimNames.length, 2); i++) {
    for (const v of dimValues[i] || []) {
      if (!finalVerify.names.includes(v)) allMissing.push(`${dimNames[i]}:${v}`);
    }
  }
  const groups = await readSpecGroups(page);
  const groupMismatch = [];
  for (let i = 0; i < Math.min(dimNames.length, 2); i++) {
    const want = dimValues[i] || [];
    const mine = i === 0 ? groups.g0 : groups.g1;
    const miss = want.filter((v) => !mine.includes(v));
    const stray = mine.filter((v) => !want.includes(v));
    if (miss.length || stray.length) {
      groupMismatch.push(`${dimNames[i]}: missing=[${miss.join(',')}] stray=[${stray.join(',')}]`);
    }
  }
  // ---- 矩阵行数校验与修复（默认开启）----
  // 「分组对、值也对」不代表矩阵建全了：chip 受控组件会出现「留值不建行」，
  // 实测 chip 读回 12/3 但矩阵只有 11×3=33 行，而平台 错误（0）**完全不报**。
  // 所以这里必须按 维度值数之积 数一遍行，不足就删值重提交（见 repairSpecMatrix）。
  // 收尾失焦：让末尾输入框提交（最后一个值最容易漏，见 commitSpecTail）
  if (verifyRows) await commitSpecTail(page).catch(() => {});

  let matrix = null;
  if (verifyRows && dimNames.length >= 2 && (dimValues[0] || []).length && (dimValues[1] || []).length) {
    matrix = await repairSpecMatrix(page, dimNames, dimValues, { maxRound })
      .catch((e) => ({ ok: false, expected: null, count: null, err: e.message }));
  }
  return {
    ok: allMissing.length === 0 && groupMismatch.length === 0 && (!matrix || matrix.ok),
    verify: finalVerify,
    missing: allMissing,
    groups,
    groupMismatch,
    matrix,
  };
}

// ---------- fill (no submit) ----------
/**
 * Fill category/basic/spec/SKU/prices/images. NEVER calls submit.
 * productData: from read_excel.py — { title, brand, category, ref_price, skus, dimensions, main_images, detail_images, ... }
 */
/**
 * ⚠️ 遗留入口（2026-09-29 明确定位）：**优先用「step 脚本」跑全流程，不要直接调本函数。**
 *
 * 为什么：本编排是早期产物，我们一直在绕开它自己写 step 脚本（见 playbook「一次生成」的 15 步清单）。
 * step 脚本在旧版/新版两套页面上都端到端验证过（278.8s / 341.2s，`validateForm` 13 项全过），
 * 而本函数只被实跑过一次，且暴露了两个与实际打法不符的地方：
 *   1. **属性缺失时直接 `ok:false` 中止**（`reason: 'required_attributes_missing'`），
 *      后面的规格/SKU/预览图/参考价全不做。而实际打法是「按数据包候选取值 + `needReview` 告警 + **继续往下做**」
 *      （属性回落很常见，如 PE6 的 风格→中式、适用空间→卧室）。
 *   2. 它的规格/SKU 段没有走 `ensureSpecTable` 的新校验（矩阵行数、分组自愈、`validateSpecValues` 预检）。
 *
 * 想用它的话，至少要传齐 `productData.attributes`（否则必挂在属性这一步）；
 * 但它**不会**跑 36 行 SKU / 预览图 / 参考价那几段 —— 那些是 step 脚本做的。
 *
 * 若要维护它，优先对齐两点：属性缺失改为「告警继续」（用 `applyAttributesByCandidates`），
 * 以及把规格/SKU 段换成 `ensureSpecTable` + `fillSkuRowsAndVerify` + `uploadMissingPreviews`。
 */
async function fillProductForm(page, productData, opts = {}) {
  const {
    mainFiles = [],
    detailFiles = [],
    categoryText = productData.category || '',
    brandName = productData.brand || '',
  } = opts;

  // Precheck payload (paths/title/ref) before touching UI — fail fast
  if (opts.precheckPayload !== false) {
    const pre = validateListingPayload(productData, { checkFiles: opts.checkFiles !== false });
    if (!pre.ok) {
      return {
        ok: false,
        submitted: false,
        reason: 'payload_precheck_failed',
        detail: pre.blocking,
        warnings: pre.warnings,
        steps: [{ name: 'payload_precheck', ok: false, detail: pre.blocking.join('; ') }],
      };
    }
  }

  const steps = [];
  const log = (name, ok, detail) => { steps.push({ name, ok, detail }); return ok; };

  // -- category page flow (new or old form) --
  await page.goto('https://mms.pinduoduo.com/goods/category', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  const _det = await detectCategoryPage(page);
    const isNew = _det.kind === 'new';

  if (isNew) {
    if (mainFiles.length) {
      // Lock to carousel/main section file input when multiple exist (edit/full form).
      // Blind page-wide .first() can hit 包装标签图 / 辅助图 instead.
      const mainIdx = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input[type=file]'));
        const mainRe = /商品主图|商品轮播图/;
        const otherRe = /包装标签|辅助图|商品详情|详情介绍|快捷编辑/;
        for (let i = 0; i < inputs.length; i++) {
          let node = inputs[i].parentElement;
          let depth = 0;
          while (node && depth < 10) {
            const t = (node.innerText || '').slice(0, 500);
            if (mainRe.test(t) && !otherRe.test(t)) return i;
            if (otherRe.test(t) && !mainRe.test(t)) break;
            node = node.parentElement;
            depth++;
          }
        }
        return 0;
      });
      // Zone by counter text when available (full form). New-flow first step has
      // no 「商品轮播图 …/10」 counter → lock to the 商品主图 区块 ONLY.
      // Never fall back to "first image input" — that lands in 包装标签图 (PE2→9228).
      let mainRes = await uploadZoneFast(page, '商品轮播图', 10, mainFiles, { timeoutMs: 40000 });
      if (!mainRes.ok) {
        // New-flow first step has no carousel counter and often no 商品主图 text on the
        // input's ancestors. If this step exposes exactly ONE image input it is the
        // main-image uploader (playbook: 仅新版第一步才可用 first). Otherwise require
        // section-keyword exclusivity and fail fast rather than dumping into 包装标签图.
        const stepInputs = await waitForImageInput(page, { timeoutMs: 25000 });
        const imageIdxs = stepInputs.filter((s) => s.image).map((s) => s.i);
        let mainIdx = -1;
        if (imageIdxs.length >= 1 && imageIdxs.length <= 2) {
          // Category step only uploads main images — use the first image input.
          mainIdx = imageIdxs[0];
        } else {
          mainIdx = await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('input[type=file]'));
            const mainRe = /商品主图|商品轮播图/;
            const otherRe = /包装标签|辅助图|商品详情|详情介绍|快捷编辑|视频/;
            for (let i = 0; i < inputs.length; i++) {
              if (!/image/i.test(inputs[i].accept || '')) continue;
              let node = inputs[i].parentElement;
              let depth = 0;
              let inMain = false;
              let inOther = false;
              while (node && depth < 12) {
                const t = (node.innerText || '').slice(0, 600);
                if (mainRe.test(t)) inMain = true;
                if (otherRe.test(t)) inOther = true;
                node = node.parentElement;
                depth++;
              }
              if (inMain && !inOther) return i;
            }
            return -1;
          });
        }
        if (mainIdx < 0) {
          // Fail fast: better to stop than to dump主图 into 包装标签图
          log('main_images', false, 'main_block_not_found');
          return {
            ok: false,
            steps,
            submitted: false,
            reason: 'main_block_not_found',
            detail: '未找到「商品主图/商品轮播图」区块的 file input；拒绝退回任意图片 input',
          };
        }
        try {
          await page.locator('input[type=file]').nth(mainIdx).setInputFiles(mainFiles, { timeout: 30000 });
        } catch (e) {
          mainRes = { ok: false, via: 'main_block', error: e.message };
        }
        let okNew = false;
        for (let i = 0; i < 30; i++) {
          await page.waitForTimeout(2000);
          const st = await page.evaluate(() => {
            const t = document.body.innerText || '';
            const counter = /已上传\s*[1-9]\d*\s*\/\s*10/.test(t);
            const imgs = Array.from(document.querySelectorAll('img')).filter(
              (im) => im.offsetParent && /blob:|pddpic|http/.test(im.src || '')
            ).length;
            return { counter, imgs };
          });
          if (st.counter || st.imgs >= Math.min(mainFiles.length, 3)) { okNew = true; break; }
        }
        if (okNew) mainRes = { ok: true, via: 'main_block', mainIdx };
        else if (!mainRes || mainRes.ok !== false) mainRes = { ok: false, via: 'main_block', mainIdx };
        else mainRes.via = 'main_block';
      }
      log('main_images', !!mainRes.ok, JSON.stringify(mainRes).slice(0, 200));
      if (!mainRes.ok) {
        const any = await page.evaluate(() => /已上传\s*[1-9]\d*\s*\/\s*10/.test(document.body.innerText));
        if (!any) {
          return { ok: false, steps, submitted: false, reason: 'main_upload_timeout', detail: mainRes };
        }
        log('main_images', true, 'fallback_any_1_10');
      }
    }
    await page.locator('input[placeholder*="商品标题"]').first().fill(productData.title);
    // v4 首屏就把类目卡放在第一步：必须"先选类目，再点下一步"，否则卡片消失只剩预测类目
    let pickedPre = { ok: false, how: 'skipped' };
    if (categoryText || productData.category_id) {
      pickedPre = await pickCategoryExact(page, categoryText, productData.category_id || '');
      if (!pickedPre.ok) {
        const more0 = page.getByText('查看更多推荐', { exact: false }).first();
        if (await more0.count().catch(() => 0)) {
          try { await more0.click({ timeout: 2000 }); await page.waitForTimeout(1200); } catch (_) {}
          pickedPre = await pickCategoryExact(page, categoryText, productData.category_id || '');
        }
      }
      log('category_pick_pre', !!pickedPre.ok, JSON.stringify(pickedPre));
      if (pickedPre.ok) await page.waitForTimeout(1200);
    }
    await page.getByText('下一步, 完善商品信息', { exact: true }).first().click({ timeout: 10000 });
    await page.waitForTimeout(4000);
    if ((categoryText || productData.category_id) && !(pickedPre && pickedPre.ok)) {
      // Expand recommendations first — target cate may only show after 查看更多推荐
      const more = page.getByText('查看更多推荐', { exact: false }).first();
      if (await more.count().catch(() => 0)) {
        try { await more.click({ timeout: 2000 }); await page.waitForTimeout(1000); } catch (_) {}
      }
      const cateId = String(productData.category_id || '').trim();
      const picked = await page.evaluate((args) => {
        const { catText, cateId } = args;
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const full = norm(catText);
        const leaf = full.split('>').pop().trim();

        // 1) by tracking params cateId
        if (cateId) {
          const byId = Array.from(document.querySelectorAll('[data-tracking-params]')).find((el) =>
            new RegExp('choosen_cate=' + cateId + '\\b').test(el.getAttribute('data-tracking-params') || '')
          );
          if (byId) { byId.click(); return { ok: true, how: 'cateId', text: norm(byId.innerText) }; }
        }

        const all = Array.from(document.querySelectorAll('div,span,li,a,p,label')).filter((el) => el.offsetParent);
        // 2) exact full path text (deepest / fewest children)
        const exact = all.filter((el) => norm(el.innerText) === full);
        if (exact.length) {
          exact.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
          exact[0].click();
          return { ok: true, how: 'exact_full', text: full };
        }
        // 3) text ends with "> leaf"
        if (leaf) {
          const ends = all.filter((el) => {
            const t = norm(el.innerText);
            return t.length <= full.length + 8 && (t.endsWith('> ' + leaf) || t.endsWith('>' + leaf));
          });
          if (ends.length) {
            ends.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
            ends[0].click();
            return { ok: true, how: 'ends_with_leaf', text: norm(ends[0].innerText) };
          }
          // 4) exact leaf alone (never substring → avoids 墙贴 ⊂ 背景墙贴)
          const leafOnly = all.filter((el) => norm(el.innerText) === leaf && el.children.length <= 3);
          if (leafOnly.length) {
            leafOnly[0].click();
            return { ok: true, how: 'leaf_only', text: leaf };
          }
        }
        return {
          ok: false,
          how: 'not_found',
          texts: all
            .filter((el) => /墙贴|墙纸|类目|分类/.test(norm(el.innerText)))
            .slice(0, 12)
            .map((el) => norm(el.innerText).slice(0, 45)),
        };
      }, { catText: categoryText || '', cateId });
      await page.waitForTimeout(1000);
      log('category_pick', !!picked.ok, picked.text || (picked.texts || []).join(' | '));
      if (!picked.ok) {
        // Hard fail: wrong category is worse than no listing
        return {
          ok: false,
          steps,
          submitted: false,
          reason: 'category_pick_failed',
          detail: picked,
        };
      }

      // Restore title if AI/side-effect shortened it
      const titleNow = await page.evaluate((expected) => {
        const inp = Array.from(document.querySelectorAll('input')).find((i) =>
          i.offsetParent && /商品标题/.test(i.placeholder || '')
        );
        if (!inp) return expected;
        if (inp.value === expected) return expected;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, expected);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return inp.value;
      }, productData.title);
      const titleOk = titleNow === productData.title;
      log('title_readback', titleOk, String(titleNow).slice(0, 40));
      if (!titleOk) {
        return { ok: false, steps, submitted: false, reason: 'title_readback_failed', detail: titleNow };
      }
    }
    await page.getByText('下一步, 完善商品信息', { exact: true }).first().click({ timeout: 10000 });
    await page.waitForTimeout(6000);
    const cateAfter = await page.evaluate(() => {
      const m = document.body.innerText.match(/商品分类[\s\S]{0,80}/);
      return m ? m[0].replace(/\s+/g, ' ') : '';
    });
    const leaf = (categoryText || '').split('>').pop().trim();
    // Exact leaf match — substring passes 墙贴 ⊂ 背景墙贴 (PE3→9228 false pass)
    const cleaned = String(cateAfter).replace(/\s*(修改分类|1基本信息)[\s\S]*$/, '').trim();
    const segs = cleaned.split('>').map((s) => s.replace(/^[\s\S]*?商品分类/, '').trim()).filter(Boolean);
    const lastSeg = segs.length ? segs[segs.length - 1].trim() : '';
    const cateOkFinal = !leaf || lastSeg === leaf;
    log('category_new', cateOkFinal, `leaf=${leaf} got=${lastSeg} | ${cateAfter.slice(0, 90)}`);
    if (!cateOkFinal) {
      return {
        ok: false,
        steps,
        submitted: false,
        reason: 'category_readback_failed',
        detail: { expectedLeaf: leaf, gotLastSegment: lastSeg, raw: cateAfter.slice(0, 120) },
      };
    }
  } else {
    // Old category tree: search leaf keyword, click EXACT full path only — never last fuzzy match
    const fullPath = String(categoryText || '').replace(/\s+/g, ' ').trim();
    const leaf = fullPath.split('>').pop().trim();
    const search = page.locator('input[placeholder*="关键词搜索分类"], input[placeholder*="搜索分类"]').first();
    if (await search.count()) {
      await search.fill('');
      if (leaf) {
        await search.type(leaf, { delay: 80 });
        await page.waitForTimeout(3500);
      }
    }
    const picked = await page.evaluate((args) => {
      const { full, leaf } = args;
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      if (full) {
        const exact = Array.from(document.querySelectorAll('div, li, span, a, td, p')).filter(
          (el) => el.offsetParent && norm(el.textContent) === full
        );
        if (exact.length) {
          exact[exact.length - 1].click();
          return { ok: true, how: 'exact_full', text: full };
        }
        // path contains leaf at end
        const pathHit = Array.from(document.querySelectorAll('div, li, span')).filter((el) => {
          if (!el.offsetParent) return false;
          const t = norm(el.textContent);
          return t.length < 90 && t.includes(leaf) && t.includes('>') && /宠物|猫\/狗|家居|分类/.test(t);
        });
        if (pathHit.length) {
          // prefer shortest non-noise path ending with leaf
          pathHit.sort((a, b) => norm(a.textContent).length - norm(b.textContent).length);
          const pick = pathHit.find((el) => norm(el.textContent).endsWith(leaf)) || pathHit[0];
          pick.click();
          return { ok: true, how: 'path', text: norm(pick.textContent) };
        }
      }
      // leaf only — click the shortest exact leaf node (not long search snippets)
      const leaves = Array.from(document.querySelectorAll('div, li, span')).filter((el) => {
        if (!el.offsetParent) return false;
        const t = norm(el.textContent);
        return t === leaf && el.children.length <= 3 && t.length < 20;
      });
      if (leaves.length) {
        leaves[leaves.length - 1].click();
        return { ok: true, how: 'leaf', text: leaf };
      }
      return { ok: false, texts: [] };
    }, { full: fullPath, leaf });
    await page.waitForTimeout(1200);

    // Verify 已选分类 line only (not search hits)
    const selLine = await page.evaluate(() => {
      const lines = (document.body.innerText || '').split('\n');
      const i = lines.findIndex((l) => l.includes('已选分类'));
      if (i < 0) return '';
      return lines.slice(i, i + 2).join(' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    });
    // 读回必须比对**整条路径**，不能只比末段叶子：
    // `selLine.includes('墙贴')` 对「家居饰品 > 贴饰 > 背景墙贴」同样成立 —— 这正是当年选错类目却校验通过的原因。
    const selOk = !fullPath
      ? (!leaf || selLine.includes(leaf))
      : selLine.replace(/\s*>\s*/g, ' > ').includes(String(fullPath).replace(/\s*>\s*/g, ' > ').trim());
    log('category_old_pick', picked.ok && selOk, `${picked.how || ''}|${selLine}`);
    if (picked.ok && !selOk) {
      return {
        ok: false,
        steps,
        submitted: false,
        reason: 'category_readback_failed',
        detail: { expectedLeaf: leaf, selectedLine: selLine },
      };
    }
    if (fullPath) {
      // ⚠️ 原来这里是「全局文本全等点最后一个」+「**无条件**点 .choose-category」，两处都错：
      //  1. `.choose-category` 属于「最近使用的分类」栏 —— 无条件点它会把刚选对的结果**覆盖掉**，
      //     而且取到的可能根本是另一个类目（PE5 实测：该栏同时有「墙贴」和「猫抓板」）。
      //  2. 全局「文本全等」在最近使用栏和搜索下拉里**各命中一个**，取哪个纯属撞运气。
      // 统一改走 searchCategory：搜索关键词 → 下拉 li[class*=searchItem] 里整条路径全等且**唯一** → 读回校验。
      const bySearch = await searchCategory(page, fullPath).catch((e) => ({ ok: false, reason: e.message }));
      log('category_by_search', bySearch.ok, `${bySearch.reason || ''}|${bySearch.chosen || ''}`);
      if (!bySearch.ok) {
        return {
          ok: false,
          steps,
          submitted: false,
          reason: 'category_search_failed',
          detail: bySearch,
        };
      }
    }
    await page.waitForTimeout(800);
    // Re-check selected line after exact path click
    const sel2 = await page.evaluate(() => {
      const lines = (document.body.innerText || '').split('\n');
      const i = lines.findIndex((l) => l.includes('已选分类'));
      if (i < 0) return '';
      return lines.slice(i, i + 2).join(' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    });
    if (leaf && !sel2.includes(leaf) && sel2.includes('已选分类') && /墙贴|沙发|墙纸/.test(sel2) && !/宠物|猫\/狗/.test(sel2)) {
      return {
        ok: false,
        steps,
        submitted: false,
        reason: 'category_readback_failed',
        detail: { expectedLeaf: leaf, selectedLine: sel2 },
      };
    }
    const btn = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('button, a, span, div')).filter(
        (el) => el.offsetParent && (el.textContent || '').trim() === '确认发布该类商品'
      );
      if (!els.length) return null;
      const r = els[els.length - 1].getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (btn) await page.mouse.click(btn.x, btn.y);
    await page.waitForTimeout(8000);
    log('category_old', !!btn, categoryText);
  }

  // Ensure on goods_add form
  if (!page.url().includes('goods_add')) {
    log('on_form', false, page.url());
    return { ok: false, steps, submitted: false };
  }
  log('on_form', true, page.url());

  // Brand
  if (brandName) {
    try {
      const brand = page.locator('input[placeholder*="品牌名称"]').first();
      await brand.click();
      await brand.fill(brandName);
      await page.waitForTimeout(2000);
      await page.evaluate((name) => {
        const els = Array.from(document.querySelectorAll('*')).filter(
          (el) => el.offsetParent && el.children.length === 0 && (el.textContent || '').trim() === name
        );
        if (els.length) els[els.length - 1].click();
      }, brandName);
      log('brand', true, brandName);
    } catch (e) { log('brand', false, e.message); }
  }

  // Dismiss 一键复用
  try {
    const noUse = page.getByText('不使用', { exact: true }).first();
    if (await noUse.count()) { await noUse.click({ timeout: 2000 }); await page.waitForTimeout(500); }
  } catch (_) {}

  // Detail images
  if (detailFiles.length) {
    try {
      const fmap = await page.evaluate(() =>
        Array.from(document.querySelectorAll('input[type=file]')).map((el, idx) => {
          let node = el, ctx = '';
          for (let i = 0; i < 8 && node; i++) {
            node = node.parentElement;
            if (!node) break;
            const t = (node.innerText || '').replace(/\s+/g, ' ').trim();
            if (t.length > 10) { ctx = t.slice(0, 90); break; }
          }
          return { idx, ctx };
        })
      );
      // Zone located by counter text (商品详情 …/50) — never by input index
      let detRes = await uploadZoneFast(page, '商品详情', 50, detailFiles, { timeoutMs: 45000 });
      if (!detRes.ok) {
        const fmap = await page.evaluate(() =>
          Array.from(document.querySelectorAll('input[type=file]')).map((el, idx) => {
            let node = el, ctx = '';
            for (let i = 0; i < 8 && node; i++) {
              node = node.parentElement;
              if (!node) break;
              const t = (node.innerText || '').replace(/\s+/g, ' ').trim();
              if (t.length > 10) { ctx = t.slice(0, 90); break; }
            }
            return { idx, ctx };
          })
        );
        const detailIdx = fmap.findIndex((f) => /快捷编辑|0\/50|已上传\d+\/50/.test(f.ctx));
        if (detailIdx >= 0) {
          await page.locator('input[type=file]').nth(detailIdx).setInputFiles(detailFiles, { timeout: 30000 });
          const up = await waitForUploadProgress(page, {
            timeoutMs: 90000,
            expectMin: Math.min(detailFiles.length, 1),
            expectTotal: 50,
            pattern: /已上传\s*(\d+)\s*\/\s*(\d+)/g,
          });
          detRes = { ok: up.ok, via: 'index_fallback', hits: up.hits };
        }
      }
      log('detail_images', !!detRes.ok, JSON.stringify(detRes).slice(0, 220));
      if (!detRes.ok) {
        const ok50 = await page.evaluate(() => {
          const m = document.body.innerText.match(/已上传\s*(\d+)\s*\/\s*50/);
          return m ? parseInt(m[1], 10) > 0 : false;
        });
        if (!ok50) {
          return { ok: false, steps, submitted: false, reason: 'detail_upload_timeout', detail: detRes };
        }
        log('detail_images', true, 'fallback_n_over_50');
      }
    } catch (e) {
      log('detail_images', false, e.message);
      return { ok: false, steps, submitted: false, reason: 'detail_upload_error', detail: e.message };
    }
  }

  // Optional category attributes (productData.attributes = { label: value })
  try {
    const attrResults = await applyAttributes(page, productData.attributes);
    const attrFail = attrResults.filter((r) => !r.ok).length;
    log('attributes', attrResults.length === 0 || attrFail < attrResults.length,
      `${attrResults.length - attrFail}/${attrResults.length}`);
    // Required-attribute probe (重要/★ 仍为「请选择」)
    const req = await probeRequiredAttributes(page);
    log('required_attrs', req.ok,
      req.ok ? `ok required=${req.required.length}` : `missing=${req.missing.map((m) => m.label).join(',')}`);
    if (!req.ok && opts.strictRequiredAttributes !== false) {
      return {
        ok: false,
        steps,
        submitted: false,
        reason: 'required_attributes_missing',
        detail: req.missing,
      };
    }
  } catch (e) { log('attributes', false, e.message); }

  // Spec types + values — derived from Excel dimensions only
  const dimNames = productData.dimensions || [];
  const dimValues = [];
  for (const dn of dimNames) {
    const uniq = [...new Set((productData.skus || []).map((s) => String(s[dn] ?? '').trim()).filter(Boolean))];
    dimValues.push(uniq);
  }
  try {
    const spec = await ensureSpecTable(page, dimNames, dimValues);
    log('spec_types', !!spec.ok,
      dimNames.join('+') || 'none' + (spec.missing && spec.missing.length ? ` missing=${spec.missing.join(',')}` : ''));
    if (!spec.ok) {
      // still continue fill — validate will catch incomplete rows
    }
  } catch (e) {
    log('spec_types', false, e.message);
  }
  const skuByKey = buildSkuByKey(productData.skus || [], dimNames);
  const rowFilter = makeRowFilter(
    (productData.skus || []).flatMap((s) => dimNames.map((d) => s[d]))
  );
  const stickyMapper = makeStickyMapRow(dimNames, skuByKey);
  const mapRow = (text, inputs) => stickyMapper.map(text, inputs);

  // Fill SKU table via shared virtual scroll
  const fillSeen = new Set();
  const meta = await getScrollMeta(page);
  for (let st = 0; st <= (meta.scrollHeight || 4000) + 400; st += 130) {
    await scrollTopTo(page, st, meta.depth);
    await page.waitForTimeout(100);
    const trs = page.locator('tbody tr');
    const count = await trs.count();
    for (let i = 0; i < count; i++) {
      const tr = trs.nth(i);
      let text = '';
      try { text = ((await tr.textContent()) || '').replace(/\s+/g, ' '); } catch (_) { continue; }
      if (!rowFilter(text)) continue;
      const mapped = mapRow(text, []);
      if (!mapped || fillSeen.has(mapped.key)) continue;
      const data = mapped.sku;
      const inputs = tr.locator('input[placeholder="请输入"]');
      const n = await inputs.count().catch(() => 0);
      if (n < 3) continue;
      try {
        await inputs.nth(0).fill(String(data.stock), { timeout: 2500 });
        await inputs.nth(1).fill(String(data.group_price), { timeout: 2500 });
        await inputs.nth(2).fill(String(data.single_price), { timeout: 2500 });
        if (n >= 4) await inputs.nth(n - 1).fill(String(data.code), { timeout: 2500 });
        if (data.goods_code && n >= 5) await inputs.nth(n - 2).fill(String(data.goods_code), { timeout: 2500 });
        fillSeen.add(mapped.key);
      } catch (_) {}
    }
  }
  // second pass if incomplete — reset sticky and walk again
  if (fillSeen.size < (productData.skus || []).length) {
    stickyMapper.reset();
    for (let st = 0; st <= (meta.scrollHeight || 4000) + 400; st += 120) {
      await scrollTopTo(page, st, meta.depth);
      await page.waitForTimeout(80);
      const trs = page.locator('tbody tr');
      const count = await trs.count();
      for (let i = 0; i < count; i++) {
        const tr = trs.nth(i);
        let text = '';
        try { text = ((await tr.textContent()) || '').replace(/\s+/g, ' '); } catch (_) { continue; }
        if (!rowFilter(text)) continue;
        const mapped = mapRow(text, []);
        if (!mapped || fillSeen.has(mapped.key)) continue;
        const data = mapped.sku;
        const inputs = tr.locator('input[placeholder="请输入"]');
        const n = await inputs.count().catch(() => 0);
        if (n < 3) continue;
        // skip if already has values
        const cur = await inputs.nth(0).inputValue().catch(() => '');
        if (cur && cur !== '0') { fillSeen.add(mapped.key); continue; }
        try {
          await inputs.nth(0).fill(String(data.stock), { timeout: 2500 });
          await inputs.nth(1).fill(String(data.group_price), { timeout: 2500 });
          await inputs.nth(2).fill(String(data.single_price), { timeout: 2500 });
          if (n >= 4) await inputs.nth(n - 1).fill(String(data.code), { timeout: 2500 });
          if (data.goods_code && n >= 5) await inputs.nth(n - 2).fill(String(data.goods_code), { timeout: 2500 });
          fillSeen.add(mapped.key);
        } catch (_) {}
      }
    }
  }
  log('sku_fill', fillSeen.size === (productData.skus || []).length,
    `${fillSeen.size}/${(productData.skus || []).length}`);

  // Reference price — write then readback+retry
  try {
    const ref = productData.ref_price;
    if (ref != null) {
      let refOk = false;
      for (let i = 0; i < 3 && !refOk; i++) {
        const now = await page.evaluate((v) => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          const inp = Array.from(document.querySelectorAll('input')).find(
            (i) => i.offsetParent && (i.placeholder || '').includes('最大单买价')
          );
          if (!inp) return null;
          setter.call(inp, String(v));
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          inp.blur();
          return inp.value;
        }, ref);
        refOk = Number(now) === Number(ref);
        if (!refOk) await page.waitForTimeout(400);
      }
      log('ref_price', refOk, refOk ? String(ref) : String(ref) + ':readback_mismatch');
      if (!refOk) {
        return { ok: false, steps, submitted: false, reason: 'ref_price_readback_failed', detail: String(ref) };
      }
    }
  } catch (e) { log('ref_price', false, e.message); }

  // Preview images — same virtual walk + sticky dim inherit (rowspan)
  const colorToFile = opts.colorToFile || {};
  const checkFiles = opts.skipFileCheck !== true;
  const prevMeta = await getScrollMeta(page);
  const prevSticky = makeStickyMapRow(dimNames, skuByKey);
  for (let pass = 0; pass < 2; pass++) {
    prevSticky.reset();
    for (let st = 0; st <= (prevMeta.scrollHeight || 4000) + 400; st += 140) {
      await scrollTopTo(page, st, prevMeta.depth);
      await page.waitForTimeout(80);
      const trs = page.locator('tbody tr');
      const count = await trs.count();
      for (let i = 0; i < count; i++) {
        const tr = trs.nth(i);
        let text = '';
        try { text = ((await tr.textContent()) || '').replace(/\s+/g, ' '); } catch (_) { continue; }
        if (!rowFilter(text)) continue;
        const mapped = prevSticky.map(text, []);
        if (!mapped) continue;
        const hasImg = await tr.evaluate(
          (el) => !!(el.querySelector('img') || el.querySelector('[style*="background-image"]'))
        ).catch(() => true);
        if (hasImg) continue;
        const fic = await tr.locator('input[type=file]').count().catch(() => 0);
        // Prefer any dimension value hit (尺寸/颜色), then code — not only dim0
        const dimVals = (productData.dimensions || [])
          .map((d) => String(mapped.sku[d] ?? ''))
          .filter(Boolean);
        // ★ 2026-09-30：同 uploadMissingPreviews —— 本行 SKU 图优先，colorToFile 只兜底。
        let file = mapped.sku?.preview || null;
        if (!file) file = opts.previewByCode?.[mapped.sku?.code];
        if (!file) {
          for (const dv of [String(mapped.sku?.[dimNames[0]] ?? ''), ...dimVals]) {
            if (dv && colorToFile[dv]) { file = colorToFile[dv]; break; }
          }
        }
        if (!file) continue;
        if (checkFiles && file) {
          try {
            if (!require('fs').existsSync(file)) continue;
          } catch (_) {}
        }

        // A) 本地上传 + filechooser first (more reliable than hidden file input)
        let uploaded = false;
        try {
          const btn = tr.locator('text=本地上传').first();
          if (await btn.count({ timeout: 400 })) {
            const [fc] = await Promise.all([
              page.waitForEvent('filechooser', { timeout: 2500 }),
              btn.click({ timeout: 2500 }),
            ]);
            if (fc) {
              await fc.setFiles(file);
              await page.waitForTimeout(450);
              uploaded = true;
            }
          }
        } catch (_) {}

        // B) pending upload: direct file input
        if (!uploaded && fic > 0) {
          try {
            await tr.locator('input[type=file]').first().setInputFiles(file, { timeout: 6000 });
            await page.waitForTimeout(400);
            uploaded = true;
          } catch (_) {}
        }

        if (uploaded) {
          const okImg = await tr.evaluate(
            (el) => !!(el.querySelector('img') || el.querySelector('[style*="background-image"]'))
          ).catch(() => false);
          if (!okImg) await page.waitForTimeout(600);
        }
      }
    }
  }

  // Also wait on any global 已上传 counters if present (main/detail already waited)
  // Repair title/main/ref/brand with readback (common PE2/PE3 gaps)
  let enforced = null;
  try {
    enforced = await enforceCriticalOnForm(page, productData, {
      mainFiles,
      colorToFile,
      previewByCode: opts.previewByCode || {},
    });
    log('enforce_title', enforced.title, enforced.titleValue ? String(enforced.titleValue).slice(0, 40) : 'empty');
    log('enforce_ref', enforced.ref, String(productData.ref_price));
    log('enforce_brand', enforced.brand, productData.brand || '');
    if (enforced.skuRows) {
      log('enforce_sku_rows', enforced.skuRows.ok === true,
        `rows=${enforced.skuRows.rowsOk}/${enforced.skuRows.rowsExpected} stock=${enforced.skuRows.stockSum}/${enforced.skuRows.stockExpected}`);
    }
    if (enforced.previews) {
      log('enforce_previews', enforced.previews.ok === true,
        `touched=${enforced.previews.touched} missing_banner=${enforced.previews.missingBanner}`);
    }
    log('enforce_main', enforced.main, (enforced.counters || []).join(','));
    if (!enforced.title || !enforced.ref) {
      return {
        ok: false,
        steps,
        submitted: false,
        reason: !enforced.title ? 'title_readback_failed' : 'ref_price_readback_failed',
        detail: enforced,
        fillCount: fillSeen.size,
      };
    }
  } catch (e) {
    log('enforce_critical', false, e.message);
  }

  // Fill summary: ok requires critical steps passed
  const allOk = steps.every((s) => s.ok);
  const criticalFailed = steps.some((s) => !s.ok && /^(category_pick|category_new|title_readback|detail_images|required_attrs|sku_fill|on_form|enforce_)/.test(s.name));
  return {
    ok: allOk && !criticalFailed,
    steps,
    submitted: false,
    fillCount: fillSeen.size,
    enforced,
    url: page.url(),
  };
}

// ---------- validate (full scroll, unknown blocks) ----------
async function validateForm(page, productData) {
  const checks = [];
  const push = (name, status, value) => {
    // status: 'pass' | 'fail' | 'unknown'
    checks.push({ name, status, pass: status === 'pass', value });
  };

  // 1. Page error banner — unknown if pattern missing
  const errInfo = await page.evaluate(() => {
    const t = document.body.innerText;
    const m =
      t.match(/错误（(\d+)）/) ||
      t.match(/错误\s*[（(](\d+)[)）]/) ||
      t.match(/(\d+)\s*个错误项未处理/);
    if (m) return { matched: true, count: parseInt(m[1], 10), raw: m[0] };
    const m2 = t.match(/(\d+)\s*个错误/);
    if (m2) return { matched: true, count: parseInt(m2[1], 10), raw: m2[0] };
    // positive signals that error UI exists
    const hasErrUi = /错误项|校验失败|请先处理/.test(t);
    return { matched: false, count: null, raw: null, hasErrUi };
  });
  if (errInfo.matched) {
    push('errors', errInfo.count === 0 ? 'pass' : 'fail', errInfo.raw);
  } else if (errInfo.hasErrUi) {
    push('errors', 'fail', 'error_ui_present_unparsed');
  } else {
    push('errors', 'unknown', 'error_pattern_not_found');
  }

  // 2. Price display
  const price = await page.evaluate(() => (document.body.innerText.match(/拼单价\n[^\n]+/) || [])[0] || '');
  if (!price) push('price_displayed', 'unknown', price);
  else if (price.includes('系统自动计算')) push('price_displayed', 'fail', price);
  else push('price_displayed', 'pass', price);

  // 3. Total stock vs Excel sum
  const stockInfo = await page.evaluate(() => {
    const m = document.body.innerText.match(/总库存\n(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  });
  const excelStock = (productData.skus || []).reduce((s, k) => s + (Number(k.stock) || 0), 0);
  if (stockInfo == null) push('total_stock', 'unknown', 'not_found');
  else if (excelStock > 0 && stockInfo !== excelStock) push('total_stock', 'fail', `${stockInfo}!=${excelStock}`);
  else if (excelStock > 0) push('total_stock', 'pass', String(stockInfo));
  else push('total_stock', 'unknown', `page=${stockInfo}`);

  // 4. Full virtual-scroll row read
  const dimNames = productData.dimensions || [];
  const skuByKey = buildSkuByKey(productData.skus || [], dimNames);
  const rowFilter = makeRowFilter((productData.skus || []).flatMap((s) => dimNames.map((d) => s[d])));
  const stickyMapper = makeStickyMapRow(dimNames, skuByKey);
  const mapRow = (text, inputs) => stickyMapper.map(text, inputs);

  const read = await readAllSkuRows(page, {
    rowFilter, mapRow, step: 180, pauseMs: 220, depth: (await getScrollMeta(page)).depth,
  });
  const excelCount = (productData.skus || []).length;
  push('sku_count', read.count === excelCount ? 'pass' : 'fail', `${read.count}/${excelCount}`);

  // Per-row stock / price / code
  let emptyStock = 0, stockMismatch = 0, priceMismatch = 0, codeEmpty = 0;
  const pageCodes = [];
  const matchedKeys = new Set();

  for (const row of read.rows) {
    matchedKeys.add(row.key);
    const sku = row.sku || skuByKey[row.key];
    const stock = String(row.stock ?? '').trim();
    const group = String(row.group ?? '').trim();
    const single = String(row.single ?? '').trim();
    const code = String(row.code ?? '').trim();

    if (!stock || stock === '0') emptyStock++;
    if (sku && stock && Number(stock) !== Number(sku.stock)) stockMismatch++;
    if (sku && group && Number(group) !== Number(sku.group_price)) priceMismatch++;
    if (sku && single && Number(single) !== Number(sku.single_price)) priceMismatch++;
    if (!code) codeEmpty++;
    if (code) pageCodes.push(code);
  }

  push('no_empty_stock', emptyStock === 0 ? 'pass' : 'fail', `empty=${emptyStock}`);
  push('stock_match', stockMismatch === 0 ? 'pass' : 'fail', `mismatch=${stockMismatch}`);
  push('price_match', priceMismatch === 0 ? 'pass' : 'fail', `mismatch=${priceMismatch}`);

  // codes_exact: set coverage + row count; dups allowed when Excel shares codes
  const codeCheck = evalCodesExact(productData.skus, pageCodes, excelCount, {
    allowDuplicateCodes: productData.allow_duplicate_codes === true,
  });
  push('codes_nonempty', codeEmpty === 0 && pageCodes.length === excelCount ? 'pass' : 'fail',
    `empty=${codeEmpty}`);
  push('codes_exact', codeCheck.pass ? 'pass' : 'fail', codeCheck.detail);

  // Per-row code ownership — catches color/型号 错配 that set-level checks miss
  const perRow = evalCodePerRow(read.rows, skuByKey);
  push('code_per_row', perRow.pass ? 'pass' : 'fail',
    `mismatch=${perRow.mismatches.length}/${perRow.checked}${perRow.mismatches.length ? ' e.g. ' + perRow.mismatches[0].got + ' != ' + perRow.mismatches[0].want : ''}`);

  // Coverage: every excel key seen during scroll
  const missingKeys = Object.keys(skuByKey).filter((k) => !matchedKeys.has(k));
  push('scroll_coverage', missingKeys.length === 0 ? 'pass' : 'fail', `missing_keys=${missingKeys.length}`);

  // 主图/轮播（2026-10-05 新增）：expect 为 0/缺省时该区可不存在；有图就必须对上
  // 兼容三种取数（2026-10-05 二次修正）：main_images 数组 / mainImageCount / main_images 直接是数字
  {
    const mi = productData.main_images;
    const expectMain = Array.isArray(mi) ? mi.length
      : (typeof mi === 'number' ? mi
        : (Number(productData.mainImageCount) || 0));
    if (expectMain > 0) {
      const ms = await mainImagesState(page).catch(() => null);
      if (!ms) {
        push('main_images', 'unknown', 'carousel_counter_not_found');
      } else if (ms.uploaded === expectMain) {
        push('main_images', 'pass', `uploaded=${ms.uploaded}/${ms.total} expect=${expectMain}`);
      } else {
        push('main_images', 'fail', `uploaded=${ms.uploaded}/${ms.total} expect=${expectMain}`);
      }
    }
  }

  // Packaging label must stay empty unless material provided (PE4 lesson)
  if (!(productData.packaging_images || []).length) {
    const pkg = await packagingLabelState(page);
    if (pkg) {
      push('packaging_label', pkg.uploaded === 0 ? 'pass' : 'fail',
        `uploaded=${pkg.uploaded}/${pkg.total} (no material → must be 0)`);
    } else {
      push('packaging_label', 'unknown', 'zone_absent_undetectable');   // 探测不到就该 unknown，不能判 pass
    }
  }

  // 详情图张数（GPVC-001：上传时计数器曾误报 8/8，稍后读回变 0/50，validateForm 原先不查）
  {
    const expectDet = productData.detailCount != null
      ? productData.detailCount
      : (productData.detail_images || []).length;
    let detN = null;
    try {
      const z = await readZoneCounter(page, '商品详情', 50);
      if (z && z.length) detN = z[0].uploaded;
    } catch (_) {}
    if (detN === null) {
      detN = await page.evaluate(() => {
        const t = document.body.innerText;
        const m = t.match(/快捷编辑\s*已上传\s*(\d+)\s*[\/／]\s*(\d+)/) || t.match(/已上传\s*(\d+)\s*[\/／]\s*50/g);
        return m ? Number(m[1]) : null;
      });
    }
    if (detN === null) {
      push('detail_images', 'unknown', 'zone_absent_or_unreadable');
    } else if (!expectDet && expectDet !== 0) {
      push('detail_images', detN > 0 ? 'unknown' : 'pass', `uploaded=${detN}/50 (no expect in payload)`);
    } else {
      push('detail_images', detN === expectDet ? 'pass' : 'fail', `uploaded=${detN} expect=${expectDet}`);
    }
  }

  // Preview images missing (page text)
  const prevErr = await page.evaluate(() => {
    const t = document.body.innerText;
    const m = t.match(/请上传第?\s*(\d+)\s*行规格的预览图/g);
    return m ? m.length : 0;
  });
  if (prevErr > 0) push('preview_images', 'fail', `missing_rows=${prevErr}`);
  else if (/请上传.*预览图|规格的预览图/.test(await page.evaluate(() => document.body.innerText))) {
    push('preview_images', 'fail', 'preview_error_ui_present');
  } else {
    // 正向判据：逐行数预览图，而不是「没看到横幅就算过」。
    // 数据直接复用上面 readAllSkuRows 那一次扫描带回来的 hasImg —— 不再单独扫第二遍
    // （原来的 countPreviewCells 单扫实测 4.3s/遍；合并后零额外往返）。
    const dims = productData.dimensions || [];
    const dv = dims.map((dn) => [...new Set((productData.skus || []).map((s) => String(s[dn] ?? '')))]);
    const rowsRead = (read.rows || []).filter((r) => r && r.hasImg !== null && r.hasImg !== undefined);
    if (dims.length < 2 || !rowsRead.length) {
      push('preview_images', 'unknown', dims.length < 2 ? 'no_dims' : 'no_row_img_data');
    } else {
      const expectRows = (dv[0] || []).length * (dv[1] || []).length;
      const withImg = rowsRead.filter((r) => r.hasImg === true).length;
      if (rowsRead.length < expectRows) {
        push('preview_images', 'unknown', `coverage=${rowsRead.length}/${expectRows}`);
      } else if (withImg === rowsRead.length) {
        push('preview_images', 'pass', `rows_with_img=${withImg}/${rowsRead.length}`);
      } else {
        const miss = rowsRead.filter((r) => r.hasImg !== true).map((r) => r.key || '?');
        push('preview_images', 'fail', `missing_rows=${miss.length} e.g. ${miss.slice(0, 3).join(' , ')}`);
      }
    }
  }

  // Brand: SKILL 要求填具体品牌。品牌若只存在于下拉里（没真选中）必须判 fail——
  // 下拉是挂在 body 下的 portal、不是输入框的祖先，所以「沿输入框向上找品牌文本」是安全判据。
  const brandWant = String(productData.brand || '').trim();
  if (brandWant) {
    const bs = await page.evaluate((want) => {
      const inp = Array.from(document.querySelectorAll('input')).find((el) => el.offsetParent && /品牌名称/.test(el.placeholder || ''));
      // 下拉是挂在 body 下的 portal，不是输入框的祖先 —— 所以不能沿输入框向上找。
      // 判据：存在「可见、文本等于品牌名、且不在下拉容器内」的元素，
      // 即品牌已以 chip 形式落到表单上，而不是还躺在下拉列表里。
      const insideDropdown = (e) => {
        let n = e;
        for (let i = 0; i < 8 && n; i++) {
          const c = String(n.className || '');
          if (/dropdownPanel|virtualList|dropdownMain|Dropdown|dropdown_/i.test(c)) return true;
          n = n.parentElement;
        }
        return false;
      };
      const hits = Array.from(document.querySelectorAll('*')).filter(
        (e) => e.offsetParent && (e.textContent || '').trim() === want && e.children.length <= 2
      );
      const outside = hits.filter((e) => !insideDropdown(e));
      return {
        hasInput: !!inp,
        inputValue: inp ? inp.value : null,
        outsideCount: outside.length,
        totalCount: hits.length,
        chosen: outside.length > 0,
      };
    }, brandWant);
    push('brand', bs.hasInput && bs.chosen ? 'pass' : 'fail',
      bs.hasInput && bs.chosen ? brandWant
        : `want=${brandWant} inputValue=${JSON.stringify(bs.inputValue)} chip_outside_dropdown=${bs.outsideCount}/${bs.totalCount}`);
  }

  // 类目属性（用户指定要填的属性，如 包装方式=袋装）：填了就必须读回一致
  {
    const attrs = productData.attributes || {};
    for (const [label, arr] of Object.entries(attrs)) {
      const want = String((Array.isArray(arr) ? arr[0] : arr) || '').trim();
      if (!want) continue;
      const got = await readDropdownFieldValue(page, label);
      if (!got.found) {
        push(`attr_${label}`, 'unknown', 'field_not_found');
      } else if ((got.value || '').trim() === want) {
        push(`attr_${label}`, 'pass', want);
      } else {
        push(`attr_${label}`, 'fail', `want=${want} got=${JSON.stringify(got.value)} placeholder=${JSON.stringify(got.placeholder)}`);
      }
    }
  }

  // 兜底 unknown 要区分「探测不到」与「探测到但没证据」：
  // 这两项保留 unknown 状态（报告里可见、不静默判过），但不作为提交否决项——
  // 否则一条实测完全正确的链接会永远到不了 allPass，等于永久禁止提交。
  const ADVISORY_UNKNOWN = new Set(['preview_images', 'packaging_label', 'detail_images']);
  const anyUnknown = checks.some((c) => c.status === 'unknown' && !ADVISORY_UNKNOWN.has(c.name));
  const anyUnknownAdvisory = checks.some((c) => c.status === 'unknown' && ADVISORY_UNKNOWN.has(c.name));
  const anyFail = checks.some((c) => c.status === 'fail');
  const allPass = !anyUnknown && !anyFail && checks.length > 0;

  return { allPass, anyFail, anyUnknown, anyUnknownAdvisory, checks, readCount: read.count, rows: read.rows };
}

// ---------- close overlays properly, then submit ----------
async function dismissOverlays(page) {
  // Prefer real UI actions over DOM removal
  const labels = ['关闭', '取消', '知道了', '完成', '我知道了', '确认'];
  for (const lab of labels) {
    try {
      const btn = page.getByRole('button', { name: lab, exact: true }).first();
      if (await btn.count({ timeout: 300 })) {
        const visible = await btn.isVisible().catch(() => false);
        if (visible) {
          await btn.click({ timeout: 1500 });
          await page.waitForTimeout(400);
        }
      }
    } catch (_) {}
  }
  // Escape residual modals
  try { await page.keyboard.press('Escape'); await page.waitForTimeout(300); } catch (_) {}
}

/**
 * Submit only if validation.allPass. Returns { goodsId, success, url } or throws.
 * success === true only when URL is goods_add/success (form still open ≠ success).
 */
async function submitProduct(page, validation) {
  if (!validation || validation.allPass !== true) {
    const failed = (validation?.checks || []).filter((c) => c.status !== 'pass');
    throw new Error(
      'validation_not_pass: ' +
      (failed.length
        ? failed.map((c) => `${c.name}=${c.status}:${c.value}`).join('; ')
        : 'missing_validation')
    );
  }

  await dismissOverlays(page);

  // Shipping promise often blocks submit with no navigation
  const shipWarn = await page.evaluate(() =>
    (document.body.innerText.match(/已选中的承诺发货时间现不可选[^\n]*/) || [])[0] || null
  );
  if (shipWarn) {
    const fixed = await page.evaluate(() => {
      const targets = ['24小时发货及揽收', '48小时发货及揽收', '当日发货及揽收'];
      for (const name of targets) {
        const els = Array.from(document.querySelectorAll('div, span, label')).filter((el) =>
          el.offsetParent &&
          (el.textContent || '').replace(/\s+/g, '').includes(name.replace(/\s+/g, '')) &&
          (el.textContent || '').trim().length < 50
        );
        if (els.length) {
          els[els.length - 1].click();
          return name;
        }
      }
      return null;
    });
    await page.waitForTimeout(1200);
    if (fixed) {
      const still = await page.evaluate(() =>
        !!document.body.innerText.match(/已选中的承诺发货时间现不可选/)
      );
      if (still) throw new Error('ship_promise_still_invalid');
    }
  }

  // Residual mask cleanup only if button still blocked — click-first already done
  const clickSubmit = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('button, a, span, div')).filter(
      (el) => el.offsetParent && ['提交并上架', '提交'].includes((el.textContent || '').trim())
    );
    if (!els.length) return false;
    els[els.length - 1].click();
    return true;
  });
  if (!clickSubmit) throw new Error('submit_button_not_found');

  await page.waitForTimeout(6000);

  // Confirm dialog if present
  try {
    const dlg = await page.evaluate(() => {
      const t = document.body.innerText;
      if (!/确认提交|是否提交|温馨提示|确定要提交/.test(t)) return null;
      const btns = Array.from(document.querySelectorAll('button, a')).filter(
        (el) => el.offsetParent && /^(确认|确定|继续|提交并上架|确认提交)$/.test((el.textContent || '').trim())
      );
      if (!btns.length) return false;
      btns[btns.length - 1].click();
      return (btns[btns.length - 1].textContent || '').trim();
    });
    if (dlg) await page.waitForTimeout(7000);
  } catch (_) {}

  const url = page.url();
  const goodsId = (url.match(/goods_id=(\d+)/) || [])[1] || null;
  // Critical: goods_id alone appears on the form — only success URL means published
  const success = url.includes('goods_add/success');
  if (!success && shipWarn) {
    throw new Error('submit_blocked_ship_promise_or_form_still_open: ' + url);
  }
  if (!success && !url.includes('goods_add')) {
    // navigated elsewhere — treat as uncertain
    return { goodsId, success: false, url, reason: 'navigated_away' };
  }
  return { goodsId, success, url };
}

async function verifyListed(page, goodsId, { retries = 3, delayMs = 4000 } = {}) {
  // List index lags success URL by a few seconds — retry before not_found
  let last = { found: false, status: 'not_found' };
  for (let i = 0; i < Math.max(1, retries); i++) {
    if (i > 0) await page.waitForTimeout(delayMs);
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    const idInput = page.locator('input[placeholder*="商品ID"], input[placeholder*="多个查询"]').first();
    if (await idInput.count()) {
      await idInput.fill(String(goodsId));
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);
    }
    last = await page.evaluate((id) => {
      const t = document.body.innerText;
      const idx = t.indexOf(id);
      if (idx < 0) return { found: false, status: 'not_found' };
      const around = t.slice(idx, idx + 300);
      let status = 'unknown';
      if (/销售中/.test(around)) status = 'on_sale';
      else if (/已下架/.test(around)) status = 'off_shelf';
      else if (/已驳回|驳回/.test(around)) status = 'rejected';
      else if (/草稿/.test(around)) status = 'draft';
      else if (/审核中|发布中/.test(around)) status = 'auditing';
      const rej = around.match(/驳回原因[:：]\s*([^\n]{5,120})/);
      return { found: true, status, rejectReason: rej ? rej[1] : null, around };
    }, String(goodsId));
    if (last.found && last.status !== 'not_found') {
      last.attempt = i + 1;
      return last;
    }
  }
  last.attempt = retries;
  return last;
}

/** Per-shop pipeline: duplicate → fill → validate → submit. Never skips validation. */
async function listProductSafe(page, productData, opts = {}) {
  const title = productData.title;
  // Always fingerprint-check BEFORE fill — avoid half-filled form then skip
  const dup = opts.skipDuplicate
    ? 'not_found'
    : await checkDuplicate(page, title, productData.skus);
  if (opts.onDuplicate) {
    try { opts.onDuplicate(dup); } catch (_) {}
  }

  if (dup === 'exact_duplicate' || dup === 'same_title_different_sku') {
    return { status: dup === 'exact_duplicate' ? 'skipped_duplicate' : 'skipped_same_title_diff_sku', dup, checks: null };
  }
  if (dup === 'search_failed') {
    // Do not treat search failure as "no duplicate" for auto-submit path
    if (opts.allowSubmitOnSearchFailed !== true) {
      return { status: 'search_failed', dup, checks: null };
    }
  }

  const fill = await fillProductForm(page, productData, opts);
  if (fill.ok !== true && opts.strictFill !== false) {
    return {
      status: 'fill_failed',
      reason: fill.reason || null,
      detail: fill.detail || fill.steps || null,
      fill,
      checks: null,
    };
  }
  const validation = await validateForm(page, productData);
  if (!validation.allPass) {
    return {
      status: validation.anyUnknown ? 'validation_unknown' : 'validation_failed',
      checks: validation.checks,
      validation,
    };
  }

  try {
    const sub = await submitProduct(page, validation);
    return { status: sub.success ? 'submitted' : 'submit_no_success', goodsId: sub.goodsId, checks: validation.checks, url: sub.url };
  } catch (e) {
    return { status: 'submit_error', error: e.message, checks: validation.checks };
  }
}





// ===== 从 _backup 回收的 20 个函数（2026-09-29 误删恢复）=====

/**
 * 按「数据包优先」的候选序列设置一个类目属性，并**明确区分命中的是哪一层**。
 *
 * 为什么需要它（2026-09-29 PE6@9226 实测踩坑）：
 * 数据包写的是「欧式」「衣柜 / 橱柜」，但该类目下拉里**根本没有这些选项** ——
 * 朴素实现会静默退到备选（中式 / 卧室），日志里却和精确命中一样显示 OK。
 * 结果：用户拿到一个「看起来是按数据包填的、其实值被换掉了」的属性，而且无从察觉。
 *
 * `how` 四档：
 * - `datapack` ：候选序列的第 1 个（= 数据包原值）精确命中 → **无需人工复核**
 * - `fallback` ：数据包原值不在选项里，退到了后续候选 → **必须列给用户确认**
 * - `fuzzy`    ：候选全不中，枚举该下拉的选项后按包含关系近似命中 → **必须确认**
 * - `unmatched`：完全没命中（附 `options` 供排查）→ **必须人工处理**
 *
 * @param {string[]} candidates 首元素必须是数据包原值，其后按优先级放备选
 * @returns {Promise<{ok:boolean,label:string,chosen:string|null,how:string,failed:string[],warn:string|null,options?:string[]}>}
 */
async function pickAttrByCandidates(page, label, candidates = []) {
  const list = (candidates || []).map(String).filter(Boolean);
  if (!list.length) return { ok: false, label, chosen: null, how: 'unmatched', failed: [], warn: '无候选值' };

  for (let i = 0; i < list.length; i++) {
    const r = await pickAttr(page, label, list[i]).catch(() => ({ ok: false }));
    if (r.ok) {
      const isDp = i === 0;
      return {
        ok: true, label, chosen: list[i],
        how: isDp ? 'datapack' : 'fallback',
        failed: list.slice(0, i),
        warn: isDp ? null : `⚠️ 数据包原值「${list[0]}」不在该类目下拉里，已退到「${list[i]}」——必须人工确认`,
      };
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(220);
  }

  // 候选全不中：枚举该下拉的选项，再按包含关系近似命中
  const opened = await page.evaluate((l) => {
    const node = Array.from(document.querySelectorAll('*')).find(
      (e) => e.offsetParent && e.children.length === 0 && (e.textContent || '').trim() === l);
    if (!node) return false;
    let row = node;
    for (let i = 0; i < 6 && row; i++) {
      row = row.parentElement;
      const inp = row && row.querySelector('input[placeholder="请选择"], input[placeholder*="请选择"]');
      if (inp && inp.offsetParent && inp.type !== 'file') {
        const r = inp.getBoundingClientRect();
        for (const t of ['mousedown', 'mouseup', 'click']) {
          inp.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: r.x + 10, clientY: r.y + 10 }));
        }
        return true;
      }
    }
    return false;
  }, label);
  if (!opened) return { ok: false, label, chosen: null, how: 'unmatched', failed: list, warn: '找不到该属性的下拉控件' };
  await page.waitForTimeout(700);
  const options = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('li, [class*=option], [class*=Option], [role=option]').forEach((e) => {
      if (!e.offsetParent) return;
      const t = (e.textContent || '').replace(/\\s+/g, ' ').trim();
      if (t && t.length < 24) out.push(t);
    });
    return Array.from(new Set(out)).slice(0, 60);
  });
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(220);

  const hit = options.find((o) => list.some((c) => o.includes(c) || c.includes(o)));
  if (hit) {
    const r = await pickAttr(page, label, hit).catch(() => ({ ok: false }));
    if (r.ok) {
      return { ok: true, label, chosen: hit, how: 'fuzzy', failed: list, options,
        warn: `⚠️ 数据包值（${list.join(' / ')}）都不在选项里，按近似取了「${hit}」——必须人工确认` };
    }
  }
  return { ok: false, label, chosen: null, how: 'unmatched', failed: list, options,
    warn: `⚠️ 数据包值（${list.join(' / ')}）在该下拉里均不可用，需人工指定` };
}

/** 批量：按 {label: [候选...]} 逐个设置，并汇总需要人工复核的项 */
async function applyAttributesByCandidates(page, attrCandidates, { pauseMs = 300 } = {}) {
  const results = [];
  for (const [label, cands] of Object.entries(attrCandidates || {})) {
    const r = await pickAttrByCandidates(page, label, cands);
    results.push(r);
    await page.waitForTimeout(pauseMs);
  }
  return {
    results,
    needReview: results.filter((r) => r.how !== 'datapack').map((r) => ({ label: r.label, chosen: r.chosen, how: r.how, warn: r.warn })),
    allFromDatapack: results.every((r) => r.how === 'datapack'),
  };
}

async function applyAttributes(page, attributes) {
  if (!attributes || typeof attributes !== 'object') return [];
  const out = [];
  for (const [label, value] of Object.entries(attributes)) {
    out.push(await pickAttr(page, label, value));
  }
  return out;
}

function buildSkuByKey(skus, dimNames) {
  const map = {};
  for (const sku of skus) {
    const parts = (dimNames || []).map((d) => String(sku[d] ?? '').trim());
    map[parts.join('|')] = sku;
  }
  return map;
}

async function checkDuplicate(page, title, skus) {
  try {
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    const search = page.locator('input[placeholder*="商品名称"], input[placeholder*="商品标题"]').first();
    if (!(await search.count())) {
      // search UI missing — cannot claim not_found
      return 'search_failed';
    }
    await search.fill(title);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);

    const bodyHasTitle = await page.evaluate((t) => document.body.innerText.includes(t), title);
    if (!bodyHasTitle) return 'not_found';

    // Title hit: compare codes if the list exposes any code text (best-effort).
    const codes = codeSet(skus);
    const pageText = await page.evaluate(() => document.body.innerText);
    const codeHits = codes.filter((c) => c && pageText.includes(c));
    if (codes.length && codeHits.length === codes.length) return 'exact_duplicate';
    if (codes.length && codeHits.length > 0 && codeHits.length < codes.length) {
      return 'same_title_different_sku';
    }
    // Title matched but no codes visible on list page → treat as same title (block re-list)
    return codes.length ? 'same_title_different_sku' : 'exact_duplicate';
  } catch (e) {
    return 'search_failed';
  }
}

async function clearZone(page, keyword, total, { max = 60 } = {}) {
  const zone0 = await zoneByCounter(page, keyword, total);
  if (!zone0) return { removed: 0, reason: 'zone_not_found' };

  const el = await page.evaluateHandle((idx) => document.querySelectorAll('input[type=file]')[idx] || null, zone0.idx);
  const inputEl = el.asElement();
  if (!inputEl) return { removed: 0, reason: 'input_not_found' };

  // container = nearest ancestor of THIS input that holds the zone's thumbs
  let removed = 0;
  for (let i = 0; i < max; i++) {
    const z = await zoneByCounter(page, keyword, total);
    if (!z || z.uploaded === 0) break;
    const img = await inputEl.evaluateHandle((inp) => {
      let node = inp;
      for (let k = 0; k < 10 && node; k++) {
        node = node.parentElement;
        if (!node) break;
        const im = node.querySelector('img');
        if (im) return im;
      }
      return null;
    });
    const imgEl = img.asElement();
    if (!imgEl) return { removed, reason: 'no_thumb' };
    try { await imgEl.hover({ timeout: 2500 }); } catch (_) { return { removed, reason: 'hover_failed' }; }
    await page.waitForTimeout(350);
    const icon = await imgEl.evaluateHandle((im) => {
      const root = im.closest('*');
      const scope = root ? root.parentElement : document;
      const sels = 'i[class*="DeleteIcon"], [class*="DeleteIcon_v2_delete"], svg[data-testid="beast-core-icon-close"]';
      const found = (scope || document).querySelectorAll(sels);
      for (const f of found) if (f.offsetParent !== null) return f;
      const all = document.querySelectorAll(sels);
      for (const f of all) if (f.offsetParent !== null) return f;
      return null;
    });
    const iconEl = icon.asElement();
    if (!iconEl) return { removed, reason: 'no_delete_icon' };
    try { await iconEl.click({ timeout: 1500, force: true }); } catch (_) { return { removed, reason: 'click_failed' }; }
    removed++;
    await page.waitForTimeout(450);
    try {
      const btn = page.getByRole('button', { name: /确[定认]|删除|移除/ }).first();
      if (await btn.count({ timeout: 250 })) {
        if (await btn.isVisible().catch(() => false)) { await btn.click({ timeout: 1200 }); await page.waitForTimeout(350); }
      }
    } catch (_) {}
  }
  const end = await zoneByCounter(page, keyword, total);
  return { removed, remaining: end ? end.uploaded : null, reason: end && end.uploaded === 0 ? 'cleared' : 'partial' };
}

function evalCodePerRow(rows, skuByKey) {
  const mismatches = [];
  let checked = 0;
  for (const row of rows || []) {
    const key = row && row.key;
    if (!key) continue;
    const sku = skuByKey[key];
    if (!sku) continue;
    const got = String(row.code ?? '').trim();
    const want = String(sku.code ?? '').trim();
    if (!got) continue;                  // emptiness是 codes_nonempty 的职责
    checked++;
    if (got !== want) mismatches.push({ key, got, want });
  }
  return { pass: mismatches.length === 0 && checked > 0, mismatches, checked };
}

function evalCodesExact(skus, pageCodes, excelCount, { allowDuplicateCodes = false } = {}) {
  const excelCodes = codeSet(skus);
  const excelCodeList = (skus || [])
    .map((s) => String(s.code || '').trim())
    .filter(Boolean);
  const sharedExcel = new Set(excelCodeList).size !== excelCodeList.length;
  const allowDup = allowDuplicateCodes || sharedExcel;
  const pageSet = new Set(pageCodes);
  const missing = excelCodes.filter((c) => !pageSet.has(c)).length;
  const extra = [...new Set(pageCodes.filter((c) => !excelCodes.includes(c)))].length;
  const dup = pageCodes.filter((c, i) => pageCodes.indexOf(c) !== i).length;
  const dupSet = new Set(pageCodes.filter((c, i) => pageCodes.indexOf(c) !== i));
  const pass =
    missing === 0 &&
    extra === 0 &&
    (allowDup || dup === 0) &&
    pageCodes.length === excelCount;
  return {
    pass,
    missing,
    extra,
    dup: dupSet.size,
    sharedExcel,
    detail: `missing=${missing},extra=${extra},dup=${dupSet.size},shared_excel=${sharedExcel},rows=${pageCodes.length}/${excelCount}`,
  };
}

function fingerprint(title, skus) {
  return JSON.stringify({ t: normalizeTitle(title), c: codeSet(skus) });
}

async function getScrollMeta(page) {
  return page.evaluate(() => {
    // Prefer the tbody ancestor that is a real virtual scroller
    // (often depth≈3, clientHeight≈800, scrollHeight≈5000+). Ignore shallow
    // wrappers like .sku-list that report sh≈ch or a tiny visible window.
    let node = document.querySelector('tbody tr');
    let depth = -1;
    let best = null;
    for (let i = 0; i < 15 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const sh = node.scrollHeight;
      const ch = node.clientHeight;
      if (sh > ch + 50 && ch > 200) {
        // Prefer larger scroll range; first solid hit often wins when equal
        if (!best || sh > best.scrollHeight) {
          best = { kind: 'ancestor', depth: i, scrollHeight: sh, clientHeight: ch };
        }
      }
    }
    if (best) return best;
    const sl = document.querySelector('.sku-list');
    if (sl && sl.scrollHeight > sl.clientHeight + 50) {
      return { kind: 'sku-list', depth: -1, scrollHeight: sl.scrollHeight, clientHeight: sl.clientHeight };
    }
    return { kind: 'none', depth: 3, scrollHeight: 4000, clientHeight: 0 };
  });
}

function makeMapRow(dimNames, skuByKey) {
  return (text, inputs) => {
    // locate which excel sku this row belongs to by longest matching dim combo
    let best = null;
    let bestScore = -1;
    for (const [key, sku] of Object.entries(skuByKey)) {
      const parts = key.split('|');
      let score = 0;
      for (const p of parts) {
        if (p && text.includes(p)) score += p.length;
        else { score = -1; break; }
      }
      if (score > bestScore) { bestScore = score; best = { key, sku }; }
    }
    if (!best || bestScore < 0) return null;
    return {
      key: best.key,
      sku: best.sku,
      text,
      stock: inputs[0] ?? '',
      group: inputs[1] ?? '',
      single: inputs[2] ?? '',
      code: inputs.length >= 4 ? inputs[inputs.length - 1] : inputs[3] ?? '',
      inputs,
    };
  };
}

function makeRowFilter(dimValues) {
  const parts = (dimValues || []).filter(Boolean).map((v) =>
    String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  );
  if (!parts.length) return (text) => /请输入/.test(text) || /规格/.test(text);
  const re = new RegExp(parts.join('|'));
  return (text) => re.test(text);
}

function makeStickyMapRow(dimNames, skuByKey) {
  const dimValues = dimNames.map((d) =>
    [...new Set(Object.values(skuByKey).map((s) => String(s[d] ?? '').trim()).filter(Boolean))]
  );
  const sticky = dimNames.map(() => '');
  return {
    map(text, inputs) {
      // update sticky when a dim value appears in the row
      dimValues.forEach((vals, di) => {
        for (const v of vals) {
          if (text.includes(v)) { sticky[di] = v; break; }
        }
      });
      // exact key if all dims present
      let best = null;
      let bestScore = -1;
      for (const [key, sku] of Object.entries(skuByKey)) {
        const parts = key.split('|');
        let score = 0;
        let all = true;
        parts.forEach((p, i) => {
          if (p && text.includes(p)) score += p.length + 10;
          else if (sticky[i] && sticky[i] === p) score += p.length;
          else { all = false; }
        });
        if (all && score > bestScore) { bestScore = score; best = { key, sku }; }
      }
      if (!best) {
        // fallback: sticky combo only
        const key = sticky.join('|');
        if (skuByKey[key]) best = { key, sku: skuByKey[key] };
      }
      if (!best) return null;
      return {
        key: best.key,
        sku: best.sku,
        text,
        stock: inputs[0] ?? '',
        group: inputs[1] ?? '',
        single: inputs[2] ?? '',
        code: inputs.length >= 4 ? inputs[inputs.length - 1] : inputs[3] ?? '',
        inputs,
      };
    },
    reset() { sticky.fill(''); },
    sticky: () => [...sticky],
  };
}

/** 读当前已展开下拉里的可选项（供 pickAttr 失败时回报） */
async function readDropdownOptions(page) {
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll('li, [class*=option], [class*=Option], [role=option]').forEach((e) => {
      if (!e.offsetParent) return;
      const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 24) out.push(t);
    });
    return Array.from(new Set(out)).slice(0, 60);
  }).catch(() => []);
}

async function pickAttr(page, label, value) {
  if (!label || value == null || value === '') return { label, value, ok: false, reason: 'empty' };
  const opened = await page.evaluate((lab) => {
    const node = Array.from(document.querySelectorAll('*')).find(
      (el) => el.offsetParent && el.children.length === 0 && (el.textContent || '').trim() === lab
    );
    if (!node) return false;
    let row = node;
    for (let i = 0; i < 6 && row; i++) {
      row = row.parentElement;
      if (!row) break;
      const inp = row.querySelector('input[placeholder="请选择"], input:not([readonly])');
      if (inp && inp.offsetParent && inp.type !== 'file') {
        const r = inp.getBoundingClientRect();
        for (const type of ['mousedown', 'mouseup', 'click']) {
          inp.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: r.x + 10, clientY: r.y + 10 }));
        }
        return true;
      }
    }
    return false;
  }, label);
  if (!opened) return { label, value, ok: false, reason: 'open_failed', options: [] };
  await page.waitForTimeout(700);
  const picked = await page.evaluate((val) => {
    const els = Array.from(document.querySelectorAll('*')).filter(
      (el) => el.offsetParent && el.children.length === 0 && (el.textContent || '').trim() === String(val)
    );
    if (!els.length) return false;
    els[els.length - 1].click();
    return true;
  }, value);
  await page.waitForTimeout(300);
  if (picked) return { label, value, ok: true };
  // ★ 失败时**枚举该下拉的可选项**并回报（2026-09-30 补能力缺口）：
  // 原实现只返回 ok:false，调用方「知道失败、不知道能填什么」，
  // 于是 SKILL 里「写值前先枚举可用选项」这条指令不可执行。现在 options 直接给出候选。
  const options = await readDropdownOptions(page);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
  return { label, value, ok: false, reason: 'value_not_in_options', options };
}

async function probeRequiredAttributes(page) {
  return page.evaluate(() => {
    // Ignore chrome/feedback text — only real form fields with 重要/★ in a short field label
    const NOISE = [
      /填写率/i, /%\s*$/, /^%/, /点击反馈/, /没有合适属性/, /请准确填写属性/,
      /利于商品在搜索/, /错误填写可能/, /品牌请输入/, /未找到需要的品牌/,
      /^重要$/, /^$/
    ];
    const isNoise = (s) => NOISE.some((re) => re.test(s));

    const missing = [];
    const required = [];
    const labels = Array.from(document.querySelectorAll('*')).filter((el) => {
      if (!el.offsetParent || el.children.length > 2) return false;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 24) return false;
      if (isNoise(t)) return false;
      // real attribute labels: 重要+名, or bare field name with nearby 重要 in row handled below
      return /[一-龥]/.test(t);
    });

    for (const node of labels) {
      const labelText = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (isNoise(labelText)) continue;
      // Skip if this node is nested chrome (contains 请确保/填写率 etc. already filtered by length)
      let row = node;
      for (let i = 0; i < 6 && row; i++) {
        row = row.parentElement;
        if (!row) break;
        const rowText = (row.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (isNoise(rowText)) break;
        const inp = row.querySelector('input[placeholder="请选择"], input[placeholder*="请选择"]');
        if (!inp || !inp.offsetParent || inp.type === 'file') continue;
        // Required only if THIS label itself starts with 重要 or the row's leading labels include 重要 + field name
        const fieldIsImportant =
          /^重要/.test(labelText) ||
          new RegExp('重要' + labelText.replace(/重要/, '')).test(rowText.slice(0, 40)) ||
          /重要/.test(rowText.slice(0, 30));
        if (!fieldIsImportant) break;
        // field name should be the labelText stripped of 重要
        const name = labelText.replace(/^重要/, '').replace(/请选择.*/, '').trim();
        if (!name || isNoise(name) || name.length > 12) break;
        const empty = !inp.value || inp.value === '请选择';
        required.push({ label: name, value: inp.value || '' });
        if (empty) missing.push({ label: name, row: rowText.slice(0, 60) });
        break;
      }
    }
    // de-dupe by label
    const seen = new Set();
    const req2 = [];
    const miss2 = [];
    for (const r of required) {
      if (seen.has(r.label)) continue;
      seen.add(r.label);
      req2.push(r);
      const m = missing.find((x) => x.label === r.label);
      if (m) miss2.push(m);
    }
    return { required: req2, missing: miss2, ok: miss2.length === 0 };
  });
}

async function readAllSkuRows(page, { rowFilter, mapRow, step = 220, pauseMs = 200, depth = null } = {}) {
  const meta = await getScrollMeta(page);
  const useDepth = depth != null ? depth : meta.depth;
  const seen = new Map();
  const maxScroll = (meta.scrollHeight || 4000) + 400;

  for (let st = 0; st <= maxScroll; st += step) {
    await scrollTopTo(page, st, useDepth);
    await page.waitForTimeout(pauseMs);
    const trs = page.locator('tbody tr');
    const count = await trs.count();
    for (let i = 0; i < count; i++) {
      const tr = trs.nth(i);
      let text = '';
      try { text = ((await tr.textContent()) || '').replace(/\s+/g, ' '); } catch (_) { continue; }
      if (rowFilter && !rowFilter(text)) continue;
      // 一次 evaluate 同时取「4 个输入框的值」与「本行有没有预览图」。
      // 后者原本由 validateForm 再单独扫一遍（countPreviewCells，实测 4.3s/遍），
      // 合并进同一次 evaluate 等于白拿，省掉一整遍全表扫描，且不增加往返次数。
      let inputsVals = [];
      let hasImg = null;
      try {
        const got = await tr.evaluate((el) => ({
          vals: Array.from(el.querySelectorAll('input[placeholder="请输入"]'))
            .filter((e) => e.offsetParent !== null)
            .map((e) => e.value),
          img: !!(el.querySelector('td.sku-preview-cell [class*=imageWrapper]') || el.querySelector('td.sku-preview-cell img')),
        }));
        inputsVals = got.vals;
        hasImg = got.img;
      } catch (_) {}
      const mapped = mapRow ? mapRow(text, inputsVals) : { text, inputs: inputsVals };
      if (!mapped) continue;
      mapped.hasImg = hasImg;
      const key = mapped.key || text.slice(0, 80);
      if (!seen.has(key)) seen.set(key, mapped);
      else {
        // merge non-empty fields from later paints
        const prev = seen.get(key);
        seen.set(key, {
          ...prev, ...mapped,
          inputs: mapped.inputs?.length ? mapped.inputs : prev.inputs,
          hasImg: mapped.hasImg == null ? prev.hasImg : mapped.hasImg,
        });
      }
    }
  }
  return { meta, rows: [...seen.values()], count: seen.size };
}

async function scrollTopTo(page, st, depth = null) {
  await page.evaluate((args) => {
    const { scrollTop, depth } = args;
    const tr = document.querySelector('tbody tr');
    if (!tr) { window.scrollTo(0, Math.max(0, scrollTop)); return; }
    let node = tr;
    let target = null;
    let byDepth = null;
    for (let k = 0; k < 15 && node; k++) {
      node = node.parentElement;
      if (!node) break;
      const cs = getComputedStyle(node);
      const scrollable = node.scrollHeight > node.clientHeight + 20 && /auto|scroll/.test(cs.overflowY);
      if (depth != null && depth >= 0 && k === depth) byDepth = node;
      if (!target && scrollable) target = node;
    }
    const el = byDepth || target;
    if (el) {
      try { el.scrollTop = scrollTop; } catch (_) {}
      return;
    }
    window.scrollTo(0, Math.max(0, scrollTop));
  }, { scrollTop: st, depth });
}

async function uploadMissingPreviews(page, productData, { colorToFile = {}, previewByCode = {} } = {}) {
  const dimNames = productData.dimensions || [];
  const skus = productData.skus || [];
  const byDim = {};
  for (const s of skus) {
    for (const d of dimNames) {
      const v = String(s[d] ?? '');
      if (v && !byDim[v] && s.preview) byDim[v] = s.preview;
    }
    if (s['尺寸'] && !byDim[String(s['尺寸'])]) byDim[String(s['尺寸'])] = s.preview;
    if (s['颜色'] && !byDim[String(s['颜色'])]) byDim[String(s['颜色'])] = s.preview;
  }
  const sticky = makeStickyMapRow(dimNames, buildSkuByKey(skus, dimNames));
  const rowFilter = makeRowFilter(skus.flatMap((s) => dimNames.map((d) => s[d])));
  let touched = 0;
  const meta = await getScrollMeta(page);
  for (let pass = 0; pass < 3; pass++) {
    let attempted = 0;
    let touchedThisPass = 0;
    sticky.reset();
    for (let st = 0; st <= (meta.scrollHeight || 4000) + 500; st += 110) {
      await scrollTopTo(page, st, meta.depth);
      await page.waitForTimeout(45);
      const trs = page.locator('tbody tr');
      const n = await trs.count();
      for (let i = 0; i < n; i++) {
        const tr = trs.nth(i);
        const text = ((await tr.textContent().catch(() => '')) || '').replace(/\s+/g, ' ');
        if (!rowFilter(text)) continue;
        const mapped = sticky.map(text, []);
        if (!mapped) continue;
        const hasImg = await tr.evaluate(
          (el) => !!(el.querySelector('img') || el.querySelector('[style*="background-image"]'))
        ).catch(() => false);
        if (hasImg) continue;
        // ★ 2026-09-30：本行 SKU 预览图 / previewByCode 优先。
        //   原先 byDim/colorToFile 是 first-wins（每个维度值只认第一张图），
        //   对「同一颜色在不同尺寸下配图不同」的结构（ZDT-003：6色×4尺码=72行）
        //   会静默给多数行传错图。维度值映射只作兜底。
        let file = null;
        if (mapped.sku) file = previewByCode[mapped.sku.code] || mapped.sku.preview || null;
        if (!file) {
          for (const d of dimNames) {
            const v = String(mapped.sku?.[d] ?? '');
            if (v && (colorToFile[v] || byDim[v])) { file = colorToFile[v] || byDim[v]; break; }
          }
        }
        if (!file) continue;
        attempted++;
        // ★ 2026-09-30 实测改序：先走同格隐藏 input，再退回「本地上传」按钮。
        //   该格里一直有 input[type=file]（accept=image/jpeg,image/png、offsetParent=true）；
        //   而「本地上传」按钮在 sticky + 虚拟滚动下位于视口之外
        //   （实测 rect.y ≈ 2955 而 viewportH = 945，hitTest=none），
        //   Playwright 每行要等满 2500ms actionability 超时才抛错、然后才落到 input 路径
        //   → 72 行白等约 180s（trial click 实测 2515ms/行）。
        //   倒序后每行约 0.3s；上传策略仍是「一行一张」，不变。
        let uploaded = false;
        const fic = await tr.locator('input[type=file]').count().catch(() => 0);
        if (fic > 0) {
          try {
            await tr.locator('input[type=file]').first().setInputFiles(file, { timeout: 5000 });
            // 用「本行出现缩略图」代替固定 300ms 空等：通常 100~200ms 就返回。
            // 固定睡眠既不保证落上、又固定花掉 300ms × 72 = 21.6s。
            for (let k = 0; k < 6; k++) {
              const has = await tr
                .evaluate((el) => !!(el.querySelector('img') || el.querySelector('[style*="background-image"]')))
                .catch(() => false);
              if (has) break;
              await page.waitForTimeout(100);
            }
            uploaded = true;
          } catch (_) {}
        }
        if (!uploaded) {
          try {
            const btn = tr.locator('text=本地上传').first();
            if (await btn.count()) {
              const [fc] = await Promise.all([
                page.waitForEvent('filechooser', { timeout: 3000 }),
                btn.click({ timeout: 2500 }),
              ]);
              if (fc) { await fc.setFiles(file); await page.waitForTimeout(350); uploaded = true; }
            }
          } catch (_) {}
        }
        if (uploaded) { touched++; touchedThisPass++; }
      }
    }
    // 本遍没有待传行、或本遍所有待传行都成功 → 已就绪，不必再扫一遍复核。
    // 原实现固定 3 遍：即使第一遍就全传完，也会再空扫两遍
    // （每遍约 46 个滚动位置 × 全行 hasImg 判定 ≈ 7s）。
    // 复核交给调用方：run_listing 的 ⑧b 与 validateForm 的 preview_images 都做逐行正向核验。
    if (attempted === 0 || touchedThisPass === attempted) break;
  }
  const banner = await page.evaluate(
    () => (document.body.innerText.match(/请上传第?\s*\d+\s*行规格的预览图/g) || []).length
  );
  return { ok: banner === 0, touched, missingBanner: banner };
}

async function uploadZone(page, keyword, total, files, { timeoutMs = 90000, trim = true } = {}) {
  // ⚠️ 确认环节已改（2026-09-29 根治隐患）：原来是「循环最多 50 次、每次固定等 2.5s、
  // 每次调 zoneByCounter 读回 uploaded」。而 zoneByCounter 的计数**在轮播图区恒为 0**
  // （三次实测都返回 uploaded:0，可页面计数器是「已上传10/10张」）→ 条件永不成立 →
  // 空转满 50×2.5s=125s。这就是旧版「主图+标题」134 秒的真正来源。
  // 改为 waitForUploads（认两套文案 + 缩略图兜底，短轮询），只保留 trim 那段的原逻辑。
  const zone = await zoneByCounter(page, keyword, total);
  if (!zone || zone.idx < 0) return { ok: false, reason: 'zone_not_found', keyword, total };
  await page.locator('input[type=file]').nth(zone.idx).setInputFiles(files, { timeout: timeoutMs });

  const w = await waitForUploads(page, files.length, { capacity: total, timeoutMs: Math.min(45000, timeoutMs), pollMs: 400 });
  let uploaded = w.ok ? files.length : 0;
  let trimmed = null;
  if (trim) {
    // trim 仍按「实际多出来的张数」处理；zoneByCounter 的 uploaded 不可信，这里以 waitForUploads 的结果为准
    const z = await zoneByCounter(page, keyword, total).catch(() => null);
    const shown = z && typeof z.uploaded === 'number' ? z.uploaded : uploaded;
    if (shown > files.length) {
      trimmed = await clearZone(page, keyword, total, { max: shown - files.length + 2 });
      if (trimmed && trimmed.remaining === 0) {
        await page.locator('input[type=file]').nth(zone.idx).setInputFiles(files, { timeout: timeoutMs });
        await page.waitForTimeout(2500);
        trimmed.over_cleared = true;
      }
    }
  }
  return {
    ok: !!w.ok,
    expect: files.length,
    uploaded: w.ok ? files.length : 0,
    trimmed,
    how: 'waitForUploads',
    waitMs: w.ms,
  };
}

function validateListingPayload(productData, { checkFiles = true } = {}) {
  const warnings = [];
  const blocking = [];
  const skus = productData?.skus || [];
  const title = String(productData?.title || '');
  const han = (title.match(/[一-鿿]/g) || []).length;
  if (!title) blocking.push('no_title');
  else if (han > 30) blocking.push(`title_han_over_30:${han}`);

  if (skus.length === 0) blocking.push('sku_count_zero');

  const singles = skus.map((s) => Number(s.single_price)).filter((n) => !Number.isNaN(n));
  const maxSingle = singles.length ? Math.max(...singles) : 0;
  const ref = Number(productData?.ref_price);
  if (!(ref > 0)) blocking.push('missing_ref_price');
  else if (maxSingle && !(ref > maxSingle)) {
    blocking.push(`ref_price_not_greater:max_single=${maxSingle}`);
  }

  const emptyCodes = skus.filter((s) => !String(s.code || '').trim()).length;
  if (emptyCodes) blocking.push(`empty_codes:${emptyCodes}`);

  if (checkFiles) {
    const fs = (() => { try { return require('fs'); } catch (_) { return null; } })();
    if (fs) {
      const missPrev = (skus || [])
        .map((s) => String(s.preview || '').trim())
        .filter(Boolean)
        .filter((p) => !fs.existsSync(p));
      if (missPrev.length) blocking.push(`preview_missing:${missPrev.length}:${missPrev[0]}`);
      const mainMiss = (productData?.main_images || []).filter((p) => !fs.existsSync(p));
      if (mainMiss.length) blocking.push(`main_image_missing:${mainMiss.length}:${mainMiss[0]}`);
      const detMiss = (productData?.detail_images || []).filter((p) => !fs.existsSync(p));
      if (detMiss.length) warnings.push(`detail_image_missing:${detMiss.length}`);
    } else {
      warnings.push('fs_unavailable_skip_file_check');
    }
  }

  // dimension values must be unique per dimension set for matrix size
  const dims = productData?.dimensions || [];
  if (dims.length) {
    const combos = new Set(
      (skus || []).map((s) => dims.map((d) => String(s[d] ?? '')).join('|'))
    );
    if (combos.size !== skus.length) {
      warnings.push(`duplicate_dimension_combos:${skus.length - combos.size}`);
    }
  }

  return { ok: blocking.length === 0, warnings, blocking };
}

async function waitForUploadProgress(page, {
  timeoutMs = 30000,
  pattern = /已上传\s*(\d+)\s*\/\s*(\d+)/g,
  expectMin = 1,
  expectTotal = null, // filter hits where total === expectTotal
  contextSelector = null,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const snap = await page.evaluate((args) => {
      const { patternSrc, expectTotal, contextSelector } = args;
      const re = new RegExp(patternSrc, 'g');
      let scope = document;
      if (contextSelector) {
        const el = document.querySelector(contextSelector);
        if (el) scope = el;
      }
      const t = scope.innerText || document.body.innerText;
      const hits = [];
      let m;
      while ((m = re.exec(t)) !== null) {
        const uploaded = parseInt(m[1], 10);
        const total = parseInt(m[2], 10);
        hits.push({ uploaded, total, raw: m[0] });
      }
      return hits;
    }, {
      patternSrc: pattern.source,
      expectTotal,
      contextSelector,
    });
    last = snap;
    const scoped = expectTotal != null
      ? snap.filter((h) => h.total === expectTotal)
      : snap;
    // Prefer scoped by total; if none matched total yet, keep waiting (don't use other slots)
    if (expectTotal != null && scoped.length === 0) {
      await page.waitForTimeout(400);
      continue;
    }
    const pool = scoped.length ? scoped : snap;
    if (pool.length) {
      const ok = pool.some((h) => h.uploaded >= expectMin || (expectMin <= 1 && h.uploaded > 0) || h.uploaded === h.total);
      if (ok) return { ok: true, hits: pool, all: snap };
    }
    await page.waitForTimeout(400);
  }
  return { ok: false, hits: last || [], all: last || [] };
}

async function zoneByCounter(page, keyword, total) {
  // 分区定位：优先「计数器 total 匹配 + 邻近关键字/快捷编辑」；禁止只靠全页 first
  const zones = (await page.evaluate((args) => {
    const { keys, keyword, total } = args;
    const inputs = Array.from(document.querySelectorAll('input[type=file]'));
    const out = [];
    for (let i = 0; i < inputs.length; i++) {
      const el = inputs[i];
      if (!/image/i.test(el.accept || '')) continue;
      let node = el;
      let counter = null;
      let counterLevel = -1;
      let kw = null;
      let kwLevel = -1;
      let kwKeys = [];
      let hasQuickEdit = false;
      let hasZoneName = false;
      for (let k = 1; k <= 14 && node; k++) {
        node = node.parentElement;
        if (!node) break;
        const t = (node.innerText || '').replace(/\s+/g, ' ');
        if (!hasQuickEdit && /快捷编辑/.test(t)) { hasQuickEdit = true; }
        if (!hasZoneName && t.includes(keyword)) { hasZoneName = true; }
        if (!counter) {
          const m = t.match(/已上传\s*(\d+)\s*\/\s*(\d+)\s*张?/) || t.match(/已上传\s*\((\d+)\s*\/\s*(\d+)\)/);
          if (m) { counter = { uploaded: Number(m[1]), total: Number(m[2]) }; counterLevel = k; }
        }
        const here = keys.filter((x) => t.includes(x));
        if (here.length === 1 && kwLevel < 0) { kw = here[0]; kwLevel = k; kwKeys = here; }
      }
      // 详情区：计数器 total 匹配且邻近有快捷编辑/商品详情 → 强制归详情
      if (counter && counter.total === total && keyword === '商品详情' && (hasQuickEdit || hasZoneName)) {
        kw = '商品详情';
        if (kwLevel < 0) kwLevel = 1;
      }
      // 包装标签：必须邻近出现「包装标签图」，避免和轮播同为 /10 误命中
      if (counter && counter.total === total && keyword === '包装标签图' && hasZoneName && kw !== '商品轮播图' && kw !== '商品主图') {
        kw = '包装标签图';
        if (kwLevel < 0) kwLevel = 1;
      }
      out.push({ idx: i, counter, counterLevel, kw, kwLevel, kwKeys, hasQuickEdit, hasZoneName });
    }
    return out;
  }, { keys: ZONE_KEYS, keyword, total })) || [];

  const withTotal = zones.filter((z) => z.counter && z.counter.total === total);
  // 1) exact keyword classification (exclusive ancestor)
  const exact = withTotal.find((z) => z.kw === keyword);
  if (exact) {
    return { uploaded: exact.counter.uploaded, total, idx: exact.idx, keyword, how: 'kw_exclusive', kwLevel: exact.kwLevel, hasQuickEdit: !!exact.hasQuickEdit };
  }
  // 1b) 详情区兜底：total 匹配 + 快捷编辑/商品详情
  if (keyword === '商品详情') {
    const det = withTotal.find((z) => z.hasQuickEdit || z.kw === '商品详情' || z.hasZoneName);
    if (det) {
      return { uploaded: det.counter.uploaded, total, idx: det.idx, keyword, how: 'detail_quick_edit', kwLevel: det.kwLevel, hasQuickEdit: !!det.hasQuickEdit };
    }
  }
  // 2) carousel fallback: the /10 image input NOT classified as packaging/detail
  if (/商品主图|商品轮播图/.test(keyword)) {
    const other = withTotal.filter((z) => z.kw && z.kw !== '商品轮播图' && z.kw !== '商品主图' && z.kw !== '包装标签图');
    const candidate = withTotal.find((z) => !other.some((o) => o.idx === z.idx) && (z.hasZoneName || !z.hasQuickEdit));
    if (candidate) {
      return { uploaded: candidate.counter.uploaded, total, idx: candidate.idx, keyword, how: 'main_fallback', kwLevel: candidate.kwLevel };
    }
  }
  return null;
}



// ===== 从 _backup 回收的顶层常量（2026-09-29 误删恢复）=====

const ZONE_KEYS = ['包装标签图', '商品详情', '商品轮播图', '商品主图', '辅助图']

module.exports = {
  resolvePlaywrightCore,
  connectShop,
  disconnectPage,
  normalizeTitle,
  codeSet,
  fingerprint,
  checkDuplicate,
  getScrollMeta,
  scrollTopTo,
  readAllSkuRows,
  makeRowFilter,
  makeMapRow,
  makeStickyMapRow,
  buildSkuByKey,
  applyCodeTemplate,
  evalCodesExact,
  evalCodePerRow,
  validateListingPayload,
  enforceCriticalOnForm,
  fillProductForm,
  pickAttr,
  applyAttributes,
  pickAttrByCandidates,
  applyAttributesByCandidates,
  probeRequiredAttributes,
  waitForUploadProgress,
  probeShop,
  probePagesAlive,
  cleanupShopTabs,
  closeTarget,
  zoneByCounter,
  readZoneCounter,
  waitForZoneCounter,
  clearZone,
  uploadZone,
  uploadZoneFast,
  packagingLabelState,
  mainImagesState,
  quickZoneCount,
  readDropdownFieldValue,
  countPreviewCells,
  readDropdownOptions,
  fillEmptySkuRows,
  fillSkuRowsAndVerify,
  detectCategoryPage,
  waitForFormReady,
  waitForUploads,
  uploadMissingPreviews,
  specGroups,
  readSpecGroups,
  removeSpecValue,
  validateSpecValues,
  addSpecValuesRobust,
  commitSpecTail,
  dimToken,
  pathSuffixMatch,
  scanSkuKeys,
  repairSpecMatrix,
  robustCommitSpecValue,
  clearSpecValues,
  ensureSpecValuesRobust,
  pickCategoryExact,
  searchCategory,
  openManualCategoryPicker,
  waitForImageInput,
  ensureSpecTable,
  setSpecType,
  addSpecValues,
  validateForm,
  dismissOverlays,
  submitProduct,
  verifyListed,
  listProductSafe,
  LIST_URL,
};

