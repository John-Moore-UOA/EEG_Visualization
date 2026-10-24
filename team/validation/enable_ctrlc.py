"""Re-enable Ctrl+C processing (the ignore flag is inherited from the tool harness), then run a script in-process
exactly as `python script args` would."""
import ctypes, runpy, sys
ctypes.windll.kernel32.SetConsoleCtrlHandler(None, False)
script = sys.argv[1]
sys.argv = sys.argv[1:]
runpy.run_path(script, run_name="__main__")
