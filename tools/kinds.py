"""看会话存档里有哪些事件类型，以及 user/message 的 source.kind 分布。"""
import collections
import json
import sys

import zstandard

path = sys.argv[1]
raw = zstandard.ZstdDecompressor().stream_reader(open(path, "rb")).read().decode("utf-8", "replace")
types = collections.Counter()
kinds = collections.Counter()
for line in raw.split("\n"):
    if not line.strip():
        continue
    try:
        row = json.loads(line)
    except Exception:
        continue
    kind = row.get("type")
    types[str(kind)] += 1
    if kind == "user/message":
        src = (row.get("data") or {}).get("source") or {}
        kinds[str(src.get("kind"))] += 1
print("事件类型：", types.most_common(25))
print("user/message 的 source.kind：", kinds.most_common(15))
