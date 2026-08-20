#!/usr/bin/env python3
"""能力训练优化注入器。

将 AI 产生并通过图谱校验的优化方案，在不改动源训练的前提下注入另一个目标训练。
保留原卡片的附件、封面、知识库、搜索、角色等非文本配置，并优先继承原连线的
flowConfiguration。新增卡片可以继承一张原卡的基础配置，但默认不复制附件。
"""

import argparse
import copy
import json
from collections import Counter, defaultdict, deque
from pathlib import Path

from split_training import (
    EMPTY_FLOW_CFG,
    build_clone_detail,
    clean_task,
    create_script_flow,
    create_script_node_min,
    create_start_end_nodes,
    detail_of,
    edit_script_step,
    generate,
    is_business,
    load_env_config,
    load_source,
    query_script_step_flows,
    query_script_steps,
)

START = "START"
END = "END"


def text(value):
    return str(value or "").strip()


def bool_value(value):
    return value is True or value == 1 or str(value).lower() in {"1", "true"}


def load_plan(plan_file):
    plan = json.loads(Path(plan_file).read_text(encoding="utf-8"))
    if not isinstance(plan, dict):
        raise ValueError("优化方案必须是 JSON 对象。")
    return plan


def source_endpoints(nodes):
    starts = {
        n.get("stepId")
        for n in nodes
        if detail_of(n).get("nodeType") == "SCRIPT_START"
    }
    ends = {
        n.get("stepId")
        for n in nodes
        if detail_of(n).get("nodeType") == "SCRIPT_END"
    }
    return starts, ends


def normalize_source_endpoint(step_id, starts, ends):
    if step_id in starts:
        return START
    if step_id in ends:
        return END
    return step_id


def reachable(start, adjacency):
    seen = set()
    queue = deque([start])
    while queue:
        current = queue.popleft()
        if current in seen:
            continue
        seen.add(current)
        queue.extend(v for v in adjacency.get(current, []) if v not in seen)
    return seen


def validate_plan(plan, source_nodes, source_flows):
    errors = []
    warnings = []
    nodes = plan.get("nodes") or []
    flows = plan.get("flows") or []
    if not text(plan.get("taskName")):
        errors.append("缺少优化后训练名称。")
    if not text(plan.get("description")):
        errors.append("缺少优化后训练描述。")
    if not nodes:
        errors.append("优化方案没有业务卡片。")

    source_business_ids = {
        n.get("stepId") for n in source_nodes if is_business(n)
    }
    source_flow_ids = {f.get("flowId") for f in source_flows}
    node_ids = set()
    used_sources = set()
    for index, node in enumerate(nodes, start=1):
        node_id = text(node.get("id"))
        if not node_id or node_id in node_ids or node_id in {START, END}:
            errors.append(f"第 {index} 张卡片 id 缺失、重复或使用了保留字。")
        node_ids.add(node_id)
        source_id = text(node.get("sourceStepId"))
        template_id = text(node.get("templateSourceStepId"))
        if source_id:
            if source_id not in source_business_ids:
                errors.append(f"卡片 {node_id} 引用的 sourceStepId 不存在。")
            if source_id in used_sources:
                errors.append(f"sourceStepId {source_id} 被重复使用。")
            used_sources.add(source_id)
        elif template_id and template_id not in source_business_ids:
            errors.append(f"新卡片 {node_id} 的 templateSourceStepId 不存在。")
        if not text(node.get("stepName")):
            errors.append(f"卡片 {node_id or index} 缺少 stepName。")
        if len(text(node.get("llmPrompt"))) < 80:
            errors.append(f"卡片 {node_id or index} 提示词过短。")
        if not text(node.get("prologue")):
            errors.append(f"卡片 {node_id or index} 缺少开场白。")

    flow_ids = set()
    adjacency = defaultdict(list)
    reverse = defaultdict(list)
    outgoing = Counter()
    defaults = Counter()
    for index, flow in enumerate(flows, start=1):
        flow_id = text(flow.get("id"))
        start = text(flow.get("from"))
        end = text(flow.get("to"))
        if not flow_id or flow_id in flow_ids:
            errors.append(f"第 {index} 条连线 id 缺失或重复。")
        flow_ids.add(flow_id)
        if start != START and start not in node_ids:
            errors.append(f"连线 {flow_id} 起点不存在：{start}。")
        if end != END and end not in node_ids:
            errors.append(f"连线 {flow_id} 终点不存在：{end}。")
        if start == END or end == START or start == end:
            errors.append(f"连线 {flow_id} 方向不合法。")
        source_flow_id = text(flow.get("sourceFlowId"))
        if source_flow_id and source_flow_id not in source_flow_ids:
            errors.append(f"连线 {flow_id} 引用的 sourceFlowId 不存在。")
        adjacency[start].append(end)
        reverse[end].append(start)
        outgoing[start] += 1
        if bool_value(flow.get("isDefault")):
            defaults[start] += 1

    if not adjacency.get(START):
        errors.append("缺少 START 到首卡的连线。")
    if not reverse.get(END):
        errors.append("缺少末卡到 END 的连线。")
    for start, count in outgoing.items():
        if count > 1 and defaults[start] != 1:
            errors.append(
                f"起点 {start} 有 {count} 条出边，必须且只能有 1 条默认边。"
            )
        if defaults[start] > 1:
            errors.append(f"起点 {start} 存在多条默认边。")

    from_start = reachable(START, adjacency)
    to_end = reachable(END, reverse)
    for node_id in node_ids:
        if node_id not in from_start:
            errors.append(f"卡片 {node_id} 从 START 不可达。")
        if node_id not in to_end:
            errors.append(f"卡片 {node_id} 不能流向 END。")
    return list(dict.fromkeys(errors)), list(dict.fromkeys(warnings))


