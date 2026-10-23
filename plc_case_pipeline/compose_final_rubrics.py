#!/usr/bin/env python3
"""Aggregate one rubric item per case for each final training."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from compose_final_graphs import FINAL_GROUPS
from compose_branches import read_title


def rubric_body(markdown: str) -> str:
    lines = markdown.splitlines()
    kept = []
    for line in lines:
        if line.startswith("# ") or line.startswith("## 总分") or line.startswith("## 评价标准概述"):
            continue
        if re.match(r"^\*\*评分区间[：:]\*\*$", line.strip()) or re.match(r"^\*\*评价描述[：:]\*\*", line.strip()):
            continue
        # Nested dimensions must not be parsed as additional top-level score
        # items by the platform parser.
        if re.match(r"^##\s+", line):
            line = "### " + re.sub(r"^##\s+", "", line)
        kept.append(line)
    return "\n".join(kept).strip()


def compose(training: int, group: dict, source_dir: Path, generated_dir: Path, manifest: dict) -> str:
    cases = [case for _, _, _, branch_cases in group["branches"] for case in branch_cases]
    count = len(cases)
    base, remainder = divmod(100, count)
    chunks = [
        f"# PLC能力训练-训练{training}-{group['name']} - 评价标准",
        "",
        "## 总分：100 分",
        "",
        "本评分表按案例综合评价；每个案例的分值为组内等权折算值，案例内部仍保留理论、实操、拓展和互动四类评价要求。",
        "",
    ]
    for index, case_no in enumerate(cases):
        points = base + (1 if index < remainder else 0)
        rubric_file = generated_dir / f"case_{case_no:02d}_rubric.md"
        body = rubric_body(rubric_file.read_text(encoding="utf-8"))
        title = read_title(manifest, case_no)
        chunks.extend([
            f"## 案例{case_no:02d}-{title}（{points} 分）",
            f"**评价描述：** 本案例综合考核理论掌握、虚拟实操分析、拓展优化思路和语音互动表现；以下要求来自教师案例的原始评分标准。",
            "**评分区间：**",
            body,
            "",
        ])
    return "\n".join(chunks).strip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=Path("plc_case_pipeline/01_sources/case_manifest.json"))
    parser.add_argument("--generated-dir", type=Path, default=Path("plc_case_pipeline/02_generated"))
    parser.add_argument("--output-dir", type=Path, default=Path("plc_case_pipeline/03_composed/final"))
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for group in FINAL_GROUPS:
        training = int(group["training"])
        path = args.output_dir / f"training_{training}_rubric.md"
        path.write_text(compose(training, group, args.output_dir, args.generated_dir, manifest), encoding="utf-8")
        print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
