---
name: hr-doc-generation
description: 生成人事/行政类 Word、Excel 文档的标准工作流。适用于招聘需求提报单、Offer、入职登记、制度、考勤报表、台账等 HR 文档任务。
version: 1.0.0
author: Hermes HR Admin
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [hr, hr-doc, docx, xlsx, human-resources, admin]
    category: productivity
    related_skills: [docx, xlsx, pdf, powerpoint]
---

# HR 文档生成工作流

## 何时使用

用户要求生成任何人事/行政文档、表单、制度、报表、台账时使用本技能。

## 必须按顺序执行

1. **读取上下文**：先读取 `AGENTS.md`、`company_context.json`（如存在）、`data/` 中的台账。
2. **检查模板**：检查 `templates/` 下是否有对应模板；有则必须基于模板填充。
3. **确定输出目录**：使用 `output/<任务编号>/`，任务编号可用日期加序号，如 `output/20260820-001/`。
4. **生成正文**：先输出 Markdown 结构化正文。
5. **生成文件**：如需 Word 使用 `docx` 技能，如表格/台账使用 `xlsx` 技能，按对应 SKILL.md 执行。
6. **校验与交付**：信息不足的字段列为“待确认字段”；文件写入后在回复末尾用“📎 生成文件”列出相对路径。

## 质量要求

- 不要编造员工、薪资、日期等数据
- 制度类文档：目的 → 适用范围 → 职责 → 流程 → 检查清单
- 表单类文档：字段分组清晰，附填写说明
- 报表类文档：先定义统计口径，再用公式，不心算
