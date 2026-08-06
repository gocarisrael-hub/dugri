#!/usr/bin/env python3
"""The ONE place the generator invokes headless Chrome.

Every render path — preview card, fronts strip, full page, board/back, the deck
PDF, calibration, recipe detection — screenshots or prints through here. It used
to be seven hand-rolled ``subprocess.run([CHROME, "--headless", ...])`` calls in
six modules, each with its own flag list and its own idea of error handling, and
NONE of them with a ``timeout=``.

That cost us a production outage. A Chrome that never exits blocks the Python
process forever; Node gives up on its own timer and SIGKILLs the generator,
which orphans the Chrome underneath it. Each orphan is one chromium plus its
crashpad handler, reparented to PID 1 and never reaped. Roughly nine hundred of
those exhausted the container's cgroup PID budget (``PIDS current=1001
max=1000``) and from then on EVERY spawn failed with ``EAGAIN`` — /api/preview,
order generation and the press build all 500'd while HTTP kept serving, because
Node itself never forks.

So the timeout, the kill-on-expiry, the flag set and the error text live here
and only here. A new render path gets them by construction; a scattered fix
would have regressed the first time someone added one.

Three rules worth stating out loud, because all three look like improvements:

  * Chrome is NOT given its own session/process group (no ``start_new_session``).
    ``server/index.js`` spawns the generator ``detached: true`` and kills the
    whole process GROUP on timeout; Chrome and its helpers only receive that
    signal because they inherit the generator's group. Isolating Chrome here
    would make it survive exactly the kill that is meant to reach it.
  * Every run gets its OWN throwaway profile — but through ``HOME``/``XDG_*``,
    NOT through ``--user-data-dir``. See "profile isolation" below; the flag and
    the env var are not interchangeable, and one of them hangs.
  * Chrome runs are capped to ``MAX_CONCURRENT`` at a time, across processes.
    See "the concurrency cap" below; separate profiles remove the lock
    collision but not the PID ceiling underneath it.

PROFILE ISOLATION — why this exists and why it is env vars, not a flag
---------------------------------------------------------------------
A comment here used to claim "concurrent runs sharing the default profile were
measured fine (six at once)". That was measured on a laptop and is FALSE in the
container, where it is the opposite of fine: with no per-run profile every
invocation contends for ``$HOME/.config/chromium`` and its lock, and the losers
die in about two seconds with::

    Failed to create /root/.config/chromium/SingletonLock: File exists (17)

Measured on staging (Chromium 149.0.7827.53, Alpine): two concurrent screenshots
sharing the default profile → 1 of 2 succeeds. Four, six, eight → exactly one
survives each time. That is not a resource ceiling, it is a mutex. And it is not
only the owner's problem: /api/preview spawns Chrome too and previews are PUBLIC,
so one deck generating took 59 of ~87 concurrent preview renders down with it.
A buyer browsing designs killed the owner's order; the owner's order killed the
buyers' previews.

The obvious fix — ``--user-data-dir=<fresh dir>`` — is a trap, and the old
comment was right about that part. Re-measured on Chrome 150.0.7871.187 (macOS):
with the flag the screenshot IS written and the browser then hangs until killed;
without it the same run exits in ~2.2s. Fresh dir, reused dir, with the
first-run flags, with ``--use-mock-keychain`` — every combination hangs. So the
flag stays out (``test_chrome`` asserts it), and instead each run gets a private
``HOME``/``XDG_CONFIG_HOME``/``XDG_CACHE_HOME``, which moves the DEFAULT profile
path — lock and all — somewhere no other run is looking. Verified on both:
Alpine Chromium 2/4/6/8-way concurrent → 8 of 8 succeed, zero SingletonLock;
macOS Chrome exits normally and at the same speed as an un-isolated run, and a
real ``preview.py`` render of a shipped theme comes out byte-identical.

(A fresh profile does need PROFILE_FLAGS below to behave — most of all the
credential-store pair. Without those a fresh profile hangs too, which is very
likely what the old measurement actually saw and misattributed to the flag.)

The profile directory is deleted in a ``finally``, so a crashed, failed or
timed-out render cleans up after itself. That is not enough on its own: when the
render exceeds Node's timer, ``server/index.js`` SIGKILLs the whole process
GROUP, and a SIGKILLed Python runs no ``finally``. So the directories all live
under one root and every run first sweeps the root for leftovers older than
``STALE_PROFILE_S``. Cheap insurance — a leaked profile is ~1MB, but a container
whose disk fills is just a slower outage than the one this fixes.

THE CONCURRENCY CAP
-------------------
Separate profiles remove the lock collision; they do not remove what is under
it. Measured on staging, per concurrent screenshot: ~120 cgroup tasks and
~250MB. Against this container's ceilings (``pids.max`` 1000, 8GB) that puts the
wall at eight::

    n=1   ok 1/1    peak  133 PIDs   603MB
    n=4   ok 4/4    peak  488 PIDs  1322MB
    n=8   ok 8/8    peak  926 PIDs  2326MB     <- 93% of pids.max
    n=12  ok 4/12   peak 1000 PIDs             <- ceiling; 8 runs HUNG for the
                                                  full timeout, they did not
                                                  fail fast

Twelve is not a hypothetical: /api/preview is public and unauthenticated, and
the failure mode past the ceiling is a HANG, which is the expensive kind. So
Chrome runs take a slot from a cross-process semaphore (``flock`` on N files —
the kernel drops the lock even if the holder is SIGKILLed, so a slot cannot go
stale). MAX_CONCURRENT is 4: peak ~490 PIDs and ~1.3GB leaves roughly 2x
headroom for Node, the press Ghostscript pass and the container's own
processes, and four 1-second screenshots drain a queue faster than a buyer
notices. Raise it with DUGRI_CHROME_MAX_CONCURRENT, or set it to 0 to disable
the cap entirely; 8 is the measured wall, not a safe setting.
"""
import contextlib
import errno
import os
import random
import shutil
import subprocess
import tempfile
import time

