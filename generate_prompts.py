#!/usr/bin/env python3
"""
从评分标准文档生成 prompts.ts 文件的脚本
"""

import re
import json

def parse_markdown_document(md_file_path):
    """解析 Markdown 文档,提取评分标准"""
    with open(md_file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    dimensions = {}
    current_dimension = None
    current_sub_dimension = None
    
    lines = content.split('\n')
    i = 0
    
    while i < len(lines):
        line = lines[i]
        
        # 匹配一级维度标题 (如 "## 一、目标达成度（20分）" 或 "## 五、教学策略（20分 - 加分项）")
        if re.match(r'^## [一二三四五]、(.+?)（(\d+)分', line):
            match = re.match(r'^## [一二三四五]、(.+?)（(\d+)分', line)
            dim_name = match.group(1)
            full_score = int(match.group(2))
            current_dimension = {
                'name': dim_name,
                'full_score': full_score,
                'sub_dimensions': {}
            }
            dimensions[dim_name] = current_dimension
        
        # 匹配二级维度标题 (如 "### 1.1 知识点覆盖率（10分）")
        elif re.match(r'^### \d+\.\d+ (.+?)（(\d+)分）', line):
            match = re.match(r'^### \d+\.\d+ (.+?)（(\d+)分）', line)
            sub_dim_name = match.group(1)
            sub_full_score = int(match.group(2))
            
            # 提取评分标准表格
            scoring_table = []
            j = i + 1
            while j < len(lines):
                if lines[j].startswith('**扣分细则：**') or lines[j].startswith('**加分要点：**'):
                    break
                if lines[j].startswith('|') and '分数段' not in lines[j] and '---' not in lines[j]:
                    scoring_table.append(lines[j])
                j += 1
            
            # 提取扣分细则
            deduction_rules = []
            if j < len(lines) and (lines[j].startswith('**扣分细则：**') or lines[j].startswith('**加分要点：**')):
                j += 1
                while j < len(lines) and lines[j].startswith('- '):
                    deduction_rules.append(lines[j][2:])  # 去掉 "- "
                    j += 1
            
            # 提取评分要点
            evaluation_points = []
            while j < len(lines):
                if lines[j].startswith('**评分要点：**') or lines[j].startswith('**加分要点：**'):
                    j += 1
                    while j < len(lines) and lines[j].startswith('- '):
                        evaluation_points.append(lines[j][2:])
                        j += 1
                    break
                j += 1
            
            current_sub_dimension = {
                'name': sub_dim_name,
                'full_score': sub_full_score,
                'scoring_table': scoring_table,
                'deduction_rules': deduction_rules,
                'evaluation_points': evaluation_points
            }
            
            if current_dimension:
                current_dimension['sub_dimensions'][sub_dim_name] = current_sub_dimension
        
        i += 1
    
    return dimensions

def generate_prompt_for_subdimension(dim_name, sub_dim, teacher_doc_var='teacherDoc', dialogue_var='dialogueText'):
    """为单个子维度生成 prompt"""
    
    prompt = f'''
# 评测任务: {sub_dim['name']}

## 评测对象
你需要评测一个教学智能体与学生的对话,专门针对「{sub_dim['name']}」这一维度进行评分。

## 教师文档(标准答案)
\\`\\`\\`markdown
${{{teacher_doc_var}}}
\\`\\`\\`

## 实际对话记录
\\`\\`\\`json
${{{dialogue_var}}}
\\`\\`\\`

## 评分标准

满分: {sub_dim['full_score']}分

'''
    
    # 添加评分标准表格
    if sub_dim['scoring_table']:
        prompt += '### 分数段标准\n\n'
        for row in sub_dim['scoring_table']:
            prompt += row + '\\n'
        prompt += '\\n'
    
    # 添加扣分细则
    if sub_dim['deduction_rules']:
        prompt += '### 扣分细则\n\n'
        for rule in sub_dim['deduction_rules']:
            prompt += f'- {rule}\\n'
        prompt += '\\n'
    
    # 添加评分要点
    if sub_dim['evaluation_points']:
        prompt += '### 评分要点\n\n'
        for point in sub_dim['evaluation_points']:
            prompt += f'- {point}\\n'
        prompt += '\\n'
    
    # 添加输出格式要求
    prompt += '''
## 输出要求(严格JSON格式)

你必须按照以下JSON格式输出评分结果:

\\`\\`\\`json
{
  "sub_dimension": "''' + sub_dim['name'] + '''",
  "score": 0, // 替换为该分项的实际得分(数字)
  "full_score": ''' + str(sub_dim['full_score']) + ''',
  "rating": "合格", // 替换为实际评级 (优秀/良好/合格/不足/较差)
  "score_range": "", // 替换为实际落入的分数段
  "judgment_basis": "此处填写详细的得分理由...", // 必须基于事实分析
  "issues": [
    {
      "description": "此处填写具体问题描述",
      "location": "第1轮对话",
      "quote": "此处引用对话原文",
      "severity": "medium",
      "impact": "问题影响简述"
    }
  ]
}
\\`\\`\\`

**字段说明:**
- score: 必须是数字
- rating: 必须是 "优秀"/"良好"/"合格"/"不足"/"较差" 之一
- severity: 必须是 "high"/"medium"/"low" 之一

**关键要求:**
1. **绝不要直接复制上面的示例值！** 你必须根据实际对话内容重新生成所有字段的值。
2. **先判定分数段**: 根据整体表现确定属于哪个分数段
3. **再列举问题**: 详细列出导致该分数段判定的具体问题
4. **强制证据引用**: 每个问题必须有明确的位置定位和原文引用
5. **quote字段必须是对话中的实际内容**, 不能编造
6. **location必须精确到第X轮对话**
7. **特别注意**: 字符串内部的双引号必须转义 (例如使用 \\" 而不是 "), 确保JSON格式合法

请严格按JSON格式输出,不要有任何多余的文字!
'''
    
    return prompt

def generate_prompts_ts(dimensions, output_file):
    """生成完整的 prompts.ts 文件"""
    
    ts_content = '''/**
 * LLM 评测提示词模板 (新版本 - 分数段限定版)
 * 自动生成于评分标准文档
 */

export interface PromptContext {
  teacherDoc: string;
  dialogueText: string;
  workflowConfig?: string;
}

/**
 * 构建子维度评测的提示词
 */
export function buildSubDimensionPrompt(
  dimensionKey: string,
  subDimensionKey: string,
  context: PromptContext
): string {
  const { teacherDoc, dialogueText } = context;

  const prompts: Record<string, Record<string, string>> = {
'''
    
    # 为每个维度和子维度生成 prompt
    for dim_name, dim_data in dimensions.items():
        # 创建维度键名 (转换为 snake_case)
        dim_key = dim_name.lower().replace(' ', '_').replace('（', '').replace('）', '')
        
        ts_content += f'    "{dim_key}": {{\n'
        
        for sub_dim_name, sub_dim_data in dim_data['sub_dimensions'].items():
            # 创建子维度键名
            sub_dim_key = sub_dim_name.lower().replace(' ', '_').replace('（', '').replace('）', '')
            
            # 生成 prompt
            prompt = generate_prompt_for_subdimension(dim_name, sub_dim_data)
            
            # 转义特殊字符
            prompt_escaped = prompt.replace('\\', '\\\\').replace('`', '\\`').replace('$', '\\$')
            
            ts_content += f'      "{sub_dim_key}": `{prompt_escaped}`,\n'
        
        ts_content += '    },\n'
    
    ts_content += '''  };

  return prompts[dimensionKey]?.[subDimensionKey] || "";
}

/**
 * 获取所有子维度的键名列表
 */
export function getAllSubDimensions(): Record<string, string[]> {
  return {
'''
    
    # 添加子维度列表
    for dim_name, dim_data in dimensions.items():
        dim_key = dim_name.lower().replace(' ', '_').replace('（', '').replace('）', '')
        sub_dim_keys = [
            sub_dim_name.lower().replace(' ', '_').replace('（', '').replace('）', '')
            for sub_dim_name in dim_data['sub_dimensions'].keys()
        ]
        ts_content += f'    "{dim_key}": {json.dumps(sub_dim_keys, ensure_ascii=False)},\n'
    
    ts_content += '''  };
}
'''
    
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(ts_content)
    
    print(f"✅ 成功生成 {output_file}")
    print(f"📊 包含 {len(dimensions)} 个一级维度")
    total_sub_dims = sum(len(d['sub_dimensions']) for d in dimensions.values())
    print(f"📊 包含 {total_sub_dims} 个二级维度")

if __name__ == '__main__':
    import sys
    
    if len(sys.argv) < 2:
        print("用法: python generate_prompts.py <评分标准文档路径>")
        print("示例: python generate_prompts.py docs/训练智能体Prompt优化方案.md")
        sys.exit(1)
    
    md_file = sys.argv[1]
    output_file = 'frontend/lib/llm/prompts.ts'
    
    print(f"📖 正在解析文档: {md_file}")
    dimensions = parse_markdown_document(md_file)
    
    print(f"🔨 正在生成 prompts.ts...")
    generate_prompts_ts(dimensions, output_file)
    
    print("\\n✨ 完成!")
