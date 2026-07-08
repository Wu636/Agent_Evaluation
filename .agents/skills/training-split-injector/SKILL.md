---
name: training-split-injector
description: 能力训练拆分与合并注入器 - 支持两种操作模式：(1) 拆分模式：从智慧树平台提取已搭建好的能力训练（含多个关卡），按关卡拆分为独立能力训练，注入到指定目标任务；(2) 合并模式：将多个独立能力训练合并为一个能力训练，支持串联合并和分支合并。自动识别关卡结构、排除分支节点、保留原始编号、全量克隆节点内容和附件资源。关键词:能力训练拆分、能力训练合并、关卡注入、节点克隆、API自动化、Polymas平台
allowed-tools: Read, Grep, Glob, Write, Bash
---

# 能力训练拆分与合并注入器

## 使用时机

当用户提出以下需求时使用此 skill：

**拆分模式**：
- 用户想把一个已搭建好的能力训练（含多个关卡）拆分成多个独立能力训练
- 用户提到"拆分能力训练"、"关卡拆分"、"把XX关拆成单独的"
- 用户提供了源数据文件（queryscriptsteplist.json / queryscriptstepflowlist.json）并要求拆分

**合并模式**：
- 用户想把多个独立能力训练合并成一个能力训练
- 用户提到"合并能力训练"、"把几个训练拼到一起"、"做多分支训练"
- 用户需要创建一个包含多个分支路径的能力训练
- 用户有多个已搭建好的训练，想串联或分支合并

## 概述

本 skill 支持两种操作模式：

### 拆分模式（split_training.py）

将一个包含 N 个关卡的能力训练，拆分为 N 个独立的能力训练。每个关卡的内容原样保留，只是从整体中分离出来成为独立训练。

```
提取源数据 → 分析关卡结构 → 规划拆分方案 → Dry-run验证 → 正式注入
```

### 合并模式（merge_training.py）

将 M 个独立能力训练合并为一个能力训练。支持两种合并方式：

- **串联合并（sequential）**：A → B → C，线性拼接，前一个训练的末节点连接到后一个训练的首节点
- **分支合并（branch）**：A → [分支节点] → B / C → END，在训练之间插入分支选择节点，学生可自主选择路径

```
查询各源训练 → 分析首末节点 → 规划合并方案 → Dry-run验证 → 正式注入
```

## Instructions

### 第一步：获取源数据

源数据是平台能力训练的节点列表和连线列表，有两种获取方式：

#### 方式 A：用户提供 JSON 文件

用户可能直接提供以下文件（通常从浏览器开发者工具导出）：
- `queryscriptsteplist.json` — 节点列表（包含每个关卡的详细配置）
- `queryscriptstepflowlist.json` — 连线列表（节点间的流转关系）

将这些文件放到工作目录。

#### 方式 B：通过 API 在线提取

如果用户提供了 `AUTHORIZATION` 和 `COOKIE`，可以通过 API 直接提取：

```python
import requests, json

BASE_URL = "https://cloudapi.polymas.com/teacher-course/abilityTrain"
headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Authorization": "<用户提供的Authorization>",
    "Cookie": "<用户提供的Cookie>",
}

# 提取节点
resp = requests.post(f"{BASE_URL}/queryScriptStepList",
    headers=headers,
    json={"trainTaskId": "<源任务ID>", "trainSubType": "ability"})
nodes = resp.json()["data"]

# 提取连线
resp = requests.post(f"{BASE_URL}/queryScriptStepFlowList",
    headers=headers,
    json={"trainTaskId": "<源任务ID>"})
flows = resp.json()["data"]

# 保存
json.dump({"data": nodes}, open("queryscriptsteplist.json", "w"), ensure_ascii=False, indent=2)
json.dump({"data": flows}, open("queryscriptstepflowlist.json", "w"), ensure_ascii=False, indent=2)
```

### 第二步：分析关卡结构

读取源数据后，分析以下内容：

1. **节点分类**：
   - `SCRIPT_START` — 起始节点（1个）
   - `SCRIPT_END` — 结束节点（1个）
   - `SCRIPT_NODE` — 业务节点（需要拆分的）

2. **关卡识别**：
   - Header 节点：名称匹配 `关卡[一二三四五六七八九十][：:]`（如"关卡一：初入帝国"）
   - 子关卡节点：名称匹配 `关卡[1-9]\.`（如"关卡1.1：理解封装"）
   - 分支节点：不属于任何关卡的节点（如"选择关卡二或关卡三"），默认**排除**

3. **连线分类**：
   - **组内连线**：起点和终点都在同一关卡内 → 保留
   - **边界出边**：起点在当前关卡、终点在其他关卡 → 改指向 END
   - **边界入边**：起点在其他关卡、终点在当前关卡 → 忽略（START 会单独连首节点）

