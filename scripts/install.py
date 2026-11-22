"""Install the extracted Hermes Live ZIP into an existing Hermes profile."""
import argparse
from contextlib import ExitStack
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
from uuid import uuid4


def retry_readonly_removal(remove, path, error):
    # copytree can preserve the Windows read-only attribute on a staged file.
    exc = error[1]
    if remove not in (os.unlink, os.rmdir) or not isinstance(exc, PermissionError):
        raise exc
    attributes = os.lstat(path).st_file_attributes
    if attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT or not attributes & stat.FILE_ATTRIBUTE_READONLY:
        raise exc
    os.chmod(path, stat.S_IWRITE)
    remove(path)


def install(source, home):
    home = home.expanduser().absolute()
    if not home.is_dir():
        raise ValueError(f"Select an existing Hermes profile directory: {home}")
    root = home.parent.parent if home.parent.name.lower() == "profiles" else home
    desktop = root / "desktop-plugins/hermes-live"
    backend = home / "plugins/hermes-live"
    frontend = source / "desktop-plugins/hermes-live"
    agent = source / "plugins/hermes-live"
    if not (agent / "plugin.yaml").is_file() or not (frontend / "plugin.js").is_file():
        raise ValueError("Extract the complete release ZIP before running install.py.")
    if os.path.lexists(backend):
        raise ValueError(f"Move the existing plugin to a backup directory before updating: {backend}")
    copies = []
    if os.path.lexists(desktop):
        entry = desktop / "plugin.js"
        if (desktop.is_symlink() or entry.is_symlink() or not entry.is_file()
                or os.path.lexists(desktop / ".hermes-package.json")
                or entry.read_bytes() != (frontend / "plugin.js").read_bytes()):
            raise ValueError(f"Move the existing Desktop plugin to a backup directory before updating: {desktop}")
    else:
        copies.append((frontend, desktop))
    copies.append((agent, backend))
    # Publish complete directories. A retry after a Desktop-only install reuses the bundle.
    with ExitStack() as staging:
        ready = []
        for src, dest in copies:
            dest.parent.mkdir(exist_ok=True)
            if sys.platform == "win32":
                # TemporaryDirectory creates a protected Windows ACL (mode 0700).
                # A normal mkdir inherits this plugin root's ACL before we copy.
                tmp = dest.parent / f".hermes-live-stage-{uuid4().hex}"
                tmp.mkdir()
                staging.callback(shutil.rmtree, tmp, onerror=retry_readonly_removal)
            else:
                tmp = Path(staging.enter_context(tempfile.TemporaryDirectory(dir=dest.parent)))
            staged = tmp / "payload"
            shutil.copytree(src, staged)
            ready.append((staged, dest))
        for staged, dest in ready:
            staged.rename(dest)
    print(f"Backend: {backend}\nDesktop: {desktop}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile-home", default=os.environ.get("HERMES_HOME"),
                        help="existing profile directory (default: HERMES_HOME)")
    args = parser.parse_args()
    if not args.profile_home:
        parser.error("set HERMES_HOME or pass --profile-home")
    try:
        install(Path(__file__).resolve().parent, Path(args.profile_home))
    except (OSError, ValueError) as exc:
        parser.exit(1, f"{exc}\n")
