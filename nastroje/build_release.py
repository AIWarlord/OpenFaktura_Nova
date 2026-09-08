# Sestaví balíčky OpenFaktura-<verze>-windows.zip a -mac.zip (včetně runtime) do zadané složky.
# Použití (ve složce programu):  python nastroje/build_release.py <vystupni_slozka>
# Vydání pak:  gh release create v<verze> <zipy> -R AIWarlord/OpenFaktura_Nova --title "OpenFaktura <verze>" --notes "..."

import io, json, os, sys, zipfile
root = os.getcwd()
ver = json.load(io.open('verze.json', encoding='utf-8'))['verze']
out_dir = sys.argv[1]
os.makedirs(out_dir, exist_ok=True)

common = ['server.js', 'verze.json', 'CTI-MNE.txt', 'OpenFaktura.bat', 'OpenFaktura.command',
          'web/index.html', 'web/lib/pdfmake.js', 'web/lib/qrcode.js']

def add(z, rel, top, mode=None):
    full = os.path.join(root, rel)
    zi = zipfile.ZipInfo(top + '/' + rel.replace(os.sep, '/'))
    zi.compress_type = zipfile.ZIP_DEFLATED
    zi.date_time = (2026, 9, 7, 12, 0, 0)
    if mode is None:
        mode = 0o755 if rel.endswith('.command') else 0o644
    zi.external_attr = (mode & 0xFFFF) << 16
    with open(full, 'rb') as f:
        z.writestr(zi, f.read())

def add_tree(z, rel_dir, top, mode=0o644):
    for dp, dn, fn in os.walk(os.path.join(root, rel_dir)):
        for n in fn:
            rel = os.path.relpath(os.path.join(dp, n), root)
            add(z, rel, top, mode)

def build(name, runtimes, exec_mode):
    top = 'OpenFaktura'
    path = os.path.join(out_dir, f'OpenFaktura-{ver}-{name}.zip')
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for rel in common: add(z, rel, top)
        for rt in runtimes: add_tree(z, os.path.join('runtime', rt), top, exec_mode)
        # prázdné složky pro data a PDF (server je stejně vytvoří sám)
        for d in ('data/faktury/', 'pdf-faktury/'):
            zi = zipfile.ZipInfo(top + '/' + d); zi.external_attr = (0o755 << 16) | 0x10; z.writestr(zi, b'')
    print(path, round(os.path.getsize(path) / 1e6, 1), 'MB')

build('windows', ['win'], 0o644)
build('mac', ['mac-arm64', 'mac-x64'], 0o755)
