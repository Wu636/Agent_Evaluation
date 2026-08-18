import unittest
import tempfile
import zipfile
from pathlib import Path

try:
    from .skill_review_service import (
        CorrectionSkillError,
        build_grading_skill_metadata_payload,
        build_submission_requirement_from_overview,
        build_skill_score_table,
        compact_skill_report,
        normalize_skill_models,
        validate_grading_skill_package,
    )
except ImportError:
    from skill_review_service import (
        CorrectionSkillError,
        build_grading_skill_metadata_payload,
        build_submission_requirement_from_overview,
        build_skill_score_table,
        compact_skill_report,
        normalize_skill_models,
        validate_grading_skill_package,
    )


def sample_report(total_score: float, item_score: float):
    return {
        "code": 200,
        "success": True,
        "data": {
            "skill": {
                "reportStatus": "SUCCESS",
                "name": "grading-skill",
                "createTime": "2026-08-10 15:09:17",
                "finishedAt": "2026-08-10 15:13:47",
            },
            "scoring": {
                "scoringType": "ITEMS",
                "totalScore": total_score,
                "scoreData": {
                    "totalScore": total_score,
                    "fullMark": 100,
                    "items": [
                        {
                            "itemIndex": 1,
                            "itemName": "数据表",
                            "itemScore": item_score,
                            "itemFullMark": 15,
                            "comment": "数据完整",
                            "itemAnswer": "这里是较长的学生原文，不应进入批量摘要",
                        }
                    ],
                },
            },
            "surfaces": [
                {
                    "surfaceId": "eval_0",
                    "templateType": "LIST",
                    "dataModelUpdate": {
                        "contents": [
                            {"key": "sectionTitle", "valueString": "综合评语"},
                            {
                                "key": "cards",
                                "valueArray": [
                                    {
                                        "key": "0",
                                        "valueMap": [
                                            {"key": "subtitle", "valueString": "整体良好"},
                                            {"key": "description", "valueString": "主要计算正确"},
                                        ],
                                    }
                                ],
                            },
                        ]
                    },
                },
                {
                    "surfaceId": "eval_2",
                    "templateType": "COMPARISON",
                    "dataModelUpdate": {
                        "contents": [
                            {"key": "sectionTitle", "valueString": "数据验算明细"},
                            {
                                "key": "entries",
                                "valueArray": [
                                    {
                                        "key": "0",
                                        "valueMap": [
                                            {"key": "title", "valueString": "表格1计算核对"},
                                            {
                                                "key": "status",
                                                "valueMap": [
                                                    {"key": "label", "valueString": "2 处错误"},
                                                    {"key": "type", "valueString": "warning"},
                                                ],
                                            },
                                        ],
                                    }
                                ],
                            },
                        ]
                    },
                },
            ],
        },
    }