4. **确认拆分规则**（向用户确认）：
   - 是否排除分支节点？（默认：是）
   - 是否保留原始关卡编号？（默认：是，不重编号）
   - 是否只拆分部分关卡？（默认：全部拆分）

### 第三步：生成拆分脚本

使用本 skill 附带的 `split_training.py` 脚本模板（见下方"脚本模板"部分），根据实际关卡数量修改以下配置：

1. **`LEVEL_META`**：根据源数据中实际关卡数配置
2. **`SKIP_NAMES`**：需要排除的分支节点名称
3. **`SOURCE_COURSE_ID`**：源训练的 courseId

### 第四步：Dry-run 验证

先执行 dry-run 确认拆分方案：

```bash
python split_training.py --dry-run
```

检查输出：
- 每个关卡的业务节点数量是否正确
- 节点名称是否正确（是否保留原始编号）
- 组内连线数量是否合理
- 边界出边是否正确识别

### 第五步：正式注入

1. **前提条件**：
   - 用户已在平台上创建好空的目标能力训练任务
   - 用户提供每个关卡对应的目标任务 ID
   - `.env` 文件中配置了有效的 `AUTHORIZATION` 和 `COOKIE`

2. **执行注入**：

```bash
python split_training.py --import \
    --level1 <TASK_ID_1> --level2 <TASK_ID_2> ... --levelN <TASK_ID_N>
```

3. **注入流程**（每个关卡自动执行）：
   - 清空目标任务中的现有节点和连线
   - 创建 START 和 END 节点
   - 逐个克隆业务节点（最小创建 → 全量编辑补全）
   - 创建连线：START→首节点 + 组内连线 + 边界出边→END
   - 回采验证：检查节点数、连线数、附件数是否匹配

4. **认证要求**：
   - AUTHORIZATION 和 COOKIE 必须是**最新的**（从浏览器登录平台后获取）
   - Token 有效期约 24 小时，过期会返回 401
   - 如果返回 401，请用户重新登录平台获取新凭证

---

## 合并模式使用流程

### 第一步：准备源训练信息

收集用户要合并的多个能力训练的任务 ID（trainTaskId），以及目标空任务的 ID 和 courseId。

### 第二步：确认合并模式

向用户确认合并方式：

1. **串联合并（sequential）**：
   - 适用场景：多个训练按顺序依次进行
   - 结构：START → 源A首节点 → ... → 源A末节点 → 源B首节点 → ... → 源B末节点 → ... → END
   - 跨源连线：前一个训练的末节点 → 后一个训练的首节点

2. **分支合并（branch）**：
   - 适用场景：学生可以自主选择训练路径
   - 结构：START → 源A首节点 → ... → 源A末节点 → [分支节点] → 源B / 源C → ... → END
   - 自动创建分支节点，提供选择提示词
   - 分支节点之后各源训练并行，最终都连向 END

### 第三步：确认关卡续编号

如果多个源训练都包含"关卡一"等相同编号，需要确认是否续编号：

- **不续编号（默认）**：各源训练保留原始关卡号（可能出现重复的"关卡一"）
- **续编号（--renumber）**：自动续编（源A关卡一~三保持，源B关卡一~二重编为关卡四~五）

### 第四步：Dry-run 验证

```bash
# 串联合并预览
python merge_training.py --dry-run \
    --target <TARGET_TASK_ID> --course-id <COURSE_ID> \
    --source1 <TASK_ID_A> --source2 <TASK_ID_B> --source3 <TASK_ID_C> \
    --mode sequential --renumber

# 分支合并预览
python merge_training.py --dry-run \
    --target <TARGET_TASK_ID> --course-id <COURSE_ID> \
    --source1 <TASK_ID_A> --source2 <TASK_ID_B> --source3 <TASK_ID_C> \
    --mode branch --renumber
```

检查输出：
- 各源训练的节点数、连线数、首末节点数
- 关卡续编号映射是否正确
- 跨源连线数量是否合理
- 分支模式下分支节点是否正确创建

### 第五步：正式合并注入

```bash
# 串联合并
python merge_training.py --import \
    --target <TARGET_TASK_ID> --course-id <COURSE_ID> \
    --source1 <A> --source2 <B> --source3 <C> \
    --mode sequential --renumber

# 分支合并
python merge_training.py --import \
    --target <TARGET_TASK_ID> --course-id <COURSE_ID> \
    --source1 <A> --source2 <B> --source3 <C> \
    --mode branch --renumber
```

