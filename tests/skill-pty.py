import os, sys, json, pty, selectors, subprocess, time, fcntl, termios, struct

command = json.loads(sys.argv[1])
steps = json.loads(sys.argv[2])
size = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {"columns": 100, "rows": 30}
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", size["rows"], size["columns"], 0, 0))
child = subprocess.Popen(command, stdin=slave, stderr=slave, stdout=slave if size.get("full") else subprocess.PIPE)
os.close(slave)
poller = selectors.DefaultSelector()
poller.register(master, selectors.EVENT_READ, "terminal")
if child.stdout is not None:
    poller.register(child.stdout, selectors.EVENT_READ, "stdout")
terminal = ""
stdout = ""
seen = ""
deadline = time.monotonic() + 15
try:
    while poller.get_map() and time.monotonic() < deadline:
        for key, _ in poller.select(0.1):
            try:
                value = os.read(key.fd, 65536)
            except OSError:
                value = b""
            if not value:
                poller.unregister(key.fd)
                continue
            text = value.decode("utf-8", errors="replace")
            if key.data == "terminal":
                terminal += text
                seen += text
                while steps and steps[0]["wait"] in seen:
                    step = steps.pop(0)
                    end = seen.index(step["wait"]) + len(step["wait"])
                    os.write(master, step["keys"].encode())
                    seen = seen[end:]
            else:
                stdout += text
    if child.poll() is None:
        child.kill()
    code = child.wait()
    print(json.dumps({"code": code, "stdout": stdout, "terminal": terminal, "pending": steps}))
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    poller.close()
    os.close(master)
