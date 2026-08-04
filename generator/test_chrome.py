#!/usr/bin/env python3
"""Tests for generator/chrome.py — the ONE headless-Chrome invocation.

These exist because of a production outage nothing here caught. Every Chrome
``subprocess.run`` in the generator passed ``check=True`` and NO ``timeout=``,
so a Chrome that never exited blocked Python forever; Node gave up on its own
timer and SIGKILLed the generator, orphaning the Chrome underneath it. Each
orphan (chromium + its crashpad handler) was reparented to PID 1 and never
reaped, until the container's cgroup PID budget ran out and every spawn on the
box failed with EAGAIN.

The tests below stub Chrome with a shell script that hangs, so the failure mode
is reproduced for real rather than described:

  1. a hanging Chrome is KILLED, not waited on forever;
  2. it surfaces as a legible, actionable error, not a hang or a bare
     CalledProcessError;
  3. the stub process is actually DEAD afterwards (no orphan);
  4. every render path in the generator goes through this module — the guard
     that makes the fix survive the next render path someone adds.

Run: python3 generator/test_chrome.py   (or via pytest)
"""
import os
import re
import subprocess
import sys
import tempfile
import time

import chrome

HERE = os.path.dirname(os.path.abspath(__file__))


def _stub(body, tmp, name="fake-chrome"):
    """Write an executable shell script standing in for the Chrome binary."""
    path = os.path.join(tmp, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write("#!/bin/sh\n" + body)
    os.chmod(path, 0o755)
    return path


def _alive(pid):
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


# --- 1. a hanging Chrome is bounded, killed, and explained -------------------

def test_a_hanging_chrome_is_killed_instead_of_blocking_forever():
    with tempfile.TemporaryDirectory() as tmp:
        # Writes the PNG (so the "did it produce output" check can't be what
        # rescues us) and then hangs, exactly like the Chrome that took staging
        # down: the screenshot was fine, the browser just never exited.
        pidfile = os.path.join(tmp, "pid")
        exe = _stub(
            'echo "$$" > "%s"\n'
            'for a in "$@"; do\n'
            '  case "$a" in --screenshot=*) : > "${a#--screenshot=}";; esac\n'
            'done\n'
            'sleep 120\n' % pidfile,
            tmp,
        )
        os.environ["CHROME"] = exe
        try:
            started = time.time()
            try:
                chrome.screenshot(os.path.join(tmp, "in.svg"),
                                  os.path.join(tmp, "out.png"), 100, 100,
                                  timeout=2)
            except chrome.ChromeTimeout as exc:
                took = time.time() - started
                msg = str(exc)
            else:
                raise AssertionError("a Chrome that never exits must not succeed")
        finally:
            os.environ.pop("CHROME", None)

        # (1) bounded — it returned on the timeout, not after the stub's sleep.
        assert took < 30, f"waited {took:.1f}s; the timeout was not enforced"
        # (2) legible: says what timed out, how long we waited, and what to do.
        assert "2s" in msg or "2 s" in msg, msg
        assert re.search(r"timed out|did not finish", msg), msg
        assert "DUGRI_CHROME_TIMEOUT_S" in msg, "the message must name the knob"
        # (3) no orphan: the stub is gone.
        pid = int(open(pidfile, encoding="utf-8").read().strip())
        for _ in range(50):
            if not _alive(pid):
                break
            time.sleep(0.1)
        assert not _alive(pid), (
            f"Chrome stub {pid} survived the timeout — this is the leak: every "
            "such survivor is a permanently orphaned browser"
        )


def test_the_timeout_error_is_a_runtime_error_callers_already_handle():
    # order_to_pdf/preview surface RuntimeError to the owner; a timeout must not
    # slip past as a subprocess exception type nobody catches.
    assert issubclass(chrome.ChromeTimeout, chrome.ChromeError)
    assert issubclass(chrome.ChromeError, RuntimeError)


def test_a_chrome_that_writes_nothing_is_an_error_not_a_silent_success():
    with tempfile.TemporaryDirectory() as tmp:
        exe = _stub("exit 0\n", tmp)
        os.environ["CHROME"] = exe
        try:
            try:
                chrome.screenshot("in.svg", os.path.join(tmp, "out.png"), 10, 10)
            except chrome.ChromeError as exc:
                assert "MISSING" in str(exc), str(exc)
            else:
                raise AssertionError("exit 0 with no screenshot must raise")
        finally:
            os.environ.pop("CHROME", None)


def test_a_failing_chrome_quotes_what_chrome_said():
    with tempfile.TemporaryDirectory() as tmp:
        exe = _stub('echo "could not load font" 1>&2\nexit 3\n', tmp)
        os.environ["CHROME"] = exe
        try:
            try:
                chrome.screenshot("in.svg", os.path.join(tmp, "out.png"), 10, 10,
                                  what="the board")
            except chrome.ChromeError as exc:
                assert "the board" in str(exc)
                assert "could not load font" in str(exc)
                assert "exit 3" in str(exc)
            else:
                raise AssertionError("a non-zero exit must raise")
        finally:
            os.environ.pop("CHROME", None)


def test_a_missing_binary_names_the_binary_and_the_env_var():
    os.environ["CHROME"] = "/no/such/chrome-binary"
    try:
        try:
            chrome.screenshot("in.svg", "/tmp/out.png", 10, 10)
        except chrome.ChromeError as exc:
            assert "/no/such/chrome-binary" in str(exc)
            assert "CHROME" in str(exc)
        else:
            raise AssertionError("an unrunnable binary must raise")
    finally:
        os.environ.pop("CHROME", None)


# --- 2. the flags ------------------------------------------------------------

def test_the_argv_carries_the_container_flags_and_the_font_wait():
    with tempfile.TemporaryDirectory() as tmp:
        argfile = os.path.join(tmp, "argv")
        exe = _stub(
            'printf "%s\\n" "$@" > "{a}"\n'
            'for x in "$@"; do\n'
            '  case "$x" in --screenshot=*) : > "${{x#--screenshot=}}";; esac\n'
            'done\n'.format(a=argfile),
            tmp,
        )
        os.environ["CHROME"] = exe
        try:
            chrome.screenshot(os.path.join(tmp, "in.svg"),
                              os.path.join(tmp, "out.png"), 640, 480, scale=3)
            argv = open(argfile, encoding="utf-8").read().split("\n")
            assert "--headless" in argv
            assert "--no-sandbox" in argv          # root in a container
            assert "--disable-dev-shm-usage" in argv
            assert chrome.FONT_WAIT in argv        # embedded @font-face must load
            assert "--force-device-scale-factor=3" in argv
            assert "--window-size=640,480" in argv
            # Verified on Chrome 150.0.7871.187: a per-run --user-data-dir makes
            # the browser write the screenshot and then HANG until killed, while
            # the same run without it exits in ~2.2s. It causes the exact failure
            # it was proposed to prevent, so it must stay out.
            assert not any(a.startswith("--user-data-dir") for a in argv), (
                "a per-run --user-data-dir makes headless Chrome hang after "
                "writing the screenshot — measured, not assumed"
            )
        finally:
            os.environ.pop("CHROME", None)


def test_font_wait_is_off_for_the_detection_paths():
    with tempfile.TemporaryDirectory() as tmp:
        argfile = os.path.join(tmp, "argv")
        exe = _stub(
            'printf "%s\\n" "$@" > "{a}"\n'
            'for x in "$@"; do\n'
            '  case "$x" in --screenshot=*) : > "${{x#--screenshot=}}";; esac\n'
            'done\n'.format(a=argfile),
            tmp,
        )
        os.environ["CHROME"] = exe
        try:
            chrome.screenshot(os.path.join(tmp, "in.svg"),
                              os.path.join(tmp, "out.png"), 10, 10,
                              font_wait=False)
            argv = open(argfile, encoding="utf-8").read().split("\n")
            assert chrome.FONT_WAIT not in argv
        finally:
            os.environ.pop("CHROME", None)


def test_print_pdf_uses_the_longer_budget_and_no_virtual_clock():
    # The deck is one Chrome pass over 200+ pages, so it needs its own ceiling;
    # a virtual-time budget there makes Chrome sit out the whole clock.
    assert chrome.PRINT_TIMEOUT_S > chrome.TIMEOUT_S
    with tempfile.TemporaryDirectory() as tmp:
        argfile = os.path.join(tmp, "argv")
        exe = _stub(
            'printf "%s\\n" "$@" > "{a}"\n'
            'for x in "$@"; do\n'
            '  case "$x" in --print-to-pdf=*) : > "${{x#--print-to-pdf=}}";; esac\n'
            'done\n'.format(a=argfile),
            tmp,
        )
        os.environ["CHROME"] = exe
        try:
            chrome.print_pdf(os.path.join(tmp, "deck.html"),
                             os.path.join(tmp, "deck.pdf"))
            argv = open(argfile, encoding="utf-8").read().split("\n")
            assert any(a.startswith("--print-to-pdf=") for a in argv)
            assert "--no-pdf-header-footer" in argv
            assert chrome.FONT_WAIT not in argv
        finally:
            os.environ.pop("CHROME", None)


def test_the_screenshot_budget_is_generous_but_finite():
    # Generous: the heaviest real render (the eight-front strip at scale 2, on
    # top of a 15s virtual clock) measures 3-5s, and the container is slower.
    # Finite: an unbounded run is the whole bug.
    assert 60 <= chrome.TIMEOUT_S <= 600
    assert 60 <= chrome.PRINT_TIMEOUT_S <= 900


# --- 3. no render path may bypass the module ---------------------------------

RENDER_MODULES = ["render_page.py", "build.py", "calibrate.py", "recipe.py",
                  "recipe_diff.py", "render_card.py"]


def test_no_generator_module_invokes_chrome_by_hand():
    # The original bug was seven hand-rolled invocations in six modules, each
    # rebuilding the flag list and none of them with a timeout. Adding another
    # one must fail here rather than in production a thousand renders later.
    offenders = []
    for name in RENDER_MODULES + ["preview.py", "order_to_pdf.py", "press.py",
                                  "redetect.py", "pack.py", "topup.py"]:
        path = os.path.join(HERE, name)
        if not os.path.exists(path):
            continue
        src = open(path, encoding="utf-8").read()
        for m in re.finditer(r"subprocess\.(run|Popen|call|check_output)\(", src):
            window = src[m.start():m.start() + 400]
            if "CHROME" in window or "--headless" in window:
                line = src[:m.start()].count("\n") + 1
                offenders.append(f"{name}:{line}")
    assert not offenders, (
        "these call Chrome directly instead of going through generator/chrome.py, "
        "so they get no timeout and no kill-on-expiry: " + ", ".join(offenders)
    )


def test_chrome_is_never_given_its_own_session():
    # server/index.js kills the generator's whole process GROUP; Chrome only
    # receives that signal because it inherits the group. Putting it in its own
    # session would make it survive exactly the kill meant to reach it.
    src = open(os.path.join(HERE, "chrome.py"), encoding="utf-8").read()
    code = "\n".join(line for line in src.splitlines()
                     if not line.lstrip().startswith("#"))
    assert "start_new_session=True" not in code
    assert "setsid" not in code
    assert "preexec_fn" not in code


def test_every_render_module_still_exposes_its_chrome_binary():
    # The re-exported names other modules and tests read.
    import build
    import calibrate
    import recipe
    import recipe_diff
    import render_card
    import render_page as rp
    for mod in (rp, build, calibrate, recipe, recipe_diff, render_card):
        assert mod.CHROME == chrome.CHROME, mod.__name__
    assert rp.CHROME_FONT_WAIT == chrome.FONT_WAIT
    assert build.DECK_TIMEOUT_S == chrome.PRINT_TIMEOUT_S


# --- 4. the real thing, when a real browser is available ---------------------

def _real_chrome():
    import shutil
    exe = chrome.CHROME
    if exe and os.path.exists(exe):
        return exe
    return (shutil.which("google-chrome") or shutil.which("chromium")
            or shutil.which("chromium-browser"))


def test_a_real_render_leaves_no_chrome_behind():
    """The end-to-end property: after a render, the process table is as it was.

    This is the check the owner ran against the container by hand
    (``pids.current`` must return to baseline, not climb). Skipped when there is
    no browser installed.
    """
    exe = _real_chrome()
    if not exe:
        print("  (skipped: no Chrome)")
        return
    pattern = os.path.basename(exe)

    def count():
        r = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True)
        return len([p for p in r.stdout.split() if p.strip()])

    with tempfile.TemporaryDirectory() as tmp:
        svg = os.path.join(tmp, "t.svg")
        with open(svg, "w", encoding="utf-8") as f:
            f.write('<svg xmlns="http://www.w3.org/2000/svg" width="200" '
                    'height="120"><rect width="200" height="120" fill="#eee"/>'
                    '</svg>')
        os.environ["CHROME"] = exe
        try:
            before = count()
            for i in range(3):
                chrome.screenshot(svg, os.path.join(tmp, f"o{i}.png"), 200, 120,
                                  scale=1)
            for _ in range(30):
                after = count()
                if after <= before:
                    break
                time.sleep(0.2)
        finally:
            os.environ.pop("CHROME", None)
    assert after <= before, (
        f"{after - before} Chrome process(es) survived three renders — that is "
        "the leak that exhausted the container's PID budget"
    )


if __name__ == "__main__":
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("ok  ", name)
            except Exception as exc:  # noqa: BLE001 - test runner
                failed += 1
                print("FAIL", name, "-", exc)
    sys.exit(1 if failed else 0)