**合并注入流程**（自动执行）：
1. 清空目标任务中的现有节点和连线
2. 创建 START 和 END 节点
3. 逐个查询源训练，克隆所有业务节点（跳过原 START/END）
4. 创建各源训练的组内连线（ID 重映射）
5. 创建跨源连线：
   - sequential：START→首源首节点 → ... → 末源末节点→END
   - branch：START→首源首节点 → ... → 分支节点 → 各分支源首节点 → ... → END
6. 回采验证：检查节点数、连线数、附件数

### 合并模式特有注意事项

1. **首末节点识别**：通过源训练的 START→节点 和 节点→END 连线自动识别首末节点。如果一个训练有多个首节点或末节点，全部保留。

2. **分支节点自动创建**：branch 模式下自动创建分支节点，默认配置见 `BRANCH_NODE_TEMPLATE`。可根据需要修改节点名称、提示词等。

3. **跨源连线条件继承**：串联模式下，源N末节点→源N+1首节点的连线条件继承自源N末节点→END 的连线条件（如果有）。

4. **关卡续编号**：`--renumber` 参数自动计算续编号映射。例如源A有关卡1-3，源B有关卡1-2，则源B重编为4-5。开场白中的关卡名称也会同步替换。

## 脚本模板

以下是通用拆分脚本的核心结构。实际使用时需要根据源数据调整 `LEVEL_META` 和 `SKIP_NAMES`。

### 关键数据结构

#### 节点结构（stepDetailDTO 核心字段）

```python
{
    "nodeType": "SCRIPT_NODE",          # 节点类型
    "stepName": "关卡1.1：理解封装",      # 节点名称（用于关卡识别）
    "description": "...",                # 节点描述
    "prologue": "...",                   # 开场白
    "modelId": "Doubao-Seed-2.0-pro",   # 模型ID
    "llmPrompt": "...",                  # 提示词
    "trainerName": "...",                # 训练官名称
    "interactiveRounds": 5,              # 互动轮次
    "scriptStepCover": {...},            # 背景图
    "scriptStepResourceList": [...],     # 附件资源列表
    "stepExtProperty": {...},            # 扩展属性（含resources）
    "knowledgeBaseSwitch": 1,            # 知识库开关
    "searchEngineSwitch": 1,             # 搜索引擎开关
    "agentId": "Tg3LpKo28D",            # 智能体ID
    "avatarNid": "...",                  # 数字人ID
    "historyRecordNum": -1,              # 历史记录数
}
```

#### 连线结构（核心字段）

```python
{
    "flowId": "...",
    "scriptStepStartId": "...",          # 起点节点ID
    "scriptStepEndId": "...",            # 终点节点ID
    "flowCondition": "NEXT_TO_XXX",      # 流转条件
    "flowConfiguration": {...},          # 流转配置（条件组）
    "transitionPrompt": "...",           # 过渡提示词
    "transitionHistoryNum": -1,          # 过渡历史记录数
    "isDefault": 1,                      # 是否默认流转
}
```

### 核心函数说明

| 函数 | 作用 |
|------|------|
| `load_source()` | 加载源 JSON 文件 |
| `group_nodes_by_level()` | 按关卡分组节点，排除分支节点 |
| `classify_flows()` | 将连线分为组内/边界出边 |
| `clean_task()` | 清空目标任务的所有节点和连线 |
| `create_start_end_nodes()` | 创建 START 和 END 节点 |
| `create_script_node_min()` | 最小化创建业务节点 |
| `build_clone_detail()` | 构造全量编辑载荷（含资源重映射） |
| `edit_script_step()` | 全量编辑节点补全内容 |
| `create_script_flow()` | 创建连线（可从源连线继承字段） |
| `import_level()` | 完整导入单个关卡 |
| `convert_resources()` | 资源格式转换（读形状→写形状） |

### 资源转换要点

源数据中附件资源有两种存在形式，注入时都需要处理：

1. **`scriptStepResourceList`**（扁平列表）→ 重映射 `trainTaskId` 和 `scriptStepId`，移除 `scriptStepResourceId`
2. **`stepExtProperty.resources`**（分组结构）→ 重新构建，每组包含 `nid`、`category`、`list`

```python
# 资源重映射核心逻辑
for r in src_resources:
    r["trainTaskId"] = new_task_id
    r["scriptStepId"] = new_step_id
    r.pop("scriptStepResourceId", None)  # 让平台分配新ID
```

### 连线创建逻辑

```python
# 1. START → 首节点（无条件）
create_script_flow(task_id, start_id=START, end_id=first_node, cond="")

# 2. 组内连线（从源连线继承条件、过渡提示词等）
for fl in internal_flows:
    create_script_flow(task_id, src_flow=fl,
        start_id=id_map[fl["scriptStepStartId"]],
        end_id=id_map[fl["scriptStepEndId"]])

# 3. 边界出边 → END（从源连线继承条件）
for fl in boundary_out_flows:
    create_script_flow(task_id, src_flow=fl,
        start_id=id_map[fl["scriptStepStartId"]],
        end_id=END)
```

