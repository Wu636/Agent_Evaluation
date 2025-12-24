#!/usr/bin/env python3
"""
基于LLM的实训智能体评测系统
使用大模型进行深度语义理解和评测
"""

import json
import os
from typing import Dict, List, Any, Optional
from dataclasses import dataclass, field
from enum import Enum


class EvaluationLevel(Enum):
    """评测等级"""
    EXCELLENT = "优秀"
    GOOD = "良好"
    PASS = "合格"
    FAIL = "不合格"
    VETO = "一票否决"  # 关键任务未完成


@dataclass
class DimensionScore:
    """单个维度的评分"""
    dimension: str
    score: float  # 0-100
    weight: float
    level: str  # 优秀/良好/合格/不合格
    analysis: str  # 详细分析
    evidence: List[str]  # 支撑证据
    issues: List[str]  # 发现的问题
    suggestions: List[str]  # 改进建议
    is_veto: bool = False  # 是否一票否决
    
    @property
    def weighted_score(self) -> float:
        return self.score * self.weight


@dataclass
class EvaluationReport:
    """完整评测报告"""
    task_id: str
    total_score: float
    final_level: EvaluationLevel
    dimensions: List[DimensionScore]
    executive_summary: str  # 高管摘要
    critical_issues: List[str]  # 关键问题
    actionable_suggestions: List[str]  # 可执行建议
    pass_criteria_met: bool  # 是否达到合格标准
    veto_reasons: List[str] = field(default_factory=list)  # 一票否决原因


