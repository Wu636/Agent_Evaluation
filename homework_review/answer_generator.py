"""
题卷答案生成器
解析 Word 题卷，调用 LLM 生成5个不同等级的学生答案，并生成 .docx 文件
"""

import json
import os
import re
import asyncio
from pathlib import Path
from typing import List, Dict, Tuple, Optional
from datetime import datetime

try:
    from docx import Document
    from docx.shared import Pt, RGBColor
    from docx.enum.text import WD_PARAGRAPH_ALIGNMENT, WD_BREAK
except ImportError:
    Document = None

import requests

# Import Cloud API functions
from homework_reviewer_v2 import upload_file, homework_file_analysis


def load_llm_config_from_args(context: dict) -> Tuple[str, str, str]:
    """从上下文加载 LLM 配置"""
    api_key = context.get("llm_api_key") or os.getenv("LLM_API_KEY", "")
    api_url = context.get("llm_api_url") or os.getenv("LLM_API_URL", "http://llm-service.polymas.com/api/openai/v1/chat/completions")
    model = context.get("llm_model") or os.getenv("LLM_MODEL", "gpt-4o")
    return api_key, api_url, model


def extract_questions_from_cloud(docx_path: Path, context: dict) -> Tuple[str, str]:
    """
    使用云端 API 解析题卷结构：
    1. upload_file  → 获取 fileUrl
    2. homework_file_analysis → 获取 textInput 结构
    """
    authorization = os.getenv("AUTHORIZATION", "")
    cookie_env = os.getenv("COOKIE", "")
    if not authorization or not cookie_env:
        print(f"📄 使用本地解析模式")
        return extract_questions_from_local(docx_path)

    auth_preview = authorization[:20] + "..." if len(authorization) > 20 else authorization
    print(f"☁️ 正在上传题卷到云端: {docx_path.name} (auth={auth_preview})")
    try:
        # Step 1: 上传文件获取 fileUrl
        file_info = upload_file(str(docx_path))
        if not file_info or not file_info.get("fileUrl"):
            raise ValueError("文件上传失败，未获取到 fileUrl。请检查 Authorization/Cookie 是否已过期")

        print(f"✅ 文件上传成功: {file_info.get('fileName')}")

        # Step 2: 调用 homework_file_analysis 解析题卷结构
        print(f"☁️ 正在解析题卷结构...")
        success, result, text_input = homework_file_analysis(file_info, context)

        if not success or not text_input:
            error_msg = ""
            if isinstance(result, dict):
                error_msg = result.get("error", "") or result.get("msg", "")
            raise ValueError(f"云端解析失败: {error_msg}")

        print(f"✅ 题卷结构解析完成")

        # text_input 是 JSON 字符串，解析为结构化内容给 LLM
        title = docx_path.stem  # 默认标题用文件名

        parsed = text_input
        if isinstance(text_input, str):
            try:
                parsed = json.loads(text_input)
            except json.JSONDecodeError:
                # 纯文本直接用
                return title, text_input

        # 如果是列表结构 [{ itemName, stuAnswerContent }, ...]
        # 格式化为可读文本
        if isinstance(parsed, list):
            full_text_lines = []
            for i, item in enumerate(parsed):
                item_name = item.get("itemName", "")
                content = item.get("stuAnswerContent", "")
                if item_name or content:
                    full_text_lines.append(f"【{item_name}】" if item_name else f"题目{i + 1}:")
                    if content:
                        full_text_lines.append(content)
                    full_text_lines.append("")
            return title, "\n".join(full_text_lines)

        if isinstance(parsed, dict):
            return title, json.dumps(parsed, ensure_ascii=False, indent=2)

        return title, str(parsed)

    except Exception as e:
        print(f"⚠️ 云端解析失败 ({e})，尝试本地解析...")
        return extract_questions_from_local(docx_path)


