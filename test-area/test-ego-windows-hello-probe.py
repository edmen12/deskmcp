"""Candidate native Windows Hello broker safety regression.

Runs only --check, --validate and malformed/invalid-owner rejection.
NEVER exercises live --review-sign or creates Windows Hello credentials.
"""
from pathlib import Path
import subprocess
import time

EXE = Path(__file__).resolve().parents[1] / "runtime" / "ego-windows-hello-probe.exe"
assert EXE.is_file(), "Compile test-area/build-ego-windows-hello-broker.cmd first."
BASE = [
    "deskmcp-browser-human-v2",
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "accept",
    "3",
    "f" * 32,
    str(int(time.time() * 1000) + 30000),
]
VALID = "\n".join(BASE)


def run(args: list[str], data: str = VALID) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run([str(EXE), *args], input=data.encode("utf-8"),
                          capture_output=True, timeout=5, check=False)


tests = [
    ("v2_valid", ["--validate"], VALID, 0),
    ("old_version", ["--validate"], VALID.replace("human-v2", "human-v1"), 6),
    ("missing_desktop", ["--validate"], "\n".join(BASE[:3] + BASE[4:]), 6),
    ("invalid_desktop", ["--validate"], VALID.replace(BASE[3], "invalid-desktop"), 6),
    ("bad_action", ["--validate"], VALID.replace("\naccept\n", "\nexecute\n"), 6),
    ("expired", ["--validate"], VALID.replace(BASE[7], "1000"), 6),
    ("extra_line", ["--validate"], VALID + "\n", 6),
    ("embedded_nul", ["--validate"], VALID + "\x00", 6),
    ("missing_gui_owner", ["--review-sign"], VALID, 2),
    ("invalid_gui_owner", ["--review-sign", "0"], VALID, 6),
    ("legacy_direct_sign_blocked", ["--sign"], VALID, 2),
]
for label, args, data, expected in tests:
    result = run(args, data)
    assert result.returncode == expected, (
        label, result.returncode, result.stderr.decode(errors="replace"))
    print(f"PASS {label}: exit={result.returncode}")

capability = run(["--check"], "")
assert capability.returncode == 0 and b"HELLO_SUPPORTED" in capability.stdout
print("PASS read-only Windows Hello capability probe")
print("12/12 safety checks PASS. No Hello signature/PIN/enrollment executed.")
