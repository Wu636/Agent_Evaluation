#!/usr/bin/env python3
"""能力训练合并注入器 — 将多个能力训练合并为一个能力训练。

支持两种合并模式：
  1) sequential（串联）: A → B → C，线性拼接
  2) branch（分支）: A → [分支节点] → B / C → END，用户可选择路径

用法：
  # 串联合并（A→B→C）
  python merge_training.py --import --target <TARGET_TASK_ID> \
      --source1 <TASK_ID_A> --source2 <TASK_ID_B> --source3 <TASK_ID_C> \
      --mode sequential --course-id <COURSE_ID>

  # 分支合并（A→[选择B或C]→B/C→END）
  python merge_training.py --import --target <TARGET_TASK_ID> \
      --source1 <TASK_ID_A> --source2 <TASK_ID_B> --source3 <TASK_ID_C> \
      --mode branch --course-id <COURSE_ID>

  # Dry-run 预览
  python merge_training.py --dry-run --target <TARGET_TASK_ID> \
      --source1 <TASK_ID_A> --source2 <TASK_ID_B> --mode sequential

  # 关卡自动续编号（A的关卡一~三保持，B的关卡一~二重编为关卡四~五）
  python merge_training.py --import --target <TARGET_TASK_ID> \
      --source1 <A> --source2 <B> --mode sequential --renumber

环境变量（.env 文件或系统环境变量）：
  AUTHORIZATION  —— 平台 API Authorization 头
  COOKIE         —— 平台登录 Cookie

依赖: pip install requests nanoid python-dotenv
"""

import argparse
import copy
import json
import os
import re
import sys
from pathlib import Path

import requests
from nanoid import generate

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None

# ── 常量 ──────────────────────────────────────────────

BASE_URL = "https://cloudapi.polymas.com/teacher-course/abilityTrain"

CN = {
    1: "一", 2: "二", 3: "三", 4: "四", 5: "五",
    6: "六", 7: "七", 8: "八", 9: "九", 10: "十",
    11: "十一", 12: "十二", 13: "十三", 14: "十四", 15: "十五",
    16: "十六", 17: "十七", 18: "十八", 19: "十九", 20: "二十",
}
CN2NUM = {v: k for k, v in CN.items()}

EMPTY_FLOW_CFG = {
    "relation": "and",
    "conditions": [
        {"text": "条件组1", "relation": "and", "conditions": [{"text": ""}]}
    ],
}

# 分支节点默认配置（branch 模式下在源训练之间插入）
BRANCH_NODE_TEMPLATE = {
    "nodeType": "SCRIPT_NODE",
    "stepName": "分支选择",
    "description": "请选择接下来要进行的训练",
    "prologue": "你已经完成了当前阶段，接下来你想挑战哪个方向？",
    "modelId": "Doubao-Seed-2.0-pro",
    "llmPrompt": (
        "# Role\n你是训练引导官，负责帮助学生选择下一步的训练方向。\n\n"
        "# Context & Task\n学生已完成当前阶段训练，需要选择下一个训练分支。\n\n"
        "# Workflow & Interaction Rules\n"
        "1. **判定选择有效**: 学生明确选择了某个分支。策略: 输出对应跳转关键词。\n"
        "2. **判定未选择**: 学生未明确选择。策略: 列出可选分支，引导学生选择。\n"
        "3. **判定无关话题**: 策略: 拉回选择环节。\n\n"
        "# Response Constraints\n跳转时仅输出关键词，不含其他内容。"
    ),
    "trainerName": "训练引导官",
    "interactiveRounds": 3,
    "scriptStepCover": {},
    "whiteBoardSwitch": 0,
    "agentId": "Tg3LpKo28D",
    "avatarNid": "",
    "videoSwitch": 0,
    "scriptStepResourceList": [],
    "knowledgeBaseSwitch": 0,
    "searchEngineSwitch": 0,
    "historyRecordNum": -1,
    "trainSubType": "ability",
}


