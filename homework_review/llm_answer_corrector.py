"""
LLM 答案校验模块
用于校验和补充云端 OCR 解析中空白或错误的答案
"""

import json
import os
import re
from pathlib import Path
from typing import List, Dict, Tuple, Optional

import requests
from dotenv import load_dotenv

try:
    from docx import Document
except ImportError:
    Document = None


def load_llm_config() -> Tuple[str, str]:
    """加载 LLM API 配置"""
    load_dotenv()
    api_key = os.getenv("LLM_API_KEY", "")
    api_url = os.getenv("LLM_API_URL", "http://llm-service.polymas.com/api/openai/v1/chat/completions")
    return api_key, api_url


def extract_text_from_docx(docx_path: Path) -> str:
    """从 Word 文档提取纯文本"""
    if Document is None:
        raise ImportError("请安装 python-docx: pip install python-docx")
    
    doc = Document(docx_path)
    paragraphs = [p.text.strip() for p in doc.paragraphs if p.text.strip()]
    return "\n".join(paragraphs)


def find_answer_issues(items: List[Dict]) -> List[Dict]:
    """
    检测答案中的问题
    返回需要补充的题目列表
    """
    issues = []
    
    for i, item in enumerate(items):
        item_name = item.get("itemName", "")
        answer = item.get("stuAnswerContent", "")
        
        # 检测空白答案
        if not answer or answer.strip() == "":
            issues.append({
                "index": i,
                "itemName": item_name,
                "issue": "答案为空",
                "current": answer
            })
            continue
        
        # 检测选择题答案格式问题
        if "选择题" in item_name:
            # 选择题答案应该是 A/B/C/D
            if not re.match(r'^[A-Da-d]$', answer.strip()):
                issues.append({
                    "index": i,
                    "itemName": item_name,
                    "issue": "选择题答案格式异常",
                    "current": answer[:50] if len(answer) > 50 else answer
                })
        
        # 检测判断题答案格式问题
        elif "判断题" in item_name:
            # 判断题答案应该是 √/×/对/错/T/F 等
            valid_answers = ["√", "×", "✓", "✗", "对", "错", "是", "否", "T", "F", "t", "f"]
            if answer.strip() not in valid_answers:
                issues.append({
                    "index": i,
                    "itemName": item_name,
                    "issue": "判断题答案格式异常",
                    "current": answer[:50] if len(answer) > 50 else answer
                })
    
    return issues


def build_correction_prompt(doc_text: str, items: List[Dict], issues: List[Dict]) -> str:
    """构建 LLM 校验的 prompt"""
    
    # 构建问题列表描述
    issues_desc = []
    for issue in issues:
        issues_desc.append(f"- {issue['itemName']}: {issue['issue']}，当前值=\"{issue['current']}\"")
    
    # 构建当前解析结果摘要
    items_summary = []
    for item in items:
        name = item.get("itemName", "")
        answer = item.get("stuAnswerContent", "")
        preview = answer[:30].replace("\n", " ") if answer else "(空)"
        items_summary.append(f"  {name}: {preview}")
    
    prompt = f"""你是一个作业答案校验助手。请对比【原始文档内容】和【OCR解析结果】，找出并补充缺失或错误的答案。

【原始文档内容】
{doc_text[:8000]}

【OCR解析结果摘要】
{chr(10).join(items_summary[:30])}

【需要校验补充的题目】
{chr(10).join(issues_desc)}

请仔细阅读原始文档，找出上述题目的正确答案。

输出要求：
1. 直接输出 JSON 格式，包含需要修正的题目
2. 格式为: {{"corrections": [{{"itemName": "题目名称", "stuAnswerContent": "正确答案"}}]}}
3. 选择题只输出选项字母（如 A/B/C/D）
4. 判断题输出 √ 或 ×
5. 主观题输出完整答案内容
6. 只输出 JSON，不要其他解释

请开始："""
    
    return prompt


def call_llm_api(prompt: str, api_key: str, api_url: str) -> Optional[str]:
    """调用 LLM API"""
    headers = {
        "api-key": api_key,
        "Content-Type": "application/json"
    }
    
    payload = {
        "maxTokens": 4096,
        "messages": [
            {
                "role": "system",
                "content": "你是一个专业的作业答案校验助手，擅长从文档中提取和补充答案。"
            },
            {
                "role": "user",
                "content": prompt
            }
        ],
        "model": "claude-sonnet-4-20250514",  # Claude Sonnet 4.5
        "temperature": 0.1,  # 低温度确保输出稳定
        "n": 1
    }
    
    try:
        response = requests.post(api_url, headers=headers, json=payload, timeout=120)
        response.raise_for_status()
        result = response.json()
        
        if "choices" in result and len(result["choices"]) > 0:
            return result["choices"][0]["message"]["content"]
        return None
    except Exception as e:
        print(f"❌ LLM API 调用失败: {e}")
        return None


