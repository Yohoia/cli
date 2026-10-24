import os, sys, json, pty, selectors, subprocess, time

command = json.loads(sys.argv[1])
steps = json.loads(sys.argv[2])
master, slave = pty.openpty()
child = subprocess.Popen(command, stdin=slave, stderr=slave, stdout=subprocess.PIPE)
os.close(slave)
poller = selectors.DefaultSelector()
poller.register(master, selectors.EVENT_READ, "terminal")
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
                if steps and steps[0]["wait"] in seen:
                    step = steps.pop(0)
                    os.write(master, step["keys"].encode())
                    seen = ""
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
