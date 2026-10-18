#!/bin/bash
# Stops the local dev server and mock API started for e2e tests.
for p in /proc/[0-9]*; do
  pid=${p#/proc/}
  [ "$pid" = "$$" ] && continue
  c=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)
  case "$c" in *"vite dev"*|*mock-server.mjs*|*workerd\ serve*) kill "$pid" 2>/dev/null ;; esac
done
