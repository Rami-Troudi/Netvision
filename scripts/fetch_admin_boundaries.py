#!/usr/bin/env python3
"""Fetch official Tunisia COD-AB administrative boundary source files."""

from __future__ import annotations

import argparse
import sys
import urllib.request
from pathlib import Path


DEFAULT_URL = (
    "https://data.humdata.org/dataset/e47eda48-8f83-4858-b739-dbffb8a50c47/"
    "resource/ebe19593-9438-4d14-8291-e65f811e2671/download/"
    "tun_admin_boundaries.geojson.zip"
)


def download(url: str, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            if response.status >= 400:
                raise RuntimeError(f"HTTP {response.status}")
            output.write_bytes(response.read())
    except Exception as exc:  # noqa: BLE001 - CLI should print clear failure.
        raise RuntimeError(
            "Failed to download COD-AB Tunisia boundaries. "
            f"Place tun_admin_boundaries.geojson.zip in {output.parent} and rerun. "
            f"Source URL: {url}"
        ) from exc


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=DEFAULT_URL, help="COD-AB GeoJSON ZIP URL")
    parser.add_argument(
        "--output",
        default="data/admin_boundaries/raw/tun_admin_boundaries.geojson.zip",
        help="Local ZIP output path",
    )
    args = parser.parse_args()

    output = Path(args.output)
    download(args.url, output)
    print(f"Downloaded {output} ({output.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
