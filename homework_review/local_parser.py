"""
本地 Word 文档解析模块
用于将 Word 文档转换为 textInput 格式，跳过云端解析 API
"""

import re
import json
from pathlib import Path
from typing import List, Dict, Optional

try:
    from docx import Document
except ImportError:
    raise ImportError("请安装 python-docx: pip install python-docx")


def parse_word_to_text_input(docx_path: Path) -> str:
    """
    本地解析 Word 文档，生成符合 textInput 格式的 JSON
    
    Args:
        docx_path: Word 文档路径
        
    Returns:
        textInput JSON 字符串
    """
    doc = Document(docx_path)
    paragraphs = [p.text.strip() for p in doc.paragraphs if p.text.strip()]
    
    items: List[Dict] = []
    
    # 状态机变量
    current_section = None  # 当前题型: 选择题/判断题/简答题/论述题/案例分析题
    current_question_num = 0
    current_answer_lines = []
    current_question_title = ""
    
    for i, text in enumerate(paragraphs):
        # 检测题型标题
        section = detect_section(text)
        if section:
            # 保存上一题的答案
            if current_section in ["简答题", "论述题", "案例分析题"] and current_answer_lines:
                save_subjective_answer(items, current_section, current_question_num, current_answer_lines)
            current_section = section
            current_question_num = 0
            current_answer_lines = []
            continue
        
        # 根据当前题型解析
        if current_section == "单项选择题":
            parse_choice_answers(text, items, "单项选择题")
        elif current_section == "判断题":
            parse_judge_answers(text, items)
        elif current_section in ["简答题", "论述题", "案例分析题"]:
            # 跳过案例背景等非答案内容
            if is_case_background(text):
                continue
            
            # 检测是否是新题目（更严格的匹配）
            q_match = is_question_start(text)
            if q_match:
                # 保存上一题
                if current_answer_lines:
                    save_subjective_answer(items, current_section, current_question_num, current_answer_lines)
                current_question_num = q_match
                current_answer_lines = [text]
            elif current_question_num > 0:
                # 继续收集当前题目的答案
                current_answer_lines.append(text)
    
    # 保存最后一题
    if current_section in ["简答题", "论述题", "案例分析题"] and current_answer_lines:
        save_subjective_answer(items, current_section, current_question_num, current_answer_lines)
    
    return json.dumps(items, ensure_ascii=False)


def detect_section(text: str) -> Optional[str]:
    """检测题型标题"""
    text_clean = text.replace("*", "").strip()
    
    if re.search(r'[一二三四五六七八九十]、?\s*单项选择题', text_clean):
        return "单项选择题"
    elif re.search(r'[一二三四五六七八九十]、?\s*判断题', text_clean):
        return "判断题"
    elif re.search(r'[一二三四五六七八九十]、?\s*简答题', text_clean):
        return "简答题"
    elif re.search(r'[一二三四五六七八九十]、?\s*论述题', text_clean):
        return "论述题"
    elif re.search(r'[一二三四五六七八九十]、?\s*案例分析题', text_clean):
        return "案例分析题"
    
    return None


def is_case_background(text: str) -> bool:
    """判断是否为案例背景（非答案内容）"""
    text_clean = text.replace("*", "").strip()
    
    # 检测案例背景关键词
    background_patterns = [
        r'^案例背景',
        r'^背景[:：]',
        r'^\*{0,2}案例背景',
    ]
    
    for pattern in background_patterns:
        if re.match(pattern, text_clean):
            return True
    
    return False