def graph_positions(plan):
    """依据连线的最短层级生成可读布局；循环或旁路卡片使用稳定后备层。"""
    nodes = [text(node.get("id")) for node in (plan.get("nodes") or [])]
    adjacency = defaultdict(list)
    for flow in plan.get("flows") or []:
        adjacency[text(flow.get("from"))].append(text(flow.get("to")))
    depth = {}
    queue = deque([(START, -1)])
    while queue:
        current, current_depth = queue.popleft()
        for child in adjacency.get(current, []):
            if child == END:
                continue
            proposed = current_depth + 1
            if child not in depth or proposed < depth[child]:
                depth[child] = proposed
                queue.append((child, proposed))
    fallback = max(depth.values(), default=-1) + 1
    layers = defaultdict(list)
    for node_id in nodes:
        layers[depth.get(node_id, fallback)].append(node_id)
    positions = {}
    for layer in sorted(layers):
        layer_nodes = layers[layer]
        for row, node_id in enumerate(layer_nodes):
            positions[node_id] = {
                "x": 300 + layer * 430,
                "y": 180 + row * 330,
            }
    end_x = 300 + (max(layers.keys(), default=0) + 1) * 430
    return positions, end_x


def source_detail_for_plan_node(node, source_by_id, first_source):
    source_id = text(node.get("sourceStepId"))
    template_id = text(node.get("templateSourceStepId"))
    selected = source_by_id.get(source_id or template_id) or first_source
    if not selected:
        raise ValueError(f"卡片 {node.get('id')} 没有可用的原卡模板。")
    detail = copy.deepcopy(detail_of(selected))
    if not source_id:
        detail["scriptStepResourceList"] = []
        ext = copy.deepcopy(detail.get("stepExtProperty") or {})
        ext["resources"] = []
        detail["stepExtProperty"] = ext
    return detail


def overlay_refined_fields(detail, node):
    result = copy.deepcopy(detail)
    for field in [
        "stepName",
        "description",
        "trainerName",
        "prologue",
        "llmPrompt",
        "interactiveRounds",
    ]:
        result[field] = node.get(field)
    for field in ["modelId", "agentId", "avatarNid"]:
        if text(node.get(field)):
            result[field] = node.get(field)
    result["nodeType"] = "SCRIPT_NODE"
    result["trainSubType"] = "ability"
    return result


def file_ids(detail):
    return [
        text(item.get("fileId"))
        for item in (detail.get("scriptStepResourceList") or [])
        if text(item.get("fileId"))
    ]


def print_dry_run(plan, source_by_id):
    print("=" * 72)
    print(f"🛠️  优化训练：{plan.get('taskName')}")
    print(f"📝 摘要：{plan.get('summary') or '-'}")
    print(f"🧩 架构：{plan.get('architectureRationale') or '-'}")
    print(f"📦 卡片 {len(plan.get('nodes') or [])} 张，连线 {len(plan.get('flows') or [])} 条")
    for node in plan.get("nodes") or []:
        source_id = text(node.get("sourceStepId"))
        attachments = file_ids(detail_of(source_by_id[source_id])) if source_id else []
        marker = "原卡优化" if source_id else "新增卡"
        print(
            f"  · [{marker}] {node.get('id')} | {node.get('stepName')} | "
            f"附件 {len(attachments)} | 轮次 {node.get('interactiveRounds')}"
        )
    for flow in plan.get("flows") or []:
        default = "默认" if bool_value(flow.get("isDefault")) else "条件"
        print(
            f"  → {flow.get('from')} --[{default}: {text(flow.get('condition'))[:48]}]--> {flow.get('to')}"
        )