# ── 环境 & HTTP ──────────────────────────────────────


def load_env_config():
    if load_dotenv is None:
        print("⚠️ python-dotenv 未安装，仅使用系统环境变量")
        return
    current = Path(__file__).parent
    for d in [current, current.parent, current.parent.parent, Path.cwd()]:
        env = d / ".env"
        if env.exists():
            load_dotenv(env)
            print(f"✅ 加载环境配置: {env}")
            return
    print("⚠️ 未找到 .env 文件，使用系统环境变量")


def get_headers():
    auth = os.getenv("AUTHORIZATION")
    cookie = os.getenv("COOKIE")
    if not auth or not cookie:
        raise ValueError(
            "缺少 AUTHORIZATION 或 COOKIE 环境变量。\n"
            "请在 .env 文件或系统环境变量中设置。"
        )
    return {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": auth,
        "Cookie": cookie,
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/142.0.0.0 Safari/537.36"
        ),
    }


def api_post(action, payload, timeout=20):
    url = f"{BASE_URL}/{action}"
    resp = requests.post(url, headers=get_headers(), json=payload, timeout=timeout)
    j = resp.json()
    ok = j.get("code") == 200 or j.get("success") is True
    return ok, j


# ── 节点工具 ──────────────────────────────────────────


def detail_of(node):
    return node.get("stepDetailDTO", {})


def is_business(node):
    return detail_of(node).get("nodeType") == "SCRIPT_NODE"


def is_start(node):
    return detail_of(node).get("nodeType") == "SCRIPT_START"


def is_end(node):
    return detail_of(node).get("nodeType") == "SCRIPT_END"


def module_of(step_name):
    """从节点名解析所属关卡号，非关卡节点返回 None。"""
    m = re.match(r"关卡([1-9]|10|1[1-9]|20)\.", step_name)
    if m:
        return int(m.group(1))
    m = re.match(r"关卡([一二三四五六七八九十]+)[：:]", step_name)
    if m:
        return CN2NUM.get(m.group(1))
    return None


def renumber_name(step_name, rmap):
    """按重编号映射表替换节点名中的关卡编号。rmap 为空时不重编号。"""
    if not rmap:
        return step_name
    m = re.match(r"(关卡)([1-9]|10|1[1-9]|20)(\..*)", step_name, re.S)
    if m:
        old = int(m.group(2))
        new = rmap.get(old, old)
        return f"关卡{new}{m.group(3)}"
    m = re.match(r"(关卡)([一二三四五六七八九十]+)([：:].*)", step_name, re.S)
    if m:
        old = CN2NUM.get(m.group(2))
        if old is None:
            return step_name
        new = rmap.get(old, old)
        return f"关卡{CN[new]}{m.group(3)}"
    return step_name


def is_header_name(step_name):
    return bool(re.match(r"关卡[一二三四五六七八九十]+[：:]", step_name))


def detect_max_level(nodes):
    """检测节点列表中的最大关卡号。"""
    max_lv = 0
    for n in nodes:
        if not is_business(n):
            continue
        name = detail_of(n).get("stepName", "")
        lv = module_of(name)
        if lv and lv > max_lv:
            max_lv = lv
    return max_lv


# ── 资源转换 ──────────────────────────────────────────


def convert_resources(srl, new_task_id, new_step_id):
    srl = srl or []
    groups = {}
    order = []
    for r in srl:
        if not r.get("fileId"):
            continue
        nid = r.get("resourceTypeNid") or r.get("nid") or "default"
        cat = r.get("category") or "未分类"
        key = (nid, cat)
        if key not in groups:
            groups[key] = {"nid": nid, "category": cat, "list": []}
            order.append(key)
        groups[key]["list"].append(
            {
                "type": r.get("type", "resource"),
                "fileId": r.get("fileId"),
                "fileName": r.get("fileName"),
                "thumbnail": r.get("thumbnail", ""),
                "fileUrl": r.get("fileUrl"),
                "isRequired": bool(r.get("isRequired")),
                "description": r.get("description", ""),
                "trainTaskId": new_task_id,
                "scriptStepId": new_step_id,
                "sort": r.get("sort"),
                "scriptStepResourceId": generate(size=20),
            }
        )
    return [groups[k] for k in order]


