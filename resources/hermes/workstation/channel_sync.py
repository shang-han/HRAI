"""Gateway transcript sync bridge for the Hermes desktop app.

Streams Weixin / WeCom gateway conversations (stored in Hermes state.db) to
stdout as JSON lines so Electron can mirror them into the desktop session list.

Usage:
  python channel_sync.py
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

PLATFORMS = {"weixin", "wecom"}
POLL_INTERVAL_SECONDS = 2.0

hermes_home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
state_db_path = hermes_home / "state.db"


def emit(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def parse_platform(origin_json: Optional[str]) -> Optional[str]:
    if not origin_json:
        return None
    try:
        data = json.loads(origin_json)
    except Exception:
        return None
    platform = str(data.get("platform") or "").lower()
    return platform if platform in PLATFORMS else None


def fetch_channel_sessions(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    sessions: List[Dict[str, Any]] = []
    rows = conn.execute(
        "SELECT id, origin_json, chat_id, chat_type, display_name FROM sessions"
    ).fetchall()
    for session_id, origin_json, chat_id, chat_type, display_name in rows:
        platform = parse_platform(origin_json)
        if not platform:
            continue
        origin = json.loads(origin_json) if origin_json else {}
        sessions.append({
            "id": session_id,
            "platform": platform,
            "chatId": str(chat_id or origin.get("chat_id") or ""),
            "chatType": str(chat_type or origin.get("chat_type") or ""),
            "displayName": str(display_name or origin.get("chat_name") or origin.get("user_name") or chat_id or ""),
        })
    return sessions


def main() -> None:
    last_message_ids: Dict[str, int] = {}
    emitted_sessions: set[str] = set()

    while True:
        try:
            if not state_db_path.exists():
                time.sleep(POLL_INTERVAL_SECONDS)
                continue

            conn = sqlite3.connect(f"file:{state_db_path.as_posix()}?mode=ro", uri=True, timeout=2)
            try:
                sessions = fetch_channel_sessions(conn)
                for session in sessions:
                    sid = session["id"]
                    if sid not in emitted_sessions:
                        emitted_sessions.add(sid)
                        emit({"type": "session", **session})

                for session in sessions:
                    sid = session["id"]
                    floor = last_message_ids.get(sid, 0)
                    rows = conn.execute(
                        "SELECT id, role, content, timestamp FROM messages "
                        "WHERE session_id = ? AND id > ? AND role IN ('user','assistant') "
                        "AND content IS NOT NULL AND content != '' "
                        "AND tool_name IS NULL "
                        "ORDER BY id ASC",
                        (sid, floor),
                    ).fetchall()
                    for msg_id, role, content, ts in rows:
                        emit({
                            "type": "message",
                            "sessionId": sid,
                            "gatewaySessionId": sid,
                            "role": role,
                            "content": content,
                            "timestamp": ts,
                            "sourceId": f"gw:{sid}:{msg_id}",
                        })
                        last_message_ids[sid] = max(last_message_ids.get(sid, 0), msg_id)
            finally:
                conn.close()
        except Exception as exc:
            # 同步失败不能影响主流程，下个轮次重试
            emit({"type": "error", "error": str(exc)})

        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
