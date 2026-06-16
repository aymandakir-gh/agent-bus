"""Make the sibling ``agentbus`` package importable regardless of CWD."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