def build_clone_detail(src_detail, new_step_id, new_task_id, rmap):
    d = copy.deepcopy(src_detail)
    old_name = d.get("stepName", "")
    d["stepName"] = renumber_name(old_name, rmap)

    if is_header_name(old_name) and rmap:
        old_mod = module_of(old_name)
        new_mod = rmap.get(old_mod, old_mod)
        if old_mod != new_mod:
            d["prologue"] = (d.get("prologue", "") or "").replace(
                f"关卡{CN[old_mod]}", f"关卡{CN[new_mod]}"
            )

    src_srl = d.get("scriptStepResourceList") or []
    remapped = []
    for r in src_srl:
        if not r.get("fileId"):
            continue
        nr = copy.deepcopy(r)
        nr["trainTaskId"] = new_task_id
        nr["scriptStepId"] = new_step_id
        nr.pop("scriptStepResourceId", None)
        remapped.append(nr)
    d["scriptStepResourceList"] = remapped

    ext = copy.deepcopy(d.get("stepExtProperty") or {})
    ext["resources"] = convert_resources(src_srl, new_task_id, new_step_id)
    d["stepExtProperty"] = ext

    if (d.get("scriptStepCover") or {}).get("fileUrl"):
        d.setdefault("scriptBackgroundType", "image")
    d.setdefault("contentSkip", 0)
    d.pop("createTime", None)
    d.pop("updateTime", None)
    return d


# ── API 封装 ──────────────────────────────────────────


def query_script_steps(task_id):
    ok, j = api_post(
        "queryScriptStepList", {"trainTaskId": task_id, "trainSubType": "ability"}
    )
    return j.get("data", []) if ok else []


def query_script_step_flows(task_id):
    ok, j = api_post("queryScriptStepFlowList", {"trainTaskId": task_id})
    return j.get("data", []) if ok else []


def create_start_end_nodes(task_id, course_id):
    start_id = generate(size=21)
    end_id = generate(size=21)
    for nid, ntype, pos in [
        (start_id, "SCRIPT_START", {"x": 0, "y": 300}),
        (end_id, "SCRIPT_END", {"x": 3000, "y": 300}),
    ]:
        ok, j = api_post(
            "createScriptStep",
            {
                "trainTaskId": task_id,
                "stepId": nid,
                "stepDetailDTO": {
                    "nodeType": ntype,
                    "stepName": "defaultStepName",
                    "description": "",
                    "prologue": "",
                    "modelId": "",
                    "llmPrompt": "",
                    "trainerName": "",
                    "scriptStepCover": {},
                    "whiteBoardSwitch": 0,
                    "videoSwitch": 0,
                    "scriptStepResourceList": [],
                    "knowledgeBaseSwitch": 0,
                    "searchEngineSwitch": 0,
                    "trainSubType": "ability",
                },
                "positionDTO": pos,
                "courseId": course_id,
                "libraryFolderId": "",
            },
        )
        if not ok:
            raise RuntimeError(f"创建 {ntype} 失败: {j}")
    return start_id, end_id


