# API 参考文档

## 平台 API 概览

**基础 URL**: `https://cloudapi.polymas.com/teacher-course/abilityTrain`

**认证方式**: Authorization header (JWT) + Cookie header (会话)

### 请求格式

所有接口均为 POST 请求，Content-Type: `application/json; charset=utf-8`

```python
headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Authorization": "<JWT Token>",
    "Cookie": "<完整 Cookie>",
    "User-Agent": "Mozilla/5.0 ...",
}
```

### 响应格式

```json
{
    "code": 200,
    "success": true,
    "data": "...",
    "msg": null
}
```

- `code == 200` 或 `success == true` 表示成功
- 401 表示认证过期，需重新获取凭证

---

## 接口详情

### 1. queryScriptStepList — 查询节点列表

```python
payload = {
    "trainTaskId": "<任务ID>",
    "trainSubType": "ability"
}
```

返回 `data` 为节点数组，每个节点包含：
- `stepId`: 节点唯一 ID
- `stepDetailDTO`: 节点详情（包含 nodeType, stepName, llmPrompt, prologue 等）

### 2. queryScriptStepFlowList — 查询连线列表

```python
payload = {
    "trainTaskId": "<任务ID>"
}
```

返回 `data` 为连线数组，每条连线包含：
- `flowId`: 连线唯一 ID
- `scriptStepStartId`: 起点节点 ID
- `scriptStepEndId`: 终点节点 ID
- `flowCondition`: 流转条件（如 "NEXT_TO_STAGE2"）
- `flowConfiguration`: 条件组配置
- `transitionPrompt`: 过渡提示词

### 3. createScriptStep — 创建节点

**START/END 节点最小载荷**:
```python
{
    "trainTaskId": "<任务ID>",
    "stepId": "<nanoid(21)>",
    "stepDetailDTO": {
        "nodeType": "SCRIPT_START",  # 或 SCRIPT_END
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
        "trainSubType": "ability"
    },
    "positionDTO": {"x": 0, "y": 300},
    "courseId": "<courseId>",
    "libraryFolderId": ""
}
```

**SCRIPT_NODE 最小创建载荷**（后续用 editScriptStep 补全）:
```python
{
    "trainTaskId": "<任务ID>",
    "stepId": "<nanoid(21)>",
    "stepDetailDTO": {
        "nodeType": "SCRIPT_NODE",
        "stepName": "关卡1.1：...",
        "description": "...",
        "prologue": "",  # 创建时留空，edit 时补全
        "modelId": "Doubao-Seed-2.0-pro",
        "llmPrompt": "",  # 创建时留空，edit 时补全
        "trainerName": "...",
        "interactiveRounds": 5,
        "scriptStepCover": {},
        "whiteBoardSwitch": 0,
        "agentId": "Tg3LpKo28D",
        "avatarNid": "...",
        "videoSwitch": 0,
        "scriptStepResourceList": [],
        "knowledgeBaseSwitch": 1,
        "searchEngineSwitch": 1,
        "historyRecordNum": -1,
        "trainSubType": "ability"
    },
    "positionDTO": {"x": 100, "y": 100},
    "courseId": "<courseId>",
    "libraryFolderId": ""
}
```

### 4. editScriptStep — 全量编辑节点

```python
{
    "trainTaskId": "<任务ID>",
    "stepId": "<已创建的节点ID>",
    "stepDetailDTO": {
        # 完整的 stepDetailDTO，包含所有字段
        "nodeType": "SCRIPT_NODE",
        "stepName": "...",
        "description": "...",
        "prologue": "...",           # 开场白
        "modelId": "...",
        "llmPrompt": "...",          # 提示词
        "trainerName": "...",
        "interactiveRounds": 5,
        "scriptStepCover": {...},    # 背景图
        "scriptStepResourceList": [...],  # 附件资源（已重映射 trainTaskId/scriptStepId）
        "stepExtProperty": {
            "resources": [...]       # 分组资源结构
        },
        # ... 其他字段
    },
    "positionDTO": {"x": 200, "y": 300},
    "courseId": "<courseId>"
}
```

