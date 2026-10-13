"""Keep the previous entry point and run the real browser-script contract tests."""
from pathlib import Path
import subprocess


if __name__ == "__main__":
    subprocess.run(["node", "--test", str(Path(__file__).with_suffix(".test.cjs"))], check=True)