def create_script_node_min(task_id, course_id, step_id, src_detail, rmap):
    ok, j = api_post(
        "createScriptStep",
        {
            "trainTaskId": task_id,
            "stepId": step_id,
            "stepDetailDTO": {
                "nodeType": "SCRIPT_NODE",
                "stepName": renumber_name(src_detail.get("stepName", ""), rmap),
                "description": src_detail.get("description", ""),
                "prologue": "",
                "modelId": src_detail.get("modelId") or "Doubao-Seed-2.0-pro",
                "llmPrompt": "",
                "trainerName": src_detail.get("trainerName", ""),
                "interactiveRounds": src_detail.get("interactiveRounds", 0),
                "scriptStepCover": {},
                "whiteBoardSwitch": 0,
                "agentId": src_detail.get("agentId") or "Tg3LpKo28D",
                "avatarNid": src_detail.get("avatarNid", ""),
                "videoSwitch": 0,
                "scriptStepResourceList": [],
                "knowledgeBaseSwitch": src_detail.get("knowledgeBaseSwitch", 1),
                "searchEngineSwitch": src_detail.get("searchEngineSwitch", 1),
                "historyRecordNum": src_detail.get("historyRecordNum", -1),
                "trainSubType": "ability",
            },
            "positionDTO": {"x": 100, "y": 100},
            "courseId": course_id,
            "libraryFolderId": "",
        },
    )
    if not ok:
        print(f"❌ createScriptStep 失败 [{step_id}]: {j}")
    return ok


def edit_script_step(payload):
    ok, j = api_post("editScriptStep", payload)
    if not ok:
        print(f"❌ editScriptStep 失败: {j}")
    return ok


def create_script_flow(
    task_id,
    *,
    start_id,
    end_id,
    src_flow=None,
    cond=None,
    transition=None,
    is_default=None,
    flow_config=None,
    hist_num=None,
):
    flow_id = generate(size=21)

    def pick(value, src_key, default):
        if value is not None:
            return value
        if src_flow is not None and src_key in src_flow:
            return copy.deepcopy(src_flow[src_key])
        return default

    ok, j = api_post(
        "createScriptStepFlow",
        {
            "trainTaskId": task_id,
            "flowId": flow_id,
            "scriptStepStartId": start_id,
            "scriptStepStartHandle": f"{start_id}-source-bottom",
            "scriptStepEndId": end_id,
            "scriptStepEndHandle": f"{end_id}-target-top",
            "flowCondition": pick(cond, "flowCondition", ""),
            "flowConfiguration": pick(
                flow_config, "flowConfiguration", copy.deepcopy(EMPTY_FLOW_CFG)
            ),
            "flowSettingType": "quick",
            "transitionPrompt": pick(transition, "transitionPrompt", ""),
            "transitionHistoryNum": pick(hist_num, "transitionHistoryNum", -1),
            "isDefault": pick(is_default, "isDefault", 1),
            "isError": False,
        },
    )
    if not ok:
        print(f"❌ createScriptStepFlow 失败: {j}")
    return ok


def delete_script_step_flow(task_id, flow_id):
    ok, j = api_post(
        "delScriptStepFlow", {"trainTaskId": task_id, "flowId": flow_id}
    )
    if not ok:
        print(f"   ❌ 删除连线失败 {flow_id}: {j.get('msg')}")
    return ok


def delete_script_step(task_id, step_id):
    ok, j = api_post(
        "delScriptStep", {"trainTaskId": task_id, "stepId": step_id}
    )
    if not ok:
        print(f"   ❌ 删除节点失败 {step_id}: {j.get('msg')}")
    return ok


def clean_task(task_id):
    flows = query_script_step_flows(task_id)
    for fl in flows:
        if fl.get("flowId"):
            delete_script_step_flow(task_id, fl["flowId"])
    steps = query_script_steps(task_id)
    for st in steps:
        if st.get("stepId"):
            delete_script_step(task_id, st["stepId"])
    print(
        f"   🧹 已清空任务 {task_id}：删除连线 {len(flows)}，节点 {len(steps)}"
    )
    remaining = query_script_steps(task_id)
    if remaining:
        raise RuntimeError(f"清空后仍残留 {len(remaining)} 个节点，已中止。")


# ── 源训练分析 ──────────────────────────────────────


