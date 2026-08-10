import unittest

try:
    from .skill_review_service import (
        CorrectionSkillError,
        build_skill_score_table,
        compact_skill_report,
        normalize_skill_models,
    )
except ImportError:
    from skill_review_service import (
        CorrectionSkillError,
        build_skill_score_table,
        compact_skill_report,
        normalize_skill_models,
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
