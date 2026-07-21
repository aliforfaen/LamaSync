#!/usr/bin/env python3
"""Send a single line-delimited JSON command to the lamasyncd Unix socket."""
import argparse
import json
import socket
import sys


def send_command(socket_path: str, command: dict) -> dict:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(10)
    sock.connect(socket_path)

    sock.sendall((json.dumps(command) + "\n").encode("utf-8"))

    buffer = b""
    while b"\n" not in buffer:
        chunk = sock.recv(4096)
        if not chunk:
            break
        buffer += chunk

    sock.close()
    line = buffer.split(b"\n", 1)[0].decode("utf-8").strip()
    return json.loads(line)


def main() -> int:
    parser = argparse.ArgumentParser(description="Send a command to lamasyncd socket")
    parser.add_argument("--socket", default="/home/testuser/lamasync.sock", help="Unix socket path")
    parser.add_argument("--cmd", default="sync-all", help="Command name")
    parser.add_argument("--args", default="{}", help="Extra JSON object to merge into command")
    args = parser.parse_args()

    command = {"cmd": args.cmd}
    command.update(json.loads(args.args))

    try:
        response = send_command(args.socket, command)
    except Exception as e:
        print(f"socket error: {e}", file=sys.stderr)
        return 1

    print(json.dumps(response, indent=2))
    return 0 if response.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
