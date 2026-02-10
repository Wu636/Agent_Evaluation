"""
作业批阅服务端入口（非交互）
用于 Web/API 调用
"""

import argparse
import json
import os
from pathlib import Path
from typing import List, Optional

from homework_reviewer_v2 import (
    load_env_config,
    ensure_instance_context,
    run_batch,
    extract_core_data,
    calculate_category_scores,
)


def parse_args():
    parser = argparse.ArgumentParser(description="Homework Review Service")
    parser.add_argument("--inputs", required=True, help="JSON array of input file paths")
    parser.add_argument("--attempts", type=int, default=5, help="评测次数")
    parser.add_argument("--output-format", choices=["json", "pdf"], default="json")
    parser.add_argument("--output-root", required=True, help="输出目录")
    parser.add_argument("--max-concurrency", type=int, default=5)
    parser.add_argument("--local-parse", action="store_true")
    return parser.parse_args()


def list_output_files(output_root: Path) -> List[str]:
    files = []
    if not output_root.exists():
        return files
    for path in output_root.rglob("*"):
        if path.is_file():
            files.append(str(path.relative_to(output_root)))
    return sorted(files)


def build_score_table(results: list, file_paths: list, attempts: int) -> dict:
    """
    从批阅结果构建评分表 JSON 数据，供前端渲染。
    结构:
    {
        "attempts": 5,
        "students": [
            {
                "name": "等级一_优秀_学生答案",
                "full_mark": 100,
                "total_scores": [85, 87, 86, null, 85],
                "mean": 85.75,
                "variance": 0.69,
                "categories": [
                    { "name": "单项选择题", "total": 20, "scores": [18,18,...], "mean": 18.0, "variance": 0 }
                ],
                "dimensions": [
                    { "name": "内容准确性", "scores": [8,9,...], "mean": 8.5, "variance": 0.25 }
                ]
            }
        ]
    }
    """
    from collections import defaultdict

    label_counts: dict = defaultdict(int)
    label_by_path: dict = {}
    for p in file_paths:
        key = str(p)
        if key not in label_by_path:
            base = Path(p).stem
            label_counts[base] += 1
            label = base if label_counts[base] == 1 else f"{base}({label_counts[base]})"
            label_by_path[key] = label

    # Aggregate per student
    student_data: dict = {}
    dim_order_by_label: dict = {}
    cat_order_by_label: dict = {}

    for item in (results or []):
        if not item or not item.get("success"):
            continue
        core = extract_core_data(item.get("result", {}))
        if not core:
            continue
        fp = item.get("file_path", "")
        label = label_by_path.get(fp, Path(fp).stem if fp else "未命名")
        entry = student_data.setdefault(label, {
            "full_mark": core.get("full_mark", 100),
            "total_scores": [None] * attempts,
            "categories": {},
            "dimensions": {},
        })
        dim_order = dim_order_by_label.setdefault(label, [])
        cat_order = cat_order_by_label.setdefault(label, [])

        ai = item.get("attempt_index", 0)
        if ai < 1 or ai > attempts:
            continue

        entry["total_scores"][ai - 1] = core.get("total_score")

        # Categories
        for cat_name in core.get("category_order", []):
            if cat_name not in cat_order:
                cat_order.append(cat_name)
            cat_scores = core.get("category_scores", {}).get(cat_name, {})
            ce = entry["categories"].setdefault(cat_name, {
                "scores": [None] * attempts,
                "total": cat_scores.get("total", 0),
            })
            ce["scores"][ai - 1] = cat_scores.get("score")
            if cat_scores.get("total", 0) > ce["total"]:
                ce["total"] = cat_scores.get("total", 0)

        # Dimensions
        for dim in core.get("dimension_scores", []):
            dname = dim.get("evaluationDimension") or "未命名维度"
            if dname not in dim_order:
                dim_order.append(dname)
            ds = entry["dimensions"].setdefault(dname, [None] * attempts)
            ds[ai - 1] = dim.get("dimensionScore")

    def stats(scores):
        valid = [s for s in scores if s is not None]
        if not valid:
            return None, None
        mean = round(sum(valid) / len(valid), 2)
        var = round(sum((x - mean) ** 2 for x in valid) / len(valid), 2) if len(valid) > 1 else 0
        return mean, var

    # 按等级排序
    level_order = {"优秀": 1, "良好": 2, "中等": 3, "合格": 4, "较差": 5}

    def sort_key(label):
        for lv, pri in level_order.items():
            if lv in label:
                return pri
        return 999

    students = []
    for label in sorted(student_data.keys(), key=sort_key):
        entry = student_data[label]
        ts = entry["total_scores"]
        t_mean, t_var = stats(ts)

        cats = []
        for cn in cat_order_by_label.get(label, []):
            ce = entry["categories"].get(cn, {})
            cs = ce.get("scores", [])
            c_mean, c_var = stats(cs)
            cats.append({
                "name": cn,
                "total": ce.get("total", 0),
                "scores": cs,
                "mean": c_mean,
                "variance": c_var,
            })

        dims = []
        for dn in dim_order_by_label.get(label, []):
            ds = entry["dimensions"].get(dn, [])
            d_mean, d_var = stats(ds)
            dims.append({
                "name": dn,
                "scores": ds,
                "mean": d_mean,
                "variance": d_var,
            })

        students.append({
            "name": label,
            "full_mark": entry.get("full_mark", 100),
            "total_scores": ts,
            "mean": t_mean,
            "variance": t_var,
            "categories": cats,
            "dimensions": dims,
        })

    return {"attempts": attempts, "students": students}


def main():
    args = parse_args()

    # 解析输入文件列表
    try:
        input_list = json.loads(args.inputs)
    except json.JSONDecodeError:
        raise SystemExit("inputs 参数必须是 JSON 数组")

    if not isinstance(input_list, list) or not input_list:
        raise SystemExit("inputs 为空或格式不正确")

    file_paths = [Path(p) for p in input_list]
    for p in file_paths:
        if not p.exists():
            raise SystemExit(f"输入文件不存在: {p}")

    output_root = Path(args.output_root)
    output_root.mkdir(parents=True, exist_ok=True)

    # 加载环境配置（如果环境变量已由父进程设置则跳过 .env）
    if not os.environ.get("AUTHORIZATION") or not os.environ.get("COOKIE") or not os.environ.get("INSTANCE_NID"):
        load_env_config()
    else:
        print("✅ 使用父进程传入的环境变量")

    # 获取实例信息
    context = ensure_instance_context()
    if not context:
        raise SystemExit("无法获取实例信息，请检查 INSTANCE_NID 配置")

    # 执行批阅
    result = None
    try:
        import asyncio
        result = asyncio.run(
            run_batch(
                file_paths,
                args.attempts,
                context,
                output_root,
                args.output_format,
                max_concurrency=args.max_concurrency,
                local_parse=args.local_parse,
            )
        )
    except Exception as e:
        raise SystemExit(f"批阅失败: {e}")

    output_files = list_output_files(output_root)

    # 构建评分表 JSON
    score_table = {}
    batch_results = (result or {}).get("results", [])
    if batch_results:
        score_table = build_score_table(batch_results, [str(p) for p in file_paths], args.attempts)
        # 同时写到文件
        st_path = output_root / "score_table.json"
        st_path.write_text(json.dumps(score_table, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"✅ 评分表JSON已生成: {st_path}")

    payload = {
        "success": True,
        "output_root": str(output_root),
        "output_files": output_files,
        "result": result or {},
        "score_table": score_table,
    }

    print("__RESULT__" + json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