def extract_questions_from_local(docx_path: Path) -> Tuple[str, str]:
    """
    本地解析作为兜底
    """
    if Document is None:
        raise ImportError("请安装 python-docx: pip install python-docx")
    
    doc = Document(docx_path)
    
    title = ""
    for p in doc.paragraphs[:5]:
        if p.text.strip():
            title = p.text.strip()
            break
            
    full_text = []
    for p in doc.paragraphs:
        if p.text.strip():
            full_text.append(p.text.strip())
            
    return title, "\n".join(full_text)


def build_generation_prompt(title: str, exam_content: str, level: str, level_desc: str) -> str:
    """构建生成答案的 Prompt"""
    return f"""你是一名【{level}】水平的学生，正在作答《{title}》。
请根据你的水平要求完成所有题目。

【等级要求：{level}】
{level_desc}

【试卷内容】
{exam_content[:15000]}  # 限制长度防止超限

【输出格式要求】
请严格按照以下格式输出你的答案，不要包含任何多余的开场白或解释：

一、单项选择题（每题2分，共20分）
1.A 2.B 3.C ...

二、判断题（每题2分，共20分）
1.√ 2.× 3.√ ...

三、简答题（每题5分，共20分）
1. 简述...（题目）
（你的答案内容...）

四、论述题（每题10分，共20分）
1. 论述...（题目）
（你的答案内容...）

...（其他题型依次类推）

注意：
1. 必须包含题型标题（如"一、单项选择题"）
2. 选择题和判断题请尽量紧凑，每行多个
3. 主观题请写出完整的答案内容，不要只写要点
4. 答案的质量必须符合【{level}】的设定，如果是较差等级，可以故意包含一些错误或逻辑不清的内容。
"""


async def generate_answer_content(prompt: str, context: dict) -> Optional[str]:
    """调用 LLM 生成答案内容"""
    api_key, api_url, model = load_llm_config_from_args(context)
    
    if not api_key:
        print("❌ 未配置 LLM API Key，请在右上角 ⚙️ 设置中配置")
        print(f"   context keys: {list(context.keys())}")
        print(f"   env LLM_API_KEY set: {bool(os.getenv('LLM_API_KEY'))}")
        return None
    
    # 首次调用时打印配置（脱敏）
    key_preview = api_key[:8] + "..." + api_key[-4:] if len(api_key) > 12 else "***"
    print(f"🔧 LLM 配置: url={api_url}, model={model}, key={key_preview}")
        
    headers = {
        "api-key": api_key,
        "Content-Type": "application/json"
    }
    
    payload = {
        "maxTokens": 4096,
        "messages": [
            {
                "role": "system",
                "content": "你是一个模拟真实学生作答的AI助手。你会根据指定的能力等级，生成符合该水平的试卷答案。"
            },
            {
                "role": "user",
                "content": prompt
            }
        ],
        "model": model, 
        "temperature": 0.5,
    }
    
    try:
        # 使用 run_in_executor 进行异步调用
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None, 
            lambda: requests.post(api_url, headers=headers, json=payload, timeout=180)
        )
        
        if response.status_code != 200:
            body_preview = response.text[:500] if response.text else "(empty)"
            print(f"❌ LLM API 返回 {response.status_code}: {body_preview}")
            print(f"   请求 URL: {api_url}")
            print(f"   请求 Model: {model}")
            print(f"   API Key 前缀: {api_key[:10]}..." if len(api_key) > 10 else f"   API Key: (len={len(api_key)})")
            response.raise_for_status()
        
        result = response.json()
        
        if "choices" in result and len(result["choices"]) > 0:
            return result["choices"][0]["message"]["content"]
        print(f"⚠️ LLM 响应中没有 choices: {json.dumps(result, ensure_ascii=False)[:300]}")
        return None
    except requests.exceptions.HTTPError:
        # 已在上面打印详细信息
        return None
    except Exception as e:
        print(f"❌ LLM 生成失败: {type(e).__name__}: {e}")
        return None


