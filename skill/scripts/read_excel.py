#!/usr/bin/env python3
"""PDD asset package Excel reader with strict precheck.

ok is true only when data is complete enough to list:
- sku_count > 0
- required fields present and non-empty
- ref_price > max(single_price)
- no blocking warnings
"""
import json
import os
import re
import sys
from pathlib import Path

try:
    from openpyxl import load_workbook
except ModuleNotFoundError:
    # 2026-10-05：PATH 上的 python 可能是没装 openpyxl 的虚拟环境（本机 hermes venv 就是），
    # 直接抛裸栈会让人误以为素材包坏了。这里给一条能照做的提示，仍按硬错误 exit 1。
    sys.stderr.write(
        "★ 当前解释器没有 openpyxl：%s\n"
        "  不要用这个 python 跑本脚本。改用装了 openpyxl 的解释器，例如本机：\n"
        r"     <your-python.exe>" "\n"
        "  或把它写进 skill 根目录 config.json 的 \"python\" 字段（resolve_env.ps1 会优先使用）。\n"
        "  安装：<该解释器> -m pip install openpyxl\n" % sys.executable
    )
    raise SystemExit(1)

DIM_CANDIDATES = [
    "颜色", "款式", "尺寸", "规格", "颜色分类", "规格类型",
    "商品规格", "自定义规格名", "图案", "花色", "系列",
]
SKU_METRIC_KEYS = {
    "预览图文件名", "库存", "拼单价", "单买价", "规格编码",
    "商品编码", "商家编码", "价格", "数量", "skuPreviewImage",
    "skuStock", "skuGroupPrice", "skuSinglePrice", "skuCode",
    "goodsCode", "规格图片",
}
BLOCKING_PREFIXES = (
    "no_pdd_sheet", "no_path", "file_not_found", "sku_count_zero",
    "no_title", "missing_title", "missing_ref_price",
    "ref_price_not_greater", "no_skus", "parse_error",
)


def _is_blocking(w: str) -> bool:
    if w.startswith(BLOCKING_PREFIXES):
        return True
    if w.startswith("sku_") and (
        "empty_stock" in w
        or "empty_group_price" in w
        or "empty_code" in w
        or "empty_single_price" in w
        or "empty_preview" in w
    ):
        return True
    if w in ("no_title_column", "no_stock_column", "no_group_price_column",
             "no_single_price_column", "no_ref_price_column", "no_preview_column",
             "missing_title", "missing_ref_price"):
        return True
    # 图片路径不参与 ok 判定（2026-09-29 依据审计修正）：图片常放在 Excel 兄弟目录，
    # read_excel 的资产根扫不到是常态；playbook 也写明「图不在 asset_roots 可忽略 blocking，靠 opts 传绝对路径」。
    # 照原判据会让标准素材包必然 ok=false，而门禁又要求 ok!==true 就停工 —— 流程永远开不了工。
    if w.startswith("duplicate_codes:") or w.startswith("ref_price_not_greater"):
        return True
    return False


def _norm_header(v) -> str:
    """Normalize header cell: strip ★/☆/*, quotes, whitespace."""
    if v is None:
        return ""
    s = str(v).strip()
    for ch in ("★", "☆", "*", "＊", "※"):
        s = s.replace(ch, "")
    return s.strip()


def _find_image(roots, filename: str):
    name = filename.strip()
    if not name:
        return True
    for root in roots:
        if not root or not Path(root).exists():
            continue
        try:
            if any(Path(root).rglob(name)):
                return True
        except OSError:
            continue
    return False


def _asset_roots(path: Path, ws_settings_root=None):
    roots = []
    if ws_settings_root:
        roots.append(Path(ws_settings_root))
    roots.append(path.parent)
    # de-dup while preserving order
    seen = set()
    out = []
    for r in roots:
        rp = str(Path(r).resolve()) if Path(r).exists() else str(r)
        if rp not in seen:
            seen.add(rp)
            out.append(Path(r))
    return out


