# PLC 35 案例能力训练流水线

## 已完成

- `01_sources/`：DOCX 拆出的 35 个案例和 `case_manifest.json`。
- `02_generated/`：35 份 Claude Opus 4.8 逐案生成的剧本、评分标准和原始 SSE；`generation_report.json` 显示 35 成功、0 失败。
- `03_composed/`：7 个分支源配置；`03_composed/final/` 是可直接注入三个目标任务的最终图结构脚本和聚合评分标准。
- `assets/`：正文实际引用的 28 个唯一媒体文件；`04_manifests/resource_manifest.json` 记录 30 个放置位，重复媒体已指向现有文件。
- `04_manifests/resource_placement_plan.md`：图片对应卡片和转换提示。
- `04_manifests/branch_injection_plan.md`：三个目标训练的分支、阶段、节点和连线预期。

## 复现命令

```bash
python3 plc_case_pipeline/extract_cases.py \
  "/Users/w/智慧树/能力训练/未完成/可编程序控制器原理及应用--内蒙古工业大学/35 案例/1基础案例实操训练(1).docx"
python3 plc_case_pipeline/extract_media.py \
  "/Users/w/智慧树/能力训练/未完成/可编程序控制器原理及应用--内蒙古工业大学/35 案例/1基础案例实操训练(1).docx"
python3 plc_case_pipeline/generate_cases.py --model claude-opus-4-8 --workers 1
python3 plc_case_pipeline/compose_branches.py
python3 plc_case_pipeline/compose_final_graphs.py
python3 plc_case_pipeline/compose_final_rubrics.py
```

正式注入前需要目标平台的 `Authorization`、`Cookie`，以及训练 1/2/3 的完整页面链接或任务 ID。收到后先做 dry-run 回采，再逐个目标确认导入。