def parse_llm_response(response: str) -> List[Dict]:
    """解析 LLM 返回的修正结果"""
    if not response:
        return []
    
    try:
        # 尝试提取 JSON
        json_match = re.search(r'\{[\s\S]*\}', response)
        if json_match:
            data = json.loads(json_match.group())
            return data.get("corrections", [])
    except json.JSONDecodeError:
        pass
    
    return []


def apply_corrections(items: List[Dict], corrections: List[Dict]) -> List[Dict]:
    """将修正结果应用到原始数据"""
    # 创建 itemName -> correction 映射
    correction_map = {}
    for corr in corrections:
        name = corr.get("itemName", "")
        if name:
            correction_map[name] = corr.get("stuAnswerContent", "")
    
    # 应用修正
    corrected_count = 0
    for item in items:
        item_name = item.get("itemName", "")
        if item_name in correction_map:
            old_value = item.get("stuAnswerContent", "")
            new_value = correction_map[item_name]
            if new_value and new_value != old_value:
                item["stuAnswerContent"] = new_value
                corrected_count += 1
                print(f"  ✏️ 修正 {item_name}: \"{old_value[:20]}...\" → \"{new_value[:50]}...\"")
    
    return items


def correct_answers_with_llm(docx_path: Path, text_input: str) -> str:
    """
    使用 LLM 校验并补充空白答案
    
    Args:
        docx_path: 原始 Word 文档路径
        text_input: 云端 OCR 解析的 textInput JSON 字符串
        
    Returns:
        修正后的 textInput JSON 字符串
    """
    # 加载配置
    api_key, api_url = load_llm_config()
    if not api_key:
        print("⚠️ 未配置 LLM_API_KEY，跳过 LLM 校验")
        return text_input
    
    # 解析 textInput
    try:
        items = json.loads(text_input)
    except json.JSONDecodeError:
        print("⚠️ textInput 格式错误，跳过 LLM 校验")
        return text_input
    
    # 检测问题
    issues = find_answer_issues(items)
    if not issues:
        print("✅ 所有答案格式正常，无需 LLM 校验")
        return text_input
    
    print(f"\n🔍 检测到 {len(issues)} 个问题答案，启动 LLM 校验...")
    for issue in issues[:5]:  # 只显示前5个
        print(f"  - {issue['itemName']}: {issue['issue']}")
    if len(issues) > 5:
        print(f"  ... 还有 {len(issues) - 5} 个问题")
    
    # 提取文档文本
    try:
        doc_text = extract_text_from_docx(docx_path)
    except Exception as e:
        print(f"⚠️ 文档读取失败: {e}，跳过 LLM 校验")
        return text_input
    
    # 构建 prompt 并调用 LLM
    prompt = build_correction_prompt(doc_text, items, issues)
    print("🤖 调用 LLM 校验中...")
    
    llm_response = call_llm_api(prompt, api_key, api_url)
    if not llm_response:
        print("⚠️ LLM 未返回结果，跳过校验")
        return text_input
    
    # 解析修正结果
    corrections = parse_llm_response(llm_response)
    if not corrections:
        print("⚠️ LLM 未返回有效修正，跳过校验")
        return text_input
    
    # 应用修正
    print(f"\n📝 应用 {len(corrections)} 个修正...")
    corrected_items = apply_corrections(items, corrections)
    
    print("✅ LLM 校验完成")
    return json.dumps(corrected_items, ensure_ascii=False)


# 异步版本
async def async_correct_answers_with_llm(docx_path: Path, text_input: str) -> str:
    """异步版本的 LLM 校验"""
    import asyncio
    # 在线程池中运行同步版本
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, correct_answers_with_llm, docx_path, text_input)


if __name__ == "__main__":
    # 测试用
    import sys
    
    if len(sys.argv) > 2:
        docx_path = Path(sys.argv[1])
        text_input = sys.argv[2]
        
        result = correct_answers_with_llm(docx_path, text_input)
        print("\n修正后的 textInput:")
        print(result[:500] + "..." if len(result) > 500 else result)
    else:
        print("用法: python llm_answer_corrector.py <docx路径> <textInput>")