try:
    import fcntl
except ImportError:  # pragma: no cover - POSIX only; the generator never runs elsewhere
    fcntl = None

DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CHROME = os.environ.get("CHROME", DEFAULT_CHROME)

# Headless Chrome screenshots a large SVG BEFORE its base64 data:-URL @font-face
# fonts finish loading, so the word/title text silently falls back to a default
# heavy Hebrew face instead of the theme font (Cafe, Mr Dafoe, …). Advancing a
# virtual clock forces Chrome to wait for the fonts (and all resources) to settle
# before capturing, so the calibrated fonts actually render. Verified: without it
# Cafe renders as a bold fallback; with it the real Cafe face renders.
FONT_WAIT = "--virtual-time-budget=15000"

# Flags every run needs. --no-sandbox + --disable-dev-shm-usage are what running
# Chromium as root in a container requires; the container's CHROME wrapper also
# injects them, and Chrome accepts the duplicates.
BASE_FLAGS = ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]

# Wall-clock ceiling for one screenshot run. The heaviest real screenshot is the
# eight-front calibration strip — ~9200x1660px at scale 2, on top of FONT_WAIT's
# 15s virtual clock — measured at 3-5s on a laptop. 120s is ~25x that, so a slow
# shared container CPU never has a legitimate render cut short, while a Chrome
# that is genuinely stuck is reclaimed long before it can pile up. It also sits
# ABOVE the caller-side timers (PREVIEW_TIMEOUT_MS 40s, GENERATE_TIMEOUT_MS 120s)
# on purpose: for a request Node's timer is what the user waits on, and this is
# the backstop for the paths with no Node timer at all (CLI runs, calibration).
TIMEOUT_S = float(os.environ.get("DUGRI_CHROME_TIMEOUT_S", "120"))

# The deck/press print pass is a different order of magnitude — one Chrome run
# over a 200+ page document — so it gets its own, longer budget. Name kept from
# build.DECK_TIMEOUT_S so an existing deployment's env var still applies.
PRINT_TIMEOUT_S = float(os.environ.get("DUGRI_DECK_TIMEOUT_S", "180"))