### 5. delScriptStep — 删除节点

```python
payload = {
    "trainTaskId": "<任务ID>",
    "stepId": "<节点ID>"
}
```

### 6. createScriptStepFlow — 创建连线

```python
{
    "trainTaskId": "<任务ID>",
    "flowId": "<nanoid(21)>",
    "scriptStepStartId": "<起点节点ID>",
    "scriptStepStartHandle": "<起点ID>-source-bottom",
    "scriptStepEndId": "<终点节点ID>",
    "scriptStepEndHandle": "<终点ID>-target-top",
    "flowCondition": "NEXT_TO_XXX",  # 流转条件
    "flowConfiguration": {           # 条件组
        "relation": "and",
        "conditions": [
            {"text": "条件组1", "relation": "and", "conditions": [{"text": ""}]}
        ]
    },
    "flowSettingType": "quick",
    "transitionPrompt": "...",       # 过渡提示词
    "transitionHistoryNum": -1,
    "isDefault": 1,
    "isError": False
}
```

### 7. delScriptStepFlow — 删除连线

```python
payload = {
    "trainTaskId": "<任务ID>",
    "flowId": "<连线ID>"
}
```

---

## 资源结构说明

### scriptStepResourceList（扁平列表，用于 editScriptStep）

每个资源项：
```python
{
    "fileId": "<文件ID>",
    "fileName": "coordinate.h",
    "fileUrl": "<文件URL>",
    "thumbnail": "",
    "type": "resource",
    "isRequired": True,
    "description": "",
    "resourceTypeNid": "<资源类型NID>",
    "category": "代码文件",
    "trainTaskId": "<目标任务ID>",   # 必须重映射
    "scriptStepId": "<新节点ID>",    # 必须重映射
    "sort": 1
    # scriptStepResourceId 移除，让平台分配
}
```

### stepExtProperty.resources（分组结构，用于 editScriptStep）

```python
[
    {
        "nid": "<资源类型NID>",
        "category": "代码文件",
        "list": [
            {
                "type": "resource",
                "fileId": "...",
                "fileName": "...",
                "fileUrl": "...",
                "thumbnail": "",
                "isRequired": True,
                "description": "",
                "trainTaskId": "<目标任务ID>",
                "scriptStepId": "<新节点ID>",
                "sort": 1,
                "scriptStepResourceId": "<nanoid(20)>"
            }
        ]
    }
]
```

---

## 常见问题

### Q: 为什么创建节点要分两步（create + edit）？
A: createScriptStep 接口不接受全部字段（如 llmPrompt、prologue、scriptStepCover 等），必须先用最小载荷创建节点，再用 editScriptStep 全量补全。

### Q: 资源为什么要同时设置 scriptStepResourceList 和 stepExtProperty.resources？
A: 平台两种形式都会使用：scriptStepResourceList 是扁平列表用于存储，stepExtProperty.resources 是分组结构用于前端展示。注入时两种都要正确设置。

### Q: nanoid 的 size 有什么讲究？
A: 节点和连线 ID 使用 size=21，资源 ID 使用 size=20。这是平台的惯例，保持一致避免冲突。

### Q: 连线的 Handle 格式是什么？
A: 起点 handle 为 `{startId}-source-bottom`，终点 handle 为 `{endId}-target-top`。这是平台 React Flow 的固定格式。

### Q: 如何获取最新的 AUTHORIZATION 和 COOKIE？
A: 在浏览器中登录 Polymas 平台，打开开发者工具（F12）→ Network 标签页，找到任意 API 请求，从 Request Headers 中复制 Authorization 和 Cookie 的完整值。注意 Cookie 很长，包含多个字段，需完整复制。
