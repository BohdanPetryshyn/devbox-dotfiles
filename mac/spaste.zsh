# spaste — send Mac clipboard image to a remote host and put the resulting
# remote path on the clipboard, ready to Cmd+V into Claude Code on the remote.
# Usage: spaste <ssh-host>   # host name from ~/.ssh/config
spaste() {
  local host="${1:?usage: spaste <ssh-host>}"
  local local_tmp="/tmp/_spaste.png"
  local remote_path="/tmp/clip-$(date +%s).png"

  local result
  result=$(osascript <<EOF
try
  set png to (the clipboard as «class PNGf»)
  set f to open for access POSIX file "$local_tmp" with write permission
  set eof of f to 0
  write png to f
  close access f
  return "ok"
on error
  return "no_image"
end try
EOF
)

  if [[ "$result" != "ok" ]]; then
    echo "clipboard has no image" >&2
    return 1
  fi

  scp -q "$local_tmp" "$host:$remote_path" || return $?
  rm -f "$local_tmp"

  printf '%s' "$remote_path" | pbcopy
  echo "→ $host:$remote_path (copied to clipboard)"
}
