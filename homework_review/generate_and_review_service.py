"""
答案生成服务（仅生成，不评测）
用于 Web/API 调用：上传题卷 → 生成多等级答案 → 返回生成文件列表
评测阶段由前端确认后另行触发标准批阅 API。
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

# Ensure we can import from local directory
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from answer_generator import generate_level_answers
from homework_reviewer_v2 import ensure_instance_context


def parse_args():
    parser = argparse.ArgumentParser(description="Answer Generation Service (generate-only)")
    parser.add_argument("--input", default="", help="Path to blank exam docx")
    parser.add_argument("--input-text-file", default="", help="Path to pasted exam text file")
    parser.add_argument("--input-title", default="", help="Optional title for pasted exam text")
    parser.add_argument("--output-root", required=True, help="Root for outputs")
    parser.add_argument("--levels", nargs="+",
                        default=["优秀的回答", "良好的回答", "中等的回答", "合格的回答", "较差的回答"],
                        help="Levels to generate")

    # LLM Config args
    parser.add_argument("--llm-api-key", default="", help="LLM API Key")
    parser.add_argument("--llm-api-url", default="", help="LLM API URL")
    parser.add_argument("--llm-model", default="", help="LLM Model")

    return parser.parse_args()


class StreamPrinter:
    """JSON 行协议输出，供前端 SSE 解析"""

    @staticmethod
    def log(message: str):
        print(json.dumps({"type": "log", "message": message}, ensure_ascii=False), flush=True)

    @staticmethod
    def error(message: str):
        print(json.dumps({"type": "error", "message": message}, ensure_ascii=False), flush=True)

    @staticmethod
    def progress(current: int, total: int, message: str = ""):
        print(json.dumps({"type": "progress", "current": current, "total": total, "message": message},
                         ensure_ascii=False), flush=True)


async def main():
    args = parse_args()
    printer = StreamPrinter()

    input_path = Path(args.input) if args.input else None
    input_text_file = Path(args.input_text_file) if args.input_text_file else None
    output_root = Path(args.output_root)

    if input_path is None and input_text_file is None:
        printer.error("必须提供题卷文件或题卷文字内容")
        return
    if input_path is not None and not input_path.exists():
        printer.error(f"输入文件不存在: {input_path}")
        return
    if input_text_file is not None and not input_text_file.exists():
        printer.error(f"题卷文字文件不存在: {input_text_file}")
        return
    is_text_mode = input_path is None and input_text_file is not None

    # ── 构建 context（认证信息可选）──
    # 环境变量由 API route 的 childEnv 注入
    authorization = os.getenv("AUTHORIZATION", "")
    cookie_val = os.getenv("COOKIE", "")
    instance_nid = os.getenv("INSTANCE_NID", "")

    context = {}

    if is_text_mode:
        printer.log("📝 使用粘贴文字模式，跳过题卷文件解析")
    elif authorization and cookie_val and instance_nid:
        # 有认证信息 → 获取实例详情（支持云端解析）
        printer.log("🔑 正在获取实例信息...")
        context = ensure_instance_context() or {}
        if not context:
            printer.log("⚠️ 无法获取实例信息，将使用本地解析")
    else:
        printer.log("ℹ️ 未提供智慧树认证信息，将使用本地解析模式")

    # 注入 LLM 配置（优先 args，fallback 环境变量）
    llm_key = args.llm_api_key or os.getenv("LLM_API_KEY", "")
    llm_url = args.llm_api_url or os.getenv("LLM_API_URL", "")
    llm_model = args.llm_model or os.getenv("LLM_MODEL", "")
    if llm_key:
        context["llm_api_key"] = llm_key
    if llm_url:
        context["llm_api_url"] = llm_url
    if llm_model:
        context["llm_model"] = llm_model
    # 自定义 Prompt（前端传入，通过环境变量传递）
    custom_prompt = os.getenv("CUSTOM_PROMPT", "").strip()
    if custom_prompt:
        context["custom_prompt"] = custom_prompt
        printer.log("📝 使用用户自定义 Prompt 模板")

    custom_levels = os.getenv("CUSTOM_LEVELS", "").strip()
    if custom_levels:
        context["custom_levels"] = custom_levels
        printer.log("📝 使用用户自定义等级描述")
    printer.log(f"🔧 LLM Key: {'已配置 (' + llm_key[:6] + '...)' if llm_key else '❌ 未配置'}")
    printer.log(f"🔧 LLM URL: {llm_url or '(默认)'}")
    printer.log(f"🔧 LLM Model: {llm_model or '(默认)'}")

    # ── 生成阶段 ──
    printer.log(f"🚀 开始生成学生答案 (共 {len(args.levels)} 份)")

    gen_output_dir = output_root / "generated_answers"

    try:
        source_text = input_text_file.read_text(encoding="utf-8") if is_text_mode and input_text_file is not None else ""
        generated_files = await generate_level_answers(
            exam_docx_path=input_path,
            output_dir=gen_output_dir,
            levels=args.levels,
            context=context,
            custom_prompt=context.get("custom_prompt", ""),
            custom_levels_json=context.get("custom_levels", ""),
            source_text=source_text,
            source_title=args.input_title.strip(),
        )
    except Exception as e:
        printer.error(f"生成阶段发生错误: {e}")
        return

    if not generated_files:
        printer.error("未能生成任何答案文件，请检查 LLM 配置。")
        return

    printer.log(f"✅ 全部生成完成，共 {len(generated_files)} 份答案")

    # ── 输出结果 ──
    saved_files = []
    for p in generated_files:
        saved_files.append({
            "name": p.name,
            "path": str(p),
            "relative": str(p.relative_to(output_root)),
        })

    final = {
        "type": "generate_complete",
        "outputRoot": str(output_root),
        "files": saved_files,
    }
    print(json.dumps(final, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(main())