def create_answer_docx(content: str, output_path: Path, title: str, level: str, level_desc: str):
    """将生成的文本写入 Word 文档，模仿标准格式"""
    doc = Document()
    
    # 1. 试卷标题
    p_title = doc.add_paragraph(f"{title}五等级学生答案")
    if p_title.runs: p_title.runs[0].bold = True
    
    # 2. 等级描述
    p_level = doc.add_paragraph(f"等级：{level}（{level_desc}）")
    if p_level.runs: p_level.runs[0].bold = True 
    
    # 3. 写入内容
    # 简单处理：按行写入，识别到题型标题加粗
    lines = content.split('\n')
    for line in lines:
        line = line.strip()
        if not line:
            continue
            
        p = doc.add_paragraph(line)
        
        # 识别题型标题加粗 (一、xxx)
        if re.match(r'^[一二三四五六七八九十]+[、\.]', line):
            if p.runs: p.runs[0].bold = True
            
    doc.save(output_path)


LEVEL_DEFINITIONS = {
    "优秀的回答": "满分90-100分，知识全面精准，逻辑清晰连贯，案例结合到位，合规细节无遗漏",
    "良好的回答": "满分80-89分，知识点覆盖较全，逻辑较清晰，有一定案例结合，偶有小瑕疵",
    "中等的回答": "满分70-79分，基本知识点掌握，逻辑一般，案例结合较少，表述平铺直叙",
    "合格的回答": "满分60-69分，核心知识点有遗漏，逻辑不够严密，表述存在模糊之处",
    "较差的回答": "满分60分以下，知识漏洞多，逻辑混乱，未结合案例，存在明显错误"
}

LEVEL_FILENAMES = {
    "优秀的回答": "等级一_优秀_学生答案",
    "良好的回答": "等级二_良好_学生答案",
    "中等的回答": "等级三_中等_学生答案",
    "合格的回答": "等级四_合格_学生答案",
    "较差的回答": "等级五_较差_学生答案"
}


async def generate_level_answers(
    exam_docx_path: Path,
    output_dir: Path,
    levels: List[str],  # e.g., ["优秀的回答", "较差的回答"]
    context: dict
) -> List[Path]:
    """
    生成指定等级的答案文件
    """
    print(f"📄 正在解析题卷: {exam_docx_path.name}")
    try:
        title, exam_content = extract_questions_from_cloud(exam_docx_path, context)
    except Exception as e:
        print(f"❌ 解析题卷失败: {e}")
        return []

    print(f"✅ 题卷解析完成，标题: {title}，目标生成 {len(levels)} 份答案")
    
    output_dir.mkdir(parents=True, exist_ok=True)
    generated_files = []
    
    # 并发生成
    tasks = []
    for level_key in levels:
        # 映射 level key 到描述
        # 前端传来的可能是 "优秀", "良好" 等简写，需要匹配
        full_key = next((k for k in LEVEL_DEFINITIONS if level_key in k), level_key)
        
        desc = LEVEL_DEFINITIONS.get(full_key, "无描述")
        file_suffix = LEVEL_FILENAMES.get(full_key, f"{level_key}_学生答案")
        
        clean_title = re.sub(r'[\\/:*?"<>|]', '_', title)
        filename = f"{clean_title}_{file_suffix}.docx"
        output_path = output_dir / filename
        
        tasks.append((full_key, desc, output_path))

    # 执行生成任务
    for level, desc, path in tasks:
        print(f"🤖 正在生成: {level}...")
        prompt = build_generation_prompt(title, exam_content, level, desc)
        content = await generate_answer_content(prompt, context)
        
        if content:
            create_answer_docx(content, path, title, level, desc)
            print(f"✅ 生成完毕: {path.name}")
            generated_files.append(path)
        else:
            print(f"❌ 生成失败: {level}")

    return generated_files
