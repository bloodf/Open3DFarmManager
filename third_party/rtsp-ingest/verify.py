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
# Check selection before integrity checks so a bumped root cannot bypass a scoped replacement.
mod = (repo / "tools/rtsp-ingest/go.mod").read_text()
requirements = dict(re.findall(r"(?m)^\s*(\S+)\s+(v\S+)", mod.split("replace (", 1)[0]))
replacements = re.findall(r"(?m)^\s*(\S+)\s+(v\S+)\s+=>\s+(\S+)\s*$", mod)
by_module = {m["module"]: m for m in modules}
assert len(replacements) == len(modules)
for name, version in requirements.items():
    assert name in by_module, f"selected requirement lacks retained source: {name} {version}"
    entry = by_module[name]
    target = "../../third_party/rtsp-ingest/" + entry["source"]
    assert entry["version"] == version and (name, version, target) in replacements, f"selected requirement/local source mismatch: {name} {version}"
for entry in modules:
    proof = entry.get("upstream_verification")
    if proof:
        assert proof["module"] == entry["module"] and proof["version"] == entry["version"]
        assert proof["info"]["Version"] == entry["version"]
        assert proof["info"]["Origin"]["Hash"] == entry["upstream_revision"]
        assert proof["zip_h1"] == entry["upstream_h1"]
        assert proof["sha256"]["mod"] == entry["go_mod_sha256"]

assert {m["module"] for m in modules if m["h1_reverification_exception"]} == {"github.com/wlynxg/anet"}
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
graph = json.loads((root / "module-graph.json").read_text())
assert graph["main_require_pins"] == requirements
assert graph["selected_dependencies"] == {m["module"]: m["version"] for m in modules}
edges = []
for entry in modules:
    block = False
    for number, line in enumerate((root / entry["source"] / "go.mod").read_text().splitlines(), 1):
        text = line.split("//", 1)[0].strip()
        if text == "require (":
            block = True
            continue
        if text == ")":
            block = False
            continue
        declaration = text if block else text.removeprefix("require ") if text.startswith("require ") else ""
        match = re.fullmatch(r"(\S+)\s+(v\S+)", declaration)
        if match:
            edges.append({"from_module": entry["module"], "from_version": entry["version"], "module": match[1], "version": match[2], "indirect": "indirect" in line, "line": number, "tagx_ignore": "tagx:ignore" in line})
assert graph["edges"] == edges
assert graph["coverage"]["declared_requirements"] == len(edges)
assert graph["coverage"]["tagx_ignore_declarations"] == sum(edge["tagx_ignore"] for edge in edges)
assert graph["coverage"]["unretained_declarations"] == [edge for edge in edges if edge["module"] not in by_module]

notices = (root / "THIRD_PARTY_NOTICES.txt").read_text()
assert sum(line.startswith("Source ") for line in notices.splitlines()) == 44
mod = (repo / "tools/rtsp-ingest/go.mod").read_text()
assert mod.startswith("module open3dfarm.local/rtsp-ingest\n\ngo 1.27.1\n")
assert not re.search(r"(?m)^toolchain\s", mod)
assert len(requirements) == len(graph["main_require_pins"])
assert (repo / "tools/rtsp-ingest/go.sum").read_bytes() == (root / "sources/github.com--bluenviron--gortsplib--v5/go.sum").read_bytes()
checksum_lines = set((repo / "tools/rtsp-ingest/go.sum").read_text().splitlines())
for entry in modules:
    proof = entry.get("upstream_verification")
    if proof:
        assert f'{entry["module"]} {entry["version"]} {proof["zip_h1"]}' in checksum_lines
        assert f'{entry["module"]} {entry["version"]}/go.mod {proof["go_mod_h1"]}' in checksum_lines

for m in modules:
    assert f'{m["module"]} {m["version"]} => ../../third_party/rtsp-ingest/{m["source"]}' in mod
assert len(re.findall(r"(?m)^\s*[^\s]+\s+v[^\s]+\s+=>\s", mod)) == 29
for path in [root / "manifest.json", root / "module-graph.json", root / "THIRD_PARTY_NOTICES.txt", repo / "tools/rtsp-ingest/go.mod"]:
    data = path.read_bytes()
    assert b"/Users/" + b"heitor/" not in data and b".t3/" + b"task-ledgers/" not in data
print(f"PASS: {len(modules)} modules, {len(actual)} source files, {size} bytes, 44 notices, 29 replacements")
