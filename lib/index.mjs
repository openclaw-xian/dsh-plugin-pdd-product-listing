/**
 * dsh-plugin-pdd-product-listing — DeepSeek Harness 插件
 *
 * 把一个「拼多多多店铺商品上架」技能（pdd-product-listing）内嵌进 DSH：
 *   - 通过官方 `ctx.skills.register()` 注册为运行时技能（progressive disclosure：
 *     目录里只有 name/description，正文在模型调用 `skill` 时才加载）；
 *   - 附带完整 `scripts/` 与 `references/`，并用 `resourceBase` 告诉模型
 *     「相对路径按插件内 skill/ 目录解析」；
 *   - **不注册任何工具、不提交任何商品**：脚本只做「填空 + 读回校验」，
 *     提交始终由用户在商家后台自己点。
 *
 * 本插件无第三方运行时依赖（只用 node: 内置模块 + ctx 服务）。真正的重活
 * （Playwright CDP、Excel 解析）由插件自带的 Node/Python 脚本执行，需要宿主机器上有
 * Chrome（开远程调试端口）、Node + playwright-core、Python 3 + openpyxl。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

export const name = 'pdd-product-listing';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const SKILL_DIR = join(PKG_ROOT, 'skill');
const SKILL_MD = join(SKILL_DIR, 'SKILL.md');

/* ------------------------------------------------------------------ *
 * 配置 schema（cordis 要求 Config 是带 .validate() 的 schema 对象）
 *   @deepseek-ai/schemastery 由宿主（dsh profile）提供：插件装进 profile 后
 *   从 profile 的 node_modules 解析得到，因此这里声明为 peerDependency 即可。
 * ------------------------------------------------------------------ */

function defineConfig() {
  const desc = 'dsh-plugin-pdd-product-listing：内嵌「拼多多多店铺商品上架」技能；只填空与校验，绝不提交。';
  try {
    // eslint-disable-next-line
    const req = createRequire(import.meta.url);
    const mod = req('@deepseek-ai/schemastery');
    const Schema = mod?.default ?? mod;
    if (!Schema || typeof Schema.object !== 'function') throw new Error('schemastery 形态异常');
    return Schema.object({
      scriptsDirectory: Schema.string().description('自定义脚本目录（默认用插件内 skill/scripts）'),
      pythonPath: Schema.string().description('带 openpyxl 的 Python 解释器绝对路径'),
      nodePath: Schema.string().description('Node 可执行文件路径（可选）'),
      chromePath: Schema.string().description('Chrome 可执行文件路径（可选）'),
      playwrightCore: Schema.string().description('playwright-core 目录绝对路径'),
      shops: Schema.dict(Schema.object({
        port: Schema.natural(),
        page_kind: Schema.string(),
      })).description('店铺 → 端口/页面形态'),
      configOverrides: Schema.dict(Schema.any()).description('额外写进 skill/config.json 的键'),
      registerForAgents: Schema.boolean().default(false).description('为每个 agent 作用域再注册一次（覆盖 CLI 技能目录同名技能）'),
      verbose: Schema.boolean().default(false).description('打印插件调试日志'),
    }).description(desc);
  } catch (e) {
    // 拿不到 schemastery（例如离线自测、或宿主没装）时退化为普通对象：
    // 注意这种形态不能直接进 cordis（它会调 Config.validate），仅用于单测/降级。
    return {
      __fallback: true,
      __error: String(e && e.message),
      type: 'object',
      additionalProperties: false,
      properties: {
        scriptsDirectory: { type: 'string' },
        pythonPath: { type: 'string' },
        nodePath: { type: 'string' },
        chromePath: { type: 'string' },
        playwrightCore: { type: 'string' },
        shops: { type: 'object', additionalProperties: true },
        configOverrides: { type: 'object', additionalProperties: true },
        registerForAgents: { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
      },
      validate(value) {
        if (value == null) return {};
        if (typeof value !== 'object') throw new TypeError('config 必须是对象');
        return value;
      },
      description(text) { this.__desc = text; return this; },
      // cordis 走的是 standard-schema 接口（`Config["~standard"].validate`）
      '~standard': { version: 1, vendor: 'pdd-product-listing', validate: (v) => ({ value: v == null ? {} : v }) },
    };
  }
}

export const Config = defineConfig();

function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  return {
    scriptsDirectory: typeof cfg.scriptsDirectory === 'string' && cfg.scriptsDirectory ? cfg.scriptsDirectory : '',
    pythonPath: typeof cfg.pythonPath === 'string' ? cfg.pythonPath : '',
    nodePath: typeof cfg.nodePath === 'string' ? cfg.nodePath : '',
    chromePath: typeof cfg.chromePath === 'string' ? cfg.chromePath : '',
    playwrightCore: typeof cfg.playwrightCore === 'string' ? cfg.playwrightCore : '',
    shops: cfg.shops && typeof cfg.shops === 'object' ? cfg.shops : null,
    configOverrides: cfg.configOverrides && typeof cfg.configOverrides === 'object' ? cfg.configOverrides : null,
    registerForAgents: cfg.registerForAgents === true,
    verbose: cfg.verbose === true,
  };
}