def is_question_start(text: str) -> Optional[int]:
    """
    判断是否为题目开始，返回题号或 None
    更严格的匹配：排除 "1.8%" 这类假题目
    """
    text_clean = text.replace("*", "").strip()
    
    # 匹配题目开始的模式
    # 格式: "1. 题目内容" 或 "1、题目内容"
    # 但排除 "1.8%" 这种百分比格式
    
    # 先检查是否以数字开头
    match = re.match(r'^(\d+)[\.．、\\\\\.]\s*(.+)', text_clean)
    if not match:
        return None
    
    num = int(match.group(1))
    rest = match.group(2)
    
    # 排除假题目（如 "1.8%" 开头）
    # 如果数字后面紧跟着百分号或小数，则不是题目
    if re.match(r'^\d+%', rest):
        return None
    
    # 检查题号是否合理（1-10 以内）
    if num < 1 or num > 10:
        return None
    
    return num


def parse_choice_answers(text: str, items: List[Dict], section_name: str):
    """
    解析选择题答案
    格式: "1.B 2.B 3.B 4.B 5.C 6.C 7.B 8.B 9.C 10.A"
    """
    # 清理文本
    text_clean = text.replace("*", "").replace("**", "").strip()
    
    # 匹配 "题号.答案" 格式
    pattern = r'(\d+)[\.．]([A-Da-d])'
    matches = re.findall(pattern, text_clean)
    
    for num_str, answer in matches:
        items.append({
            "itemId": "",
            "itemName": f"{section_name}第{num_str}题",
            "stuAnswerContent": answer.upper()
        })


def parse_judge_answers(text: str, items: List[Dict]):
    """
    解析判断题答案
    格式: "1.√ 2.× 3.√ 4.× 5.√ 6.× 7.√ 8.× 9.√ 10.×"
    """
    # 清理文本
    text_clean = text.replace("*", "").replace("**", "").strip()
    
    # 匹配 "题号.判断符号" 格式
    # 支持: √ × ✓ ✗ 对 错 是 否 T F
    pattern = r'(\d+)[\.．]([√×✓✗对错是否TtFf])'
    matches = re.findall(pattern, text_clean)
    
    for num_str, answer in matches:
        # 统一转换为 √ 或 ×
        normalized = normalize_judge_answer(answer)
        items.append({
            "itemId": "",
            "itemName": f"判断题第{num_str}题",
            "stuAnswerContent": normalized
        })


def normalize_judge_answer(answer: str) -> str:
    """标准化判断题答案"""
    positive = ["√", "✓", "对", "是", "T", "t"]
    negative = ["×", "✗", "错", "否", "F", "f"]
    
    if answer in positive:
        return "√"
    elif answer in negative:
        return "×"
    return answer


def save_subjective_answer(items: List[Dict], section: str, question_num: int, answer_lines: List[str]):
    """保存主观题答案"""
    if not answer_lines:
        return
    
    # 合并所有行，用换行符连接
    full_answer = "\n\n".join(answer_lines)
    
    # 确定题目名称
    if section == "案例分析题":
        item_name = f"案例分析题第{question_num}问"
    else:
        item_name = f"{section}第{question_num}题"
    
    items.append({
        "itemId": "",
        "itemName": item_name,
        "stuAnswerContent": full_answer
    })


def preview_parse_result(docx_path: Path) -> None:
    """
    预览解析结果（用于调试）
    """
    text_input = parse_word_to_text_input(docx_path)
    items = json.loads(text_input)
    
    print(f"\n📋 解析结果预览 ({len(items)} 题):")
    print("-" * 50)
    
    for i, item in enumerate(items, 1):
        name = item.get("itemName", "")
        answer = item.get("stuAnswerContent", "")
        # 截断过长答案
        display = answer[:60].replace("\n", " ") + "..." if len(answer) > 60 else answer.replace("\n", " ")
        status = "✅" if answer else "⚠️ 空"
        print(f"  {i:2}. {name}: {display} {status}")
    
    print("-" * 50)


if __name__ == "__main__":
    import sys
    
    if len(sys.argv) > 1:
        docx_path = Path(sys.argv[1])
        if docx_path.exists():
            preview_parse_result(docx_path)
        else:
            print(f"❌ 文件不存在: {docx_path}")
    else:
        print("用法: python local_parser.py <word文档路径>")
