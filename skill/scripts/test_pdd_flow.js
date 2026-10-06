// 最小回归测试：纯函数不被改坏。运行：node scripts/test_pdd_flow.js
const path = require('path');
const f = require(process.env.PDD_FLOW_JS || path.join(__dirname, 'pdd_flow.js'));

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

console.log('[回归] pdd_flow.js 纯函数');
t('导出可加载', !!f && typeof f === 'object');
t('关键函数齐备', ['uploadZone','uploadZoneFast','waitForUploads','searchCategory','openManualCategoryPicker',
  'detectCategoryPage','ensureSpecTable','validateSpecValues','fillSkuRowsAndVerify','validateForm',
  'pickAttrByCandidates','applyAttributesByCandidates','scanSkuKeys','repairSpecMatrix','robustCommitSpecValue']
  .every((n) => typeof f[n] === 'function'));

// validateSpecValues：字符集 + 40 字
const D = ['型号','尺寸'];
t('PE5 值合法', f.validateSpecValues(D, [['微浮雕白色--【1.0基础标准款/标准遮丑#】'], ['长3米*宽50厘米【万墙可贴/遮丑不透底】']]).ok);
t('× 非法字符被拦', f.validateSpecValues(D, [['a'], ['长3米×宽50厘米【x】']]).bad.length === 1);
t('超 40 字被拦', f.validateSpecValues(D, [['x'.repeat(41)], ['y']]).bad.length === 1);

// dimToken
t('dimToken 截断分隔符', f.dimToken('长3米*宽50厘米【贴5平方】') === '长3米');
t('dimToken 无分隔符原样', f.dimToken('纯白') === '纯白');

// 导出里不应有非函数（LIST_URL 除外）
const badExport = Object.keys(f).filter((n) => typeof f[n] !== 'function' && n !== 'LIST_URL');
t('导出只有函数与 LIST_URL', badExport.length === 0);

// ★ P0-① 路径后缀匹配（平台下拉常不带顶级前缀）
t('后缀匹配：同级等长', f.pathSuffixMatch('家居饰品 > 贴饰 > 墙贴', '家居饰品 > 贴饰 > 墙贴'));
t('后缀匹配：去顶级前缀（猫抓板型）', f.pathSuffixMatch('宠物/宠物食品及用品 > 猫/狗玩具 > 猫抓板', '家居生活 > 宠物/宠物食品及用品 > 猫/狗玩具 > 猫抓板'));
t('后缀匹配：子串陷阱不误命中', !f.pathSuffixMatch('家居饰品 > 贴饰 > 背景墙贴', '家居饰品 > 贴饰 > 墙贴'));
t('后缀匹配：候选更长不命中', !f.pathSuffixMatch('家居饰品 > 贴饰 > 墙贴 > x', '家居饰品 > 贴饰 > 墙贴'));
t('后缀匹配：空值不命中', !f.pathSuffixMatch('', '家居饰品 > 贴饰 > 墙贴') && !f.pathSuffixMatch('a', ''));

console.log('[回归] 结果 ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
