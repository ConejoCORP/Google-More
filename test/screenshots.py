"""Google More : régénère les captures du README (dossier screenshots/).

Affiche le vrai popup via test/popup-harness.html dans Edge ou Chrome sans fenêtre, une capture par
onglet, puis recadre chaque image sur le popup et lui ajoute un cadre arrondi avec une ombre légère.

    python test/screenshots.py

Variable d'environnement facultative : GM_BROWSER = chemin de msedge.exe ou chrome.exe.
"""

import functools
import http.server
import os
import pathlib
import subprocess
import tempfile
import threading

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "screenshots"
PORT = 8766
SCALE = 2           # captures en haute définition (écrans Retina, zoom GitHub)
WIDTH = 400         # largeur du popup (popup.css)
HEIGHT = 1100       # hauteur de la fenêtre de capture, recadrée ensuite

SHOTS = [
    ("page", "01_page-to-txt.png"),
    ("rewrite", "02_reformuler.png"),
    ("titles", "03_titres-youtube.png"),
    ("password", "04_mots-de-passe.png"),
]

BROWSERS = [
    os.environ.get("GM_BROWSER", ""),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
]


def find_browser():
    for path in BROWSERS:
        if path and os.path.isfile(path):
            return path
    raise SystemExit("Ni Edge ni Chrome trouvé : renseigne GM_BROWSER.")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def capture(browser, tab, dest):
    url = f"http://127.0.0.1:{PORT}/test/popup-harness.html?tab={tab}"
    with tempfile.TemporaryDirectory() as profile:
        subprocess.run([
            browser,
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--no-first-run",
            "--no-default-browser-check",
            f"--user-data-dir={profile}",
            f"--force-device-scale-factor={SCALE}",
            # Thème clair pour le README, même si Windows est en thème sombre (1 = clair).
            "--blink-settings=preferredColorScheme=1",
            f"--window-size={WIDTH},{HEIGHT}",
            "--virtual-time-budget=4000",
            f"--screenshot={dest}",
            url,
        ], check=True, capture_output=True, timeout=60)


def frame(raw_path, dest):
    """Recadre sur le contenu, puis pose le popup sur un fond transparent avec coins et ombre."""
    img = Image.open(raw_path).convert("RGB")
    # Couleur du fond lue en bas de l'image (vide sous le popup), plutôt que supposée blanche.
    fond = img.getpixel((img.width // 2, img.height - 2))
    diff = ImageChops.difference(img, Image.new("RGB", img.size, fond))
    box = diff.getbbox()
    bottom = min(img.height, (box[3] if box else img.height) + 14 * SCALE)
    popup = img.crop((0, 0, img.width, bottom))

    radius = 12 * SCALE
    margin = 18 * SCALE
    w, h = popup.size
    canvas = Image.new("RGBA", (w + 2 * margin, h + 2 * margin), (0, 0, 0, 0))

    shadow = Image.new("L", canvas.size, 0)
    ImageDraw.Draw(shadow).rounded_rectangle(
        (margin, margin + 4 * SCALE, margin + w, margin + h + 4 * SCALE), radius, fill=70)
    shadow = shadow.filter(ImageFilter.GaussianBlur(8 * SCALE))
    canvas.paste((0, 0, 0, 255), (0, 0), shadow)

    mask = Image.new("L", popup.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius, fill=255)
    canvas.paste(popup, (margin, margin), mask)
    ImageDraw.Draw(canvas).rounded_rectangle(
        (margin, margin, margin + w - 1, margin + h - 1), radius, outline=(218, 220, 224, 255), width=SCALE)

    canvas.save(dest, optimize=True)


def main():
    browser = find_browser()
    OUT.mkdir(exist_ok=True)
    server = serve()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            for tab, name in SHOTS:
                raw = pathlib.Path(tmp) / f"{tab}.png"
                capture(browser, tab, raw)
                frame(raw, OUT / name)
                size = Image.open(OUT / name).size
                print(f"{name} : {size[0]} x {size[1]}")
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