class LLMEvaluationAgent:
    """基于LLM的评测Agent"""
    
    MAX_DIALOGUE_LENGTH = 15000  # 最大对话字符数限制
    
    # 评测维度配置(按你的要求重新设计)
    DIMENSIONS = {
        "teaching_goal_completion": {
            "name": "目标达成度",
            "weight": 0.40,  # 最高权重
            "is_veto": True,  # 一票否决项
            "veto_threshold": 60  # 低于60分直接不合格
        },
        "teaching_strategy": {
            "name": "策略引导力",
            "weight": 0.20,
            "is_veto": False
        },
        "workflow_consistency": {
            "name": "流程遵循度",
            "weight": 0.15,
            "is_veto": False
        },
        "interaction_experience": {
            "name": "交互体验感",
            "weight": 0.10,
            "is_veto": False
        },
        "hallucination_control": {
            "name": "幻觉控制力",
            "weight": 0.10,
            "is_veto": False
        },
        "robustness": {
            "name": "异常处理力",
            "weight": 0.05,
            "is_veto": False
        }
    }
    
    def __init__(self, 
                 teacher_doc_path: str, 
                 dialogue_json_path: str,
                 llm_api_key: Optional[str] = None,
                 llm_base_url: Optional[str] = None,
                 llm_model: str = "gpt-4o"):
        """
        初始化LLM评测Agent
        
        Args:
            teacher_doc_path: 教师文档路径
            dialogue_json_path: 对话记录JSON路径
            llm_api_key: LLM API密钥(如果为None,从.env文件读取)
            llm_base_url: LLM API基础URL(如果为None,从.env文件读取)
            llm_model: 使用的模型名称
        """
        self.teacher_doc_path = teacher_doc_path
        self.dialogue_json_path = dialogue_json_path
        
        # 加载.env文件
        self._load_env_config()
        
        # LLM配置(优先使用参数,其次使用.env,最后使用环境变量)
        self.llm_api_key = llm_api_key or self.env_config.get('LLM_API_KEY') or os.getenv('LLM_API_KEY')
        self.llm_base_url = llm_base_url or self.env_config.get('LLM_BASE_URL') or os.getenv('LLM_BASE_URL')
        self.llm_model = llm_model or self.env_config.get('LLM_MODEL', 'gpt-4o')
        
        if not self.llm_api_key:
            raise ValueError(
                "未找到LLM API密钥。请在.env文件中配置 LLM_API_KEY "
                "或设置环境变量,或在初始化时传入 llm_api_key 参数"
            )
        
        if not self.llm_base_url:
            raise ValueError(
                "未找到LLM API地址。请在.env文件中配置 LLM_BASE_URL "
                "或设置环境变量,或在初始化时传入 llm_base_url 参数"
            )
        
        # 加载数据
        self.teacher_doc = self._load_teacher_doc()
        self.dialogue_data = self._load_dialogue_json()
        
        print(f"✓ 已加载教师文档: {len(self.teacher_doc)} 字符")
        print(f"✓ 已加载对话记录: {self.dialogue_data['metadata']['total_rounds']} 轮")
        print(f"✓ LLM配置: {self.llm_base_url} / {self.llm_model}")
    
    def _load_env_config(self):
        """加载.env文件配置"""
        self.env_config = {}
        
        # 查找.env文件(当前目录或上级目录)
        env_paths = [
            '.env',
            '../.env',
            '../../.env',
            os.path.join(os.path.dirname(__file__), '.env'),
            os.path.join(os.path.dirname(os.path.dirname(__file__)), '.env')
        ]
        
        env_file = None
        for path in env_paths:
            if os.path.exists(path):
                env_file = path
                break
        
        if env_file:
            print(f"✓ 找到配置文件: {env_file}")
            with open(env_file, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    # 跳过注释和空行
                    if not line or line.startswith('#'):
                        continue
                    # 解析键值对
                    if '=' in line:
                        key, value = line.split('=', 1)
                        # 移除引号
                        value = value.strip().strip('"').strip("'")
                        self.env_config[key.strip()] = value
        else:
            print("⚠️ 未找到.env文件,将使用环境变量")
    
    def _load_teacher_doc(self) -> str:
        """加载教师文档"""
        # 如果是docx,先转换
        if self.teacher_doc_path.lower().endswith('.docx'):
            md_path = self._convert_docx_to_md(self.teacher_doc_path)
            with open(md_path, 'r', encoding='utf-8') as f:
                return f.read()
        else:
            with open(self.teacher_doc_path, 'r', encoding='utf-8') as f:
                return f.read()
    
    def _convert_docx_to_md(self, docx_path: str) -> str:
        """转换docx为markdown"""
        import subprocess
        
        base_name = os.path.splitext(os.path.basename(docx_path))[0]
        output_dir = os.path.dirname(docx_path) or '.'
        md_path = os.path.join(output_dir, f"{base_name}_converted.md")
        
        try:
            subprocess.run(
                ['pandoc', '--track-changes=all', docx_path, '-o', md_path],
                check=True,
                capture_output=True
            )
            print(f"✓ 已将docx转换为markdown: {md_path}")
            return md_path
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"Pandoc转换失败: {e.stderr.decode()}")
        except FileNotFoundError:
            raise RuntimeError("未安装pandoc。请运行: brew install pandoc")
    
    def _load_dialogue_json(self) -> Dict:
        """加载对话记录"""
        with open(self.dialogue_json_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    
    def _call_llm(self, prompt: str, temperature: float = 0.3) -> str:
        """
        调用LLM API
        
        Args:
            prompt: 提示词
            temperature: 温度参数(0-1,越低越确定)
            
        Returns:
            LLM返回的文本
        """
        try:
            import requests
            
            # 构造请求
            url = self.llm_base_url
            headers = {
                'api-key': self.llm_api_key,
                'Content-Type': 'application/json'
            }
            
            payload = {
                "maxTokens": 4000,
                "messages": [
                    {
                        "role": "system",
                        "content": "你是一位资深的教学质量评估专家,擅长分析教学智能体的对话质量。你的评价客观、专业、有建设性。"
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                "model": self.llm_model,
                "n": 1,
                "presence_penalty": 0.0,
                "temperature": temperature
            }
            
            # 发送POST请求
            #import pdb;pdb.set_trace()
            response = requests.post(url, headers=headers, json=payload, timeout=120)
            
            # 检查响应状态
            if response.status_code != 200:
                raise RuntimeError(
                    f"API请求失败: HTTP {response.status_code}\n"
                    f"响应内容: {response.text[:500]}"
                )
            
            # 解析响应
            result = response.json()
            
            # 提取返回的内容
            if 'choices' in result and len(result['choices']) > 0:
                content = result['choices'][0]['message']['content']
                
                # 打印token使用情况(如果有)
                if 'usage' in result:
                    usage = result['usage']
                    print(f"   Token使用: 提示{usage.get('prompt_tokens', 0)} + "
                          f"生成{usage.get('completion_tokens', 0)} = "
                          f"总计{usage.get('total_tokens', 0)}")
                
                return content
            else:
                raise RuntimeError(f"API返回格式异常: {result}")
            
        except requests.exceptions.Timeout:
            raise RuntimeError("API请求超时(120秒),请检查网络或稍后重试")
        except requests.exceptions.ConnectionError:
            raise RuntimeError(f"无法连接到API服务器: {self.llm_base_url}")
        except Exception as e:
            raise RuntimeError(f"LLM API调用失败: {str(e)}")
    
    def _evaluate_dimension(self, dimension_key: str) -> DimensionScore:
        """
        评测单个维度
        
        Args:
            dimension_key: 维度键名
            
        Returns:
            该维度的评分结果
        """
        config = self.DIMENSIONS[dimension_key]
        dimension_name = config['name']
        
        print(f"\n⏳ 正在评测: {dimension_name}...")
        
        # 构造专门的评测提示词
        prompt = self._build_dimension_prompt(dimension_key)
        
        # 调用LLM评测
        llm_response = self._call_llm(prompt)
        
        # 解析LLM返回的JSON
        result = self._parse_llm_response(llm_response)
        
        # 构造评分对象
        score = DimensionScore(
            dimension=dimension_name,
            score=result['score'],
            weight=config['weight'],
            level=result['level'],
            analysis=result['analysis'],
            evidence=result['evidence'],
            issues=result['issues'],
            suggestions=result['suggestions'],
            is_veto=config.get('is_veto', False) and result['score'] < config.get('veto_threshold', 60)
        )
        
        print(f"✓ {dimension_name}: {score.score:.1f}分 - {score.level}")
        
        return score
    
    def _build_dimension_prompt(self, dimension_key: str) -> str:
        """构造维度评测的提示词"""
        
        config = self.DIMENSIONS[dimension_key]
        dimension_name = config['name']
        
        # 准备对话文本
        dialogue_text = self._format_dialogue_for_llm()
        
        # 根据不同维度构造专门的提示词
        prompts = {
            "teaching_goal_completion": f"""
# 评测任务:教学目标与任务完成度评测

## 评测对象
你需要评测一个教学智能体与学生的对话,判断智能体是否成功引导学生完成了教师文档中规定的全部教学目标。

**这是一票否决项!如果核心任务未完成,无论对话多流畅,都不能通过。**

## 教师文档(标准答案)
```markdown
{self.teacher_doc}
```

## 实际对话记录
```json
{dialogue_text}
```

## 评测要点(请逐项检查)

### 1. 关键能力点覆盖率(40分)
- 是否覆盖文档中定义的**所有核心知识点和操作步骤**?
- 每个环节的关键参数、标准是否都传达到位?
- 是否遗漏了任何必要的教学内容?

### 2. 任务顺序与流程完整性(25分)
- 是否按照文档规定的顺序引导学生完成任务?
- 每个环节之间的过渡是否自然合理?
- 是否有跳步、省略、或顺序错乱?

### 3. 主动引导与节点推进(20分)
- 在关键节点,智能体是否主动发起引导?
- 还是被动等待学生提问?
- 是否能在学生卡壳时给出**恰当的提示**(不直接给答案)?

### 4. 任务收敛与总结(15分)
- 任务完成后,是否有明确的收敛与总结?
- 是否确认学生已理解所有要点?
- 是否有"下一步"的引导或反思?

## 输出要求(严格JSON格式)

```json
{{
  "score": 85,  // 0-100的分数
  "level": "良好",  // 优秀/良好/合格/不合格
  "analysis": "详细分析:智能体完成了文档中的5个主要环节...",
  "evidence": [
    "环节1'母株选择'中,完整传达了3-5年生、直径1.0-1.5cm等关键参数",
    "环节2'环剥操作'中,准确说明了深度至木质部、宽度1.5倍等标准",
    "..."
  ],
  "issues": [
    "遗漏了'雨天检查透气孔'这一养护要点",
    "第三环节'基质包裹'中,未明确提及透气孔的具体位置要求",
    "..."
  ],
  "suggestions": [
    "补充完整的养护注意事项清单",
    "在基质包裹环节增加透气孔位置的详细说明",
    "..."
  ]
}}
```

**重要提醒:**
- 如果发现**核心任务未完成**(如5个环节只完成3个),分数应<60分
- 如果只是细节遗漏但主体完整,可给70-80分
- 如果全部完成且质量高,可给85-95分
- 不要给100分,总有改进空间

请严格按JSON格式输出,不要有任何多余的文字!
""",
            
            "teaching_strategy": f"""
# 评测任务:教学策略与引导质量评测

## 核心理念
**教学智能体 ≠ 百科问答机器人**

好的教学不是直接给答案,而是:
- 引导学生思考
- 循序渐进地建立知识体系
- 允许试错,在错误中学习
- 通过追问促进深度理解

## 教师文档
```markdown
{self.teacher_doc}
```

## 实际对话记录
```json
{dialogue_text}
```

## 评测要点

### 1. 引导式教学而非直接给答案(30分)
检查对话中:
- ❌ "答案是XXX" → 直接给答案
- ✅ "你觉得应该选择什么样的枝条?" → 引导提问
- ✅ "想想看,为什么要选1-2年生的枝条?" → 启发思考

### 2. 循序渐进,由浅入深(25分)
- 是否从简单概念开始,逐步深入?
- 是否在学生掌握基础后才引入复杂内容?
- 前后知识点的衔接是否合理?

### 3. 追问与反问促进思考(25分)
- 当学生回答后,是否有追问"为什么"?
- 是否用反问激发学生主动思考?
- 例如:"你觉得这样做的目的是什么?"

### 4. 允许试错与纠错技巧(20分)
- 学生答错时,是否直接给标准答案?还是引导找出错误原因?
- 纠错时是否说明原因而非简单纠正?
- 是否鼓励学生再次尝试?

## 输出JSON格式

```json
{{
  "score": 75,
  "level": "良好",
  "analysis": "智能体整体采用引导式教学...",
  "evidence": [
    "在第2轮对话中,用'请说明母株和枝条的选择标准'引导而非直接告知",
    "..."
  ],
  "issues": [
    "第5轮学生回答错误后,直接给出了标准答案,未引导学生思考",
    "缺少'为什么'类的深度追问",
    "..."
  ],
  "suggestions": [
    "在学生答错时,改用'你觉得哪里可能有问题'这样的引导",
    "增加追问环节,如'为什么要选这个直径范围'",
    "..."
  ]
}}
```

请严格按JSON格式输出!
""",
            
            "workflow_consistency": f"""
# 评测任务:对话流程一致性与工作流遵循度

## 评测目标
检查智能体是否严格按照设计的工作流运行,有无异常的跳步、回退、循环等问题。

## 教师文档(预期工作流)
```markdown
{self.teacher_doc}
```

## 实际对话记录
```json
{dialogue_text}
```

## 评测要点

### 1. 环节顺序正确性(35分)
- 是否按文档规定的环节顺序执行?
- 有无跳过某个环节?
- 有无环节顺序颠倒?

### 2. 角色一致性(25分)
- 智能体是否保持了预设角色(如"辅助员芍药")?
- 有无角色混乱或不该出现的角色发言?
- 角色转换是否合理?

### 3. 流程收敛性(25分)
- 每个环节是否有明确的结束标志?
- 是否在完成后才进入下一环节?
- 有无在结束节点后仍继续无关对话?

### 4. 异常状态处理(15分)
- 出现异常输入时,是否能回到主流程?
- 有无死循环、无限追问?
- 是否能从偏离中恢复?

## 输出JSON格式

```json
{{
  "score": 88,
  "level": "良好",
  "analysis": "工作流执行基本规范,5个环节按序完成...",
  "evidence": [
    "环节1→2→3→4→5的顺序完全符合文档",
    "每个环节结束时都有明确的'达标'/'可进入下一环节'标记",
    "..."
  ],
  "issues": [
    "第3轮和第4轮之间出现了短暂的话题偏离",
    "环节4中有一次回退到环节3的内容",
    "..."
  ],
  "suggestions": [
    "增强环节间的过渡控制,避免话题偏离",
    "..."
  ]
}}
```
""",
            
            "interaction_experience": f"""
# 评测任务:语言与交互体验

## 评测重点
这里不追求文学性,而是**教学可用性**。

## 对话记录
```json
{dialogue_text}
```

## 评测要点

### 1. 表达清晰度(30分)
- 指令是否明确,无歧义?
- 专业术语是否解释到位?
- 学生能否准确理解意图?

### 2. 机械感与模板化(25分)
- 是否存在明显的模板痕迹?
- 语言是否过于程式化?
- 是否有重复使用相同句式?

### 3. 上下文理解(25分)
- 能否正确理解学生的指代("这个"、"它")?
- 能否承接上一轮对话的内容?
- 有无答非所问的情况?

### 4. 语气适配性(20分)
- 语气是否符合教学场景?
- 是否过于随意或过于冷漠?
- 鼓励与纠错的语气是否恰当?

## 输出JSON格式

```json
{{
  "score": 82,
  "level": "良好",
  "analysis": "语言表达整体清晰,符合教学场景...",
  "evidence": [
    "第5轮对纠错时语气委婉:'需调整'而非'错误'",
    "..."
  ],
  "issues": [
    "多次出现'请按照要求...'的模板化表达",
    "第8轮未能理解学生的'那个'指代",
    "..."
  ],
  "suggestions": [
    "减少模板化用语,增加表达多样性",
    "..."
  ]
}}
```
""",
            
            "hallucination_control": f"""
# 评测任务:幻觉与不当输出控制

## 教师文档(知识边界)
```markdown
{self.teacher_doc}
```

## 对话记录
```json
{dialogue_text}
```

## 评测要点

### 1. 知识准确性(40分)
- 是否引用了不存在的概念/工具?
- 参数、数值是否与文档一致?
- 有无自行编造的"标准"?

### 2. 文档一致性(30分)
- 是否与教师文档冲突?
- 是否给出了文档中没有的操作步骤?
- 有无超出文档范围的扩展?

### 3. 权限边界(20分)
- 是否越权添加了教学目标?
- 是否擅自修改了评估标准?
- 是否保持在"辅助员"角色内?

### 4. 自信度校准(10分)
- 不确定时是否承认不确定?
- 还是错了也很自信?

## 输出JSON格式

```json
{{
  "score": 65,
  "level": "合格",
  "analysis": "存在一些参数不一致和超纲内容...",
  "evidence": [
    "环节2中生根剂浓度与文档一致(2000mg/L)",
    "..."
  ],
  "issues": [
    "提到了'多菌灵溶液预防霉菌',但文档中未涉及病虫害防治",
    "基质湿度说了'60%-70%'但文档要求是'70%-80%'",
    "..."
  ],
  "suggestions": [
    "严格对照文档,不添加文档外内容",
    "所有参数都需与文档完全一致",
    "..."
  ]
}}
```
""",
            
            "robustness": f"""
# 评测任务:鲁棒性与异常处理能力

## 对话记录
```json
{dialogue_text}
```

## 评测要点

### 1. 偏离后的恢复能力(30分)
- 学生不按预期回答时,能否拉回主线?
- 学生答非所问时,如何纠偏?
- 恢复的方式是否自然?

### 2. 重复问题处理(25分)
- 学生重复提问,是否有耐心?
- 会不会给出完全相同的回答?
- 是否换个角度重新解释?

### 3. 循环避免(25分)
- 有无死循环(反复问同一问题)?
- 有无陷入无意义的对话?
- 是否能主动打破僵局?

### 4. 越界请求处理(20分)
- 学生直接要答案,如何处理?
- 学生要求做文档外的事,如何拒绝?
- 拒绝时是否给出合理解释?

## 输出JSON格式

```json
{{
  "score": 70,
  "level": "合格",
  "analysis": "基本具备异常处理能力,但某些情况下表现不够稳定...",
  "evidence": [
    "在学生回答简短时,能够继续引导而非卡住",
    "..."
  ],
  "issues": [
    "未检测到学生重复提问的情况,无法评估",
    "学生一次回答过于简略,智能体未追问",
    "..."
  ],
  "suggestions": [
    "增加对学生异常输入的识别和处理",
    "..."
  ]
}}
```
"""
        }
        
        return prompts.get(dimension_key, "")
    
    def _format_dialogue_for_llm(self) -> str:
        """格式化对话记录为LLM可读格式"""
        formatted = []
        
        for stage in self.dialogue_data['stages']:
            formatted.append(f"\n## {stage['stage_name']}\n")
            
            for msg in stage['messages']:
                role = "智能体" if msg['role'] == 'assistant' else "学生"
                formatted.append(f"**{role}(第{msg['round']}轮):** {msg['content']}\n")
        
        return "\n".join(formatted)
    
    def _parse_llm_response(self, response: str) -> Dict:
        """解析LLM返回的JSON"""
        try:
            # 清理可能的markdown代码块
            response = response.strip()
            if response.startswith('```json'):
                response = response[7:]
            if response.startswith('```'):
                response = response[3:]
            if response.endswith('```'):
                response = response[:-3]
            response = response.strip()
            
            # 解析JSON
            result = json.loads(response)
            
            # 验证必要字段
            required_fields = ['score', 'level', 'analysis', 'evidence', 'issues', 'suggestions']
            for field in required_fields:
                if field not in result:
                    raise ValueError(f"LLM返回缺少必要字段: {field}")
            
            return result
            
        except json.JSONDecodeError as e:
            print(f"⚠️ JSON解析失败: {e}")
            print(f"原始响应: {response[:500]}...")
            # 返回默认值
            return {
                'score': 50,
                'level': '合格',
                'analysis': f'JSON解析失败,使用默认分数。错误: {str(e)}',
                'evidence': [],
                'issues': ['LLM返回格式错误'],
                'suggestions': ['需要修复LLM提示词或响应解析']
            }
    
    def evaluate(self) -> EvaluationReport:
        """
        执行完整评测
        
        Returns:
            完整的评测报告
        """
        print("\n" + "="*70)
        print("开始LLM驱动的智能体评测")
        print("="*70)
        
        dimension_scores = []
        veto_reasons = []
        
        # 按顺序评测各维度
        for dimension_key in self.DIMENSIONS.keys():
            score = self._evaluate_dimension(dimension_key)
            dimension_scores.append(score)
            
            # 检查一票否决
            if score.is_veto:
                veto_reasons.append(
                    f"{score.dimension}得分{score.score:.1f}分,低于{self.DIMENSIONS[dimension_key]['veto_threshold']}分阈值"
                )
        
        # 计算总分
        total_score = sum(s.weighted_score for s in dimension_scores)
        
        # 确定最终等级
        if veto_reasons:
            final_level = EvaluationLevel.VETO
            pass_criteria_met = False
        elif total_score >= 90:
            final_level = EvaluationLevel.EXCELLENT
            pass_criteria_met = True
        elif total_score >= 75:
            final_level = EvaluationLevel.GOOD
            pass_criteria_met = True
        elif total_score >= 60:
            final_level = EvaluationLevel.PASS
            pass_criteria_met = True
        else:
            final_level = EvaluationLevel.FAIL
            pass_criteria_met = False
        
        # 生成高管摘要
        executive_summary = self._generate_executive_summary(
            dimension_scores, total_score, final_level, veto_reasons
        )
        
        # 提取关键问题和建议
        critical_issues = self._extract_critical_issues(dimension_scores)
        actionable_suggestions = self._extract_actionable_suggestions(dimension_scores)
        
        report = EvaluationReport(
            task_id=self.dialogue_data['metadata']['task_id'],
            total_score=total_score,
            final_level=final_level,
            dimensions=dimension_scores,
            executive_summary=executive_summary,
            critical_issues=critical_issues,
            actionable_suggestions=actionable_suggestions,
            pass_criteria_met=pass_criteria_met,
            veto_reasons=veto_reasons
        )
        
        print("\n" + "="*70)
        print(f"评测完成!总分: {total_score:.1f} - {final_level.value}")
        print("="*70)
        
        return report
    
    def _generate_executive_summary(self, 
                                    dimensions: List[DimensionScore],
                                    total_score: float,
                                    level: EvaluationLevel,
                                    veto_reasons: List[str]) -> str:
        """生成高管摘要"""
        lines = [
            f"## 评测结论: {level.value} ({total_score:.1f}/100)",
            ""
        ]
        
        if veto_reasons:
            lines.append("### ⚠️ 一票否决原因")
            for reason in veto_reasons:
                lines.append(f"- {reason}")
            lines.append("")
        
        lines.append("### 各维度得分")
        for dim in dimensions:
            emoji = "✅" if dim.score >= 80 else "⚠️" if dim.score >= 60 else "❌"
            lines.append(
                f"{emoji} **{dim.dimension}**: {dim.weighted_score:.1f}/{dim.weight*100:.0f} "
            )
        
        lines.append("")
        lines.append("### 核心发现")
        
        # 最高分维度
        best_dim = max(dimensions, key=lambda d: d.score)
        lines.append(f"- ✨ **优势**: {best_dim.dimension}表现最好")
        
        # 最低分维度
        worst_dim = min(dimensions, key=lambda d: d.score)
        lines.append(f"- 🔧 **待改进**: {worst_dim.dimension}需要重点优化")
        
        return "\n".join(lines)
    
    def _extract_critical_issues(self, dimensions: List[DimensionScore]) -> List[str]:
        """提取关键问题"""
        critical = []
        
        for dim in dimensions:
            if dim.score < 60:  # 不合格的维度
                critical.extend([f"【{dim.dimension}】{issue}" for issue in dim.issues])
            elif dim.score < 75:  # 合格但需改进的维度
                # 只取前2个最重要的问题
                critical.extend([f"【{dim.dimension}】{issue}" for issue in dim.issues[:2]])
        
        return critical
    
    def _extract_actionable_suggestions(self, dimensions: List[DimensionScore]) -> List[str]:
        """提取可执行建议(按优先级)"""
        suggestions = []
        
        # 按分数从低到高排序,优先改进低分项
        sorted_dims = sorted(dimensions, key=lambda d: d.score)
        
        for dim in sorted_dims:
            if dim.suggestions:
                # 为每条建议添加维度标签，最多取前3条
                for suggestion in dim.suggestions[:3]:
                    # 清理建议文本，移除多余的空格和编号
                    clean_suggestion = suggestion.strip()
                    # 如果建议已经以数字开头（如"1."），则移除它
                    if clean_suggestion and clean_suggestion[0].isdigit():
                        parts = clean_suggestion.split('.', 1)
                        if len(parts) > 1:
                            clean_suggestion = parts[1].strip()
                    if clean_suggestion:
                        suggestions.append(f"【{dim.dimension}】{clean_suggestion}")
        
        return suggestions
    
    def generate_report(self, output_path: str = None) -> str:
        """
        生成评测报告
        
        Args:
            output_path: 输出路径(可选)
            
        Returns:
            报告文本
        """
        report = self.evaluate()
        
        lines = [
            "="*80,
            "基于LLM的实训智能体评测报告",
            "="*80,
            "",
            f"任务ID: {report.task_id}",
            f"评测时间: {self.dialogue_data['metadata']['workflow_start_time']}",
            f"学生类型: {self.dialogue_data['metadata'].get('student_profile_label', '未知')}",
            f"对话轮次: {self.dialogue_data['metadata']['total_rounds']}",
            "",
            "="*80,
            report.executive_summary,
            "",
            "="*80,
            "详细分析",
            "="*80,
            ""
        ]
        
        # 各维度详情
        for dim in report.dimensions:
            lines.extend([
                f"### {dim.dimension}",
                f"**得分**: {dim.weighted_score:.1f}/{dim.weight*100:.0f} ",
                f"**等级**: {dim.level}",
                "",
                f"**分析**:",
                dim.analysis,
                "",
                f"**支撑证据**:",
            ])
            for evidence in dim.evidence:
                lines.append(f"  ✓ {evidence}")
            
            lines.append("")
            lines.append(f"**发现的问题**:")
            for issue in dim.issues:
                lines.append(f"  ✗ {issue}")
            
            lines.append("")
            lines.append(f"**改进建议**:")
            for suggestion in dim.suggestions:
                lines.append(f"  → {suggestion}")
            
            lines.append("")
            lines.append("-"*80)
            lines.append("")
        
        # 关键问题汇总
        lines.extend([
            "="*80,
            "关键问题汇总",
            "="*80,
            ""
        ])
        for issue in report.critical_issues:
            lines.append(f"• {issue}")
        
        # 可执行建议
        lines.extend([
            "",
            "="*80,
            "可执行建议(按优先级)",
            "="*80,
            ""
        ])
        for suggestion in report.actionable_suggestions:
            lines.append(suggestion)
        
        # 最终结论
        lines.extend([
            "",
            "="*80,
            "最终结论",
            "="*80,
            f"",
            f"总分: {report.total_score:.1f}/100",
            f"等级: {report.final_level.value}",
            f"是否合格: {'✅ 是' if report.pass_criteria_met else '❌ 否'}",
            ""
        ])
        
        if report.veto_reasons:
            lines.append("⚠️ 一票否决原因:")
            for reason in report.veto_reasons:
                lines.append(f"  • {reason}")
        
        lines.extend([
            "",
            "="*80,
            "评测完成",
            "="*80
        ])
        
        report_text = "\n".join(lines)
        
        if output_path:
            with open(output_path, 'w', encoding='utf-8') as f:
                f.write(report_text)
            print(f"\n✓ 报告已保存: {output_path}")
        
        return report_text


def main():
    """主函数"""
    import sys
    
    if len(sys.argv) < 3:
        print("用法: python llm_evaluation_agent.py <教师文档> <对话记录.json> [API_KEY]")
        print("\n或设置环境变量:")
        print("  export OPENAI_API_KEY=your_key")
        print("  export OPENAI_BASE_URL=https://api.openai.com/v1  # 可选")
        sys.exit(1)
    
    teacher_doc = sys.argv[1]
    dialogue_json = sys.argv[2]
    api_key = sys.argv[3] if len(sys.argv) > 3 else None
    
    try:
        agent = LLMEvaluationAgent(
            teacher_doc_path=teacher_doc,
            dialogue_json_path=dialogue_json,
            llm_api_key=api_key
        )
        
        output_path = dialogue_json.replace('.json', '_llm_evaluation.txt')
        agent.generate_report(output_path)
        
    except Exception as e:
        print(f"\n❌ 错误: {str(e)}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()