def _read_settings_root(wb, package_dir: Path):
    """Optional 素材包设置 sheet with 根目录 / asset root."""
    for name in wb.sheetnames:
        if "素材包" in name or "设置" in name:
            ws = wb[name]
            for row in ws.iter_rows(min_row=1, max_row=min(30, ws.max_row), values_only=True):
                for i, v in enumerate(row):
                    if v is None:
                        continue
                    s = _norm_header(v)
                    if s in ("根目录", "素材根目录", "素材包根目录", "asset_root", "图片根目录") and i + 1 < len(row):
                        nxt = row[i + 1]
                        if nxt:
                            return str(nxt).strip()
                    if "=" in s and s.split("=", 1)[0].strip() in ("根目录", "素材根目录", "素材包根目录"):
                        return s.split("=", 1)[1].strip()
    # Prefer real package dir when configured path is stale/missing
    if package_dir and Path(package_dir).exists():
        return str(package_dir)
    return None


def _header_map(ws, row_idx):
    """Map normalized header name -> column index (0-based). Later cols don't overwrite first."""
    hdr = {}
    for r in ws.iter_rows(min_row=row_idx, max_row=row_idx, values_only=True):
        for i, v in enumerate(r):
            k = _norm_header(v)
            if k and k not in hdr:
                hdr[k] = i
    return hdr


def _list_images(folder_names, roots, exts=(".png", ".jpg", ".jpeg", ".webp")):
    """Collect image filenames under matching folder names (sorted)."""
    found = []
    for root in roots:
        rootp = Path(root)
        if not rootp.exists():
            continue
        for dirpath, dirnames, filenames in os.walk(rootp):
            base = Path(dirpath).name
            if base not in folder_names:
                continue
            for fn in sorted(filenames):
                if Path(fn).suffix.lower() in exts:
                    found.append(fn)
    # stable unique
    seen = set()
    out = []
    for f in found:
        if f not in seen:
            seen.add(f)
            out.append(f)
    return out