/* ------------------------------------------------------------------ *
 * 把插件配置写进插件自带的 skill/config.json
 *   resolve_env.ps1 / pdd_flow.js 都优先读 config.json → 环境变量 → 自动探测；
 *   这样用户在插件配置里写一次 pythonPath 就够，不必再设环境变量。
 * ------------------------------------------------------------------ */

function syncSkillConfig(cfg, log) {
  const path = join(SKILL_DIR, 'config.json');
  let current = {};
  try {
    current = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    current = {};
  }
  // ⚠️ 只写「本次确实有值」的键：绝不能拿空值/空对象覆盖模板默认值。
  //   （2026-10-06 踩坑：归一化后的 cfg 里 shops=null、pythonPath='' →
  //    旧实现把 config.json 的 shops 覆盖成 {}、python 覆盖成空字符串。）
  const patch = {};
  const setIfValue = (key, value) => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string' && value.trim() === '') return;
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return;
    patch[key] = value;
  };
  setIfValue('python', cfg.pythonPath);
  setIfValue('node', cfg.nodePath);
  setIfValue('chrome', cfg.chromePath);
  setIfValue('playwright_core', cfg.playwrightCore);
  setIfValue('shops', cfg.shops);
  setIfValue('scripts_root', cfg.scriptsDirectory);
  if (cfg.configOverrides && typeof cfg.configOverrides === 'object') {
    for (const [k, v] of Object.entries(cfg.configOverrides)) setIfValue(k, v);
  }
  const next = { ...current, ...patch };
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  if (!changed) return { changed: false, path };
  try {
    writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf8');
    const keys = Object.keys(patch);
    if (keys.length) log(`[pdd] 已把插件配置写入 skill/config.json（${keys.join(', ')}）`);
    return { changed: true, path, keys };
  } catch (e) {
    log(`[pdd] 写 skill/config.json 失败（不影响使用，可改用环境变量）：${e.message}`);
    return { changed: false, path, error: e.message };
  }
}

/* ------------------------------------------------------------------ *
 * 依赖预检：把「会阻塞整条流程」的问题在技能加载时就报出来
 * ------------------------------------------------------------------ */

const SCRIPTS_REQUIRED = ['pdd_flow.js', 'run_listing.js', 'read_excel.py', 'build_product.py'];

function checkSkillFiles(scriptsDir) {
  const problems = [];
  if (!existsSync(SKILL_MD)) problems.push(`技能正文缺失：${SKILL_MD}`);
  for (const f of SCRIPTS_REQUIRED) {
    if (!existsSync(join(scriptsDir, f))) problems.push(`脚本缺失：${join(scriptsDir, f)}`);
  }
  if (!existsSync(join(SKILL_DIR, 'references', 'playbook.md'))) {
    problems.push(`参考手册缺失：${join(SKILL_DIR, 'references', 'playbook.md')}`);
  }
  return problems;
}

