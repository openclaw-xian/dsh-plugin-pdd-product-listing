# -*- coding: utf-8 -*-
"""把 dsh-plugin-pdd-product-listing 装进某个 DSH profile。

由 install.ps1 调用（本插件本来就要求机器上有 Python）。

用法：
  python install.py --plugin-dir <插件目录> --profile-dir <profile 目录> [--name dsh-plugin-pdd-product-listing]

做四件事：
  1. 复制插件到 <profile>/node_modules/<name>
  2. 把 <name> 追加进 <profile>/package.json 的 dsh.profile.bundles
  3. 在 <profile>/cordis.patch.yml 追加插件配置（已存在则跳过）
  4. 依赖体检（Python/openpyxl、playwright-core）
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

# Windows 控制台默认是 GBK：print 中文会 UnicodeEncodeError。
# 这里自己兜住，不依赖调用方设 PYTHONIOENCODING。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

NAME = 'dsh-plugin-pdd-product-listing'


def log(msg):
    print('==> ' + msg, flush=True)


def warn(msg):
    print('!! ' + msg, flush=True)


def load_json(path):
    """容忍 BOM：别的机器上 profile 的 package.json 可能是 UTF-8 with BOM。"""
    try:
        raw = open(path, 'rb').read()
    except FileNotFoundError:
        return None, False
    bom = raw.startswith(b'\xef\xbb\xbf')
    text = raw.decode('utf-8-sig')
    try:
        return json.loads(text), bom
    except Exception as e:
        raise SystemExit('无法解析 %s：%s' % (path, e))


def dump_json(path, data, bom=False):
    """写回 profile 的 package.json。

    ⚠️ 这里**故意不写 BOM**：dsh 用 `JSON.parse(readFileSync(...))` 读 profile manifest，
    带 BOM 会直接报 `SyntaxError: Unexpected token '\\ufeff'` 而启动失败。
    所以即使原文件带 BOM（某些工具生成的），我们也写成无 BOM 的 UTF-8。
    """
    text = json.dumps(data, ensure_ascii=False, indent=2) + '\n'
    with open(path, 'wb') as f:
        f.write(text.encode('utf-8'))


def find_profile_dir(explicit):
    """推断目标 profile 目录：显式 > DSH_HOME 环境变量 > ~/.dsh；profile 名按 desktop > web > tui 选。"""
    if explicit:
        p = os.path.abspath(explicit)
        if not os.path.isdir(p):
            raise SystemExit('profile 目录不存在：%s' % p)
        return p
    home = os.environ.get('DSH_HOME') or os.path.join(os.path.expanduser('~'), '.dsh')
    root = os.path.join(home, 'profiles')
    if not os.path.isdir(root):
        raise SystemExit('找不到 profiles 目录：%s（可用 --profile-dir 显式指定）' % root)
    for name in ('desktop', 'web', 'tui'):
        cand = os.path.join(root, name)
        if os.path.isdir(cand):
            return cand
    others = [d for d in sorted(os.listdir(root))
              if os.path.isdir(os.path.join(root, d)) and d != 'node_modules']
    if len(others) == 1:
        return os.path.join(root, others[0])
    raise SystemExit('无法判断 profile，请用 --profile-dir 指定。候选：%s' % ', '.join(others))


def find_python_with_openpyxl():
    """在候选解释器里找第一个能 import openpyxl 的（PATH 上的 python 可能是个没有它的 venv）。
    @returns (解释器路径, "版本 openpyxl版本") 或 None"""
    cands = []
    if os.environ.get('PDD_PYTHON'):
        cands.append(os.environ['PDD_PYTHON'])
    cands.append(sys.executable)
    # 本机常见的独立 Python 安装（PATH 上那个可能是工具链自带的 venv）
    home = os.path.expanduser('~')
    cands += [
        os.path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
        os.path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
        os.path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'python.exe'),
    ]
    for name in ('python', 'python3', 'py'):
        p = shutil.which(name)
        if p:
            cands.append(p)
    seen = set()
    code = ('import sys, openpyxl; '
            'print("%s openpyxl %s" % (sys.version.split()[0], openpyxl.__version__))')
    for exe in cands:
        if not exe:
            continue
        exe = os.path.abspath(exe)
        if exe in seen or not os.path.isfile(exe):
            continue
        seen.add(exe)
        try:
            r = subprocess.run([exe, '-c', code], capture_output=True, text=True, timeout=20)
            if r.returncode == 0:
                return exe, (r.stdout or '').strip()
        except Exception:
            continue
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--plugin-dir', default=None,
                    help='插件目录（默认：本脚本所在目录）')
    ap.add_argument('--profile-dir', default=None,
                    help='目标 profile 目录（默认：从 DSH_HOME/~/.dsh 推断 desktop>web>tui）')
    ap.add_argument('--name', default=NAME)
    a = ap.parse_args()

    src = os.path.abspath(a.plugin_dir or os.path.dirname(os.path.abspath(__file__)))
    prof = find_profile_dir(a.profile_dir)
    if not os.path.isdir(src):
        raise SystemExit('插件目录不存在：%s' % src)
    log('插件目录: %s' % src)
    log('目标 profile: %s' % prof)

    dest = os.path.join(prof, 'node_modules', a.name)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    shutil.copytree(src, dest, ignore=shutil.ignore_patterns('node_modules', '.git', '__pycache__'))
    log('已复制插件 -> %s' % dest)

    # 2) bundles
    pkg_path = os.path.join(prof, 'package.json')
    pkg, had_bom = load_json(pkg_path)
    pkg = pkg or {}
    pkg.setdefault('name', 'dsh-profile-' + os.path.basename(prof))
    pkg.setdefault('private', True)
    bundles = pkg.setdefault('dsh', {}).setdefault('profile', {}).setdefault('bundles', [])
    if a.name not in bundles:
        bundles.append(a.name)
        dump_json(pkg_path, pkg, bom=had_bom)
        log('已把 %s 追加进 dsh.profile.bundles' % a.name)
    else:
        log('bundles 里已存在 %s' % a.name)
    print('    bundles = %s' % json.dumps(bundles, ensure_ascii=False))

    # 3) cordis.patch.yml
    patch_path = os.path.join(prof, 'cordis.patch.yml')
    text = ''
    if os.path.isfile(patch_path):
        with open(patch_path, encoding='utf-8') as f:
            text = f.read()
    if 'id: pdd-product-listing' in text:
        log('cordis.patch.yml 已存在该条目')
    else:
        if not text.strip():
            text = '# profile patch layer (managed by dsh-plugin-pdd-product-listing/install.py)\n'
        text = text.rstrip('\n') + '\n\n- id: pdd-product-listing\n  config:\n    verbose: false\n'
        with open(patch_path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(text)
        log('已追加 cordis.patch.yml 配置')

    # 4) 依赖体检：找「带 openpyxl」的解释器（PATH 上的 python 未必是它）
    print('')
    log('依赖体检')
    py_ok = find_python_with_openpyxl()
    plugin_cfg = os.path.join(dest, 'skill', 'config.json')
    if py_ok:
        print('    Python OK -> %s (%s)' % (py_ok[0], py_ok[1]))
        if os.path.isfile(plugin_cfg):
            try:
                with open(plugin_cfg, encoding='utf-8') as f:
                    cfg = json.load(f)
                cfg['python'] = py_ok[0]
                with open(plugin_cfg, 'w', encoding='utf-8', newline='\n') as f:
                    json.dump(cfg, f, ensure_ascii=False, indent=2)
                    f.write('\n')
                print('    已把该解释器写进插件配置 skill/config.json 的 "python"')
            except Exception as e:
                warn('写插件配置失败（可用环境变量 PDD_PYTHON 代替）：%s' % e)
    else:
        warn('没找到带 openpyxl 的 Python —— read_excel.py 会失败。')
        print('    处理：任一解释器执行  <python> -m pip install openpyxl')
        print('    然后重跑本脚本，或在插件配置里指定 pythonPath。')

    home = os.path.expanduser('~')
    pw_candidates = [
        os.path.join(os.path.dirname(os.path.dirname(prof)), 'node_modules', 'playwright-core'),
        os.path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', 'playwright-core'),
        os.path.join(home, '.dsh', 'profiles', 'node_modules', 'playwright-core'),
    ]
    hit = next((p for p in pw_candidates if os.path.isfile(os.path.join(p, 'package.json'))), None)
    if hit:
        print('    playwright-core OK -> %s' % hit)
    else:
        warn('没找到 playwright-core：可在插件目录 npm i playwright-core，或在 DSH 插件配置里指定 playwrightCore')

    # 5) 提示 Chrome
    print('    Chrome：需已登录店铺并以 --remote-debugging-port=<端口> 启动（技能自带 scripts/open_browser.ps1）')

    print('')
    log('完成。请重启 DeepSeek Harness，然后在会话里用 /pdd-product-listing（或直接说“把这个素材包上架到店铺C”）。')
    print('    本插件只填空与校验，绝不代替你提交商品。')


if __name__ == '__main__':
    main()