class SkillReviewServiceTest(unittest.TestCase):
    @staticmethod
    def _write_skill_zip(path: Path, *, include_agents: bool = False) -> None:
        skill_text = """---
name: physics-lab-grading
description: 批阅大学物理实验报告，依据数据、图表和分析过程逐项评分，并输出综合评语与可执行改进建议。
---

# 大学物理实验批阅

## 批阅对象
学生提交的实验报告。

## 批阅流程
读取附件并逐项核对。

## 1. 评分项（score）
`score_type`: `dimension`
`full_score`: `100`

| 维度 | 分值 | 说明 | 证据 |
|---|---:|---|---|
| 数据 | 100 | 数据完整正确 | 报告正文 |

## 2. 评价项（evaluations）
输出综合评语和改进建议。

```json
{"score": {"total": 100}, "evaluations": {"综合评语": [], "改进建议": []}}
```
"""
        readme_text = """# 批阅技能 · 文件结构说明

本技能严格采用课程作业批阅模板。
"""
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("physics-lab-grading/README.md", readme_text)
            archive.writestr("physics-lab-grading/SKILL.md", skill_text)
            if include_agents:
                archive.writestr("physics-lab-grading/agents/openai.yaml", "name: test")

    def test_validate_grading_skill_package(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            package_path = Path(temp_dir) / "physics-lab-grading.zip"
            self._write_skill_zip(package_path)
            result = validate_grading_skill_package(str(package_path))

        self.assertEqual(result["rootName"], "physics-lab-grading")
        self.assertEqual(result["skillName"], "physics-lab-grading")
        self.assertEqual(result["displayName"], "大学物理实验批阅")
        self.assertEqual(result["fileCount"], 2)

    def test_validate_grading_skill_package_rejects_template_external_directory(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            package_path = Path(temp_dir) / "physics-lab-grading.zip"
            self._write_skill_zip(package_path, include_agents=True)
            with self.assertRaisesRegex(CorrectionSkillError, "模板外目录"):
                validate_grading_skill_package(str(package_path))

    def test_build_grading_metadata_preserves_card_fields_and_sets_type_one(self):
        payload = build_grading_skill_metadata_payload(
            skill_nid="A4hMufA32w",
            card={
                "cnName": "采购评阅助手",
                "description": "批阅采购案例讨论报告。",
                "iconUrl": "https://example.test/icon.png",
                "customTags": [{"id": 12}],
                "typeTagId": 2,
            },
        )

        self.assertEqual(payload["skillNid"], "A4hMufA32w")
        self.assertEqual(payload["cnName"], "采购评阅助手")
        self.assertEqual(payload["skillDesc"], "批阅采购案例讨论报告。")
        self.assertEqual(payload["iconUrl"], "https://example.test/icon.png")
        self.assertEqual(payload["customTagIds"], [12])
        self.assertEqual(payload["typeTagId"], 1)

    def test_build_submission_requirement_from_overview(self):
        requirement = build_submission_requirement_from_overview({
            "code": 200,
            "data": {
                "skill": {
                    "extractionStatus": "SUCCESS",
                    "description": "完成用模拟法测绘静电场实验报告。",
                },
                "scoring": {
                    "fullMark": 100,
                    "scoreData": {
                        "itemSplit": "按实验报告结构拆为2项。",
                        "items": [
                            {
                                "itemIndex": 1,
                                "itemFullMark": 25,
                                "itemContent": "表格数据",
                                "itemDescription": "6个电压各8次测量并计算均值。",
                            },
                            {
                                "itemIndex": 2,
                                "itemFullMark": 75,
                                "itemContent": "等势面及电场线",
                                "itemDescription": "方向、线型和标注正确。",
                            },
                        ],
                    },
                },
                "evaluations": [
                    {"evaluationName": "综合评语", "evaluationDescription": "整体表现概括"}
                ],
            },
        })

        self.assertIn("完成用模拟法测绘静电场实验报告", requirement)
        self.assertIn("评分要求（满分 100 分）", requirement)
        self.assertIn("1. 表格数据（25 分）", requirement)
        self.assertIn("综合评语：整体表现概括", requirement)

    def test_normalize_skill_models_uses_platform_fields_and_default(self):
        models = normalize_skill_models({
            "code": 200,
            "data": [
                {
                    "code": "claude-opus-4-8",
                    "description": "Claude Opus 4.8",
                    "logo": "https://example.test/opus.png",
                    "defaultFlag": 1,
                },
                {
                    "code": "gpt-5-2",
                    "description": "GPT-5.2",
                    "defaultFlag": 0,
                },
            ],
        })

        self.assertEqual([item["code"] for item in models], ["claude-opus-4-8", "gpt-5-2"])
        self.assertTrue(models[0]["isDefault"])
        self.assertFalse(models[1]["isDefault"])

    def test_report_history_response_is_not_treated_as_model_list(self):
        with self.assertRaises(CorrectionSkillError):
            normalize_skill_models({
                "code": 200,
                "data": {
                    "list": [
                        {"taskId": "test-1", "title": "批阅结果", "status": "SUCCESS"}
                    ]
                },
            })

    def test_compact_report_extracts_scoring_and_surface_cards(self):
        compact = compact_skill_report(
            sample_report(88, 13),
            file_name="学生A.docx",
            file_index=0,
            attempt_index=1,
            task_id="test-1",
            report_url="https://example.test/report",
        )

        self.assertTrue(compact["success"])
        self.assertEqual(compact["totalScore"], 88)
        self.assertEqual(compact["fullMark"], 100)
        self.assertEqual(compact["items"][0]["itemScore"], 13)
        self.assertNotIn("itemAnswer", compact["items"][0])
        self.assertEqual(compact["sections"][0]["title"], "综合评语")
        self.assertEqual(compact["sections"][0]["cards"][0]["subtitle"], "整体良好")
        self.assertEqual(compact["sections"][1]["title"], "数据验算明细")
        self.assertEqual(compact["sections"][1]["entries"][0]["title"], "表格1计算核对")
        self.assertEqual(compact["sections"][1]["entries"][0]["status"]["type"], "warning")

    def test_score_table_aggregates_attempts_and_variance(self):
        first = compact_skill_report(
            sample_report(88, 13),
            file_name="学生A.docx",
            file_index=0,
            attempt_index=1,
            task_id="test-1",
            report_url="https://example.test/report/1",
        )
        second = compact_skill_report(
            sample_report(92, 15),
            file_name="学生A.docx",
            file_index=0,
            attempt_index=2,
            task_id="test-2",
            report_url="https://example.test/report/2",
        )

        table = build_skill_score_table([second, first], attempts=2)
        student = table["students"][0]

        self.assertEqual(table["attempts"], 2)
        self.assertEqual(student["name"], "学生A")
        self.assertEqual(student["total_scores"], [88.0, 92.0])
        self.assertEqual(student["mean"], 90.0)
        self.assertEqual(student["variance"], 4.0)
        self.assertEqual(student["questions"][0]["scores"], [13.0, 15.0])
        self.assertEqual(student["questions"][0]["variance"], 1.0)


if __name__ == "__main__":
    unittest.main()
