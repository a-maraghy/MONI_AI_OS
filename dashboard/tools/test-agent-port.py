#!/usr/bin/env python3
"""moni-helper assign_api_port: two agents never share a webhook API port.

Regression for 2026-10-25: saving MINT Pace in the panel wrote the catalogue
default 8080 over its hand-set 8091, mavix-bot already had 8080, and MINT Pace
crashed at every start. Run: python3 tools/test-agent-port.py
"""
import importlib.machinery, importlib.util, os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
loader = importlib.machinery.SourceFileLoader("helper", os.path.join(HERE, "..", "deploy", "moni-helper"))
spec = importlib.util.spec_from_loader("helper", loader)
h = importlib.util.module_from_spec(spec)
loader.exec_module(h)

root = tempfile.mkdtemp()
h.AGENTS_DIR = root
h.agent_dir = lambda s: os.path.join(root, s)
for slug, env in (("mavix-bot", "ENABLE_API_SERVER=true\nAPI_SERVER_PORT=8080\n"),
                  ("mint-pace", "ENABLE_API_SERVER=true\nAPI_SERVER_PORT=8091\n"),
                  ("quiet", "ENABLE_API_SERVER=false\nAPI_SERVER_PORT=8082\n")):
    os.makedirs(os.path.join(root, slug))
    with open(os.path.join(root, slug, "agent.env"), "w") as fh:
        fh.write(env)

passed = failed = 0
def check(name, slug, port, want_port, want_moved, on="true"):
    global passed, failed
    cfg = {"addon_env": {"ENABLE_API_SERVER": on, "API_SERVER_PORT": port}}
    moved = h.assign_api_port(slug, cfg)
    got = cfg["addon_env"]["API_SERVER_PORT"]
    ok = got == want_port and bool(moved) == want_moved
    passed += ok; failed += not ok
    print(("ok   " if ok else "FAIL ") + name + f" -> {got} moved={moved}")

check("an agent keeps its own port", "mavix-bot", "8080", "8080", False)
check("a save offering the default keeps the agent's current free port", "mint-pace", "8080", "8091", True)
check("a new agent asking for a taken port gets the first free one", "newbie", "8080", "8081", True)
check("a port held only by an agent with the API off is free", "newbie", "8082", "8082", False)
check("a free port asked for is kept", "newbie", "9000", "9000", False)
check("nothing changes when the API is off", "newbie", "8080", "8080", False, on="false")
print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
