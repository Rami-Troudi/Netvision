"""
Restore legacy CSV snapshots from git history and convert them to parquet-backed outputs.

This is a one-time migration helper for Phase 3.
"""

import argparse
import subprocess
from pathlib import Path
from typing import List, Tuple

from process_time_series import process_time_series_data


DEFAULT_SOURCES = [
    "a380743:data_set_radio_1.csv",
    "999ca39:data_set_radio_all_hour.csv",
]


def parse_source_entry(entry: str) -> Tuple[str, str]:
    commit, sep, file_path = entry.partition(":")
    if not sep or not commit.strip() or not file_path.strip():
        raise ValueError(f"Invalid --source entry '{entry}'. Expected '<commit>:<path>'")
    return commit.strip(), file_path.strip()


def git_show_file(commit: str, file_path: str) -> bytes:
    ref = f"{commit}:{file_path}"
    try:
        return subprocess.check_output(["git", "show", ref], stderr=subprocess.STDOUT)
    except subprocess.CalledProcessError as exc:
        output = exc.output.decode("utf-8", errors="replace")
        raise RuntimeError(f"Failed to restore {ref} from git history.\n{output}") from exc


def restore_sources(source_entries: List[str], restore_dir: Path, overwrite: bool) -> List[Tuple[Path, bool]]:
    restored_paths: List[Tuple[Path, bool]] = []

    for source in source_entries:
        commit, file_path = parse_source_entry(source)
        file_name = Path(file_path).name
        destination = restore_dir / file_name

        if destination.exists() and not overwrite:
            print(f"[SKIP] {destination} already exists")
            restored_paths.append((destination, False))
            continue

        print(f"[RESTORE] {commit}:{file_path} -> {destination}")
        raw_bytes = git_show_file(commit, file_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(raw_bytes)
        restored_paths.append((destination, True))

    return restored_paths


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Restore historical CSV from git and generate parquet-backed time-series outputs."
    )
    parser.add_argument(
        "--source",
        action="append",
        default=None,
        help="Git source in '<commit>:<path>' format. Repeat for multiple files.",
    )
    parser.add_argument(
        "--restore-dir",
        default=".",
        help="Directory where restored CSV files should be written (default: project root).",
    )
    parser.add_argument(
        "--output",
        default=".",
        help="Output directory for baseline.json, time_index.json, stats.json and time_data/*.parquet.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite CSV files if they already exist at --restore-dir.",
    )
    parser.add_argument(
        "--keep-csv",
        action="store_true",
        help="Keep restored CSV files after conversion.",
    )
    args = parser.parse_args()

    restore_dir = Path(args.restore_dir).resolve()
    output_dir = Path(args.output).resolve()
    sources = args.source if args.source else DEFAULT_SOURCES

    restored_paths = restore_sources(sources, restore_dir, overwrite=args.overwrite)
    input_files = [str(path) for path, _ in restored_paths]

    print("[CONVERT] Running time-series processor with restored CSV files")
    process_time_series_data(input_files=input_files, output_dir=str(output_dir))
    print(f"[DONE] Parquet-backed outputs written to {output_dir}")

    if not args.keep_csv:
        for path, was_restored in restored_paths:
            if was_restored and path.exists():
                path.unlink()
                print(f"[CLEANUP] Removed restored CSV {path}")


if __name__ == "__main__":
    main()