# Flags that make a FRESH profile behave like an established one. Two different
# problems, and the second one is load-bearing:
#
#  * First-run work. Without --no-first-run and friends Chrome treats every run
#    as a first run and goes to the network (variations, component updates,
#    sync) before it renders — 19-40s on macOS versus ~1.6s with them.
#  * The OS credential store. A brand-new profile needs an encryption key for
#    its password store, and asking for one blocks forever in headless: on macOS
#    a fresh profile writes the screenshot and then HANGS until killed, every
#    time, and --use-mock-keychain is the whole difference between 45s+ timeout
#    and 3.3s. --password-store=basic is the same instruction for Linux. This is
#    what the old "a per-run profile hangs" note had actually measured; it read
#    the symptom onto --user-data-dir and concluded per-run profiles were
#    impossible. (They are not — but --user-data-dir really does hang on macOS,
#    mock keychain or not, which is why isolation goes through HOME instead.)
#
# None of them change a pixel: the same SVG renders byte-identical with and
# without. --disable-crash-reporter also drops the crashpad handler, one fewer
# process per run against the PID budget.
PROFILE_FLAGS = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-crash-reporter",
    "--no-service-autorun",
    "--metrics-recording-only",
    "--password-store=basic",   # Linux credential store: none
    "--use-mock-keychain",      # macOS credential store: none
]

# Where the throwaway per-run profiles live. Deliberately the system temp dir
# (the container's overlay, ~1.9TB free) and NOT DATA_DIR — that is the 4.5GB
# Railway volume holding every generated PDF, and profiles have no business
# competing with orders for it.
PROFILE_ROOT = (os.environ.get("DUGRI_CHROME_PROFILE_ROOT")
                or os.path.join(tempfile.gettempdir(), "dugri-chrome"))

# A profile still on disk this long after its run started belongs to a process
# that was SIGKILLed (see the module docstring). Comfortably above PRINT_TIMEOUT_S
# so a legitimately slow deck print is never swept out from under itself.
STALE_PROFILE_S = float(os.environ.get("DUGRI_CHROME_STALE_S", "1800"))

# How many Chrome runs may be in flight at once, across ALL generator processes.
# 4 by default; 0 disables the cap. See "the concurrency cap" in the docstring
# for the measurements behind the number.
MAX_CONCURRENT = int(os.environ.get("DUGRI_CHROME_MAX_CONCURRENT", "4"))

# How long a run waits for a slot before giving up. Long enough to queue behind
# a deck print (PRINT_TIMEOUT_S), short enough that a wedged box says so instead
# of accumulating waiters.
SLOT_WAIT_S = float(os.environ.get("DUGRI_CHROME_SLOT_WAIT_S", "240"))


class ChromeError(RuntimeError):
    """Chrome could not produce the artifact (missing binary, crash, no file)."""


class ChromeTimeout(ChromeError):
    """Chrome did not finish in time and was killed."""


class ChromeBusy(ChromeError):
    """Too many renders are already in flight; this one never started."""


def binary():
    """The Chrome binary to run.

    Re-reads the environment each call rather than freezing it at import, so a
    caller (or a test stubbing Chrome with a script) that sets CHROME after this
    module is imported is still honoured. Falls back to the import-time value.
    """
    return os.environ.get("CHROME") or CHROME


def _profile_root():
    """The profile root, re-read from the environment (see ``binary``)."""
    return (os.environ.get("DUGRI_CHROME_PROFILE_ROOT")
            or os.path.join(tempfile.gettempdir(), "dugri-chrome"))


