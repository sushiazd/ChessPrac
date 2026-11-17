"""Mode développeur : `python -m chessprac` lance le serveur et ouvre l'interface dans le navigateur."""
import sys
import time
import webbrowser

from .server import serve
from .worker import worker


def main():
    httpd, port = serve()
    url = f"http://127.0.0.1:{port}"
    print(f"ChessPrac sur {url}  (Ctrl+C pour arrêter)", flush=True)
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        worker.stop()
        httpd.shutdown()


if __name__ == "__main__":
    main()