def analyze_source(task_id, label=""):
    """查询一个源训练的节点和连线，返回分析结果。"""
    steps = query_script_steps(task_id)
    flows = query_script_step_flows(task_id)

    biz_nodes = [s for s in steps if is_business(s)]
    start_nodes = [s for s in steps if is_start(s)]
    end_nodes = [s for s in steps if is_end(s)]

    start_id = start_nodes[0]["stepId"] if start_nodes else None
    end_id = end_nodes[0]["stepId"] if end_nodes else None

    # 找首节点（START 连向谁）
    first_ids = []
    for fl in flows:
        if fl.get("scriptStepStartId") == start_id:
            first_ids.append(fl["scriptStepEndId"])

    # 找末节点（谁连向 END）
    last_ids = []
    for fl in flows:
        if fl.get("scriptStepEndId") == end_id:
            last_ids.append(fl["scriptStepStartId"])

    # 组内连线（不含 START/END 相关的）
    biz_ids = {n["stepId"] for n in biz_nodes}
    internal_flows = [
        fl for fl in flows
        if fl.get("scriptStepStartId") in biz_ids
        and fl.get("scriptStepEndId") in biz_ids
    ]

    # START→首节点 的连线（用于继承条件）
    start_flows = [
        fl for fl in flows
        if fl.get("scriptStepStartId") == start_id
        and fl.get("scriptStepEndId") in biz_ids
    ]

    # 末节点→END 的连线（用于继承条件）
    end_flows = [
        fl for fl in flows
        if fl.get("scriptStepEndId") == end_id
        and fl.get("scriptStepStartId") in biz_ids
    ]

    max_level = detect_max_level(biz_nodes)

    info = {
        "task_id": task_id,
        "label": label,
        "nodes": biz_nodes,
        "internal_flows": internal_flows,
        "start_flows": start_flows,
        "end_flows": end_flows,
        "first_ids": first_ids,
        "last_ids": last_ids,
        "max_level": max_level,
        "node_count": len(biz_nodes),
        "flow_count": len(internal_flows),
    }
    return info


def build_renumber_map(sources):
    """构建关卡续编号映射表。
    
    例如:
      Source A: 关卡一~三 (1-3)
      Source B: 关卡一~二 (1-2) → 重编为 4-5
      Source C: 关卡一 (1) → 重编为 6
    
    返回每个 source 的 rmap: {old_level: new_level}
    """
    rmaps = []
    next_level = 1
    for src in sources:
        max_lv = src["max_level"]
        if max_lv == 0:
            rmaps.append({})
            continue
        rmap = {}
        for old in range(1, max_lv + 1):
            rmap[old] = next_level
            next_level += 1
        rmaps.append(rmap)
    return rmaps


# ── Dry-run ──────────────────────────────────────────


def print_dry_run(sources, rmaps, mode):
    print("\n" + "=" * 72)
    print(f"📋 合并模式: {mode}")
    print(f"📦 源训练数量: {len(sources)}")
    total_nodes = 0
    total_flows = 0
    for i, (src, rmap) in enumerate(zip(sources, rmaps)):
        print(f"\n── 源训练 {i+1}（{src['label'] or src['task_id']}）──")
        print(f"   业务节点: {src['node_count']} 个")
        print(f"   组内连线: {src['flow_count']} 条")
        print(f"   首节点: {len(src['first_ids'])} 个")
        print(f"   末节点: {len(src['last_ids'])} 个")
        print(f"   最大关卡号: {src['max_level']}")
        if rmap:
            print(f"   关卡重编号: {rmap}")
        print(f"   节点列表:")
        for n in src["nodes"]:
            d = detail_of(n)
            old = d.get("stepName", "")
            new = renumber_name(old, rmap)
            files = [
                r.get("fileName")
                for r in (d.get("scriptStepResourceList") or [])
                if r.get("fileId")
            ]
            rnm = f" → {new}" if new != old else ""
            print(f"     · {old[:40]}{rnm}  | 附件: {files}")
        total_nodes += src["node_count"]
        total_flows += src["flow_count"]

    # 额外节点和连线
    extra_nodes = 0
    extra_flows = 1  # START → 首节点
    if mode == "branch" and len(sources) > 1:
        extra_nodes = len(sources) - 1  # 分支节点
        extra_flows += len(sources) - 1  # 末节点 → 分支节点
        extra_flows += len(sources) - 1  # 分支节点 → 各源首节点
    elif mode == "sequential" and len(sources) > 1:
        extra_flows += len(sources) - 1  # 末节点 → 下一源首节点
    extra_flows += len(sources[-1]["last_ids"])  # 末源末节点 → END

    print(f"\n📊 汇总:")
    print(f"   源节点总数: {total_nodes}")
    print(f"   额外节点(分支): {extra_nodes}")
    print(f"   总节点(含START/END): {total_nodes + extra_nodes + 2}")
    print(f"   组内连线: {total_flows}")
    print(f"   跨源+边界连线: {extra_flows}")
    print(f"   总连线: {total_flows + extra_flows}")


