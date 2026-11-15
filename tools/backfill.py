# -*- coding: utf-8 -*-
"""P1 存量回填：把 dsh-work-ledger 生成的历史台账解析成索引事实（append-only JSONL）。

输入：根目录 `工作台账-*.md` 与 `_台账\工作台账-*.md`（同一会话可能各有一份，按较长摘要去重）
输出：`_台账\索引.jsonl`（一行一节点，写入即冻结）+ 控制台核对报告

口径（与方案 §10 一致）：
- ts_session  = 台账头部的"生成时间" + 台账文件的修改日期（台账里没有首条消息时间）
- ts_source   = "ledger_generated"（区别于今后由会话实际写入的 "session_start"）
- project     = null（存量台账里没有项目号，全部落自由会话）
- 节点内多条结论合并为一行，摘要取全部结论正文的前 100 字

不做任何文件移动/删除，只新建索引文件。
"""
import json
import os
import re
import sys
from datetime import datetime, timedelta

from pathlib import Path

ROOT = str(Path(__file__).resolve().parents[1])
OUT_DIR = os.path.join(ROOT, "_台账")
OUT_JSONL = os.path.join(OUT_DIR, "索引.jsonl")

STATUS_MAP = {"已完成": "done", "进行中": "active", "受阻": "blocked", "未知": "unknown"}

RE_SESSION = re.compile(r"会话：\s*(session-[0-9a-fA-F-]+|unknown)")
RE_GENTIME = re.compile(r"生成时间：\s*(\d{1,2}:\d{2}:\d{2})")
RE_NODE = re.compile(r"^##\s+(\d+)\.\s+(.+?)（(已完成|进行中|受阻|未知)）\s*$")
RE_NODE_FALLBACK = re.compile(r"^##\s+(\d+)\.\s+(.+?)\s*$")
RE_NOTE = re.compile(r"^###\s+结论\s+(\d+)\s+—\s+(\d{1,2}:\d{2}:\d{2})\s*$")
RE_EVIDENCE = re.compile(r"^###\s+证据")
RE_FILE = re.compile(r"^\s+-\s+文件：(.+)$")
RE_CALLID = re.compile(r"^\s+-\s+锚点：`([^`]+)`")
RE_TABLE_ROW = re.compile(r"^\|(.+)\|\s*$")


def shorten(text, limit=100):
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def pick_values_from_tables(body_lines):
    """从结论正文里抓"关键数字"表格的数值列（第 2 列）。"""
    values = []
    for line in body_lines:
        m = RE_TABLE_ROW.match(line.strip())
        if not m:
            continue
        cells = [c.strip() for c in m.group(1).split("|")]
        if len(cells) < 2:
            continue
        if all(set(c) <= set("-: ") for c in cells):  # 分隔行
            continue
        if cells[0] in ("指标", "数值"):  # 表头
            continue
        val = cells[1]
        if not val or val in ("数值",):
            continue
        # 过滤噪声：SHA-256 之类的长十六进制串、超长串不是"关键数字"
        if re.fullmatch(r"[0-9a-fA-F]{32,}", val):
            continue
        if len(val) > 60:
            continue
        if re.search(r"\d", val):
            values.append(val)
    return values


