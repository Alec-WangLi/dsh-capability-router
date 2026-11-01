"""统计一次实验会话：多久、调了哪些工具、expert() 的调用序列、注入了什么。

用法：python .scratch/exp_stat.py <session.v4.jsonl.zstd>
"""
import json
import sys
from collections import Counter

import zstandard

path = sys.argv[1]
raw = zstandard.ZstdDecompressor().stream_reader(open(path, "rb")).read().decode("utf-8", "replace")

calls = Counter()
expert_seq = []
injected = Counter()
user_turns = 0
tokens_in = 0
req = 0

for line in raw.split("\n"):
    if not line.strip():
        continue
    try:
        row = json.loads(line)
    except Exception:
        continue
    kind = row.get("type")
    data = row.get("data") or {}

    if kind == "tool/call":
        name = str(data.get("name"))
        calls[name] += 1
        if name == "expert":
            args = data.get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except Exception:
                    args = {}
            args = args or {}
            expert_seq.append(
                {
                    "name": args.get("name"),
                    "phase": args.get("phase"),
                    "project": bool(args.get("project")),
                }
            )

    elif kind == "user/message":
        source = data.get("source") or {}
        tag = source.get("kind")
        if tag == "user":
            user_turns += 1
        elif tag and str(tag).startswith("capability-router"):
            injected[str(tag)] += 1

    elif kind == "request":
        req += 1
        usage = data.get("usage") or {}
        tokens_in += int(usage.get("inputTokens") or usage.get("input_tokens") or 0)

print(f"请求数 {req}｜真人轮次 {user_turns}｜输入 token {tokens_in/1e6:.1f}M")
print("工具调用：", dict(calls.most_common()))
print("注入：", dict(injected))
print("expert() 序列：")
for i, item in enumerate(expert_seq, 1):
    print(f"  {i:>2}. {item['name']}  phase={item['phase']}")