def _sweep_stale(root, now=None):
    """Delete profile dirs left behind by a SIGKILLed run. Never raises.

    The per-run ``finally`` handles every ordinary exit including the timeout,
    but ``server/index.js`` SIGKILLs the generator's whole process group when
    its own timer fires, and a SIGKILLed Python runs no ``finally``. Without
    this sweep those directories accumulate forever, which is a disk-fill
    outage traded for a lock outage.
    """
    stale = float(os.environ.get("DUGRI_CHROME_STALE_S", STALE_PROFILE_S))
    now = time.time() if now is None else now
    removed = []
    try:
        names = os.listdir(root)
    except OSError:
        return removed
    for name in names:
        # ONLY the per-run profiles. The sibling `slots/` dir holds the flock
        # files; unlinking one while a run holds it would let the next opener
        # create a fresh inode and lock that instead — a silently uncapped box.
        if not name.startswith("run-"):
            continue
        path = os.path.join(root, name)
        try:
            # mtime, not ctime: the dir is created once and Chrome writes into
            # it throughout the run, so this tracks "last sign of life".
            if now - os.stat(path).st_mtime < stale:
                continue
        except OSError:
            continue  # vanished under us — another run's cleanup won the race
        shutil.rmtree(path, ignore_errors=True)
        removed.append(path)
    return removed


@contextlib.contextmanager
def _private_profile():
    """Yield an environment whose Chrome profile is this run's alone.

    ``HOME`` (plus the XDG pair, which takes precedence over ``HOME`` on Linux)
    relocates Chrome's DEFAULT profile — the thing every un-isolated run fights
    over — into a fresh directory. ``--user-data-dir`` would express the same
    intent and hangs; see the module docstring.
    """
    root = _profile_root()
    os.makedirs(root, exist_ok=True)
    _sweep_stale(root)
    path = tempfile.mkdtemp(prefix="run-", dir=root)
    env = dict(os.environ)
    env["HOME"] = path
    env["XDG_CONFIG_HOME"] = os.path.join(path, ".config")
    env["XDG_CACHE_HOME"] = os.path.join(path, ".cache")
    env["XDG_DATA_HOME"] = os.path.join(path, ".local", "share")
    # Fontconfig resolves user fonts under $HOME/$XDG_DATA_HOME, so moving HOME
    # would hide any font the owner installed for her user rather than
    # system-wide — a silent fallback-face render, the exact class of bug the
    # font-wait above exists to prevent. Link the real ones back in.
    real_home = os.path.expanduser("~")
    for rel in (".fonts", os.path.join(".local", "share", "fonts"),
                os.path.join("Library", "Fonts")):
        src = os.path.join(real_home, rel)
        if not os.path.isdir(src):
            continue
        dst = os.path.join(path, rel)
        try:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            os.symlink(src, dst)
        except OSError:
            pass  # best effort; system fonts still resolve
    try:
        yield env
    finally:
        shutil.rmtree(path, ignore_errors=True)


@contextlib.contextmanager
def _slot():
    """Hold one of ``MAX_CONCURRENT`` Chrome slots for the duration of the run.

    ``flock`` rather than a counter file or a directory of pid files because the
    kernel releases it when the holder dies HOWEVER it dies — and the way a
    render dies here is SIGKILL from Node's timer, which no userspace cleanup
    would survive. A slot therefore cannot go stale.
    """
    limit = int(os.environ.get("DUGRI_CHROME_MAX_CONCURRENT", MAX_CONCURRENT))
    if limit <= 0 or fcntl is None:
        yield
        return
    root = _profile_root()
    slots = os.path.join(root, "slots")
    os.makedirs(slots, exist_ok=True)
    wait = float(os.environ.get("DUGRI_CHROME_SLOT_WAIT_S", SLOT_WAIT_S))
    deadline = time.monotonic() + wait
    while True:
        for i in range(limit):
            try:
                fd = os.open(os.path.join(slots, "slot%d" % i),
                             os.O_CREAT | os.O_RDWR, 0o600)
            except OSError:
                continue
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                os.close(fd)
                if exc.errno in (errno.EAGAIN, errno.EACCES, errno.EWOULDBLOCK):
                    continue  # taken by another run
                raise
            try:
                yield
            finally:
                try:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                finally:
                    os.close(fd)
            return
        if time.monotonic() >= deadline:
            raise ChromeBusy(
                f"all {limit} render slots were busy for {wait:.0f}s, so this "
                "render never started. Chrome costs ~120 processes and ~250MB "
                "per run and the container's ceiling is 1000 processes, so runs "
                "are capped rather than allowed to hang the box. Raise "
                "DUGRI_CHROME_MAX_CONCURRENT (8 is the measured wall) or "
                "DUGRI_CHROME_SLOT_WAIT_S if this is legitimate load."
            )
        # Jittered so a burst of waiters does not re-collide in lockstep.
        time.sleep(0.05 + random.random() * 0.15)


