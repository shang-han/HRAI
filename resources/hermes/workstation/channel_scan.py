"""Channel scan-to-connect bridge for the Electron desktop app.

Usage:
  python channel_scan.py begin <wecom|dingtalk|feishu>
  python channel_scan.py poll <wecom|dingtalk|feishu> <session>

Each invocation prints a single JSON object to stdout. The desktop app
renders the returned QR URL and polls every few seconds until the user
finishes scanning in the corresponding mobile app.
"""

from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional


def emit(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(message: str) -> None:
    emit({"status": "error", "error": message})
    sys.exit(1)


# ──────────────────────────────────────────────────────────────
# WeCom Smart Robot QR flow (admin console private endpoints,
# identical to the flow shipped by Hermes wecom plugin / lxup).
# ──────────────────────────────────────────────────────────────

_WECOM_GENERATE_URL = "https://work.weixin.qq.com/ai/qc/generate"
_WECOM_QUERY_URL = "https://work.weixin.qq.com/ai/qc/query_result"


def wecom_begin() -> None:
    req = urllib.request.Request(
        f"{_WECOM_GENERATE_URL}?source=hermes",
        headers={"User-Agent": "HermesAgent/1.0"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = json.loads(resp.read().decode("utf-8"))
    data = raw.get("data") or {}
    scode = str(data.get("scode") or "").strip()
    auth_url = str(data.get("auth_url") or "").strip()
    if not scode or not auth_url:
        fail(f"企业微信扫码接口返回异常: {raw}")
    emit({
        "status": "ok",
        "qrUrl": auth_url,
        "session": scode,
        "expiresIn": 300,
        "interval": 3,
    })


def wecom_poll(scode: str) -> None:
    url = f"{_WECOM_QUERY_URL}?scode={urllib.parse.quote(scode)}"
    req = urllib.request.Request(url, headers={"User-Agent": "HermesAgent/1.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = json.loads(resp.read().decode("utf-8"))
    data = raw.get("data") or {}
    status = str(data.get("status") or "").lower()
    if status == "success":
        bot_info = data.get("bot_info") or {}
        bot_id = str(bot_info.get("botid") or bot_info.get("bot_id") or "").strip()
        secret = str(bot_info.get("secret") or "").strip()
        if bot_id and secret:
            emit({"status": "success", "botId": bot_id, "secret": secret})
            return
        emit({"status": "waiting", "message": "扫码成功，等待企业微信返回机器人凭据"})
        return
    if status in {"expired", "fail", "failed"}:
        emit({"status": "expired", "message": "二维码已失效，请重新生成"})
        return
    emit({"status": "waiting", "message": "等待手机企业微信扫码确认"})


# ──────────────────────────────────────────────────────────────
# DingTalk Stream device-flow QR authorization
# ──────────────────────────────────────────────────────────────


def dingtalk_begin() -> None:
    try:
        from hermes_cli.dingtalk_auth import begin_registration
    except Exception as exc:  # pragma: no cover
        fail(f"钉钉扫码模块加载失败: {exc}")
    try:
        reg = begin_registration()
    except Exception as exc:
        fail(f"钉钉扫码初始化失败: {exc}")
    emit({
        "status": "ok",
        "qrUrl": reg["verification_uri_complete"],
        "session": reg["device_code"],
        "expiresIn": int(reg.get("expires_in", 7200)),
        "interval": max(int(reg.get("interval", 3)), 2),
    })


def dingtalk_poll(device_code: str) -> None:
    try:
        from hermes_cli.dingtalk_auth import poll_registration
    except Exception as exc:  # pragma: no cover
        fail(f"钉钉扫码模块加载失败: {exc}")
    try:
        result = poll_registration(device_code)
    except Exception as exc:
        fail(f"钉钉扫码查询失败: {exc}")
    status = str(result.get("status") or "UNKNOWN").upper()
    if status == "SUCCESS":
        emit({
            "status": "success",
            "appKey": result.get("client_id"),
            "appSecret": result.get("client_secret"),
        })
        return
    if status in {"FAIL", "EXPIRED"}:
        emit({"status": "expired", "message": result.get("fail_reason") or status})
        return
    emit({"status": "waiting", "message": "等待钉钉扫码授权"})


# ──────────────────────────────────────────────────────────────
# Feishu / Lark scan-to-create device flow
# ──────────────────────────────────────────────────────────────


def feishu_begin() -> None:
    try:
        from plugins.platforms.feishu.adapter import _begin_registration
    except Exception as exc:  # pragma: no cover
        fail(f"飞书扫码模块加载失败: {exc}")
    try:
        reg = _begin_registration("feishu")
    except Exception as exc:
        fail(f"飞书扫码初始化失败: {exc}")
    emit({
        "status": "ok",
        "qrUrl": reg["qr_url"],
        "session": reg["device_code"],
        "expiresIn": int(reg.get("expire_in", 600)),
        "interval": max(int(reg.get("interval", 5)), 3),
    })


def feishu_poll(device_code: str) -> None:
    try:
        from plugins.platforms.feishu.adapter import _begin_registration, _poll_registration
    except Exception as exc:  # pragma: no cover
        fail(f"飞书扫码模块加载失败: {exc}")
    try:
        # 每次 poll 都需要 interval/expire_in；从 begin 阶段无法跨进程保存，
        # 这里传宽松默认值，poll 实现只用来做超时控制，单次调用会立即返回。
        result = _poll_registration(
            device_code=device_code,
            interval=1,
            expire_in=30,
            domain="feishu",
        )
    except Exception as exc:
        fail(f"飞书扫码查询失败: {exc}")
    if isinstance(result, dict):
        app_id = str(result.get("app_id") or "").strip()
        app_secret = str(result.get("app_secret") or "").strip()
        if app_id and app_secret:
            emit({"status": "success", "appId": app_id, "appSecret": app_secret})
            return
    emit({"status": "waiting", "message": "等待飞书扫码创建应用"})


_WEIXIN_BASE = "https://ilinkai.weixin.qq.com"
_WEIXIN_HEADERS = {
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": "131584",
}


def _weixin_get(path: str) -> Dict[str, Any]:
    req = urllib.request.Request(
        f"{_WEIXIN_BASE}/{path}",
        headers={**_WEIXIN_HEADERS, "User-Agent": "HermesAgent/1.0"},
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        return json.loads(resp.read().decode("utf-8"))


def weixin_begin() -> None:
    try:
        raw = _weixin_get("ilink/bot/get_bot_qrcode?bot_type=3")
    except Exception as exc:
        fail(f"微信二维码获取失败: {exc}")
    qrcode = str(raw.get("qrcode") or "").strip()
    qr_url = str(raw.get("qrcode_img_content") or "").strip() or qrcode
    if not qrcode or not qr_url:
        fail(f"微信扫码接口返回异常: {raw}")
    emit({
        "status": "ok",
        "qrUrl": qr_url,
        "session": qrcode,
        "expiresIn": 480,
        "interval": 3,
    })


def weixin_poll_once(qrcode: str, base_url: str = _WEIXIN_BASE) -> Dict[str, Any]:
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/ilink/bot/get_qrcode_status?qrcode={urllib.parse.quote(qrcode)}",
        headers={**_WEIXIN_HEADERS, "User-Agent": "HermesAgent/1.0"},
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        return json.loads(resp.read().decode("utf-8"))


def weixin_poll(qrcode: str) -> None:
    try:
        status_resp = weixin_poll_once(qrcode)
    except Exception as exc:
        emit({"status": "waiting", "message": f"微信扫码查询失败，稍后重试: {exc}"})
        return

    status = str(status_resp.get("status") or "wait").lower()
    if status == "confirmed":
        account_id = str(status_resp.get("ilink_bot_id") or "").strip()
        token = str(status_resp.get("bot_token") or "").strip()
        base_url = str(status_resp.get("baseurl") or _WEIXIN_BASE).strip()
        if account_id and token:
            emit({"status": "success", "accountId": account_id, "token": token, "baseUrl": base_url})
            return
        emit({"status": "waiting", "message": "扫码已确认，等待微信返回账号凭据"})
        return
    if status == "scaned_but_redirect":
        redirect_host = str(status_resp.get("redirect_host") or "").strip()
        if redirect_host:
            try:
                redirected = weixin_poll_once(qrcode, f"https://{redirect_host}")
            except Exception:
                redirected = {}
            redirect_status = str(redirected.get("status") or "wait").lower()
            if redirect_status == "confirmed":
                account_id = str(redirected.get("ilink_bot_id") or "").strip()
                token = str(redirected.get("bot_token") or "").strip()
                base_url = str(redirected.get("baseurl") or f"https://{redirect_host}").strip()
                if account_id and token:
                    emit({"status": "success", "accountId": account_id, "token": token, "baseUrl": base_url})
                    return
        emit({"status": "waiting", "message": "已扫码，正在微信中确认"})
        return
    if status == "scaned":
        emit({"status": "waiting", "message": "已扫码，请在手机上确认登录"})
        return
    if status == "expired":
        emit({"status": "expired", "message": "二维码已过期，请重新生成"})
        return
    emit({"status": "waiting", "message": "等待微信扫码登录"})


def main() -> None:
    if len(sys.argv) < 3:
        fail("usage: channel_scan.py <begin|poll> <weixin|wecom|dingtalk|feishu> [session]")
    action, channel = sys.argv[1], sys.argv[2].lower()

    if channel == "weixin":
        if action == "begin":
            weixin_begin()
        elif action == "poll" and len(sys.argv) >= 4:
            weixin_poll(sys.argv[3])
        else:
            fail("invalid weixin action")
        return

    if channel == "wecom":
        if action == "begin":
            wecom_begin()
        elif action == "poll" and len(sys.argv) >= 4:
            wecom_poll(sys.argv[3])
        else:
            fail("invalid wecom action")
        return

    if channel == "dingtalk":
        if action == "begin":
            dingtalk_begin()
        elif action == "poll" and len(sys.argv) >= 4:
            dingtalk_poll(sys.argv[3])
        else:
            fail("invalid dingtalk action")
        return

    if channel == "feishu":
        if action == "begin":
            feishu_begin()
        elif action == "poll" and len(sys.argv) >= 4:
            feishu_poll(sys.argv[3])
        else:
            fail("invalid feishu action")
        return

    fail("unknown channel")


if __name__ == "__main__":
    main()