function checkPython(pythonPath) {
  const candidates = [];
  if (pythonPath) candidates.push(pythonPath);
  candidates.push('python', 'python3', 'py');
  for (const exe of candidates) {
    try {
      const out = execFileSync(exe, ['-c', 'import openpyxl,sys;print(sys.version.split()[0], openpyxl.__version__)'], {
        encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      return { ok: true, exe, detail: String(out).trim() };
    } catch {
      /* try next */
    }
  }
  return { ok: false, exe: null, detail: null };
}

function checkNodeModules(scriptsDir) {
  const mods = join(PKG_ROOT, 'node_modules');
  const hasLocal = existsSync(join(mods, 'playwright-core'));
  return { hasLocal, modulesDir: mods, scriptsDir };
}

/**
 * 自动定位 playwright-core（用户装了插件但没配 playwrightCore 时用）：
 * 依次找 ① 环境变量 ② 宿主的 require.resolve ③ 插件/宿主/profile/全局/原技能目录
 * ④ 环境变量。命中就把绝对路径写进 skill/config.json，pdd_flow.js 会直接 require 它。
 * @returns {string} 命中的绝对路径，找不到返回 ''
 */
function discoverPlaywrightCore() {
  const candidates = [];
  if (process.env.PDD_PLAYWRIGHT) candidates.push(process.env.PDD_PLAYWRIGHT);
  try {
    const req = createRequire(import.meta.url);
    candidates.push(req.resolve('playwright-core'));
  } catch { /* not resolvable from here */ }
  const profileRoot = process.env.DSH_PROFILE_DIR || '';
  if (profileRoot) candidates.push(join(profileRoot, 'node_modules', 'playwright-core'));
  candidates.push(join(PKG_ROOT, 'node_modules', 'playwright-core'));
  candidates.push(join(PKG_ROOT, '..', 'node_modules', 'playwright-core'));
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) {
    candidates.push(join(home, 'AppData', 'Roaming', 'npm', 'node_modules', 'playwright-core'));
    candidates.push(join(home, '.dsh', 'profiles', 'node_modules', 'playwright-core'));
    candidates.push(join(home, '.dsh', 'profiles', 'desktop', 'node_modules', 'playwright-core'));
    // 老技能目录（把 pdd-product-listing 技能手工装过的人会有这份；可直接复用）
    candidates.push(join(home, '.config', 'mimocode', 'skills', 'pdd-product-listing', 'tools', 'npm', 'node_modules', 'playwright-core'));
  }
  candidates.push(join(process.cwd(), 'node_modules', 'playwright-core'));
  for (const p of candidates) {
    try {
      if (p && existsSync(join(String(p), 'package.json'))) return String(p);
    } catch { /* ignore */ }
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * 技能注册
 * ------------------------------------------------------------------ */

function buildSkillContent(scriptsDir, cfg) {
  const body = readFileSync(SKILL_MD, 'utf8');
  // 让正文里的 scripts/ 相对路径与「脚本可能不在播放目录」这两件事都说清楚。
  const notes = [
    '',
    '---',
    '',
    '## 本插件（DSH）附加说明',
    '',
    `- 本技能由 DeepSeek Harness 插件 \`dsh-plugin-pdd-product-listing\` 以运行时技能方式提供；`,
    `  上表资源根目录（Base directory）就是**插件内的 skill/**，\`scripts/\`、\`references/\`、\`config.json\` 都在那里。`,
    scriptsDir ? `- 解析后的脚本目录：\`${scriptsDir}\`` : '',
    cfg.pythonPath ? `- Python 解释器（插件配置指定）：\`${cfg.pythonPath}\`` : '- Python 解释器未指定：插件会在加载时探测 `python`/`python3`/`py`，并要求能 `import openpyxl`。',
    `- 运行依赖：Chrome（已登录店铺、开着 remote-debugging 端口）、Node + \`playwright-core\`、Python 3 + \`openpyxl\`。`,
    '- **本技能只填空与校验，绝不提交**；跑完由用户在拼多多商家后台自己点提交。',
    '',
  ].filter(Boolean);
  return body + notes.join('\n');
}

function makeSkillRegistration(ctx, cfg, scriptsDir, log) {
  const skills = ctx.get('skills');
  if (skills == null || typeof skills.register !== 'function') {
    log('[pdd] 当前上下文没有 ctx.skills（该服务未注册或已被裁掉）→ 跳过技能注册');
    return () => {};
  }
  const description = [
    '拼多多商家后台「新品上架」全流程自动化（多店铺）：读本地素材目录（主图/详情图/SKU 预览图/店透视 Excel 数据包），',
    '经 CDP 填标题、类目、品牌、类目属性、规格与几十到几百行 SKU、SKU 预览图、商品参考价，并跑 validateForm 全量校验；',
    '绝不代替用户点提交（只填空+校验）。',
    'Use when 用户说「拼多多上架」「上架到店铺C/店铺A/店铺B」「上架这个素材包」「pdd发布商品」「多店铺上架」，',
    '或给出 D:/图片/... 这类素材目录 + 发品 Excel 并要求上架。',
    'Negative：不要用于改价、下架、订单、客服、投流。',
  ].join('');
  const disposer = skills.register({
    name: 'pdd-product-listing',
    description,
    content: buildSkillContent(scriptsDir, cfg),
    source: 'bundled',
    resourceBase: { kind: 'directory', path: SKILL_DIR },
  });
  log(`[pdd] 技能已注册：pdd-product-listing（provider=runtime，disposer=${typeof disposer}）`);
  return disposer;
}

/**
 * Cordis 入口。DSH 会调用 apply(ctx, config)。
 * 返回的 disposer 会在插件卸载/重载时注销技能。
 */
export function apply(ctx, rawConfig = {}) {
  const cfg = normalizeConfig(rawConfig);
  const log = (...a) => { if (cfg.verbose) console.log(...a); };

  const scriptsDir = cfg.scriptsDirectory
    ? resolve(cfg.scriptsDirectory)
    : join(SKILL_DIR, 'scripts');

  // 1) 配置下沉到 skill/config.json（resolve_env / pdd_flow 会读它）
  syncSkillConfig(cfg, log);

  // 2) 文件完整性（缺文件则大声报，但仍注册技能——用户可以自行补）
  const fileProblems = checkSkillFiles(scriptsDir);
  if (fileProblems.length) {
    console.warn('[pdd-product-listing] 技能文件不完整：\n  - ' + fileProblems.join('\n  - '));
  }

  // 3) 运行时依赖体检（只提示，不阻断：用户可能还没开 Chrome）
  const py = checkPython(cfg.pythonPath);
  if (!py.ok) {
    console.warn(
      '[pdd-product-listing] 没有找到带 openpyxl 的 Python 解释器。read_excel.py 会失败。\n' +
      '  请在插件配置里指定 pythonPath（例如 C:\\Users\\<你>\\AppData\\Local\\Programs\\Python\\Python311\\python.exe），\n' +
      '  或安装：<该解释器> -m pip install openpyxl'
    );
  } else {
    log(`[pdd] Python 就绪：${py.exe} (${py.detail})`);
  }
  const nm = checkNodeModules(scriptsDir);
  const discoveredPw = cfg.playwrightCore || discoverPlaywrightCore();
  if (!existsSync(join(nm.modulesDir, 'playwright-core')) && !discoveredPw) {
    console.warn(
      '[pdd-product-listing] 找不到 playwright-core。\n' +
      '  请在插件配置里指定 playwrightCore（绝对路径），或在插件目录执行 npm i playwright-core。'
    );
  } else if (discoveredPw) {
    log(`[pdd] playwright-core = ${discoveredPw}`);
    // 把命中路径写进 skill/config.json（pdd_flow.resolvePlaywrightCore 会优先用）
    syncSkillConfig({ ...cfg, playwrightCore: discoveredPw }, log);
  }

  // 4) 注册技能
  //    ⚠️ 必须在 `ctx.inject(['skills'], …)` 里注册，而不是在 apply 里直接 ctx.get('skills')：
  //    插件与服务是并行加载的，直接在 apply 里读会因为加载顺序拿不到（browser-skill 插件同样写法）。
  const disposers = [];
  const registerNow = (c) => {
    try {
      disposers.push(makeSkillRegistration(c, cfg, scriptsDir, log));
    } catch (e) {
      console.warn('[pdd-product-listing] 技能注册失败：' + (e && e.message));
    }
  };
  if (typeof ctx.inject === 'function') {
    disposers.push(ctx.inject(['skills'], (c) => { registerNow(c); }));
  } else {
    // 兜底（旧宿主或单测 stub）：直接注册
    registerNow(ctx);
  }

  // 5) 可选：为每个 agent 作用域再注册一次（agent 层优先，覆盖 CLI 技能目录里的同名技能）
  if (cfg.registerForAgents && typeof ctx.on === 'function') {
    const owned = new Map();
    const registerFor = (agent) => {
      if (owned.has(agent)) return;
      try {
        owned.set(agent, makeSkillRegistration(agent.ctx, cfg, scriptsDir, log));
      } catch (e) {
        console.warn('[pdd-product-listing] 按 agent 注册失败：' + e.message);
      }
    };
    disposers.push(ctx.on('agent/created', ({ agent }) => registerFor(agent)));
    disposers.push(ctx.on('agent/disposed', ({ agent }) => {
      const d = owned.get(agent);
      if (typeof d === 'function') { try { d(); } catch { /* ignore */ } }
      owned.delete(agent);
    }));
    // 已存在的 agent（插件热重载场景）
    try {
      const agents = (ctx.get && ctx.get('agents')) || null;
      if (agents && typeof agents[Symbol.iterator] === 'function') for (const a of agents) registerFor(a);
    } catch { /* ignore */ }
  }

  return () => {
    for (const d of disposers.reverse()) {
      if (typeof d === 'function') { try { d(); } catch { /* ignore */ } }
    }
  };
}

export default { name, Config, apply };
