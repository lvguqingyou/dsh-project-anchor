# -*- coding: utf-8 -*-
"""P1 视图重建：索引事实（JSONL）→ 可检索视图（Markdown），全量重建，幂等。

读：`_台账\索引.jsonl` + 各项目 `04-过程\索引.jsonl`（若存在）
写：`_台账\索引.md`（全量，按项目分组）、`_台账\自由会话.md`（仅未挂项目的行）

原则（方案 §9）：事实冻结、视图可变。本脚本只读事实，不修改任何 JSONL。
"""
import json
import os
import re
import sys
from datetime import datetime

from pathlib import Path

ROOT = str(Path(__file__).resolve().parents[1])
LEDGER_DIR = os.path.join(ROOT, "_台账")
OUT_ALL = os.path.join(LEDGER_DIR, "索引.md")
OUT_FREE = os.path.join(LEDGER_DIR, "自由会话.md")

STATUS_CN = {"done": "已完成", "active": "进行中", "blocked": "受阻", "unknown": "未知"}


def collect_shards():
    shards = []
    main = os.path.join(LEDGER_DIR, "索引.jsonl")
    if os.path.isfile(main):
        shards.append(main)
    for dirpath, dirnames, filenames in os.walk(ROOT):
        if "_scratch" in dirpath or "_归档" in dirpath:
            continue
        if "索引.jsonl" in filenames and os.path.join(dirpath, "索引.jsonl") != main:
            shards.append(os.path.join(dirpath, "索引.jsonl"))
    return shards


def load_attachments():
    """归属事实：每会话取 ts 最大的一条 attach（追加即覆盖，不改历史）。"""
    path = os.path.join(LEDGER_DIR, "归属.jsonl")
    latest = {}
    if not os.path.isfile(path):
        return latest
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("type") != "attach":
                continue
            sid = row.get("session")
            ts = row.get("ts") or ""
            if sid and (sid not in latest or ts >= latest[sid][0]):
                latest[sid] = (ts, row.get("project"))
    return {k: v[1] for k, v in latest.items()}


def load_rows():
    rows = {}
    for shard in collect_shards():
        with open(shard, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if row.get("type", "note") != "note":
                    continue
                key = (row.get("session"), row.get("node"))
                prev = rows.get(key)
                if prev is None or len(row.get("summary") or "") >= len(prev.get("summary") or ""):
                    rows[key] = row
    attachments = load_attachments()
    for row in rows.values():
        project = attachments.get(row.get("session"))
        if project is not None:
            row["project"] = project
    return list(rows.values())


def short_id(session):
    m = re.search(r"([0-9a-f]{8})", session or "")
    return m.group(1) if m else (session or "?")[:8]


def cell(text, limit=None):
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    if limit:
        text = text[:limit]
    return text.replace("|", "\\|")


def fmt_row(row):
    date = (row.get("ts_session") or "")[:10]
    nums = " / ".join(cell(n) for n in (row.get("numbers") or [])[:4])
    files = "、".join(os.path.basename(f) for f in (row.get("files") or [])[:3])
    return "| {d} | {s} | {n} | {c} | {num} | {f} | {st} |".format(
        d=date,
        s=short_id(row.get("session")),
        n=cell(row.get("node")),
        c=cell(row.get("summary"), 100),
        num=nums,
        f=cell(files),
        st=STATUS_CN.get(row.get("status"), row.get("status") or ""),
    )


HEADER = "| 日期 | 会话 | 节点 | 结论摘要 | 关键数字 | 产出 | 状态 |\n|---|---|---|---|---|---|---|"


def render_section(title, rows, with_heading=True):
    out = []
    if with_heading:
        out.append(f"## {title}（{len(rows)} 行）\n")
    out.append(HEADER)
    for row in rows:
        out.append(fmt_row(row))
    out.append("")
    return "\n".join(out)


def main():
    rows = load_rows()
    if not rows:
        print("!! 没有索引事实，按约定不生成视图", file=sys.stderr)
        return 1

    rows.sort(key=lambda r: (r.get("ts_session") or "", r.get("session") or ""), reverse=True)

    by_project = {}
    for row in rows:
        by_project.setdefault(row.get("project"), []).append(row)

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    project_keys = [k for k in by_project if k]
    project_keys.sort(key=lambda k: str(k))

    parts = [
        "# 索引（成果索引）",
        "",
        f"> 由 `dsh-project-anchor/tools/render.py` 于 {now} 全量重建，**请勿手工编辑**。",
        f"> 事实源：`_台账\\索引.jsonl` · 共 {len(rows)} 行 · {len(by_project)} 组 · {len({short_id(r.get('session')) for r in rows})} 个会话",
        ">",
        "> 检索：直接在本文件里 Ctrl+F 搜业务词或数字（如 `SKU-001`、`1,234.56`）。",
        "> 口径：本索引只记「做了/得出」的结论；被否决的路线、反复过程在对应 `工作台账-*.md` 正文里。",
        "",
    ]
    for key in project_keys:
        parts.append(render_section(f"项目 {key}", by_project[key]))
    free_rows = by_project.get(None, [])
    if free_rows:
        parts.append(render_section("自由会话（未挂项目）", free_rows))
    with open(OUT_ALL, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(parts))

    free_parts = [
        "# 自由会话（未挂项目）",
        "",
        f"> 由 `dsh-project-anchor/tools/render.py` 于 {now} 全量重建，**请勿手工编辑**。",
        f"> 共 {len(free_rows)} 行。P1 阶段所有历史台账都在这里（尚未建项目）。",
        "",
    ]
    free_parts.append(render_section("自由会话", free_rows, with_heading=False))
    with open(OUT_FREE, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(free_parts))

    print(f"索引行        : {len(rows)}")
    print(f"项目组        : {len(project_keys)} -> {project_keys if project_keys else '（无）'}")
    print(f"自由会话行    : {len(free_rows)}")
    print(f"输出          : {OUT_ALL}")
    print(f"                {OUT_FREE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
