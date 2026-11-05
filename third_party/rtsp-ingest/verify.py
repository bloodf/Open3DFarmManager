# Copyright (c) Open3dFarmManager contributors. Licensed under the MIT license.
"""Check the retained source package without invoking Go or accessing the network."""
from pathlib import Path
import hashlib
import json
import re

root = Path(__file__).resolve().parent
repo = root.parent.parent
manifest = json.loads((root / "manifest.json").read_text())
modules = manifest["modules"]
assert len(modules) == 29
assert len({m["module"] for m in modules}) == 29
assert sum(bool(m["synthetic_proxy_go_mod"]) for m in modules) == 2
assert {m["module"] for m in modules if m["h1_reverification_exception"]} == {"github.com/wlynxg/anet", "golang.org/x/sys"}
expected = manifest["files"]
actual = {p.relative_to(root).as_posix(): p for p in (root / "sources").rglob("*") if p.is_file()}
assert set(expected) == set(actual)
assert len(actual) <= 6000
assert all(item["path"] not in actual for item in manifest["packaging_omissions"])
size = 0
for rel, path in actual.items():
    assert not path.is_symlink() and not Path(rel).is_absolute() and ".." not in Path(rel).parts
    data = path.read_bytes()
    assert len(data) == expected[rel]["bytes"]
    assert hashlib.sha256(data).hexdigest() == expected[rel]["sha256"]
    assert path.suffix.lower() not in {".zip", ".jar", ".exe", ".dll", ".so", ".dylib", ".a", ".o", ".pdf", ".mp4", ".mkv", ".deflate"}
    assert not data.startswith((b"\x7fELF", b"MZ", b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe", b"PK\x03\x04", b"\x1f\x8b"))
    assert b"/Users/" + b"heitor/" not in data and b".t3/" + b"task-ledgers/" not in data
    size += len(data)
assert size <= 100 * 1024 * 1024
for patch in manifest["patch_order"]:
    assert hashlib.sha256((root / patch["path"]).read_bytes()).hexdigest() == patch["sha256"]
for m in modules:
    mod = root / m["source"] / "go.mod"
    assert hashlib.sha256(mod.read_bytes()).hexdigest() == m["go_mod_sha256"]
notices = (root / "THIRD_PARTY_NOTICES.txt").read_text()
assert sum(line.startswith("Source ") for line in notices.splitlines()) == 44
mod = (repo / "tools/rtsp-ingest/go.mod").read_text()
assert mod.startswith("module open3dfarm.local/rtsp-ingest\n\ngo 1.27.1\n")
assert not re.search(r"(?m)^toolchain\s", mod)
requirements = mod.split("replace (", 1)[0]
assert len(re.findall(r"(?m)^\s*[^\s]+\s+v[^\s]+(?:\s+// indirect)?$", requirements)) == 17
assert (repo / "tools/rtsp-ingest/go.sum").read_bytes() == (root / "sources/github.com--bluenviron--gortsplib--v5/go.sum").read_bytes()
for m in modules:
    assert f'{m["module"]} {m["version"]} => ../../third_party/rtsp-ingest/{m["source"]}' in mod
assert len(re.findall(r"(?m)^\s*[^\s]+\s+v[^\s]+\s+=>\s", mod)) == 29
for path in [root / "manifest.json", root / "module-graph.json", root / "THIRD_PARTY_NOTICES.txt", repo / "tools/rtsp-ingest/go.mod"]:
    data = path.read_bytes()
    assert b"/Users/" + b"heitor/" not in data and b".t3/" + b"task-ledgers/" not in data
print(f"PASS: {len(modules)} modules, {len(actual)} source files, {size} bytes, 44 notices, 29 replacements")