def _run(extra, source, out_path, *, timeout, what):
    """Run Chrome once and guarantee it is gone when this returns.

    ``subprocess.run(timeout=…)`` SIGKILLs the child and waits for it on expiry,
    and killing the browser process takes its helpers with it — verified by
    hand: kill the browser pid and the crashpad handler, GPU process, network
    and storage services all exit within a second. That cascade is why the
    hundreds of orphans in production were orphans in the first place: nothing
    ever killed the browser at all.
    """
    exe = binary()
    argv = [exe] + BASE_FLAGS + PROFILE_FLAGS + list(extra) + [source]
    # The profile is created INSIDE the slot so a queued run holds no disk, and
    # both unwind before this function returns however it returns — including
    # the timeout path, which is the one that used to leak.
    with _slot(), _private_profile() as env:
        try:
            proc = subprocess.run(argv, capture_output=True, text=True,
                                  errors="replace", timeout=timeout, env=env)
        except subprocess.TimeoutExpired as exc:
            # Chrome has already been killed by subprocess.run at this point.
            raise ChromeTimeout(
                f"Chrome did not finish rendering {what} within {timeout:.0f}s "
                "and was killed. One render normally takes a few seconds, so "
                "this almost always means the template embeds an asset (an "
                "image, a font) that never finishes loading — open the template "
                "and check its embedded resources. Raise DUGRI_CHROME_TIMEOUT_S "
                "only if the render is genuinely that slow."
            ) from exc
        except OSError as exc:
            # The binary itself is missing/unrunnable — say WHICH one, since
            # CHROME is env-configured and differs between laptop and container.
            raise ChromeError(
                f"could not run Chrome at {exe!r} ({exc}). Set the CHROME "
                "environment variable to the browser binary."
            ) from exc
    # Chrome can exit 0 and write nothing (it has done so on a missing font or an
    # unloadable sub-resource), and the next step would then fail further away on
    # a file that was never created.
    if proc.returncode != 0 or not os.path.exists(out_path):
        tail = (proc.stderr or proc.stdout or "").strip()
        raise ChromeError(
            f"Chrome could not render {what} (exit {proc.returncode}, output "
            f"{'written' if os.path.exists(out_path) else 'MISSING'}). "
            + (f"Chrome said: {tail[-600:]}" if tail else "Chrome printed nothing.")
        )
    return out_path


def screenshot(source, out_png, width, height, *, scale=2, font_wait=True,
               timeout=None, what=None):
    """Screenshot ``source`` (an SVG or HTML file) to ``out_png``.

    ``font_wait`` advances Chrome's virtual clock so embedded @font-face faces
    load before the capture — required on every path that renders theme text,
    and off for the detection paths that screenshot artwork as-is.
    """
    extra = [f"--force-device-scale-factor={scale}",
             f"--screenshot={out_png}",
             f"--window-size={int(width)},{int(height)}"]
    if font_wait:
        extra.insert(0, FONT_WAIT)
    return _run(extra, source, out_png,
                timeout=TIMEOUT_S if timeout is None else timeout,
                what=what or os.path.basename(source))


def print_pdf(source, out_pdf, *, timeout=None, what=None):
    """Print ``source`` (an HTML file) to ``out_pdf``.

    No virtual-time budget here on purpose: Chrome's print path already waits
    for webfonts, and a budget makes it sit out the whole clock — turning a
    3-second deck into minutes.
    """
    extra = ["--no-pdf-header-footer", f"--print-to-pdf={out_pdf}"]
    return _run(extra, source, out_pdf,
                timeout=PRINT_TIMEOUT_S if timeout is None else timeout,
                what=what or os.path.basename(source))
