#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从「素材目录 + 一份 listing.json」生成 pdd_flow 可直接吃的 product.json（含 ASCII 素材副本）。

用法：
  python build_product.py --listing listing.json --assets "D:/图片/PE6_木纹替换完成" --out ./work

listing.json 结构（示例见 listing.example.json）：
{
  "title": "商品标题（≤30 汉字）",
  "brand": "祺讯",
  "ref_price": 199,
  "dimensions": ["型号", "尺寸"],
  "v0": ["微浮雕系列【白色】5.0标准款", "..."],          // 维度0 的取值（顺序即页面顺序）
  "v1": ["长3米*宽50厘米【…】", "..."],                  // 维度1 的取值
  "attrs": {"材质": ["聚乙烯(PE)", "PE"], "风格": ["欧式", "中式"]},   // 首元素=数据包原值
  "price": {"3米": {"5.0标准款": [24.9, 34.1]}, ...},   // 长度 -> 档位 -> [拼单价, 单买价]
  "stock": 500,
  "code_tpl": "50cm连续木纹-{色}-{长度}",
  "color_code": {"白色": "白色", "米黄色": "米黄"},        // 规格值里的色名 -> 编码里的色名
  "len_code": {"长3米*宽50厘米【…】": "3米"}
}

素材目录约定（子目录名可自适应）：01_主图、02_详情图、03_SKU图/12张汇总（按档位_色命名）
输出：out/product.json + out/main|detail|sku/ 的 ASCII 文件名副本
"""
import argparse
import json
import os
import re
import shutil

OK = re.compile(r"[\u4e00-\u9fa5A-Za-z0-9 #:%()'+*/.\-（）【】]")


def precheck(dims, vals):
    """规格值预检：≤40 字、字符集合法。

    2026-10-05：dims 与 vals 长度不一致时旧实现会静默跳过尾巴（3 维只给 2 组值也报 ok），
    这里显式补齐为可读的结构问题，避免「预检过了、建表时才炸」。
    """
    bad = []
    for di, arr in enumerate(vals):
        dim = dims[di] if di < len(dims) else ("维度%d(未命名)" % di)
        for v in arr:
            s = str(v)
            probs = []
            if len(s) > 40:
                probs.append("超过40字(%d)" % len(s))
            ill = sorted({ch for ch in s if ch != " " and not OK.match(ch)})
            if ill:
                probs.append("非法字符:" + " ".join(ill))
            if probs:
                bad.append((dim, s, probs))
    if len(vals) != len(dims):
        bad.append(("(结构)", "dimensions=%d 组值=%d" % (len(dims), len(vals)),
                    ["维度数与取值组数不一致，多出的维度不会被预检"]))
    return bad


# 拼多多单图硬限制：平台文案「上传图片大小不能超过 3MB」。
# ZDT-003 实测：24 张 1024×1024 PNG 恰为 3164952 字节，上传全部被拒。
IMG_LIMIT = 3 * 1024 * 1024
IMG_SAFE = 2_500_000  # 建议安全水位，留压缩/重编码余量


def _check_img_size(src_dir, fs):
    """单图 >3MB 直接失败，避免连店后在上传环节才被平台拒绝。"""
    big = []
    for f in fs:
        p = os.path.join(src_dir, f)
        try:
            sz = os.path.getsize(p)
        except OSError:
            continue
        if sz > IMG_LIMIT:
            big.append((f, sz))
    if big:
        print("★ 单图超过 3MB（拼多多：上传图片大小不能超过 3MB），禁止上传：")
        for f, sz in big:
            print("   !! %s  %.2fMB" % (f, sz / 1024.0 / 1024.0))
        print("   处理：用 Pillow 缩到 ≤800×800 并 PNG optimize（目标 <2.5MB）后再 build。")
        raise SystemExit(6)
    warn = []
    for f in fs:
        p = os.path.join(src_dir, f)
        try:
            sz = os.path.getsize(p)
        except OSError:
            continue
        if sz > IMG_SAFE:
            warn.append((f, sz))
    if warn:
        print("⚠️ 有 %d 张图接近 3MB 上限（>%.0fKB），建议先压图：" % (len(warn), IMG_SAFE / 1024.0))
        for f, sz in warn[:8]:
            print("   · %s  %.2fMB" % (f, sz / 1024.0 / 1024.0))
        if len(warn) > 8:
            print("   … 共 %d 张" % len(warn))


def copy_ascii(src_dir, dst_dir, prefix):
    os.makedirs(dst_dir, exist_ok=True)
    if not src_dir or not os.path.isdir(src_dir):
        # 目录命名认不出来时，给一条能看懂的告警，而不是抛 FileNotFoundError 的裸栈
        print("⚠️ 素材目录不存在，已跳过：%s" % src_dir)
        return [], []
    fs = sorted(f for f in os.listdir(src_dir) if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp")))
    _check_img_size(src_dir, fs)
    out = []
    for i, f in enumerate(fs, 1):
        dst = os.path.join(dst_dir, "%s_%02d%s" % (prefix, i, os.path.splitext(f)[1].lower()))
        shutil.copyfile(os.path.join(src_dir, f), dst)
        out.append(dst)
    return fs, out


def find_dir(root, *cands):
    """在 root 下按候选前缀找目录（旧行为，保留兼容）"""
    for c in cands:
        for name in os.listdir(root):
            if name.startswith(c):
                return os.path.join(root, name)
    return None


def find_dir_by_kw(root, kws, fallback=None):
    """按关键字自适应找素材目录（2026-09-29：目录命名各批不同，不能写死）。
    真实遇到过两套：01_主图/02_详情图/03_SKU图  与  商品轮播图/商品详情/预览图。
    """
    for name in sorted(os.listdir(root)):
        p = os.path.join(root, name)
        if not os.path.isdir(p):
            continue
        if any(k in name for k in kws):
            return p
    return os.path.join(root, fallback) if fallback else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--listing", required=True)
    ap.add_argument("--assets", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    cfg = json.load(open(a.listing, encoding="utf-8"))
    root = a.assets
    out = a.out
    os.makedirs(out, exist_ok=True)

    # allow_duplicate_codes 默认值：listing > config.json > False。
    # 2026-10-05：旧实现硬编码默认 True，与 config.json 的 false 相反，属「静默放行重复编码」。
    skill_cfg = {}
    try:
        skill_cfg = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config.json"), encoding="utf-8"))
    except Exception:
        skill_cfg = {}
    allow_dup = cfg.get("allow_duplicate_codes", skill_cfg.get("allow_duplicate_codes", False))

    dims = cfg.get("dimensions", ["型号", "尺寸"])
    v0, v1 = cfg["v0"], cfg["v1"]
    bad = precheck(dims, [v0, v1])
    if bad:
        print("★ 规格值预检失败（PDD 会报「数据错误」并把矩阵建成 0 行）：")
        for b in bad:
            print("   !!", b)
        raise SystemExit(2)
    print("★ 规格值预检通过（≤40 字、无非法字符）")

    # 目录可用 listing.json 的 "dirs": {"main": "...", "detail": "...", "sku": "..."} 覆盖；
    # 否则按关键字自适应（同批素材的三种常见命名都能命中）；再不行回落到旧的 01_/02_/03_ 默认。
    dirs = cfg.get("dirs", {})

    # dirs 的值是「相对 --assets 的目录名」（handoff §四 的示例就写成 "商品轮播图"），
    # 不能当路径直接 os.listdir —— 之前会 FileNotFoundError。这里统一拼到 root 上；
    # 也允许直接给绝对路径；给的目录不存在就告警并回落到关键字自适应。
    def _resolve(v):
        if not v:
            return None
        p = v if os.path.isabs(v) else os.path.join(root, v)
        if not os.path.isdir(p):
            print("⚠️ dirs 指定的目录不存在，回落到关键字自适应：%s" % v)
            return None
        return p

    main_src = _resolve(dirs.get("main")) or find_dir_by_kw(root, ["主图", "轮播"], "01_主图")
    det_src = _resolve(dirs.get("detail")) or find_dir_by_kw(root, ["详情"], "02_详情图")
    sku_root = _resolve(dirs.get("sku")) or find_dir_by_kw(root, ["SKU", "sku", "预览"], "03_SKU图")
    sku_src = sku_root
    if sku_root and os.path.isdir(sku_root):
        sub = [d for d in os.listdir(sku_root) if os.path.isdir(os.path.join(sku_root, d))]
        merged = [d for d in sub if "汇总" in d or "合并" in d]
        if merged:
            sku_src = os.path.join(sku_root, sorted(merged)[0])
    print("素材目录 = main:%s | detail:%s | sku:%s" % (
        os.path.basename(main_src or ""), os.path.basename(det_src or ""), os.path.basename(sku_src or "")))

    main_names, main_files = copy_ascii(main_src, os.path.join(out, "main"), "main")
    det_names, det_files = copy_ascii(det_src, os.path.join(out, "detail"), "detail")

    # SKU 图映射：按「档位_色」匹配文件名（仅在维度模式下有意义；rows 模式用行内 preview）
    sku_files = {}
    if sku_src and os.path.isdir(sku_src):
        if cfg.get("tier_src") and cfg.get("color_src"):
            for f in os.listdir(sku_src):
                if not f.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                    continue
                for t in cfg.get("tier_src", {}):
                    for c, sc in cfg.get("color_src", {}).items():
                        if t in f and sc in f:
                            dst = os.path.join(out, "sku", "sku_%s_%s.png" % (t.replace("/", "_"), c))
                            os.makedirs(os.path.join(out, "sku"), exist_ok=True)
                            shutil.copyfile(os.path.join(sku_src, f), dst)
                            sku_files[(t, c)] = dst
    if cfg.get("tier_src") or cfg.get("color_src"):
        print("SKU 图映射 =", len(sku_files), "（期望", len(cfg.get("tier_src", {})) * len(cfg.get("color_src", {})), "）")
    else:
        print("SKU 图映射 = 跳过（rows 直通模式：预览图按行内 preview / 维度映射给）")

    # ★ rows 直通模式（2026-09-29）：listing.json 直接给出行数据，绕开「档位×色×长度」的维度假设。
    # 适用于任意维度结构（如「款式×尺寸」两维、72 行），并且可以逐行给 stock/价格/编码。
    # 只需要 v0/v1 两个维度值数组（可选 dims），以及每行的 {i0, i1, stock, group_price, single_price, code, preview}
    if cfg.get("rows"):
        if not v0 or not v1:
            raise SystemExit("rows 模式仍需提供 v0 / v1（维度取值数组，用于生成 dims 字段）")
        rows = []
        for r in cfg["rows"]:
            rows.append({
                dims[0]: v0[r["i0"]], dims[1]: v1[r["i1"]],
                "stock": r.get("stock", cfg.get("stock", 500)),
                "group_price": r["group_price"], "single_price": r["single_price"],
                "code": r["code"],
                "preview": sku_files.get((r.get("tier"), r.get("color"))) or r.get("preview"),
            })
        product = {
            "title": cfg["title"], "brand": cfg.get("brand", "祺讯"),
            "category": cfg.get("category", ""), "category_id": cfg.get("category_id", ""),
            "ref_price": cfg.get("ref_price", 199),
            "allow_duplicate_codes": allow_dup,
            "dimensions": dims, "attributes": cfg.get("attrs", {}), "packaging_images": [],
            "detailCount": len(det_files),
            "skus": rows,
        }
        json.dump({"product": product, "main_images": main_files, "detail_images": det_files},
                  open(os.path.join(out, "product.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        codes = {}
        for r in rows:
            codes[r["code"]] = codes.get(r["code"], 0) + 1
        print("SKU 行(rows 直通) =", len(rows), "| 主图 =", len(main_files), "| 详情图 =", len(det_files))
        print("不同编码 =", len(codes), "| 重复 =", sorted(set(codes.values())))
        print("缺预览图的行 =", len([r for r in rows if not r["preview"] or not os.path.exists(str(r["preview"]))]))
        print("->", os.path.join(out, "product.json"))
        return

    rows = []
    for t in cfg.get("tier_src", {}):
        for c in cfg.get("color_src", {}):
            for L in cfg.get("lens", []):
                gp, sp = cfg["price"][L][t]
                code = (cfg.get("code_tpl") or cfg.get("code_template") or "").format(
                    色=cfg["color_code"].get(c, c),
                    长度=cfg["len_code"].get(L, L),
                )
                rows.append({
                    dims[0]: "%s【%s】%s" % (c, cfg["tier_src"][t], t),
                    dims[1]: L,
                    "stock": cfg.get("stock", 500),
                    "group_price": gp,
                    "single_price": sp,
                    "code": code,
                    "preview": sku_files.get((t, c)),
                })
    # v0/v1 直接用 listing 里的写法覆盖（listing 优先，便于写任意措辞）
    # 2026-10-05：旧实现直接 v0[i // len(v1)]，v0 给少了会 IndexError 裸栈崩掉。
    # 这里先断言「v0 数 × v1 数 == 行数」，给出可读报错。
    need0 = len(rows) // len(v1) if v1 else 0
    if not v1 or len(rows) != len(v0) * len(v1):
        raise SystemExit(
            "★ 维度模式结构不匹配：tier_src×color_src×lens 生成 %d 行，"
            "但 v0(%d) × v1(%d) = %d。请让 len(v0)*len(v1) == 行数"
            "（例如 3 档×4 色=12 个 v0、长度 3 个 v1 → 36 行）。\n"
            "  也可以改用 rows 直通模式（listing.json 给 rows 数组），完全绕开维度假设。"
            % (len(rows), len(v0), len(v1), len(v0) * len(v1))
        )
    for i, r in enumerate(rows):
        r[dims[0]] = v0[i // (len(v1))]
        r[dims[1]] = v1[i % len(v1)]

    product = {
        "title": cfg["title"], "brand": cfg.get("brand", "祺讯"),
        "category": cfg.get("category", ""), "category_id": cfg.get("category_id", ""),
        "ref_price": cfg.get("ref_price", 199),
        "allow_duplicate_codes": allow_dup,
        "dimensions": dims, "attributes": cfg.get("attrs", {}), "packaging_images": [],
        "detailCount": len(det_files),
        "skus": rows,
    }
    missing = [r[dims[0]] + "|" + r[dims[1]] for r in rows if not r["preview"] or not os.path.exists(r["preview"])]
    json.dump({"product": product, "main_images": main_files, "detail_images": det_files},
              open(os.path.join(out, "product.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    codes = {}
    for r in rows:
        codes[r["code"]] = codes.get(r["code"], 0) + 1
    print()
    print("SKU 行 =", len(rows), "| 主图 =", len(main_files), "| 详情图 =", len(det_files))
    print("不同编码 =", len(codes), "| 重复 =", sorted(set(codes.values())))
    print("总库存 =", len(rows) * cfg.get("stock", 500), "| 最大单买价 =", max(r["single_price"] for r in rows))
    print("素材缺失 =", len(missing))
    print("->", os.path.join(out, "product.json"))


if __name__ == "__main__":
    main()
