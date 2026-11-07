#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Finite diagnostic initialization. No stock-startup or readiness equivalence."""
import hashlib
from itertools import islice
import os
from pathlib import Path
import re
import stat
import sys

START_SHA256 = "4b2fac02b4c399495b2f908e11289635121286ead321e30cf297293f0ee651ee"
CONFIG = Path("/etc/supervisor/supervisord.conf")
HOME = Path("/home/printer")
DATA = HOME / "printer_data"
PID = DATA / "comms/supervisord.pid"


def owned_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_gid != os.getgid():
        raise ValueError(f"diagnostic directory ownership/type rejected: {path}")


def copy_defaults(source, destination, budget):
    """Copy only bounded regular files/directories from the digest-pinned image."""
    info = source.lstat()
    budget[0] += 1
    if budget[0] > 1024:
        raise ValueError("diagnostic defaults exceed 1024 entries")
    if stat.S_ISDIR(info.st_mode):
        destination.mkdir(mode=0o700, exist_ok=True)
        owned_directory(destination)
        children = list(islice(source.iterdir(), 1025))
        if len(children) > 1024:
            raise ValueError("diagnostic defaults exceed 1024 entries")
        for child in sorted(children):
            copy_defaults(child, destination / child.name, budget)
    elif stat.S_ISREG(info.st_mode):
        budget[1] += info.st_size
        if budget[1] > 16 * 1024 * 1024:
            raise ValueError("diagnostic defaults exceed 16 MiB")
        with source.open("rb") as reader, destination.open("xb") as writer:
            content = reader.read(info.st_size + 1)
            if len(content) != info.st_size:
                raise ValueError("diagnostic defaults changed during copy")
            writer.write(content)
    else:
        raise ValueError(f"diagnostic default is not a regular file/directory: {source}")


def link_component(source, target):
    if not stat.S_ISREG(source.lstat().st_mode):
        raise ValueError(f"diagnostic component type rejected: {source}")
    owned_directory(target.parent)
    if os.path.lexists(target):
        raise ValueError(f"diagnostic component target already exists: {target}")
    target.symlink_to(source)


def initialize():
    owned_directory(HOME)
    owned_directory(DATA)
    if stat.S_IMODE(DATA.lstat().st_mode) != 0o700:
        raise ValueError("diagnostic data root permissions rejected")
    # Only the independently mounted communications directory may pre-exist.
    if sorted(child.name for child in DATA.iterdir()) != ["comms"]:
        raise ValueError("diagnostic data root is not fresh")
    owned_directory(DATA / "comms")
    if stat.S_IMODE((DATA / "comms").lstat().st_mode) != 0o700:
        raise ValueError("diagnostic communications permissions rejected")
    if any((DATA / "comms").iterdir()):
        raise ValueError("diagnostic communications directory is not empty")
    for name in ("config", "logs", "gcodes", "webcam_images", "timelapse", "database"):
        (DATA / name).mkdir(mode=0o700)
    budget = [0, 0]
    copy_defaults(HOME / "example-configs", DATA / "config", budget)
    # Stock webcamd reads this immutable directory; preserve its command unchanged.
    copy_defaults(HOME / "mjpg_streamer_images", DATA / "webcam_images", budget)
    link_component(HOME / "moonraker-timelapse/component/timelapse.py",
                   HOME / "moonraker/moonraker/components/timelapse.py")
    link_component(HOME / "moonraker-timelapse/klipper_macro/timelapse.cfg",
                   DATA / "config/addons/timelapse.cfg")


def main():
    if (len(sys.argv) != 2 or not re.fullmatch(r"[0-9a-f]{64}", sys.argv[1])
            or os.getuid() != 1000 or os.getgid() != 1000
            or os.environ.get("HOME") != str(HOME)):
        raise ValueError("diagnostic identity/arguments rejected")
    with Path("/bin/start").open("rb") as reader:
        start = reader.read(3493)
    if len(start) != 3492 or hashlib.sha256(start).hexdigest() != START_SHA256:
        raise ValueError("diagnostic stock startup provenance rejected")
    with CONFIG.open("rb") as reader:
        content = reader.read(256 * 1024 + 1)
    if len(content) > 256 * 1024 or hashlib.sha256(content).hexdigest() != sys.argv[1]:
        raise ValueError("diagnostic transformed configuration rejected")
    # No systemctl/service_control replacement or invocation is permitted.
    if os.path.lexists("/bin/systemctl"):
        raise ValueError("diagnostic requires systemctl to remain absent")
    os.umask(0o077)
    initialize()
    os.chdir(HOME)
    os.execv("/usr/bin/supervisord", ["/usr/bin/supervisord", "-c", str(CONFIG),
                                    "-j", str(PID)])


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(f"unprivileged-diagnostic-v1 startup refused: {error}", file=sys.stderr)
        sys.exit(78)
