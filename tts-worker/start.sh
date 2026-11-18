#!/bin/sh
# Same name as the API's start script on purpose: if Railway ever applies the
# repository's root railway.json (startCommand "sh start.sh") to this service,
# it still starts the right thing.
exec python worker.py
