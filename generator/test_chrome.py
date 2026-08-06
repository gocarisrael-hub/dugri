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

Sections 5 and 6 cover the SECOND outage from the same module: with no per-run
profile every Chrome invocation contended for ``$HOME/.config/chromium`` and its
SingletonLock, so exactly ONE render could run on the container at a time and
every other one died in ~2.5s — including the public /api/preview renders, 59 of
~87 of which failed while a single deck was generating. What is pinned here is
the property, not the mechanism: each run gets a private profile, that profile is
gone afterwards HOWEVER the run ended, and the number in flight is capped so
separate profiles do not just move the failure to the container's PID ceiling.

Run: python3 generator/test_chrome.py   (or via pytest)
"""
import concurrent.futures as cf
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


class _env:
    """Set env vars for the duration of a block and restore them after."""

    def __init__(self, **kw):
        self.kw = {k: (None if v is None else str(v)) for k, v in kw.items()}
        self.old = {}

    def __enter__(self):
        for k, v in self.kw.items():
            self.old[k] = os.environ.get(k)
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        return self

    def __exit__(self, *exc):
        for k, v in self.old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        return False


def _profiles(root):
    """The per-run profile directories currently sitting under ``root``."""
    try:
        return sorted(n for n in os.listdir(root) if n.startswith("run-"))
    except OSError:
        return []


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
            # Per-run profile isolation is real (see section 5) but does NOT go
            # through this flag. Re-measured on Chrome 150.0.7871.187: with
            # --user-data-dir the browser writes the screenshot and then HANGS
            # until killed — fresh dir, reused dir, with the first-run flags and
            # with --use-mock-keychain, every combination. The same isolation via
            # HOME exits in ~3.3s. Reaching for the flag again is the mistake
            # this line exists to catch.
            assert not any(a.startswith("--user-data-dir") for a in argv), (
                "a per-run --user-data-dir makes headless Chrome hang after "
                "writing the screenshot — measured, not assumed; isolate the "
                "profile through HOME/XDG_* instead (see _private_profile)"
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


# --- 5. every run gets a private profile, and gives it back ------------------
#
# The defect: no per-run profile → every invocation shares
# $HOME/.config/chromium → `Failed to create .../SingletonLock: File exists (17)`
# → exactly one render at a time on the whole container, previews included.

def _record_env_stub(tmp, dumpfile, body=""):
    """A Chrome stub that dumps its environment (and writes the screenshot)."""
    return _stub(
        'env >> "{d}"\n'
        'for x in "$@"; do\n'
        '  case "$x" in --screenshot=*) : > "${{x#--screenshot=}}";; esac\n'
        'done\n'.format(d=dumpfile) + body,
        tmp,
    )


def _homes(dumpfile):
    return [ln.split("=", 1)[1]
            for ln in open(dumpfile, encoding="utf-8").read().splitlines()
            if ln.startswith("HOME=")]


def test_each_run_gets_its_own_profile_directory():
    # The fix itself: two runs must not be able to see each other's profile, or
    # the second one dies on the first one's SingletonLock.
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "profiles")
        dump = os.path.join(tmp, "env")
        exe = _record_env_stub(tmp, dump)
        with _env(CHROME=exe, DUGRI_CHROME_PROFILE_ROOT=root):
            for i in range(3):
                chrome.screenshot(os.path.join(tmp, "in.svg"),
                                  os.path.join(tmp, f"o{i}.png"), 10, 10)
        homes = _homes(dump)
        assert len(homes) == 3, homes
        assert len(set(homes)) == 3, f"runs shared a profile: {homes}"
        for h in homes:
            assert h.startswith(root), f"{h} is not under the profile root"


def test_the_xdg_pair_moves_too_because_it_outranks_home_on_linux():
    # XDG_CONFIG_HOME takes precedence over HOME for Chrome's profile path on
    # Linux — the container. Moving HOME alone would leave the container (the
    # only box where this bug bites) still sharing one profile.
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "profiles")
        dump = os.path.join(tmp, "env")
        exe = _record_env_stub(tmp, dump)
        with _env(CHROME=exe, DUGRI_CHROME_PROFILE_ROOT=root,
                  XDG_CONFIG_HOME=os.path.join(tmp, "shared-config"),
                  XDG_CACHE_HOME=os.path.join(tmp, "shared-cache")):
            chrome.screenshot(os.path.join(tmp, "in.svg"),
                              os.path.join(tmp, "o.png"), 10, 10)
        env = dict(ln.split("=", 1) for ln in
                   open(dump, encoding="utf-8").read().splitlines() if "=" in ln)
        home = env["HOME"]
        assert env["XDG_CONFIG_HOME"].startswith(home), env["XDG_CONFIG_HOME"]
        assert env["XDG_CACHE_HOME"].startswith(home), env["XDG_CACHE_HOME"]


def test_the_credential_store_flags_are_present():
    # A brand-new profile asks the OS credential store for an encryption key,
    # and in headless that request never returns: on macOS the screenshot is
    # written and the browser hangs forever. These two flags are the entire
    # difference between a 45s+ timeout and a 3.3s render, so per-run profiles
    # are only safe WITH them. Dropping one re-creates the hang that made the
    # last attempt at this fix conclude per-run profiles were impossible.
    with tempfile.TemporaryDirectory() as tmp:
        argfile = os.path.join(tmp, "argv")
        exe = _stub(
            'printf "%s\\n" "$@" > "{a}"\n'
            'for x in "$@"; do\n'
            '  case "$x" in --screenshot=*) : > "${{x#--screenshot=}}";; esac\n'
            'done\n'.format(a=argfile),
            tmp,
        )
        with _env(CHROME=exe, DUGRI_CHROME_PROFILE_ROOT=os.path.join(tmp, "p")):
            chrome.screenshot(os.path.join(tmp, "in.svg"),
                              os.path.join(tmp, "o.png"), 10, 10)
        argv = open(argfile, encoding="utf-8").read().split("\n")
        assert "--password-store=basic" in argv     # Linux / the container
        assert "--use-mock-keychain" in argv        # macOS / the laptop
        assert "--no-first-run" in argv


def test_the_profile_is_removed_after_a_successful_run():
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "profiles")
        exe = _record_env_stub(tmp, os.path.join(tmp, "env"))
        with _env(CHROME=exe, DUGRI_CHROME_PROFILE_ROOT=root):
            chrome.screenshot(os.path.join(tmp, "in.svg"),
                              os.path.join(tmp, "o.png"), 10, 10)
        assert _profiles(root) == [], _profiles(root)


def test_the_profile_is_removed_after_a_failing_run():
    # A failed render is the COMMON case on a box under load; if only the happy
    # path cleaned up, the disk would fill fastest exactly when things go wrong.
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "profiles")
        exe = _stub('echo boom 1>&2\nexit 3\n', tmp)
        with _env(CHROME=exe, DUGRI_CHROME_PROFILE_ROOT=root):
            try:
                chrome.screenshot(os.path.join(tmp, "in.svg"),
                                  os.path.join(tmp, "o.png"), 10, 10)
            except chrome.ChromeError:
                pass
            else:
                raise AssertionError("exit 3 must raise")
        assert _profiles(root) == [], _profiles(root)


def test_the_profile_is_removed_after_a_timeout():
    # The timeout path is where a leak would hurt most: it is the path a wedged
    # template takes, over and over, on a container with a 4.5GB volume.
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "profiles")
        exe = _stub(
            'for a in "$@"; do\n'
            '  case "$a" in --screenshot=*) : > "${a#--screenshot=}";; esac\n'
            'done\n'
            'sleep 60\n',
            tmp,
        )
        with _env(CHROME=exe, DUGRI_CHROME_PROFILE_ROOT=root):
            try:
                chrome.screenshot(os.path.join(tmp, "in.svg"),
                                  os.path.join(tmp, "o.png"), 10, 10, timeout=1)
            except chrome.ChromeTimeout:
                pass
            else:
                raise AssertionError("a hanging Chrome must not succeed")
        assert _profiles(root) == [], _profiles(root)


def test_stale_profiles_from_a_sigkilled_run_are_swept():
    # `finally` covers every exit this process controls, but server/index.js
    # SIGKILLs the generator's whole process GROUP on its own timer, and a
    # SIGKILLed python runs no finally. The sweep is what stops those leaking.
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "profiles")
        os.makedirs(root)
        old = os.path.join(root, "run-abandoned")
        fresh = os.path.join(root, "run-inflight")
        for d in (old, fresh):
            os.makedirs(d)
        os.utime(old, (time.time() - 7200, time.time() - 7200))
        exe = _record_env_stub(tmp, os.path.join(tmp, "env"))
        with _env(CHROME=exe, DUGRI_CHROME_PROFILE_ROOT=root,
                  DUGRI_CHROME_STALE_S=1800):
            chrome.screenshot(os.path.join(tmp, "in.svg"),
                              os.path.join(tmp, "o.png"), 10, 10)
        assert not os.path.exists(old), "the abandoned profile was not swept"
        assert os.path.exists(fresh), (
            "a profile younger than DUGRI_CHROME_STALE_S belongs to a run still "
            "going; sweeping it would delete a live render's profile"
        )


def test_the_sweep_never_touches_the_slot_files():
    # The slots dir lives next to the profiles. Unlinking a slot file while a
    # run holds its flock lets the next opener create a FRESH inode and lock
    # that instead — the cap would silently stop capping.
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "profiles")
        slots = os.path.join(root, "slots")
        os.makedirs(slots)
        marker = os.path.join(slots, "slot0")
        open(marker, "w", encoding="utf-8").close()
        os.utime(slots, (time.time() - 999999, time.time() - 999999))
        os.utime(marker, (time.time() - 999999, time.time() - 999999))
        chrome._sweep_stale(root)
        assert os.path.exists(marker), "the sweep ate a lock file"


# --- 6. the concurrency cap --------------------------------------------------
#
# Separate profiles remove the lock collision, not what is under it. Measured on
# staging: one Chrome run costs ~120 cgroup tasks and ~250MB, so 8 concurrent
# reaches 926 of the container's 1000-PID ceiling and 12 concurrent HANGS (4 of
# 12 completed; the rest sat until their timeout). The cap is what keeps a
# public, unauthenticated /api/preview from being able to do that.

def _counting_stub(tmp, live, counts, sleep="0.4"):
    """A stub that records how many copies of itself ran at the same time."""
    return _stub(
        'mkdir -p "{live}"\n'
        ': > "{live}/$$"\n'
        'ls "{live}" | wc -l >> "{counts}"\n'
        'for x in "$@"; do\n'
        '  case "$x" in --screenshot=*) : > "${{x#--screenshot=}}";; esac\n'
        'done\n'
        'sleep {s}\n'
        'rm -f "{live}/$$"\n'.format(live=live, counts=counts, s=sleep),
        tmp,
    )


def test_no_more_than_the_cap_run_at_once():
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "profiles")
        live = os.path.join(tmp, "live")
        counts = os.path.join(tmp, "counts")
        exe = _counting_stub(tmp, live, counts)
        with _env(CHROME=exe, DUGRI_CHROME_PROFILE_ROOT=root,
                  DUGRI_CHROME_MAX_CONCURRENT=2, DUGRI_CHROME_SLOT_WAIT_S=60):
            def one(i):
                return chrome.screenshot(os.path.join(tmp, "in.svg"),
                                         os.path.join(tmp, f"o{i}.png"), 10, 10)
            with cf.ThreadPoolExecutor(6) as ex:
                list(ex.map(one, range(6)))
        seen = [int(x) for x in open(counts, encoding="utf-8").read().split()]
        assert len(seen) == 6, seen
        assert max(seen) <= 2, f"the cap did not hold: {seen}"
        # And it really was a cap, not six runs that happened to serialise.
        assert max(seen) == 2, f"the cap never engaged, so this proves nothing: {seen}"
        assert _profiles(root) == [], "queued runs left profiles behind"


def test_a_run_that_cannot_get_a_slot_says_so_instead_of_hanging():
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "profiles")
        live = os.path.join(tmp, "live")
        exe = _counting_stub(tmp, live, os.path.join(tmp, "counts"), sleep="3")
        with _env(CHROME=exe, DUGRI_CHROME_PROFILE_ROOT=root,
                  DUGRI_CHROME_MAX_CONCURRENT=1, DUGRI_CHROME_SLOT_WAIT_S="0.5"):
            def one(i):
                try:
                    chrome.screenshot(os.path.join(tmp, "in.svg"),
                                      os.path.join(tmp, f"o{i}.png"), 10, 10)
                    return None
                except chrome.ChromeBusy as exc:
                    return str(exc)
            with cf.ThreadPoolExecutor(2) as ex:
                out = list(ex.map(one, range(2)))
        busy = [m for m in out if m]
        assert len(busy) == 1, f"expected exactly one refusal, got {out}"
        assert "DUGRI_CHROME_MAX_CONCURRENT" in busy[0], busy[0]
        # Refused BEFORE any work: nothing to clean up, nothing half-written.
        assert _profiles(root) == [], "a refused run still created a profile"
        assert not os.path.exists(os.path.join(tmp, "o1.png")) or \
            not os.path.exists(os.path.join(tmp, "o0.png"))


def test_busy_is_a_chrome_error_callers_already_handle():
    # order_to_pdf/preview surface ChromeError to the owner; a new subclass must
    # not slip past them as an unhandled exception type.
    assert issubclass(chrome.ChromeBusy, chrome.ChromeError)
    assert issubclass(chrome.ChromeBusy, RuntimeError)


def test_the_cap_can_be_switched_off():
    # An operator raising the ceiling (or a laptop that does not need the cap)
    # must not have to patch the module.
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "profiles")
        live = os.path.join(tmp, "live")
        counts = os.path.join(tmp, "counts")
        exe = _counting_stub(tmp, live, counts)
        with _env(CHROME=exe, DUGRI_CHROME_PROFILE_ROOT=root,
                  DUGRI_CHROME_MAX_CONCURRENT=0):
            def one(i):
                return chrome.screenshot(os.path.join(tmp, "in.svg"),
                                         os.path.join(tmp, f"o{i}.png"), 10, 10)
            with cf.ThreadPoolExecutor(4) as ex:
                list(ex.map(one, range(4)))
        seen = [int(x) for x in open(counts, encoding="utf-8").read().split()]
        assert max(seen) > 2, f"MAX_CONCURRENT=0 still throttled: {seen}"


def test_the_default_cap_leaves_headroom_under_the_container_ceiling():
    # ~120 cgroup tasks per Chrome run against pids.max=1000 (measured on
    # staging). The default must stay well under the 8-run wall, since Node,
    # the press Ghostscript pass and the container's own processes share it.
    assert 1 <= chrome.MAX_CONCURRENT <= 6
    assert chrome.SLOT_WAIT_S >= chrome.PRINT_TIMEOUT_S, (
        "a run must be able to queue behind a full deck print rather than be "
        "refused while the box is merely busy"
    )


def test_profiles_do_not_land_on_the_orders_volume():
    # DATA_DIR is the 4.5GB Railway volume holding every generated PDF. Profiles
    # are throwaway and must not compete with orders for it.
    with _env(DUGRI_CHROME_PROFILE_ROOT=None):
        root = chrome._profile_root()
    data = os.environ.get("DATA_DIR")
    assert root.startswith(tempfile.gettempdir()), root
    if data:
        assert not os.path.abspath(root).startswith(os.path.abspath(data)), root


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
