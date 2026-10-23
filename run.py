"""Start the Myanmar Forest Typology Explorer locally and open it in the browser.

    python run.py              # http://127.0.0.1:8770
    python run.py --lan        # also reachable from other machines on the network
"""
import argparse, threading, webbrowser
import uvicorn


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--lan", action="store_true", help="bind 0.0.0.0 instead of 127.0.0.1")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    if not args.no_browser:
        threading.Timer(2.5, lambda: webbrowser.open(f"http://127.0.0.1:{args.port}/")).start()
    uvicorn.run("app.main:app", host="0.0.0.0" if args.lan else "127.0.0.1", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
