"""Build the installable plugin ZIP after npm run build (stdlib only)."""
import json
from pathlib import Path
import stat
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]


def package():
    version = json.loads((ROOT / 'package.json').read_text())['version']
    dist = ROOT / 'dist'
    dist.mkdir(exist_ok=True)
    destination = dist / f'hermes-live-{version}.zip'
    files = [ROOT / name for name in (
        '__init__.py', 'plugin.yaml', 'LICENSE', 'NOTICE.md', 'README.md',
        'README.ko.md', 'CODEX-CALL-CONTRACT.md', 'desktop/plugin.js', 'dashboard/manifest.json',
        'scripts/install.py', 'scripts/build-whisper.mjs', 'dashboard/resources/whisper/README.md',
    )]
    files.extend((ROOT / 'dashboard').glob('*.py'))
    files.extend((ROOT / 'dashboard').glob('*.mjs'))
    whisper = ROOT / 'dashboard/resources/whisper/darwin-arm64'
    files.extend(whisper / name for name in ('whisper-server', 'manifest.json', 'LICENSE'))
    files.extend((ROOT / 'assets').glob('*.png'))
    files.extend((ROOT / 'assets').glob('*.gif'))
    with tempfile.TemporaryDirectory(dir=dist) as tmp:
        archive = Path(tmp) / destination.name
        with ZipFile(archive, 'w') as bundle:
            for file in sorted(files):
                relative = file.relative_to(ROOT).as_posix()
                special = {'desktop/plugin.js': 'desktop-plugins/hermes-live/plugin.js',
                           'scripts/install.py': 'install.py'}
                entry = ZipInfo(special.get(relative, 'plugins/hermes-live/' + relative))
                entry.create_system = 3
                executable = file.name == 'whisper-server'
                entry.external_attr = (stat.S_IFREG | (0o755 if executable else 0o644)) << 16
                bundle.writestr(entry, file.read_bytes(), compress_type=ZIP_DEFLATED)
        archive.replace(destination)
    return destination


if __name__ == '__main__':
    print(package())