### 空流转配置

创建连线时如果源连线没有 `flowConfiguration`，使用以下默认值：

```python
EMPTY_FLOW_CFG = {
    "relation": "and",
    "conditions": [
        {"text": "条件组1", "relation": "and", "conditions": [{"text": ""}]}
    ],
}
```

## API 接口清单

| 接口 | 方法 | 用途 |
|------|------|------|
| `queryScriptStepList` | POST | 查询任务的所有节点 |
| `queryScriptStepFlowList` | POST | 查询任务的所有连线 |
| `createScriptStep` | POST | 创建节点（START/END/SCRIPT_NODE） |
| `editScriptStep` | POST | 全量编辑节点（补全内容、资源、封面等） |
| `delScriptStep` | POST | 删除节点 |
| `createScriptStepFlow` | POST | 创建连线 |
| `delScriptStepFlow` | POST | 删除连线 |

**基础 URL**: `https://cloudapi.polymas.com/teacher-course/abilityTrain`

**认证**: Authorization header + Cookie header 双重认证

## 重要注意事项

### 通用注意事项

1. **认证有效期**: AUTHORIZATION 和 COOKIE 有效期约 24 小时，过期返回 401。必须从浏览器实时获取。

2. **清空操作不可逆**: `clean_task()` 会删除目标任务中的所有节点和连线。注入前请确认目标任务是可以覆盖的。

3. **节点创建两步走**: 先 `createScriptStep`（最小化创建，只含基本字段），再 `editScriptStep`（全量编辑补全提示词、资源、封面等）。这是因为创建接口不接受全部字段。

4. **资源 ID 重映射**: 克隆节点时必须重映射 `trainTaskId` 和 `scriptStepId` 为目标任务和新建节点的 ID，否则资源绑定错误。

5. **nanoid 生成**: 新节点和连线的 ID 使用 `nanoid.generate(size=21)` 生成，确保全局唯一。

6. **回采验证**: 每个关卡/源训练注入后自动回采验证节点数、连线数、附件数，确保与源数据一致。

7. **courseId**: 源训练和目标训练可能使用不同的 courseId，注入时使用目标训练的 courseId。

### 拆分模式专属注意事项

8. **分支节点处理**: 默认排除不属于任何关卡的分支节点（如"选择关卡二或关卡三"）。如果用户需要保留，修改 `SKIP_NAMES` 为空集合。

9. **关卡编号**: 默认保留原始关卡编号（关卡二还是关卡二，不重编为关卡一）。如需重编号，设置 `rmap = {old_level: new_level}`。

10. **部分导入**: 支持只导入部分关卡，只需提供对应的 `--levelN` 参数即可。

### 合并模式专属注意事项

11. **首末节点自动识别**: 合并时通过 START→节点 和 节点→END 的连线自动识别各源训练的首末节点。

12. **分支节点模板**: branch 模式下使用 `BRANCH_NODE_TEMPLATE` 自动创建分支节点，可根据场景修改模板中的提示词和配置。

13. **关卡续编号**: `--renumber` 自动计算续编号映射，同时替换节点名称和开场白中的关卡编号。不使用 `--renumber` 时保留原始编号（可能出现重复编号）。

## 排错指南

### 401 拒绝访问
- 检查 `.env` 中的 `AUTHORIZATION` 和 `COOKIE` 是否为最新
- 让用户重新登录平台，从浏览器开发者工具复制最新凭证
- 注意：Cookie 中包含多个字段，需完整复制

### 节点创建失败
- 检查 `nodeType` 是否正确（SCRIPT_START / SCRIPT_END / SCRIPT_NODE）
- 检查 `trainSubType` 是否为 "ability"
- 检查 `agentId` 是否有效

### 资源丢失
- 确认 `scriptStepResourceList` 中的 `fileId` 不为空
- 确认 `stepExtProperty.resources` 已正确转换
- 检查 `convert_resources()` 的分组逻辑

### 连线创建失败
- 检查 `scriptStepStartId` 和 `scriptStepEndId` 是否为新建节点的 ID
- 检查 `scriptStepStartHandle` 和 `scriptStepEndHandle` 格式是否正确
- 确认 `flowConfiguration` 不为空

## Version History

- v1.0 (2026-07-08): 拆分模式初始版本，支持 N 关卡拆分注入，自动识别关卡结构，排除分支节点，保留原始编号，全量克隆节点和资源
- v1.1 (2026-07-08): 新增合并模式，支持串联合并（sequential）和分支合并（branch），自动识别首末节点，关卡续编号，分支节点自动创建
