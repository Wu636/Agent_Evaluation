"""
TXT 对话记录转 JSON 格式转换器

将以下 TXT 格式：
```
对话记录
日志创建时间: 2025-12-22 15:33:54
task_id: 4ba83kl9jGtVgo4O8dz6
学生档位: 优秀学生
============================================================
[2025-12-22 15:33:59] Step xxx | 来源: runCard
AI: 内容...
--------------------------------------------------------------------------------
[2025-12-22 15:34:12] Step xxx | 第 1 轮 | 来源: chat
用户: 内容...
AI: 内容...
```

转换为 JSON 格式供评测系统使用。
"""

import re
from typing import Dict, List, Any
from datetime import datetime


def parse_txt_dialogue(txt_content: str) -> Dict[str, Any]:
    """
    解析 TXT 格式的对话记录，转换为 JSON 格式
    
    Args:
        txt_content: TXT 文件内容
        
    Returns:
        符合评测系统要求的 JSON 结构
    """
    lines = txt_content.strip().split('\n')
    
    # 解析元数据
    metadata = {
        "task_id": "",
        "student_level": "",
        "created_at": "",
        "total_rounds": 0
    }
    
    messages = []
    current_round = 0
    max_round = 0
    
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        
        # 解析元数据字段
        if line.startswith('日志创建时间:'):
            metadata['created_at'] = line.split(':', 1)[1].strip()
        elif line.startswith('task_id:'):
            metadata['task_id'] = line.split(':', 1)[1].strip()
        elif line.startswith('学生档位:'):
            metadata['student_level'] = line.split(':', 1)[1].strip()
        
        # 解析消息块 - 检测时间戳行 [YYYY-MM-DD HH:MM:SS]
        elif line.startswith('[') and ']' in line:
            # 提取轮次信息
            round_match = re.search(r'第\s*(\d+)\s*轮', line)
            if round_match:
                current_round = int(round_match.group(1))
                max_round = max(max_round, current_round)
            else:
                # 没有轮次信息的（如 runCard 开场白）算作第 0 轮
                current_round = 0
            
            # 读取后续的消息内容
            i += 1
            while i < len(lines):
                msg_line = lines[i]
                
                # 遇到分隔线或下一个时间戳，结束当前消息块
                if msg_line.strip().startswith('---') or \
                   (msg_line.strip().startswith('[') and ']' in msg_line.strip()):
                    break
                
                # 解析 AI 消息
                if msg_line.startswith('AI:') or msg_line.startswith('AI：'):
                    content = msg_line.split(':', 1)[1].strip() if ':' in msg_line else msg_line.split('：', 1)[1].strip()
                    # 继续读取多行内容
                    content_lines = [content]
                    i += 1
                    while i < len(lines):
                        next_line = lines[i]
                        if next_line.startswith('用户:') or next_line.startswith('用户：') or \
                           next_line.strip().startswith('---') or \
                           (next_line.strip().startswith('[') and ']' in next_line.strip()):
                            i -= 1  # 回退一行，让外层循环处理
                            break
                        content_lines.append(next_line)
                        i += 1
                    
                    full_content = '\n'.join(content_lines).strip()
                    if full_content:
                        messages.append({
                            "role": "assistant",
                            "content": full_content,
                            "round": current_round
                        })
                
                # 解析用户消息
                elif msg_line.startswith('用户:') or msg_line.startswith('用户：'):
                    content = msg_line.split(':', 1)[1].strip() if ':' in msg_line else msg_line.split('：', 1)[1].strip()
                    # 继续读取多行内容
                    content_lines = [content]
                    i += 1
                    while i < len(lines):
                        next_line = lines[i]
                        if next_line.startswith('AI:') or next_line.startswith('AI：') or \
                           next_line.strip().startswith('---') or \
                           (next_line.strip().startswith('[') and ']' in next_line.strip()):
                            i -= 1  # 回退一行
                            break
                        content_lines.append(next_line)
                        i += 1
                    
                    full_content = '\n'.join(content_lines).strip()
                    if full_content:
                        messages.append({
                            "role": "user",
                            "content": full_content,
                            "round": current_round
                        })
                else:
                    i += 1
                    continue
                
                i += 1
            continue
        
        i += 1
    
    # 更新总轮次
    metadata['total_rounds'] = max_round
    
    # 构造最终 JSON 结构
    result = {
        "metadata": metadata,
        "stages": [
            {
                "stage_name": "对话记录",
                "messages": messages
            }
        ]
    }
    
    return result


def convert_txt_to_json_file(txt_path: str, json_path: str) -> None:
    """
    将 TXT 文件转换为 JSON 文件
    
    Args:
        txt_path: 输入的 TXT 文件路径
        json_path: 输出的 JSON 文件路径
    """
    import json
    
    with open(txt_path, 'r', encoding='utf-8') as f:
        txt_content = f.read()
    
    json_data = parse_txt_dialogue(txt_content)
    
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(json_data, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    # 测试用例
    test_txt = """对话记录
日志创建时间: 2025-12-22 15:33:54
task_id: 4ba83kl9jGtVgo4O8dz6
学生档位: 优秀学生
============================================================
[2025-12-22 15:33:59] Step FbY3FxmEDyml0k14hzjmN | 来源: runCard
AI: 你刚才总结得特别到位——温度边界不是冷冰冰的数字分隔，而是技术选择与现实需求之间的一次次精准对话。
--------------------------------------------------------------------------------
[2025-12-22 15:34:12] Step FbY3FxmEDyml0k14hzjmN | 第 1 轮 | 来源: chat
用户: 我想先了解从依赖自然藏冰到偶然发现乙醚制冷这一"转折点"。
AI: 你选的这个转折点可太关键啦！古代人藏冰得熬到冬天，挖个深深的地窖存冰，夏天用的时候还得省着来。
--------------------------------------------------------------------------------
[2025-12-22 15:34:24] Step FbY3FxmEDyml0k14hzjmN | 第 2 轮 | 来源: chat
用户: 最大变化是从靠天藏冰的被动取冷，转变为用乙醚主动制冷，不再受季节限制。
AI: 哇，你说得太对啦！这个转变就是从"等大自然给冷"到"自己主动造冷"的关键一步。
"""
    
    import json
    result = parse_txt_dialogue(test_txt)
    print(json.dumps(result, ensure_ascii=False, indent=2))
