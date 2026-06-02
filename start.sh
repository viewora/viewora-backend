#!/bin/sh
if [ -n "$IS_WORKER" ]; then
  exec node --max-old-space-size=768 dist/worker.js
else
  exec node --max-old-space-size=640 dist/index.js
fi