def parse(path):
    path = Path(path)
    wb = load_workbook(path, data_only=True)
    sheets = wb.sheetnames
    pdd = next((s for s in sheets if "拼多多" in s or "pdd" in s.lower()), sheets[0] if sheets else None)
    if not pdd:
        return {"error": "no_pdd_sheet", "sheets": sheets, "ok": False, "warnings": ["no_pdd_sheet"]}
    ws = wb[pdd]

    # Row 2 product headers; row 3 SKU subheaders (also merge dims found on row 2)
    hdr = _header_map(ws, 2)
    sku_hdr = _header_map(ws, 3)

    # Also allow alternate header row if row 2 looks like metadata only
    if not hdr:
        hdr = _header_map(ws, 1)

    # Dimension detection: prefer row 3, also accept known dims on row 2
    dim_names = []
    for name in DIM_CANDIDATES:
        if name in sku_hdr:
            dim_names.append(name)
    if not dim_names:
        for name in DIM_CANDIDATES:
            if name in hdr and name not in SKU_METRIC_KEYS:
                dim_names.append(name)
    if not dim_names:
        dim_names = [
            k for k in list(sku_hdr.keys()) + list(hdr.keys())
            if k not in SKU_METRIC_KEYS and k not in dim_names
        ]
        # stable unique
        _seen = set()
        _dims = []
        for k in dim_names:
            if k not in _seen:
                _seen.add(k)
                _dims.append(k)
        dim_names = _dims

    def col(*names):
        for n in names:
            if n in hdr:
                return hdr[n]
            if n in sku_hdr:
                return sku_hdr[n]
        return None

    c_title = col("商品标题", "标题", "宝贝标题", "title", "★ 商品标题")
    c_brand = col("品牌", "brand")
    c_ref = col("商品参考价", "参考价", "referencePrice")
    c_detail = col("商品详情", "详情", "detailImages")
    c_main = col("商品轮播图", "主图", "mainImages", "1:1主图")
    c_stock = col("库存", "数量", "skuStock")
    c_group = col("拼单价", "skuGroupPrice")
    c_single = col("单买价", "skuSinglePrice")
    c_code = col("规格编码", "skuCode")
    c_goods = col("商品编码", "goodsCode", "商家编码")
    c_prev = col("预览图文件名", "skuPreviewImage", "规格图片")
    c_name = col("商品名称", "商品标识", "title")

    # Category from sheet title row: "拼多多 | platform=pdd | 家居生活 > ... | cateId=16435"
    r1 = str(ws.cell(1, 1).value or "")
    category = None
    cate_id = None
    if "|" in r1:
        parts = [p.strip() for p in r1.split("|")]
        for p in parts:
            if ">" in p:
                category = p
                break
        if not category and len(parts) >= 3:
            candidate = parts[2]
            if "platform" not in candidate and "=" not in candidate:
                category = candidate
    m = re.search(r"cateId=(\d+)", r1)
    if m:
        cate_id = m.group(1)

    data_start = None
    for r in range(5, min(ws.max_row + 1, 30)):
        vals = [ws.cell(r, c).value for c in range(1, min(ws.max_column + 1, 30))]
        if any(v is not None and str(v).strip() for v in vals):
            data_start = r
            break
    if not data_start:
        data_start = 5

    rows = []
    for r in range(data_start, ws.max_row + 1):
        vals = [ws.cell(r, c).value for c in range(1, ws.max_column + 1)]
        if not any(v is not None and str(v).strip() for v in vals):
            continue
        row = {}
        title = vals[c_title] if c_title is not None and c_title < len(vals) else None
        name = vals[c_name] if c_name is not None and c_name < len(vals) else None
        if title or name:
            main_imgs = (
                [x.strip() for x in str(vals[c_main]).split(",") if x.strip()]
                if c_main is not None and c_main < len(vals) and vals[c_main]
                else []
            )
            detail_imgs = (
                [x.strip() for x in str(vals[c_detail]).split(",") if x.strip()]
                if c_detail is not None and c_detail < len(vals) and vals[c_detail]
                else []
            )
            row["_product"] = {
                "name": name or title,
                "title": title,
                "brand": vals[c_brand] if c_brand is not None and c_brand < len(vals) else None,
                "ref_price": vals[c_ref] if c_ref is not None and c_ref < len(vals) else None,
                "category": category,
                "category_id": cate_id,
                "main_images": main_imgs,
                "detail_images": detail_imgs,
            }
        dims = {}
        for dn in dim_names:
            ci = sku_hdr.get(dn, hdr.get(dn))
            if ci is not None and ci < len(vals) and vals[ci] is not None:
                dims[dn] = str(vals[ci]).strip()
        if any(dims.values()):
            row["sku"] = {
                **dims,
                "preview": vals[c_prev] if c_prev is not None and c_prev < len(vals) else None,
                "stock": vals[c_stock] if c_stock is not None and c_stock < len(vals) else None,
                "group_price": vals[c_group] if c_group is not None and c_group < len(vals) else None,
                "single_price": vals[c_single] if c_single is not None and c_single < len(vals) else None,
                "code": vals[c_code] if c_code is not None and c_code < len(vals) else None,
                "goods_code": vals[c_goods] if c_goods is not None and c_goods < len(vals) else None,
            }
        rows.append(row)

    product = None
    skus = []
    for row in rows:
        if "_product" in row:
            product = row["_product"]
        if "sku" in row:
            skus.append(row["sku"])

    warnings = []
    if c_title is None:
        warnings.append("no_title_column")
    if c_stock is None:
        warnings.append("no_stock_column")
    if c_group is None:
        warnings.append("no_group_price_column")
    if c_single is None:
        warnings.append("no_single_price_column")
    if c_code is None:
        warnings.append("no_code_column")
    if c_ref is None:
        warnings.append("no_ref_price_column")
    if c_prev is None:
        warnings.append("no_preview_column")

    if not skus:
        warnings.append("sku_count_zero")

    for i, sku in enumerate(skus):
        if sku.get("stock") is None or str(sku.get("stock")).strip() == "":
            warnings.append(f"sku_{i}_empty_stock")
        if sku.get("group_price") is None or str(sku.get("group_price")).strip() == "":
            warnings.append(f"sku_{i}_empty_group_price")
        if sku.get("single_price") is None or str(sku.get("single_price")).strip() == "":
            warnings.append(f"sku_{i}_empty_single_price")
        if sku.get("code") is None or str(sku.get("code")).strip() == "":
            warnings.append(f"sku_{i}_empty_code")
        if sku.get("preview") is None or str(sku.get("preview")).strip() == "":
            warnings.append(f"sku_{i}_empty_preview")

    if not product or not product.get("title"):
        warnings.append("missing_title")
        product = product or {"name": None, "title": None}

    # 拼多多标题上限是「30 个汉字」，不是「60 个字符」（2026-09-30 对齐门禁口径）。
    # 此前用 len() > 60 判定，导致 30 汉字的标题（len=30）永远报不出来。
    # 这里按汉字数判定并保持**非阻塞**（超长由填表阶段去冗余，不在预检硬拦）。
    _title = str(product.get("title") or "") if product else ""
    if _title:
        _han = sum(1 for ch in _title if "\u4e00" <= ch <= "\u9fff")
        if _han > 30:
            warnings.append(f"title_han_over_30:{_han}")
        elif len(_title) > 60:
            warnings.append(f"title_too_long:{len(_title)}")

    max_single = None
    for sku in skus:
        try:
            p = float(sku.get("single_price") or 0)
            if max_single is None or p > max_single:
                max_single = p
        except (TypeError, ValueError):
            pass

    ref = product.get("ref_price") if product else None
    if ref is None or str(ref).strip() == "":
        warnings.append("missing_ref_price")
    elif max_single is not None:
        try:
            if float(ref) <= max_single:
                warnings.append(f"ref_price_not_greater_than_max_single:{ref}<={max_single}")
        except (TypeError, ValueError):
            warnings.append(f"ref_price_invalid:{ref}")

    settings_root = _read_settings_root(wb, path.parent)
    roots = _asset_roots(path, settings_root if settings_root and Path(settings_root).exists() else None)

    # Excel may leave image columns empty; discover from package folders
    if product is not None:
        if not product.get("main_images"):
            product["main_images"] = _list_images(
                {"商品轮播图", "主图", "1比1主图", "轮播图"}, roots
            )
        if not product.get("detail_images"):
            product["detail_images"] = _list_images(
                {"商品详情", "详情图", "宝贝详情", "详情"}, roots
            )
        # brand empty → 无品牌 (common PDD default)
        if not product.get("brand") or str(product.get("brand")).strip() in ("", "None"):
            product["brand"] = "无品牌"

        for img in (product.get("main_images") or []):
            img = img.strip()
            if img and not _find_image(roots, img):
                warnings.append(f"main_image_missing:{img}")
        for sku in skus:
            prev = sku.get("preview")
            if prev:
                prev = str(prev).strip()
                if prev and not _find_image(roots, prev):
                    warnings.append(f"preview_missing:{prev}")
        if not product.get("main_images"):
            warnings.append("no_main_images")
        if not product.get("detail_images"):
            warnings.append("no_detail_images")

    # Duplicate codes block listing
    codes = [str(s.get("code")).strip() for s in skus if s.get("code") not in (None, "")]
    dup = {c for c in codes if codes.count(c) > 1}
    if dup:
        warnings.append(f"duplicate_codes:{','.join(sorted(dup))}")

    blocking = [w for w in warnings if _is_blocking(w)]
    ok = len(blocking) == 0 and len(skus) > 0

    headers = {k: v for k, v in {**hdr, **sku_hdr}.items()}
    return {
        "sheet": pdd,
        "headers": headers,
        "category": category,
        "category_id": cate_id,
        "dimensions": dim_names,
        "product": product,
        "skus": skus,
        "sku_count": len(skus),
        "asset_roots": [str(p) for p in roots],
        "settings_root": settings_root,
        "warnings": warnings,
        "blocking_warnings": blocking,
        "ok": ok,
    }


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else None
    if not path:
        print(json.dumps({"error": "no_path", "ok": False, "warnings": ["no_path"]}))
        sys.exit(1)
    if not Path(path).exists():
        print(json.dumps({"error": "file_not_found", "path": path, "ok": False, "warnings": ["file_not_found"]}))
        sys.exit(1)
    try:
        result = parse(path)
    except Exception as e:
        print(json.dumps({"error": "parse_error", "message": str(e), "ok": False, "warnings": [f"parse_error:{e}"]}, ensure_ascii=False))
        sys.exit(1)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result.get("ok") else 2)
