#!/usr/bin/env python3
"""Build the three final graph scripts from the seven linear branch scripts."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Dict, List

from compose_branches import parse_stages, read_title, replace_task_prefix


FINAL_GROUPS = [
    {
        "training": 1,
        "name": "基础指令、状态表与定时器应用",
        "branches": [
            ("B1", "基本指令案例", "t1_b1_cases_01_06.md", list(range(1, 7))),
            ("B2", "状态表法程序设计", "t1_b2_cases_07_08.md", [7, 8]),
            ("B3", "定时器指令案例", "t1_b3_cases_09_13.md", list(range(9, 14))),
        ],
    },
    {
        "training": 2,
        "name": "指令综合与结构化程序设计",
        "branches": [
            ("B1", "指令综合应用", "t2_b1_cases_14_18.md", list(range(14, 19))),
            ("B2", "结构化程序设计", "t2_b2_cases_19_23.md", list(range(19, 24))),
        ],
    },
    {
        "training": 3,
        "name": "顺序控制与工艺对象设计",
        "branches": [
            ("B1", "顺序控制系统设计", "t3_b1_cases_24_31.md", list(range(24, 32))),
            ("B2", "工艺对象设计", "t3_b2_cases_32_35.md", list(range(32, 36))),
        ],
    },
]


def rewrite_final_stage(block: str, case_no: int, local_index: int, global_index: int,
                        title: str, condition: str) -> str:
    lines = block.splitlines()
    if not lines:
        return block
    lines[0] = f"### 阶段{global_index}: 案例{case_no:02d}-{title}"
    flow_line = re.compile(r"^(\s*\*\*flowCondition\*\*\s*[:：]).*$", re.I)
    old_condition = ""
    for line in lines:
        if flow_line.match(line):
            old_condition = line.split(":", 1)[-1].strip().strip('"`')
            break
    for index, line in enumerate(lines):
        if flow_line.match(line):
            lines[index] = f'**flowCondition**: "{condition}"'
    body = "\n".join(lines[1:])
    if old_condition:
        body = body.replace(old_condition, condition)
    # Keep references in prompts aligned with the global graph numbering,
    # without applying the replacement to the already rewritten heading.
    body = body.replace(f"阶段{local_index + 1}", f"阶段{global_index + 1}")
    return "\n".join([lines[0], body])


def selector_stage(training: int, name: str, branches: List[tuple]) -> str:
    options = "、".join(f"{code}：{label}" for code, label, _, _ in branches)
    conditions = "；".join(f"选择{code}时仅输出 BRANCH_T{training}_{code}" for code, *_ in branches)
    return "\n".join([
        "### 阶段1: 分支选择",
        "**虚拟训练官名字**: 训练引导官",
        "**数字人性别**: 男性",
        "**数字人年龄层**: 成年",
        "**模型**: claude-opus-4-8",
        "**声音**:",
        "**形象**:",
        f"**阶段描述**: 引导学生从训练{training}的 {options} 中选择一个案例分支，选择后进入对应分支并完成其中全部案例。",
        "**背景图**:",
        "**互动轮次**: 1",
        "**flowCondition**: \"选择分支\"",
        "**transitionPrompt**:",
        "```markdown\n根据学生选择的方向自然衔接到对应案例分支。\n```",
        "**开场白**:",
        f"> 欢迎进入训练{training}：{name}。本训练包含 {options}。请先告诉我你想进入哪个分支。",
        "**提示词**:",
        "```markdown",
        "# Role",
        "你是训练引导官，只负责识别学生的分支选择。",
        "# Context & Task",
        f"可选分支：{options}。{conditions}。未明确选择时继续追问，不泄露分支答案。",
        "# Workflow & Interaction Rules",
        "学生明确选择某一分支后，不输出解释，只输出对应 BRANCH_Tx_By 关键词。",
        "# Response Constraints",
        "跳转时仅输出关键词，不含标点或其他字符。",
        "```",
    ])


def compose_final(group: Dict[str, object], source_dir: Path, manifest: Dict[str, object]) -> Dict[str, object]:
    training = int(group["training"])
    branches = group["branches"]
    task_name = f"PLC能力训练-训练{training}-{group['name']}"
    description = "；".join(
        f"分支{code}（{label}）：案例{'、'.join(map(str, cases))}"
        for code, label, _, cases in branches
    ) + "。每个分支内部按案例编号串行完成五个阶段。"

    first_file = source_dir / branches[0][2]
    first_prefix, _, _ = parse_stages(first_file.read_text(encoding="utf-8"))
    prefix = replace_task_prefix(first_prefix, task_name, description)
    prefix = "\n".join(
        line for line in prefix.splitlines()
        if not re.match(r"^##+\s*(?:📝\s*)?训练阶段\b", line.strip())
        and not re.match(r"^\s*<!--\s*STAGE_(?:START|END)\b", line.strip())
    ).strip()

    stages = [selector_stage(training, str(group["name"]), branches)]
    edges: List[Dict[str, object]] = [
        {"from": "START", "to": "阶段1", "condition": f"BEGIN_T{training}_BRANCH_SELECT",
         "conditionDescription": "进入分支选择卡", "transitionPrompt": "", "isDefault": 1}
    ]
    global_index = 1
    branch_ranges = []
    for branch_index, (code, label, filename, cases) in enumerate(branches):
        _, branch_stages, _ = parse_stages((source_dir / filename).read_text(encoding="utf-8"))
        start_global = global_index + 1
        for stage_offset, (_, block) in enumerate(branch_stages):
            global_index += 1
            case_no = cases[stage_offset // 5]
            local_stage = stage_offset % 5 + 1
            title = read_title(manifest, case_no)
            next_condition = (
                f"T{training}_{code}_S{local_stage + 1}"
                if stage_offset < len(branch_stages) - 1
                else f"T{training}_{code}_COMPLETE"
            )
            stages.append(rewrite_final_stage(block, case_no, local_stage, global_index, title, next_condition))
            if stage_offset > 0:
                edges.append({
                    "from": f"阶段{global_index - 1}", "to": f"阶段{global_index}",
                    "condition": f"T{training}_{code}_S{local_stage}",
                    "conditionDescription": f"分支{code}进入案例阶段{local_stage}",
                    "transitionPrompt": "", "isDefault": 1,
                })
        branch_ranges.append((code, start_global, global_index, label))
        edges.append({
            "from": "阶段1", "to": f"阶段{start_global}",
            "condition": f"BRANCH_T{training}_{code}",
            "conditionDescription": f"选择分支{code}：{label}",
            "transitionPrompt": "", "isDefault": 1 if branch_index == 0 else 0,
        })
        edges.append({
            "from": f"阶段{global_index}", "to": "END",
            "condition": f"T{training}_{code}_COMPLETE",
            "conditionDescription": f"分支{code}全部案例完成", "transitionPrompt": "", "isDefault": 1,
        })

    graph_block = "\n".join([
        "## 🔀 非线性跳转关系",
        "```json",
        json.dumps({"flowType": "graph", "edges": edges}, ensure_ascii=False, indent=2),
        "```",
    ])
    output = "\n\n".join([
        prefix, "## 📝 训练阶段", "\n\n---\n\n".join(stages), graph_block,
        "## 📖 配置说明\n\n本配置包含一个分支选择卡；每个分支内部案例严格串行，分支完成后汇合到 END。",
        "<!-- TRAINING_SCRIPT_COMPLETE -->",
    ]).strip() + "\n"
    return {
        "training": training, "taskName": task_name,
        "branches": [{"code": code, "label": label, "cases": cases,
                       "stageStart": start, "stageEnd": end}
                      for (code, label, _, cases), (_, start, end, _) in zip(branches, branch_ranges)],
        "stageCount": global_index, "edgeCount": len(edges), "markdown": output,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=Path("plc_case_pipeline/01_sources/case_manifest.json"))
    parser.add_argument("--source-dir", type=Path, default=Path("plc_case_pipeline/03_composed"))
    parser.add_argument("--output-dir", type=Path, default=Path("plc_case_pipeline/03_composed/final"))
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    args.output_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for group in FINAL_GROUPS:
        result = compose_final(group, args.source_dir, manifest)
        path = args.output_dir / f"training_{result['training']}_graph.md"
        path.write_text(result.pop("markdown"), encoding="utf-8")
        result["file"] = str(path)
        results.append(result)
        print(json.dumps({k: result[k] for k in ("training", "taskName", "stageCount", "edgeCount", "file")}, ensure_ascii=False))
    (args.output_dir / "final_training_manifest.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
