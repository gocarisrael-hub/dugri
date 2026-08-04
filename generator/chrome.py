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

Two rules worth stating out loud, because both look like improvements:

  * Chrome is NOT given its own session/process group (no ``start_new_session``).
    ``server/index.js`` spawns the generator ``detached: true`` and kills the
    whole process GROUP on timeout; Chrome and its helpers only receive that
    signal because they inherit the generator's group. Isolating Chrome here
    would make it survive exactly the kill that is meant to reach it.
  * There is deliberately no per-run ``--user-data-dir``. Measured on Chrome
    150.0.7871.187: without it a screenshot run exits in ~2.2s; with it (fresh
    dir, existing dir, plus --no-first-run/--disable-background-networking) the
    PNG is written and the browser then hangs until killed — it CAUSES the
    failure it was proposed to prevent. Concurrent runs sharing the default
    profile were measured fine (six at once, all exit 3-5s).
"""
import os
import subprocess

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


class ChromeError(RuntimeError):
    """Chrome could not produce the artifact (missing binary, crash, no file)."""


class ChromeTimeout(ChromeError):
    """Chrome did not finish in time and was killed."""


def binary():
    """The Chrome binary to run.

    Re-reads the environment each call rather than freezing it at import, so a
    caller (or a test stubbing Chrome with a script) that sets CHROME after this
    module is imported is still honoured. Falls back to the import-time value.
    """
    return os.environ.get("CHROME") or CHROME


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
    argv = [exe] + BASE_FLAGS + list(extra) + [source]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True,
                              errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        # Chrome has already been killed by subprocess.run at this point.
        raise ChromeTimeout(
            f"Chrome did not finish rendering {what} within {timeout:.0f}s and "
            "was killed. One render normally takes a few seconds, so this "
            "almost always means the template embeds an asset (an image, a "
            "font) that never finishes loading — open the template and check "
            "its embedded resources. Raise DUGRI_CHROME_TIMEOUT_S only if the "
            "render is genuinely that slow."
        ) from exc
    except OSError as exc:
        # The binary itself is missing/unrunnable — say WHICH one, since CHROME
        # is env-configured and differs between a laptop and the container.
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