def parse_ledger(path):
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    lines = text.splitlines()

    session = None
    gen_time = None
    for line in lines[:15]:
        m = RE_SESSION.search(line)
        if m and session is None:
            session = m.group(1)
        m = RE_GENTIME.search(line)
        if m and gen_time is None:
            gen_time = m.group(1)

    mtime = datetime.fromtimestamp(os.path.getmtime(path))
    if gen_time:
        hh, mm, ss = (int(x) for x in gen_time.split(":"))
        base = mtime.replace(hour=hh, minute=mm, second=ss, microsecond=0)
    else:
        base = mtime.replace(microsecond=0)

    nodes = []
    cur = None          # 当前节点
    cur_note_lines = None
    in_evidence = False

    def flush_note():
        nonlocal cur_note_lines
        if cur is not None and cur_note_lines is not None and cur.get("_pending_note") is not None:
            cur["notes"].append({
                "time": cur["_pending_note"],
                "body": "\n".join(cur_note_lines).strip(),
            })
        cur_note_lines = None

    def flush_node():
        nonlocal cur
        if cur is None:
            return
        body_all = " ".join(n["body"] for n in cur["notes"])
        numbers = []
        for n in cur["notes"]:
            numbers.extend(pick_values_from_tables(n["body"].splitlines()))
        seen = set()
        uniq_numbers = []
        for v in numbers:
            if v not in seen:
                seen.add(v)
                uniq_numbers.append(v)
        files = []
        for f in cur["files"]:
            for part in f.split("、"):
                part = part.strip()
                if part and part not in files:
                    files.append(part)
        # 节点时间：取该节点最后一条结论的时间戳（台账里有），比"生成时间"准得多；
        # 若结论时间晚于生成时间，说明该结论发生在生成那一刻之前一天（跨零点补写）。
        ts = base
        note_times = [n["time"] for n in cur["notes"] if n.get("time")]
        if note_times:
            hh, mm, ss = (int(x) for x in note_times[-1].split(":"))
            ts = base.replace(hour=hh, minute=mm, second=ss)
            if gen_time:
                gh, gm, gs = (int(x) for x in gen_time.split(":"))
                if (hh, mm, ss) > (gh, gm, gs):
                    ts = ts - timedelta(days=1)
        nodes.append({
            "idx": cur["idx"],
            "title": cur["title"],
            "status": STATUS_MAP.get(cur["status"], "unknown"),
            "note_count": len(cur["notes"]),
            "summary": shorten(body_all, 100),
            "numbers": uniq_numbers[:8],
            "files": files[:5],
            "callId": cur["callId"],
            "ts": ts.isoformat(),
            "ts_source": "note_time" if note_times else "ledger_generated",
        })
        cur = None

    for line in lines:
        m = RE_NODE.match(line)
        if m:
            flush_note()
            flush_node()
            cur = {"idx": int(m.group(1)), "title": m.group(2).strip(), "status": m.group(3),
                   "notes": [], "files": [], "callId": None, "_pending_note": None}
            in_evidence = False
            continue

        m = RE_NOTE.match(line)
        if m and cur is not None:
            flush_note()
            cur["_pending_note"] = m.group(2)
            cur_note_lines = []
            in_evidence = False
            continue

        if RE_EVIDENCE.match(line):
            flush_note()
            in_evidence = True
            continue

        if cur is None:
            continue

        if in_evidence:
            mf = RE_FILE.match(line)
            if mf:
                cur["files"].append(mf.group(1).strip())
            mc = RE_CALLID.match(line)
            if mc and cur["callId"] is None:
                cur["callId"] = mc.group(1)
            continue

        if cur_note_lines is not None:
            cur_note_lines.append(line)

    flush_note()
    flush_node()

    return session or "unknown", nodes


def main():
    files = []
    for name in sorted(os.listdir(ROOT)):
        if name.startswith("工作台账-") and name.endswith(".md"):
            files.append(os.path.join(ROOT, name))
    sub = os.path.join(ROOT, "_台账")
    if os.path.isdir(sub):
        for name in sorted(os.listdir(sub)):
            if name.startswith("工作台账-") and name.endswith(".md"):
                files.append(os.path.join(sub, name))

    raw_rows = []
    per_file = []
    for path in files:
        try:
            session, nodes = parse_ledger(path)
        except Exception as exc:  # 单个文件失败不拖垮整体
            per_file.append((os.path.basename(path), -1, str(exc)))
            continue
        per_file.append((os.path.basename(path), len(nodes), ""))
        for n in nodes:
            raw_rows.append({
                "v": 1,
                "type": "note",
                "session": session,
                "project": None,
                "node": n["title"],
                "status": n["status"],
                "summary": n["summary"],
                "numbers": n["numbers"],
                "files": n["files"],
                "ts_session": n["ts"],
                "ts_source": n["ts_source"],
                "callId": n["callId"],
                "revises": None,
                "source": f"{os.path.basename(path)}#{n['idx']}",
                "note_count": n["note_count"],
            })

    # 同一 (会话, 节点) 可能来自两份台账，保留摘要更长的那条
    best = {}
    for row in raw_rows:
        key = (row["session"], row["node"])
        if key not in best or len(row["summary"]) > len(best[key]["summary"]):
            best[key] = row
    rows = sorted(best.values(), key=lambda r: (r["ts_session"], r["session"], r["node"]), reverse=True)

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT_JSONL, "w", encoding="utf-8", newline="\n") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(f"{'文件':<34}{'节点':>6}  备注")
    print("-" * 60)
    for name, cnt, err in per_file:
        print(f"{name:<34}{cnt:>6}  {err}")
    print("-" * 60)
    print(f"台账文件数      : {len(files)}")
    print(f"解析出节点(原始): {len(raw_rows)}")
    print(f"去重后索引行    : {len(rows)}")
    print(f"涉及会话数      : {len({r['session'] for r in rows})}")
    print(f"输出            : {OUT_JSONL}")

    if len(raw_rows) == 0:
        print("!! 零行，按方案约定不写视图", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
