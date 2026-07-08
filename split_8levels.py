#!/usr/bin/env python3
"""将 8 关卡能力训练拆分为 8 个独立能力训练（完全独立脚本，无外部依赖）。

用法：
  # 1) 干跑，核对拆分计划
  python split_8levels.py --dry-run

  # 2) 正式导入（每个关卡对应一个已建好的空任务 ID）
  python split_8levels.py --import \\
      --level1 <TASK_ID> --level2 <TASK_ID> --level3 <TASK_ID> \\
      --level4 <TASK_ID> --level5 <TASK_ID> --level6 <TASK_ID> \\
      --level7 <TASK_ID> --level8 <TASK_ID>

  # 也可以只导入部分关卡
  python split_8levels.py --import --level1 <TASK_ID> --level5 <TASK_ID>

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
SOURCE_COURSE_ID = "VPDz2K1XLYu5N2p8ODjZ"

CN = {1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "七", 8: "八"}
CN2NUM = {v: k for k, v in CN.items()}

EMPTY_FLOW_CFG = {
    "relation": "and",
    "conditions": [
        {"text": "条件组1", "relation": "and", "conditions": [{"text": ""}]}
    ],
}

# 8 个关卡的元信息
LEVEL_META = {
    1: {"label": "关卡一·封装与数据保护", "header_prefix": "关卡一："},
    2: {"label": "关卡二·构造与析构", "header_prefix": "关卡二："},
    3: {"label": "关卡三·对象成员与组合", "header_prefix": "关卡三："},
    4: {"label": "关卡四·继承与派生", "header_prefix": "关卡四："},
    5: {"label": "关卡五·多态与虚函数", "header_prefix": "关卡五："},
    6: {"label": "关卡六·静态成员", "header_prefix": "关卡六："},
    7: {"label": "关卡七·模板与泛型", "header_prefix": "关卡七："},
    8: {"label": "关卡八·文件输入输出", "header_prefix": "关卡八："},
}


# ── 环境 & HTTP ──────────────────────────────────────


def load_env_config():
    """加载 .env 配置（向上查找 3 级目录）。"""
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
    """统一 POST 请求，返回 (success: bool, response_json)。"""
    url = f"{BASE_URL}/{action}"
    resp = requests.post(url, headers=get_headers(), json=payload, timeout=timeout)
    j = resp.json()
    ok = j.get("code") == 200 or j.get("success") is True
    return ok, j


# ── 节点分类工具 ──────────────────────────────────────


def detail_of(node):
    return node.get("stepDetailDTO", {})


def is_business(node):
    return detail_of(node).get("nodeType") == "SCRIPT_NODE"


def module_of(step_name):
    """从节点名解析所属关卡号（1-8），非关卡节点返回 None。"""
    m = re.match(r"关卡([1-8])\.", step_name)
    if m:
        return int(m.group(1))
    m = re.match(r"关卡([一二三四五六七八])[：:]", step_name)
    if m:
        return CN2NUM[m.group(1)]
    return None


def renumber_name(step_name, rmap):
    """按重编号映射表替换节点名中的关卡编号。"""
    m = re.match(r"(关卡)([1-8])(\..*)", step_name, re.S)
    if m:
        new = rmap.get(int(m.group(2)), int(m.group(2)))
        return f"关卡{new}{m.group(3)}"
    m = re.match(r"(关卡)([一二三四五六七八])([：:].*)", step_name, re.S)
    if m:
        old = CN2NUM[m.group(2)]
        new = rmap.get(old, old)
        return f"关卡{CN[new]}{m.group(3)}"
    return step_name


def is_header_name(step_name):
    return bool(re.match(r"关卡[一二三四五六七八][：:]", step_name))


# ── 源数据加载 ──────────────────────────────────────


def load_source(source_dir):
    sd = Path(source_dir)
    nodes = json.loads(
        (sd / "queryscriptsteplist.json").read_text(encoding="utf-8")
    )["data"]
    flows = json.loads(
        (sd / "queryscriptstepflowlist.json").read_text(encoding="utf-8")
    )["data"]
    return nodes, flows


# ── 资源转换 ──────────────────────────────────────────


def convert_resources(srl, new_task_id, new_step_id):
    """把读接口的 scriptStepResourceList 转成写接口的 stepExtProperty.resources。"""
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
    """从源 stepDetailDTO 构造 editScriptStep 所需的全量 detail。"""
    d = copy.deepcopy(src_detail)
    old_name = d.get("stepName", "")
    d["stepName"] = renumber_name(old_name, rmap)

    # header 节点：重编号开场白中的关卡编号
    if is_header_name(old_name):
        old_mod = module_of(old_name)
        new_mod = rmap.get(old_mod, old_mod)
        if old_mod != new_mod:
            d["prologue"] = (d.get("prologue", "") or "").replace(
                f"关卡{CN[old_mod]}", f"关卡{CN[new_mod]}"
            )

    # 资源：重映射 task/step，清掉 scriptStepResourceId 让平台分配
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

    # 对齐 editScriptStep 载荷
    if (d.get("scriptStepCover") or {}).get("fileUrl"):
        d.setdefault("scriptBackgroundType", "image")
    d.setdefault("contentSkip", 0)
    d.pop("createTime", None)
    d.pop("updateTime", None)
    return d


# ── API 封装 ──────────────────────────────────────────


def create_start_end_nodes(task_id, course_id):
    """创建 SCRIPT_START 和 SCRIPT_END 节点，返回 (start_id, end_id)。"""
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
    """最小化创建 SCRIPT_NODE，后续由 editScriptStep 补全。"""
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
    """全量编辑节点（补全 detail、资源、封面等）。"""
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
    """创建一条连线，可从源 flow 继承字段，也可逐项覆盖。"""
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


def query_script_steps(task_id):
    ok, j = api_post(
        "queryScriptStepList", {"trainTaskId": task_id, "trainSubType": "ability"}
    )
    return j.get("data", []) if ok else []


def query_script_step_flows(task_id):
    ok, j = api_post("queryScriptStepFlowList", {"trainTaskId": task_id})
    return j.get("data", []) if ok else []


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
    """清空目标任务中的全部连线和节点。"""
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


# ── 分组逻辑 ──────────────────────────────────────────


def group_nodes_by_level(nodes):
    """将所有业务节点按 8 个关卡分组。

    分组规则：
      - 关卡 1: header「关卡一：」+ 1.1-1.5
      - 关卡 2: 分支入口「选择关卡二或关卡三」+ header「关卡二：」+ 2.1-2.5
      - 关卡 3: 分支「是否挑战过关卡三」「是否挑战过关卡二」
                + header「关卡三：」+ 3.1-3.5
      - 关卡 4-8: header + sub-nodes（无分支节点）
    """
    # 分支节点名称（不放入任何关卡，直接丢弃）
    SKIP_NAMES = {
        "选择关卡二或关卡三",
        "是否挑战过关卡三",
        "是否挑战过关卡二",
    }

    groups = {i: {"header": None, "subs": []} for i in range(1, 9)}

    for node in nodes:
        if not is_business(node):
            continue
        name = detail_of(node).get("stepName", "")

        # 跳过分支节点
        if name in SKIP_NAMES:
            continue

        # 关卡 header
        if is_header_name(name):
            level = module_of(name)
            if level:
                groups[level]["header"] = node
            continue

        # 子关卡节点（关卡X.Y）
        level = module_of(name)
        if level:
            groups[level]["subs"].append(node)

    # 组装：header → subs
    result = {}
    for level in range(1, 9):
        g = groups[level]
        if g["header"] is None:
            print(f"⚠️ 关卡{CN[level]} 未找到 header 节点")
            continue
        ordered = [g["header"]] + g["subs"]
        result[level] = ordered
    return result


def classify_flows(flows, sel_ids):
    """将连线分为组内和边界出边。"""
    internal, boundary_out = [], []
    for fl in flows:
        s = fl.get("scriptStepStartId")
        e = fl.get("scriptStepEndId")
        if s in sel_ids and e in sel_ids:
            internal.append(fl)
        elif s in sel_ids and e not in sel_ids:
            boundary_out.append(fl)
    return internal, boundary_out


# ── dry-run ──────────────────────────────────────────


def print_dry_run(level, sel_nodes, internal, boundary_out, nodes_by_id, rmap):
    meta = LEVEL_META[level]
    print("\n" + "=" * 72)
    print(
        f"📦 关卡{CN[level]}（{meta['label']}）：业务节点 {len(sel_nodes)} 个（另加 START/END）"
    )
    print("\n   节点(原名 → 新名 | 附件):")
    for n in sel_nodes:
        d = detail_of(n)
        old = d.get("stepName", "")
        files = [
            r.get("fileName")
            for r in (d.get("scriptStepResourceList") or [])
            if r.get("fileId")
        ]
        print(
            f"     · {old[:40]:42} → {renumber_name(old, rmap)[:40]:42} | {files}"
        )
    print(f"\n   组内连线: {len(internal)} 条")
    print(f"   边界出边(改指向 END): {len(boundary_out)} 条")
    for fl in boundary_out:
        sn = detail_of(nodes_by_id[fl["scriptStepStartId"]]).get("stepName", "")[:30]
        print(f"     · {sn} --[{fl.get('flowCondition','')[:20]}]--> END")


# ── 导入单个关卡 ──────────────────────────────────────


def import_level(level, task_id, course_id, sel_nodes, internal, boundary_out, rmap):
    """将一个关卡的节点和连线导入目标任务。"""
    meta = LEVEL_META[level]
    print(f"\n🚀 导入 关卡{CN[level]}（{meta['label']}） → 任务 {task_id}")

    clean_task(task_id)
    start_id, end_id = create_start_end_nodes(task_id, course_id)
    print(f"   ✅ START={start_id}  END={end_id}")

    # 为每个业务节点生成新 ID
    id_map = {n["stepId"]: generate(size=21) for n in sel_nodes}

    # 线性布局
    x_base, y_base, x_gap = 200, 300, 400

    # 创建节点：最小创建 + 全量 edit
    for idx, n in enumerate(sel_nodes):
        src_detail = detail_of(n)
        new_id = id_map[n["stepId"]]
        if not create_script_node_min(task_id, course_id, new_id, src_detail, rmap):
            raise RuntimeError(f"创建节点失败: {src_detail.get('stepName')}")
        full_detail = build_clone_detail(src_detail, new_id, task_id, rmap)
        ok = edit_script_step(
            {
                "trainTaskId": task_id,
                "stepId": new_id,
                "stepDetailDTO": full_detail,
                "positionDTO": {"x": x_base + idx * x_gap, "y": y_base},
                "courseId": course_id,
            }
        )
        if not ok:
            raise RuntimeError(f"补全节点失败: {full_detail.get('stepName')}")
        print(f"   ✅ {renumber_name(src_detail.get('stepName',''), rmap)[:40]}")

    # 确定首节点（START 指向谁）
    first_id = id_map[sel_nodes[0]["stepId"]]

    # 连线：START -> 首节点
    create_script_flow(
        task_id,
        start_id=start_id,
        end_id=first_id,
        cond="",
        is_default=0,
        transition="",
        flow_config=copy.deepcopy(EMPTY_FLOW_CFG),
        hist_num=0,
    )

    # 组内连线
    for fl in internal:
        create_script_flow(
            task_id,
            src_flow=fl,
            start_id=id_map[fl["scriptStepStartId"]],
            end_id=id_map[fl["scriptStepEndId"]],
        )

    # 边界出边 -> END
    for fl in boundary_out:
        create_script_flow(
            task_id,
            src_flow=fl,
            start_id=id_map[fl["scriptStepStartId"]],
            end_id=end_id,
        )

    total_flows = 1 + len(internal) + len(boundary_out)
    print(
        f"   ✅ 连线完成：START 1 + 组内 {len(internal)} + 边界→END {len(boundary_out)} = {total_flows} 条"
    )

    # 回采验证
    live_steps = query_script_steps(task_id)
    live_flows = query_script_step_flows(task_id)
    biz = [s for s in live_steps if is_business(s)]

    def file_count(node):
        return sum(
            1
            for r in (detail_of(node).get("scriptStepResourceList") or [])
            if r.get("fileId")
        )

    src_files = sum(file_count(n) for n in sel_nodes)
    live_files = sum(file_count(n) for n in biz)
    ok = (
        len(biz) == len(sel_nodes)
        and len(live_flows) == total_flows
        and live_files == src_files
    )
    print(
        f"   🔎 回采：节点 {len(biz)}/{len(sel_nodes)}，"
        f"连线 {len(live_flows)}/{total_flows}，"
        f"附件 {live_files}/{src_files} {'✅' if ok else '❌'}"
    )
    return ok


# ── CLI ──────────────────────────────────────────────


def parse_args():
    p = argparse.ArgumentParser(
        description="将 8 关卡能力训练拆分为 8 个独立能力训练",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "--source-dir",
        default=str(Path(__file__).parent),
        help="源 JSON 文件目录（默认脚本所在目录）",
    )
    p.add_argument(
        "--course-id",
        default=SOURCE_COURSE_ID,
        help=f"目标 courseId（默认 {SOURCE_COURSE_ID}）",
    )
    p.add_argument("--dry-run", action="store_true", help="仅打印拆分计划，不调接口")
    p.add_argument("--import", dest="do_import", action="store_true", help="正式导入")
    for i in range(1, 9):
        p.add_argument(
            f"--level{i}",
            metavar="TASK_ID",
            help=f"关卡{CN[i]}（{LEVEL_META[i]['label']}）目标任务 ID",
        )
    return p.parse_args()


def main():
    args = parse_args()
    load_env_config()

    nodes, flows = load_source(args.source_dir)
    nodes_by_id = {n["stepId"]: n for n in nodes}
    groups = group_nodes_by_level(nodes)

    print(f"📖 源数据：节点 {len(nodes)}，连线 {len(flows)}")
    for level in range(1, 9):
        if level in groups:
            print(f"   关卡{CN[level]}: {len(groups[level])} 个业务节点")

    # ── dry-run ──
    if args.dry_run:
        for level in range(1, 9):
            if level not in groups:
                continue
            sel = groups[level]
            sel_ids = {n["stepId"] for n in sel}
            internal, boundary_out = classify_flows(flows, sel_ids)
            rmap = {}  # 不重编号，保持原始关卡号
            print_dry_run(level, sel, internal, boundary_out, nodes_by_id, rmap)
        print("\n🧪 Dry-run 完成，未调用任何接口。")
        return

    # ── import ──
    if args.do_import:
        task_ids = {}
        for i in range(1, 9):
            tid = getattr(args, f"level{i}", None)
            if tid:
                task_ids[i] = tid

        if not task_ids:
            print("❌ 未提供任何目标任务 ID。使用 --level1 ~ --level8 指定。")
            return

        results = {}
        for level, tid in task_ids.items():
            if level not in groups:
                print(f"⚠️ 关卡{CN[level]} 在源数据中未找到，跳过")
                continue
            sel = groups[level]
            sel_ids = {n["stepId"] for n in sel}
            internal, boundary_out = classify_flows(flows, sel_ids)
            rmap = {}  # 不重编号，保持原始关卡号
            try:
                ok = import_level(
                    level, tid, args.course_id, sel, internal, boundary_out, rmap
                )
                results[level] = ok
            except Exception as e:
                print(f"   ❌ 导入失败: {e}")
                results[level] = False

        print("\n" + "=" * 72)
        print("📊 导入汇总：")
        for level, ok in results.items():
            status = "✅" if ok else "❌"
            print(f"   {status} 关卡{CN[level]}（{LEVEL_META[level]['label']}）")
        all_ok = all(results.values())
        print(
            f"\n{'✅ 全部导入成功！' if all_ok else '⚠️ 部分关卡导入失败，请检查上方日志。'}"
        )
        return

    print("未指定动作。使用 --dry-run 查看拆分计划，或 --import 正式导入。")


if __name__ == "__main__":
    main()