# ── 合并导入 ──────────────────────────────────────


def import_merge(target_id, course_id, sources, rmaps, mode):
    """将多个源训练合并注入到目标任务。"""
    print(f"\n🚀 合并导入 → 任务 {target_id}（模式: {mode}）")

    clean_task(target_id)
    start_id, end_id = create_start_end_nodes(target_id, course_id)
    print(f"   ✅ START={start_id}  END={end_id}")

    # 全局 ID 映射: 源 stepId → 新 stepId
    global_id_map = {}
    # 每个源的新首节点和末节点 ID 列表
    source_first_ids = []  # [[id1, ...], [id2, ...], ...]
    source_last_ids = []

    x_base, y_base, x_gap = 200, 300, 400
    x_cursor = x_base

    # ── 创建所有源训练的节点 ──
    for si, (src, rmap) in enumerate(zip(sources, rmaps)):
        src_first = []
        src_last = []
        src_id_map = {}

        for n in src["nodes"]:
            new_id = generate(size=21)
            src_id_map[n["stepId"]] = new_id
            global_id_map[(si, n["stepId"])] = new_id

        for n in src["nodes"]:
            src_detail = detail_of(n)
            new_id = src_id_map[n["stepId"]]
            if not create_script_node_min(target_id, course_id, new_id, src_detail, rmap):
                raise RuntimeError(f"创建节点失败: {src_detail.get('stepName')}")
            full_detail = build_clone_detail(src_detail, new_id, target_id, rmap)
            ok = edit_script_step({
                "trainTaskId": target_id,
                "stepId": new_id,
                "stepDetailDTO": full_detail,
                "positionDTO": {"x": x_cursor, "y": y_base},
                "courseId": course_id,
            })
            if not ok:
                raise RuntimeError(f"补全节点失败: {full_detail.get('stepName')}")
            print(f"   ✅ [{src['label'] or f'源{si+1}'}] {renumber_name(src_detail.get('stepName',''), rmap)[:40]}")
            x_cursor += x_gap

        # 映射首/末节点
        for fid in src["first_ids"]:
            src_first.append(src_id_map[fid])
        for lid in src["last_ids"]:
            src_last.append(src_id_map[lid])

        source_first_ids.append(src_first)
        source_last_ids.append(src_last)

    # ── 创建组内连线 ──
    flow_count = 0
    for si, (src, rmap) in enumerate(zip(sources, rmaps)):
        for fl in src["internal_flows"]:
            s_id = global_id_map[(si, fl["scriptStepStartId"])]
            e_id = global_id_map[(si, fl["scriptStepEndId"])]
            if create_script_flow(target_id, src_flow=fl, start_id=s_id, end_id=e_id):
                flow_count += 1

    print(f"   ✅ 组内连线: {flow_count} 条")

    # ── 创建跨源连线 ──
    if mode == "sequential":
        # START → 第一个源的首节点
        for fid in source_first_ids[0]:
            create_script_flow(
                target_id, start_id=start_id, end_id=fid,
                cond="", is_default=0, transition="",
                flow_config=copy.deepcopy(EMPTY_FLOW_CFG), hist_num=0,
            )
            flow_count += 1

        # 源N末节点 → 源N+1首节点
        for si in range(len(sources) - 1):
            for lid in source_last_ids[si]:
                for fid in source_first_ids[si + 1]:
                    # 继承源N末节点→END的连线条件（如果有）
                    src_end_flow = src["end_flows"][0] if src["end_flows"] else None
                    create_script_flow(
                        target_id,
                        src_flow=src_end_flow,
                        start_id=lid,
                        end_id=fid,
                        cond=src_end_flow.get("flowCondition", "") if src_end_flow else "",
                    )
                    flow_count += 1

        # 最后一个源的末节点 → END
        for lid in source_last_ids[-1]:
            src = sources[-1]
            src_end_flow = src["end_flows"][0] if src["end_flows"] else None
            create_script_flow(
                target_id,
                src_flow=src_end_flow,
                start_id=lid,
                end_id=end_id,
            )
            flow_count += 1

    elif mode == "branch":
        # START → 第一个源的首节点
        for fid in source_first_ids[0]:
            create_script_flow(
                target_id, start_id=start_id, end_id=fid,
                cond="", is_default=0, transition="",
                flow_config=copy.deepcopy(EMPTY_FLOW_CFG), hist_num=0,
            )
            flow_count += 1

        # 在第一个源和后续源之间创建分支节点
        branch_ids = []
        for bi in range(len(sources) - 1):
            branch_id = generate(size=21)
            branch_detail = copy.deepcopy(BRANCH_NODE_TEMPLATE)
            # 自动命名分支节点
            next_labels = [sources[bi + 1 + j]["label"] or f"训练{bi + 2 + j}" for j in range(len(sources) - 1 - bi)]
            branch_detail["stepName"] = f"选择{'或'.join(next_labels)}"
            branch_detail["description"] = f"请选择接下来进行的训练：{'、'.join(next_labels)}"

            # 创建分支节点
            ok = create_script_node_min(target_id, course_id, branch_id, branch_detail, {})
            if not ok:
                raise RuntimeError("创建分支节点失败")
            full_detail = build_clone_detail(branch_detail, branch_id, target_id, {})
            ok = edit_script_step({
                "trainTaskId": target_id,
                "stepId": branch_id,
                "stepDetailDTO": full_detail,
                "positionDTO": {"x": x_cursor, "y": y_base},
                "courseId": course_id,
            })
            if not ok:
                raise RuntimeError("补全分支节点失败")
            print(f"   ✅ [分支节点] {branch_detail['stepName']}")
            x_cursor += x_gap
            branch_ids.append(branch_id)

        # 第一个源的末节点 → 分支节点
        for lid in source_last_ids[0]:
            create_script_flow(
                target_id, start_id=lid, end_id=branch_ids[0],
                cond="", is_default=1,
            )
            flow_count += 1

        # 分支节点 → 各后续源的首节点（带条件）
        for bi, branch_id in enumerate(branch_ids):
            next_source_idx = bi + 1
            if next_source_idx < len(sources):
                src = sources[next_source_idx]
                label = src["label"] or f"训练{next_source_idx + 1}"
                for fid in source_first_ids[next_source_idx]:
                    create_script_flow(
                        target_id,
                        start_id=branch_id,
                        end_id=fid,
                        cond=f"NEXT_TO_{label}",
                        is_default=0,
                    )
                    flow_count += 1

        # 后续源的末节点 → END
        for si in range(1, len(sources)):
            src = sources[si]
            for lid in source_last_ids[si]:
                src_end_flow = src["end_flows"][0] if src["end_flows"] else None
                create_script_flow(
                    target_id,
                    src_flow=src_end_flow,
                    start_id=lid,
                    end_id=end_id,
                )
                flow_count += 1

    print(f"   ✅ 跨源+边界连线: {flow_count - len([f for s in sources for f in s['internal_flows']])} 条")
    print(f"   ✅ 总连线: {flow_count} 条")

    # ── 回采验证 ──
    live_steps = query_script_steps(target_id)
    live_flows = query_script_step_flows(target_id)
    biz = [s for s in live_steps if is_business(s)]

    def file_count(node):
        return sum(
            1
            for r in (detail_of(node).get("scriptStepResourceList") or [])
            if r.get("fileId")
        )

    src_files = sum(sum(file_count(n) for n in s["nodes"]) for s in sources)
    live_files = sum(file_count(n) for n in biz)
    expected_nodes = sum(s["node_count"] for s in sources)
    if mode == "branch":
        expected_nodes += len(sources) - 1

    ok = (
        len(biz) == expected_nodes
        and live_files == src_files
    )
    print(
        f"   🔎 回采：节点 {len(biz)}/{expected_nodes}，"
        f"连线 {len(live_flows)}/{flow_count}，"
        f"附件 {live_files}/{src_files} {'✅' if ok else '❌'}"
    )
    return ok