def import_plan(plan, source_nodes, source_flows, target_id, course_id):
    source_business = [node for node in source_nodes if is_business(node)]
    source_by_id = {node.get("stepId"): node for node in source_business}
    source_flow_by_id = {flow.get("flowId"): flow for flow in source_flows}
    first_source = source_business[0] if source_business else None
    positions, end_x = graph_positions(plan)

    print(f"🚀 将优化图谱注入目标训练 {target_id}")
    clean_task(target_id)
    start_id, end_id = create_start_end_nodes(target_id, course_id)
    print(f"   ✅ START={start_id}  END={end_id}")

    logical_to_live = {START: start_id, END: end_id}
    expected_files = Counter()
    for node in plan.get("nodes") or []:
        logical_id = text(node.get("id"))
        live_id = generate(size=21)
        logical_to_live[logical_id] = live_id
        base_detail = source_detail_for_plan_node(node, source_by_id, first_source)
        refined_source_detail = overlay_refined_fields(base_detail, node)
        if not create_script_node_min(
            target_id, course_id, live_id, refined_source_detail, {}
        ):
            raise RuntimeError(f"创建卡片失败：{node.get('stepName')}")
        full_detail = build_clone_detail(
            refined_source_detail, live_id, target_id, {}
        )
        if not edit_script_step(
            {
                "trainTaskId": target_id,
                "stepId": live_id,
                "stepDetailDTO": full_detail,
                "positionDTO": positions[logical_id],
                "courseId": course_id,
            }
        ):
            raise RuntimeError(f"补全卡片失败：{node.get('stepName')}")
        expected_files.update(file_ids(full_detail))
        print(
            f"   ✅ {node.get('stepName')}（附件 {len(file_ids(full_detail))} 个）"
        )

    # 调整 END 节点的布局会需要 editScriptStep 的完整 detail，为降低平台兼容风险，
    # 保留 create_start_end_nodes 中的默认位置；业务节点的位置已按图谱层级生成。
    _ = end_x

    expected_edges = Counter()
    for flow in plan.get("flows") or []:
        logical_start = text(flow.get("from"))
        logical_end = text(flow.get("to"))
        source_flow = source_flow_by_id.get(text(flow.get("sourceFlowId")))
        start_live = logical_to_live[logical_start]
        end_live = logical_to_live[logical_end]
        is_default = 1 if bool_value(flow.get("isDefault")) else 0
        if not create_script_flow(
            target_id,
            start_id=start_live,
            end_id=end_live,
            src_flow=source_flow,
            cond=text(flow.get("condition")),
            transition=text(flow.get("transitionPrompt")),
            is_default=is_default,
            flow_config=None if source_flow else copy.deepcopy(EMPTY_FLOW_CFG),
            hist_num=None if source_flow else -1,
        ):
            raise RuntimeError(f"创建连线失败：{logical_start} -> {logical_end}")
        expected_edges[
            (start_live, end_live, text(flow.get("condition")), is_default)
        ] += 1

    live_steps = query_script_steps(target_id)
    live_flows = query_script_step_flows(target_id)
    live_business = [node for node in live_steps if is_business(node)]
    live_files = Counter()
    for node in live_business:
        live_files.update(file_ids(detail_of(node)))
    live_edges = Counter(
        (
            text(flow.get("scriptStepStartId")),
            text(flow.get("scriptStepEndId")),
            text(flow.get("flowCondition")),
            1 if bool_value(flow.get("isDefault")) else 0,
        )
        for flow in live_flows
    )

    checks = {
        "业务卡片": len(live_business) == len(plan.get("nodes") or []),
        "连线数量": len(live_flows) == len(plan.get("flows") or []),
        "连线结构": live_edges == expected_edges,
        "附件集合": live_files == expected_files,
    }
    print(
        f"   🔎 回采：卡片 {len(live_business)}/{len(plan.get('nodes') or [])}，"
        f"连线 {len(live_flows)}/{len(plan.get('flows') or [])}，"
        f"附件 {sum(live_files.values())}/{sum(expected_files.values())}"
    )
    failed = [name for name, ok in checks.items() if not ok]
    if failed:
        raise RuntimeError("目标训练回采校验失败：" + "、".join(failed))
    print("   ✅ 目标训练回采校验全部通过")


def parse_args():
    parser = argparse.ArgumentParser(description="能力训练 AI 优化方案注入器")
    parser.add_argument("--source-dir", required=True, help="原卡片/连线 JSON 目录")
    parser.add_argument("--plan-file", required=True, help="AI 优化方案 JSON")
    parser.add_argument("--target", help="目标训练 trainTaskId")
    parser.add_argument("--course-id", help="目标课程 courseId")
    parser.add_argument("--source-task-id", help="源训练 trainTaskId，用于防止覆盖源训练")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--import", dest="do_import", action="store_true")
    return parser.parse_args()


def main():
    args = parse_args()
    source_nodes, source_flows = load_source(args.source_dir)
    plan = load_plan(args.plan_file)
    errors, warnings = validate_plan(plan, source_nodes, source_flows)
    if errors:
        raise ValueError("优化图谱校验失败：\n- " + "\n- ".join(errors))
    for warning in warnings:
        print(f"⚠️ {warning}")

    source_by_id = {
        node.get("stepId"): node for node in source_nodes if is_business(node)
    }
    print_dry_run(plan, source_by_id)
    if args.dry_run:
        print("✅ Dry-run 完成，未调用任何写入接口。")
        return

    if not text(args.target) or not text(args.course_id):
        raise ValueError("正式注入需要 --target 和 --course-id。")
    if text(args.source_task_id) and text(args.source_task_id) == text(args.target):
        raise ValueError("目标训练与源训练相同，已中止以保护原训练。")
    load_env_config()
    import_plan(
        plan,
        source_nodes,
        source_flows,
        text(args.target),
        text(args.course_id),
    )


if __name__ == "__main__":
    main()
