"""ChessPrac dans sa propre fenêtre Windows, sans navigateur ni terminal (lancé par « ChessPrac.exe »).

.pyw + pythonw.exe : aucune console. Le serveur local et l'analyse Stockfish tournent dans ce même processus,
et tout s'arrête avec la fenêtre : les Stockfish sont rattachés à un « job » Windows qui meurt avec elle, même en cas
de plantage. Un deuxième lancement ramène simplement la fenêtre déjà ouverte au premier plan. Sans console, une
erreur serait invisible : elle est écrite dans %USERPROFILE%\\.chessprac\\chessprac.log.
"""
import ctypes
import os
import sys
import traceback
from ctypes import wintypes
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

TITLE = "ChessPrac"
ICON = ROOT / "assets" / "icon.ico"

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
user32 = ctypes.WinDLL("user32", use_last_error=True)


def focus_existing_window() -> bool:
    """Un seul exemplaire à la fois."""
    kernel32.CreateMutexW(None, False, "chessprac-fenetre")
    if ctypes.get_last_error() != 183:  # ERROR_ALREADY_EXISTS
        return False
    hwnd = user32.FindWindowW(None, TITLE)
    if hwnd:
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        user32.SetForegroundWindow(hwnd)
    return True


class JobLimits(ctypes.Structure):
    """JOBOBJECT_EXTENDED_LIMIT_INFORMATION : seul LimitFlags sert, le reste doit juste avoir la bonne taille."""
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD),
        ("IoInfo", ctypes.c_uint64 * 6), ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def kill_children_with_me() -> None:
    """Les Stockfish lancés ensuite héritent du job : ils s'arrêtent forcément avec cette fenêtre."""
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    job = kernel32.CreateJobObjectW(None, None)
    limits = JobLimits(LimitFlags=0x2000)  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    kernel32.SetInformationJobObject(wintypes.HANDLE(job), 9, ctypes.byref(limits), ctypes.sizeof(limits))
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.AssignProcessToJobObject(wintypes.HANDLE(job), wintypes.HANDLE(kernel32.GetCurrentProcess()))
    kill_children_with_me.job = job  # garde le handle ouvert jusqu'à la fin du processus


def windows_dark() -> bool:
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize") as key:
            return winreg.QueryValueEx(key, "AppsUseLightTheme")[0] == 0
    except OSError:
        return True


def main() -> None:
    if focus_existing_window():
        return
    ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("chessprac.app")
    kill_children_with_me()

    from chessprac import config
    from chessprac.engine import shared
    from chessprac.server import serve
    from chessprac.worker import worker
    import webview

    config.HOME.mkdir(parents=True, exist_ok=True)
    httpd, port = serve()
    # Ouverte en plein écran (fenêtre agrandie : la barre des tâches et les boutons de la fenêtre restent visibles).
    window = webview.create_window(TITLE, f"http://127.0.0.1:{port}/", width=1440, height=920, min_size=(960, 640),
                                   maximized=True, background_color="#121211" if windows_dark() else "#f4f2ec",
                                   text_select=True)
    try:
        webview.start(gui="edgechromium", icon=str(ICON), private_mode=False,
                      storage_path=str(config.HOME / "webview"))
    finally:
        # Arrêt propre : Stockfish coupé, écritures en base terminées, journal WAL vidé, puis seulement on quitte.
        from chessprac import db
        worker.shutdown(timeout=20)
        shared.close()
        httpd.shutdown()
        db.checkpoint()
        os._exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        home = Path(os.environ.get("CHESSPRAC_HOME") or Path.home() / ".chessprac")
        home.mkdir(parents=True, exist_ok=True)
        log = home / "chessprac.log"
        with open(log, "a", encoding="utf-8") as out:
            traceback.print_exc(file=out)
        ctypes.windll.user32.MessageBoxW(None, f"ChessPrac n'a pas pu s'ouvrir.\n\nDétails : {log}", TITLE, 0x10)
