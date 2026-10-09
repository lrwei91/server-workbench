# Windows x64 上执行；静态资源布局与 cdr/app.py 的 RESOURCE_ROOT 一致。
from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules

root = Path(SPECPATH).parent
a = Analysis(
    [str(root / 'cdr' / 'server.py')],
    pathex=[str(root / 'cdr')],
    binaries=[],
    datas=[(str(root / 'cdr' / 'static'), 'cdr/static'), (str(root / 'shared'), 'shared')],
    hiddenimports=collect_submodules('uvicorn'),
    hookspath=[], hooksconfig={}, runtime_hooks=[], excludes=[], noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='cdr-service', debug=False,
          bootloader_ignore_signals=False, strip=False, upx=False, console=True)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='cdr-service')