# ── CLI ──────────────────────────────────────────────


def parse_args():
    p = argparse.ArgumentParser(
        description="能力训练合并注入器 — 将多个能力训练合并为一个",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "--course-id",
        required=True,
        help="目标 courseId",
    )
    p.add_argument("--dry-run", action="store_true", help="仅打印合并计划，不调接口")
    p.add_argument("--import", dest="do_import", action="store_true", help="正式导入")
    p.add_argument(
        "--mode",
        choices=["sequential", "branch"],
        default="sequential",
        help="合并模式: sequential=串联, branch=分支（默认 sequential）",
    )
    p.add_argument("--target", metavar="TASK_ID", required=True, help="目标任务 ID")
    p.add_argument("--renumber", action="store_true", help="关卡自动续编号")
    for i in range(1, 11):
        p.add_argument(
            f"--source{i}",
            metavar="TASK_ID",
            help=f"源训练 {i} 的任务 ID",
        )
    return p.parse_args()


def main():
    args = parse_args()
    load_env_config()

    # 收集源训练
    source_ids = []
    for i in range(1, 11):
        tid = getattr(args, f"source{i}", None)
        if tid:
            source_ids.append((i, tid))

    if not source_ids:
        print("❌ 未提供任何源训练 ID。使用 --source1 ~ --sourceN 指定。")
        return

    if len(source_ids) < 2:
        print("❌ 合并至少需要 2 个源训练。")
        return

    print(f"📖 合并模式: {args.mode}")
    print(f"📦 源训练数量: {len(source_ids)}")
    print(f"🎯 目标任务: {args.target}")

    # 查询每个源训练
    sources = []
    for idx, tid in source_ids:
        print(f"\n🔎 查询源训练 {idx}（{tid}）...")
        src = analyze_source(tid, label=f"源训练{idx}")
        print(f"   节点: {src['node_count']}，连线: {src['flow_count']}，关卡数: {src['max_level']}")
        sources.append(src)

    # 构建重编号映射
    if args.renumber:
        rmaps = build_renumber_map(sources)
    else:
        rmaps = [{}] * len(sources)

    # ── dry-run ──
    if args.dry_run:
        print_dry_run(sources, rmaps, args.mode)
        print("\n🧪 Dry-run 完成，未调用任何接口。")
        return

    # ── import ──
    if args.do_import:
        try:
            ok = import_merge(args.target, args.course_id, sources, rmaps, args.mode)
            if ok:
                print(f"\n✅ 合并导入成功！")
            else:
                print(f"\n⚠️ 合并导入完成，但回采验证有差异，请检查。")
        except Exception as e:
            print(f"\n❌ 合并导入失败: {e}")
            import traceback
            traceback.print_exc()
        return

    print("未指定动作。使用 --dry-run 查看合并计划，或 --import 正式导入。")


if __name__ == "__main__":
    main()
